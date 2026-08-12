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
import { t } from './i18n.ts'
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
      title: t('diag.noExe.title'),
      detail: t('diag.noExe.detail'),
      reasons: [],
      action: 'pickExe'
    })
    return base
  }

  if (!fs.existsSync(game.exe)) {
    checks.push({
      code: 'exe-missing',
      severity: 'blocker',
      title: t('diag.exeGone.title'),
      detail: t('diag.exeGone.detail', { exe: game.exe }),
      reasons: [],
      action: 'revealDir',
      actionPath: game.dir
    })
    return base
  }

  const exeDir = path.dirname(game.exe)
  const pe = readPe(game.exe)
  checked.push(t('diag.checked.readable'))

  if (!pe) {
    checks.push({
      code: 'bad-arch',
      severity: 'blocker',
      title: t('diag.notExe.title'),
      detail: t('diag.notExe.detail'),
      reasons: [],
      action: 'pickExe'
    })
    return base
  }

  base.arch = pe.is16bit ? t('diag.arch16') : pe.arch

  if (pe.is16bit) {
    checks.push({
      code: 'bad-arch',
      severity: 'blocker',
      title: t('diag.bit16.title'),
      detail: t('diag.bit16.detail'),
      reasons: [t('diag.bit16.reason')],
      action: 'revealDir',
      actionPath: game.dir
    })
    return base
  }

  if (pe.arch === 'arm' || pe.arch === 'arm64') {
    checks.push({
      code: 'bad-arch',
      severity: 'blocker',
      title: t('diag.badArch.title', { arch: pe.arch.toUpperCase() }),
      detail: t('diag.badArch.detail'),
      reasons: [t('diag.badArch.reason', { arch: pe.arch })]
    })
  }

  /* ---- missing runtimes ---- */

  const windir = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const searchDirs = searchDirsFor(exeDir, pe.arch, windir, pathEntries)

  const realImports = pe.imports.filter((d) => !isVirtualDll(d))
  const missing = realImports.filter((d) => !dllResolves(d, searchDirs, exeDir))
  checked.push(t('diag.checked.dlls', { n: realImports.length }))

  if (missing.length > 0) {
    const { groups, unknown } = groupMissing(missing)
    for (const group of groups) {
      checks.push({
        code: 'missing-runtime',
        severity: 'blocker',
        title: t('diag.missingRuntime.title', { pkg: t(group.pkg.labelKey) }),
        detail: (() => {
          const note = t(group.pkg.noteKey)
          const fix = t('diag.missingRuntime.detail')
          return note ? t('diag.joinSentence', { a: note, b: fix }) : fix
        })(),
        reasons: [t('diag.notFound', { names: group.dlls.join('、') })]
      })
    }
    if (unknown.length > 0) {
      checks.push({
        code: 'missing-dll',
        severity: 'blocker',
        title: t('diag.missingDll.title'),
        detail: t('diag.missingDll.detail'),
        reasons: [t('diag.notFound', { names: unknown.join('、') })],
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
      title: t('diag.delayMissing.title'),
      detail: t('diag.delayMissing.detail'),
      reasons: [missingDelay.join('、')]
    })
  }

  /* ---- elevation ---- */

  checked.push(t('diag.checked.admin'))
  if (pe.requiresAdmin === true) {
    checks.push({
      code: 'needs-admin',
      severity: 'likely',
      title: t('diag.needsAdmin.title'),
      detail: t('diag.needsAdmin.detail'),
      reasons: [t('diag.needsAdmin.reason')],
      action: 'runAsAdmin'
    })
  }

  /* ---- did they pick the right executable ---- */

  checked.push(t('diag.checked.rightExe'))
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
      title: t('diag.wrongExe.title'),
      detail: t('diag.wrongExe.detail', {
        name: mine.name,
        kind: t(
          mine.kind === 'uninstall'
            ? 'diag.wrongExe.uninstaller'
            : mine.kind === 'patch'
              ? 'diag.wrongExe.patch'
              : 'diag.wrongExe.tool'
        )
      }),
      reasons: mine.reasons.length > 0 ? mine.reasons : [t('diag.wrongExe.fallbackReason')],
      action: 'pickExe'
    })
  } else if (mine?.kind === 'locale' && (game.launchArgs?.length ?? 0) === 0) {
    // A locale emulator *is* a legitimate choice — but only when it was told what to run.
    checks.push({
      code: 'wrong-exe',
      severity: 'likely',
      title: t('diag.localeNoArgs.title'),
      detail: t('diag.localeNoArgs.detail', { name: mine.name }),
      reasons: [t('diag.localeNoArgs.reason')],
      action: 'pickExe'
    })
  }

  /* ---- locale emulator ---- */

  const acp = await readAcp()
  checked.push(t('diag.checked.codepage'))
  const names = [path.basename(game.dir), path.basename(game.exe), ...entries.map((e) => e.name)]
  const locale = localeVerdict({ acp, engine, names })
  if (locale.needed) {
    checks.push({
      code: 'needs-locale',
      severity: 'likely',
      title: t('diag.needsLocale.title'),
      detail: t('diag.needsLocale.detail'),
      reasons: locale.reasons,
      action: 'pickExe'
    })
  }

  /* ---- is it telling us right now ---- */

  // Last in the code, first in the list. Everything above this point is inference from
  // what is on disk; this is the engine saying what went wrong, and when it is there it
  // is worth more than all the rest put together.
  checked.push(t('diag.checked.dialog'))
  const windows = await readWindowsIn(game.dir)
  const dialog = windows ? pickErrorDialog(windows) : null
  if (dialog) {
    checks.push({
      code: 'error-dialog',
      severity: 'blocker',
      title: t('diag.errorDialog.title'),
      detail:
        t('diag.errorDialog.detail') + (dialog.raw ? t('diag.errorDialog.mojibakeNote') : ''),
      reasons: dialog.title ? [t('diag.errorDialog.windowTitle', { title: dialog.title })] : [],
      excerpt: dialog.raw
        ? t('diag.errorDialog.excerpt', { message: dialog.message, raw: dialog.raw })
        : dialog.message
    })
  }

  /* ---- did it write a log on the way down ---- */

  const logSince = since ?? game.lastLaunchedAt ?? 0
  if (logSince > 0) {
    checked.push(t('diag.checked.log'))
    const log = findFreshLog(game, logSince)
    if (log) {
      const tail = tailOf(log)
      checks.push({
        code: 'crash-log',
        severity: 'likely',
        title: t('diag.crashLog.title'),
        detail: t('diag.crashLog.detail', { file: path.basename(log) }),
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
