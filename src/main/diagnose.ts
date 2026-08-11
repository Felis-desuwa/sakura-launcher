import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// Extensions spelled out: this module has no electron import, so `scripts/diagnose-test.mts`
// loads it straight into node and runs the whole diagnosis against a real folder. Nothing
// fills the extension in there.
import type { Diagnosis, DiagnosisCheck, Game } from '../shared/types.ts'
import {
  groupMissing,
  isVirtualDll,
  localeVerdict,
  logHintsFor,
  pickErrorDialog,
  searchDirsFor,
  SEVERITY_RANK
} from './diagnose-rules.ts'
import { readWindowsIn } from './window-text.ts'
import { probeExeMeta } from './pe-icon.ts'
import { readPe } from './pe-imports.ts'
import { classifyExes, detectEngineAt, listDirShallow } from './scan-core.ts'

/**
 * Working out why a game did not start.
 *
 * The rules live next door in `diagnose-rules.ts`; this file is the half that has to
 * touch the disk — reading the executable, resolving its imports against the places
 * Windows would look, finding the log the engine just wrote.
 *
 * Two things it deliberately does not do. It never writes to the game folder, so a
 * diagnosis can be run on anything without consequence. And it never guesses: every
 * finding names the evidence behind it, and a check that could not be carried out is
 * reported as not carried out rather than as a clean bill of health.
 */

/** How much of a log is worth showing — enough for a stack trace, not a whole session. */
const LOG_TAIL_BYTES = 4096

/** A log older than the launch is about some previous evening, not about this failure. */
const LOG_MAX_AGE_MS = 10 * 60_000

/**
 * The system's ANSI codepage.
 *
 * Cached for the process lifetime: it cannot change without a reboot, and the diagnosis
 * would otherwise shell out every time it ran.
 */
let acpCache: number | null | undefined

function readAcp(): Promise<number | null> {
  if (acpCache !== undefined) return Promise.resolve(acpCache)
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      acpCache = null
      return resolve(null)
    }
    execFile(
      'reg',
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        const match = err ? null : /ACP\s+REG_SZ\s+(\d+)/i.exec(stdout)
        acpCache = match ? Number(match[1]) : null
        resolve(acpCache)
      }
    )
  })
}

/**
 * Whether a DLL can be found where the loader would look.
 *
 * System directories are cached across games — a library of two hundred titles otherwise
 * stats `kernel32.dll` two hundred times. The game's own folder is checked afresh each
 * time, since that is the part that differs.
 */
const systemDllCache = new Map<string, boolean>()

function dllResolves(dll: string, searchDirs: string[], exeDir: string): boolean {
  for (const dir of searchDirs) {
    const key = `${dir.toLowerCase()}|${dll}`
    const cacheable = dir !== exeDir
    if (cacheable) {
      const hit = systemDllCache.get(key)
      if (hit !== undefined) {
        if (hit) return true
        continue
      }
    }
    let found = false
    try {
      found = fs.existsSync(path.join(dir, dll))
    } catch {
      found = false
    }
    if (cacheable) systemDllCache.set(key, found)
    if (found) return true
  }
  return false
}

/** Decode a log tail, trying the two encodings these games actually use. */
function decodeLog(buf: Buffer): string {
  const utf8 = buf.toString('utf-8')
  if (!utf8.includes('\ufffd')) return utf8
  try {
    // Japanese engines predate UTF-8 as a default and write their logs in Shift-JIS.
    const sjis = new TextDecoder('shift_jis', { fatal: false }).decode(buf)
    return sjis.split('\ufffd').length < utf8.split('\ufffd').length ? sjis : utf8
  } catch {
    return utf8
  }
}

function tailOf(file: string): string | null {
  try {
    const size = fs.statSync(file).size
    const start = Math.max(0, size - LOG_TAIL_BYTES)
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(Math.min(size, LOG_TAIL_BYTES))
      fs.readSync(fd, buf, 0, buf.length, start)
      return decodeLog(buf).trim()
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

/**
 * Find a log the game wrote *this time*.
 *
 * The age limit is the whole point. Every one of these folders has an `error.log` in it
 * from some evening years ago, and presenting that as the reason today's launch failed
 * would be worse than saying nothing.
 */
function findFreshLog(game: Game, since: number): string | null {
  const hints = logHintsFor(game.engine ?? null)
  const cutoff = since - LOG_MAX_AGE_MS

  const candidates: string[] = []
  for (const entry of listDirShallow(game.dir)) {
    if (entry.isDir) continue
    if (hints.inGameDir.some((re) => re.test(entry.name))) {
      candidates.push(path.join(game.dir, entry.name))
    }
  }

  if (hints.localLow && game.exe) {
    // Unity puts it under the company and product names compiled into the executable,
    // which is the only place they are written down.
    const version = probeExeMeta(game.exe)?.version
    const company = version?.company
    const product = version?.product
    if (company && product) {
      candidates.push(
        path.join(os.homedir(), 'AppData', 'LocalLow', company, product, 'Player.log')
      )
    }
  }

  let newest: { file: string; mtime: number } | null = null
  for (const file of candidates) {
    try {
      const st = fs.statSync(file)
      if (st.mtimeMs < cutoff) continue
      if (!newest || st.mtimeMs > newest.mtime) newest = { file, mtime: st.mtimeMs }
    } catch {
      /* not there */
    }
  }
  return newest?.file ?? null
}

/**
 * Examine a game and report everything that could stop it from starting.
 *
 * `since` bounds the search for a crash log: the moment of the launch that just failed,
 * or the last recorded launch when the user asked for this out of the blue.
 */
export async function diagnoseGame(game: Game, since?: number): Promise<Diagnosis> {
  const checks: DiagnosisCheck[] = []
  const checked: string[] = []

  const engine = game.engine ?? (game.exe ? detectEngineAt(game.dir, game.exe) : null)

  const base: Diagnosis = {
    gameId: game.id,
    exe: game.exe,
    engine,
    arch: null,
    checked,
    checks
  }

  if (!game.exe) {
    checks.push({
      code: 'exe-missing',
      severity: 'blocker',
      title: '这个条目没有主程序',
      detail: '库里记着这个文件夹，但没有记着该运行哪个程序。',
      reasons: [],
      action: 'pickExe'
    })
    return base
  }

  if (!fs.existsSync(game.exe)) {
    checks.push({
      code: 'exe-missing',
      severity: 'blocker',
      title: '主程序不在了',
      detail: `${game.exe} 已经不存在 —— 文件被移走、改名，或者所在的盘没挂上。`,
      reasons: [],
      action: 'revealDir',
      actionPath: game.dir
    })
    return base
  }

  const exeDir = path.dirname(game.exe)
  const pe = readPe(game.exe)
  checked.push('主程序能不能作为可执行文件读出来')

  if (!pe) {
    checks.push({
      code: 'bad-arch',
      severity: 'blocker',
      title: '这个文件不是可执行程序',
      detail: '它的文件头不是任何一种 Windows 可执行格式。多半是主程序选错了。',
      reasons: [],
      action: 'pickExe'
    })
    return base
  }

  base.arch = pe.is16bit ? '16 位' : pe.arch

  if (pe.is16bit) {
    checks.push({
      code: 'bad-arch',
      severity: 'blocker',
      title: '16 位程序，64 位 Windows 跑不了',
      detail:
        '这是 DOS 或 16 位 Windows 时代的程序。64 位 Windows 移除了运行它们的子系统，' +
        '没有补丁能改变这一点 —— 要跑只能用 DOSBox 之类的模拟器。',
      reasons: ['文件头不是 PE'],
      action: 'revealDir',
      actionPath: game.dir
    })
    return base
  }

  if (pe.arch === 'arm' || pe.arch === 'arm64') {
    checks.push({
      code: 'bad-arch',
      severity: 'blocker',
      title: `这是 ${pe.arch.toUpperCase()} 版本的程序`,
      detail: '当前这台机器的处理器架构跑不了它。',
      reasons: [`PE 头里的 Machine 字段是 ${pe.arch}`]
    })
  }

  /* ---- missing runtimes ---- */

  const windir = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const searchDirs = searchDirsFor(exeDir, pe.arch, windir, pathEntries)

  const realImports = pe.imports.filter((d) => !isVirtualDll(d))
  const missing = realImports.filter((d) => !dllResolves(d, searchDirs, exeDir))
  checked.push(`主程序需要的 ${realImports.length} 个 DLL 是否都能找到`)

  if (missing.length > 0) {
    const { groups, unknown } = groupMissing(missing)
    for (const group of groups) {
      checks.push({
        code: 'missing-runtime',
        severity: 'blocker',
        title: `缺 ${group.pkg.label}`,
        detail: group.pkg.note
          ? `${group.pkg.note}。装上之后这个游戏，以及库里所有同样缺它的游戏，都会一起好。`
          : '装上之后这个游戏，以及库里所有同样缺它的游戏，都会一起好。',
        reasons: [`找不到 ${group.dlls.join('、')}`]
      })
    }
    if (unknown.length > 0) {
      checks.push({
        code: 'missing-dll',
        severity: 'blocker',
        title: '缺文件，但不是常见运行库',
        detail:
          '这些 DLL 本该和游戏一起分发。多半是压缩包没解全，或者解压时被杀毒软件删掉了 —— ' +
          '重新解压一次通常就能解决。',
        reasons: [`找不到 ${unknown.join('、')}`],
        action: 'revealDir',
        actionPath: exeDir
      })
    }
  }

  const missingDelay = pe.delayImports
    .filter((d) => !isVirtualDll(d))
    .filter((d) => !dllResolves(d, searchDirs, exeDir))
  if (missingDelay.length > 0) {
    checks.push({
      code: 'delay-missing',
      severity: 'note',
      title: '有几个延迟加载的 DLL 找不到',
      detail:
        '这类 DLL 只有用到时才加载，缺了不一定影响启动 —— 但如果游戏是走到某个画面才崩，' +
        '大概率就是它们。',
      reasons: [missingDelay.join('、')]
    })
  }

  /* ---- elevation ---- */

  checked.push('主程序有没有要求管理员权限')
  if (pe.requiresAdmin === true) {
    checks.push({
      code: 'needs-admin',
      severity: 'likely',
      title: '这个程序要求以管理员身份运行',
      detail:
        '它的清单里写着 requireAdministrator。双击磁贴时启动器是普通权限，系统会直接拒绝，' +
        '看上去就是毫无反应。',
      reasons: ['内嵌 manifest 的 requestedExecutionLevel 是 requireAdministrator'],
      action: 'runAsAdmin'
    })
  }

  /* ---- did they pick the right executable ---- */

  checked.push('选中的主程序是不是游戏本体')
  const entries = listDirShallow(game.dir).map((e) => ({
    name: e.name,
    isDir: e.isDir,
    size: e.sizeBytes
  }))
  const verdicts = classifyExes(game.dir, entries, probeExeMeta)
  const mine = verdicts.find(
    (v) => path.resolve(v.fullPath).toLowerCase() === path.resolve(game.exe).toLowerCase()
  )
  const wrongKinds = new Set(['uninstall', 'tool', 'patch'])
  if (mine && wrongKinds.has(mine.kind)) {
    checks.push({
      code: 'wrong-exe',
      severity: 'likely',
      title: '现在选的可能不是游戏本体',
      detail: `${mine.name} 看起来是${
        mine.kind === 'uninstall' ? '卸载程序' : mine.kind === 'patch' ? '补丁' : '工具或设置程序'
      }。换成真正的主程序试试。`,
      reasons: mine.reasons.length > 0 ? mine.reasons : ['文件名特征'],
      action: 'pickExe'
    })
  } else if (mine?.kind === 'locale' && (game.launchArgs?.length ?? 0) === 0) {
    // A locale emulator *is* a legitimate choice — but only when it was told what to run.
    checks.push({
      code: 'wrong-exe',
      severity: 'likely',
      title: '选的是区域模拟器，但没告诉它要启动什么',
      detail:
        `${mine.name} 是区域模拟器。单独运行它只会打开它自己的界面。` +
        '在「更换主程序…」里把要启动的游戏作为参数配上，双击磁贴才会是完整的那一串。',
      reasons: ['主程序是区域模拟器，且没有记录启动参数'],
      action: 'pickExe'
    })
  }

  /* ---- locale emulator ---- */

  const acp = await readAcp()
  checked.push('系统代码页与游戏文件名是否对得上')
  const names = [path.basename(game.dir), path.basename(game.exe), ...entries.map((e) => e.name)]
  const locale = localeVerdict({ acp, engine, names })
  if (locale.needed) {
    checks.push({
      code: 'needs-locale',
      severity: 'likely',
      title: '这个游戏多半要用区域模拟器启动',
      detail:
        '它按日文系统写成，会把文件名和脚本按系统代码页转换。在非日文系统上这一步会出错，' +
        '表现通常是直接退出或者满屏乱码。用 NTLEA 或 Locale Emulator 启动能解决 —— ' +
        '在「更换主程序…」里可以配成「用模拟器启动游戏本体」。',
      reasons: locale.reasons,
      action: 'pickExe'
    })
  }

  /* ---- is it telling us right now ---- */

  // Last in the code, first in the list. Everything above this point is inference from
  // what is on disk; this is the engine saying what went wrong, and when it is there it
  // is worth more than all the rest put together.
  checked.push('游戏此刻有没有弹出报错窗口')
  const windows = await readWindowsIn(game.dir)
  const dialog = windows ? pickErrorDialog(windows) : null
  if (dialog) {
    checks.push({
      code: 'error-dialog',
      severity: 'blocker',
      title: '游戏正弹着一个报错窗口',
      detail:
        '这是引擎自己给出的原因，比这里其它任何一条推断都可靠。' +
        (dialog.raw ? '原文是日文，被系统按中文代码页显示成了乱码，下面是还原后的。' : ''),
      reasons: dialog.title ? [`窗口标题：${dialog.title}`] : [],
      excerpt: dialog.raw ? `${dialog.message}\n\n（屏幕上显示的是：${dialog.raw}）` : dialog.message
    })
  }

  /* ---- did it write a log on the way down ---- */

  const logSince = since ?? game.lastLaunchedAt ?? 0
  if (logSince > 0) {
    checked.push('游戏这次有没有留下日志')
    const log = findFreshLog(game, logSince)
    if (log) {
      const tail = tailOf(log)
      checks.push({
        code: 'crash-log',
        severity: 'likely',
        title: '游戏留下了一份刚写的日志',
        detail: `${path.basename(log)} 是这次启动之后写的，末尾大概率就是它退出的原因。`,
        reasons: [log],
        action: 'openLog',
        actionPath: log,
        excerpt: tail ?? undefined
      })
    }
  }

  // Severity first, but the engine's own message outranks everything at the same level:
  // it is the only entry here that is a statement of fact rather than a deduction.
  const rank = (c: DiagnosisCheck): number =>
    SEVERITY_RANK[c.severity] * 10 + (c.code === 'error-dialog' ? 0 : 1)
  checks.sort((a, b) => rank(a) - rank(b))
  return base
}
