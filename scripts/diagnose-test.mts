import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  groupMissing,
  hasKana,
  isVirtualDll,
  JP_ERA_ENGINES,
  localeVerdict,
  logHintsFor,
  looksLikeMojibake,
  pickErrorDialog,
  runtimeFor,
  searchDirsFor,
  unmojibake,
  type ForeignWindow
} from '../src/main/diagnose-rules.ts'
import { readPe } from '../src/main/pe-imports.ts'
import { detectEngine, type DirEntry } from '../src/main/scan-core.ts'

/**
 * The launch diagnosis, judged on the cases where it must stay quiet.
 *
 * A diagnosis that cries wolf is worse than none: a player told their working game is
 * missing a runtime stops believing anything the feature says, and there is no winning
 * that trust back. So most of what follows is negative — the api-set names that are not
 * missing files, the ordinary filename that is not mojibake, the engine that does not
 * need a locale emulator.
 *
 * The PE parser is checked against real Windows binaries rather than a fixture. Nothing
 * is committed to the repository, and a parser that agrees with the actual loader on
 * files it has never seen is worth more than one that agrees with a sample I wrote.
 */

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const entries = (names: string[], dirs: string[] = []): DirEntry[] => [
  ...names.map((name) => ({ name, isDir: false, size: 1024 })),
  ...dirs.map((name) => ({ name, isDir: true, size: 0 }))
]

console.log('\n[1] 虚拟 DLL 绝不能报成缺失')

check('api-ms-win-crt-runtime 是 API set', isVirtualDll('api-ms-win-crt-runtime-l1-1-0.dll'))
check('api-ms-win-core-synch 是 API set', isVirtualDll('api-ms-win-core-synch-l1-1-0.dll'))
check('ext-ms-win-* 也是', isVirtualDll('ext-ms-win-ntuser-draw-l1-1-0.dll'))
check('kernel32 不是', !isVirtualDll('kernel32.dll'))
check('msvcp140 不是', !isVirtualDll('msvcp140.dll'))
// 名字里带 api 但不是 API set 契约的，不能被前缀误伤。
check('apisetstub.dll 不是', !isVirtualDll('apisetstub.dll'))

console.log('\n[2] 缺失的 DLL 要归到具体运行库')

check('msvcp140 → VC++ 2015-2022', runtimeFor('msvcp140.dll')?.key === 'vc2015')
check('vcruntime140_1 → VC++ 2015-2022', runtimeFor('vcruntime140_1.dll')?.key === 'vc2015')
check('msvcp140_atomic_wait → 同一份', runtimeFor('msvcp140_atomic_wait.dll')?.key === 'vc2015')
check('msvcr100 → VC++ 2010', runtimeFor('msvcr100.dll')?.key === 'vc2010')
check('msvcp120 → VC++ 2013', runtimeFor('msvcp120.dll')?.key === 'vc2013')
check('d3dx9_43 → DirectX', runtimeFor('d3dx9_43.dll')?.key === 'directx')
check('xinput1_3 → DirectX', runtimeFor('xinput1_3.dll')?.key === 'directx')
check('mfplat → Media Feature Pack', runtimeFor('mfplat.dll')?.key === 'mediafeature')
check('大小写无关', runtimeFor('MSVCP140.DLL')?.key === 'vc2015')
// 游戏自带的私有 DLL 不该被硬塞进某个运行库。
check('game_core.dll 不属于任何运行库', runtimeFor('game_core.dll') === null)
check('kernel32 不属于任何运行库', runtimeFor('kernel32.dll') === null)

{
  const { groups, unknown } = groupMissing([
    'msvcp140.dll',
    'vcruntime140.dll',
    'msvcr100.dll',
    'siglus_helper.dll'
  ])
  check('同一份运行库的多个 DLL 合成一条', groups.length === 2, `groups=${groups.length}`)
  const vc = groups.find((g) => g.pkg.key === 'vc2015')
  check('VC++ 2015 那条带两个 DLL', vc?.dlls.length === 2)
  check('认不出的单独列出', unknown.length === 1 && unknown[0] === 'siglus_helper.dll')
}

console.log('\n[3] 乱码识别 —— 正常文件名不许被冤枉')

check('典型 Shift-JIS 乱码', looksLikeMojibake('ƒAƒNƒVƒ‡ƒ“'))
check('替换字符也算', looksLikeMojibake('遊戯�'))
check('英文名不是乱码', !looksLikeMojibake('Ever17 The Out of Infinity.exe'))
check('中文名不是乱码', !looksLikeMojibake('示例游戏'))
check('正常日文名不是乱码', !looksLikeMojibake('サンプルゲーム.exe'))
// 一个孤立的可疑字符不足以定罪 —— 这正是误报的来源。
check('单个 ƒ 不算', !looksLikeMojibake('Café ƒ.exe'))
check('带破折号和省略号的正常名字不算', !looksLikeMojibake('Fate—stay night…special.exe'))

check('假名识别', hasKana('サンプル'))
check('汉字不算假名', !hasKana('漢字'))
check('英文不算假名', !hasKana('Ever17'))

console.log('\n[4] 区域模拟器判定要两个证据才开口')

check(
  '日文系统上永不建议',
  !localeVerdict({ acp: 932, engine: 'kirikiri', names: ['ƒAƒNƒV', 'ユース'] }).needed
)
check(
  '只有引擎老，不够',
  !localeVerdict({ acp: 936, engine: 'bgi', names: ['Game.exe', 'data.arc'] }).needed
)
check(
  '只有日文名，不够',
  !localeVerdict({ acp: 936, engine: 'unity', names: ['サンプル.exe'] }).needed
)
check(
  '老引擎 + 日文名 = 建议',
  localeVerdict({ acp: 936, engine: 'bgi', names: ['サンプル.exe'] }).needed
)
check(
  '乱码 + 老引擎 = 建议',
  localeVerdict({ acp: 936, engine: 'kirikiri', names: ['ƒAƒNƒVƒ‡ƒ“.xp3'] }).needed
)
check(
  'Unity 的日文游戏不建议装模拟器',
  !localeVerdict({ acp: 936, engine: 'unity', names: ['ゲーム.exe', 'ゲーム_Data'] }).needed
)
check('现代引擎不在日文时代名单里', !JP_ERA_ENGINES.has('unity') && !JP_ERA_ENGINES.has('renpy'))
check('KiriKiri 在名单里', JP_ERA_ENGINES.has('kirikiri'))

console.log('\n[5] 引擎识别')

check('Unity 靠同名 _Data 目录', detectEngine(entries([], ['Game_Data']), 'Game') === 'unity')
check(
  'Unity 也认 UnityPlayer.dll',
  detectEngine(entries(['UnityPlayer.dll'], []), 'Launcher') === 'unity'
)
check('KiriKiri 靠 .xp3', detectEngine(entries(['data.xp3']), 'krkr') === 'kirikiri')
check('BGI 靠 sysgrp.arc', detectEngine(entries(['sysgrp.arc', 'data01000.arc']), 'BGI') === 'bgi')
check('Ren’Py 靠 renpy 目录', detectEngine(entries([], ['renpy', 'game']), 'Game') === 'renpy')
check('RPG Maker MV 靠 www', detectEngine(entries([], ['www']), 'Game') === 'rpgmaker')
check('RPG Maker VX Ace 靠 rgss3a', detectEngine(entries(['Game.rgss3a']), 'Game') === 'rpgmaker')
check('Siglus 靠 Gameexe.dat', detectEngine(entries(['Gameexe.dat']), 'SiglusEngine') === 'siglus')
check('Artemis 靠 .pfs', detectEngine(entries(['root.pfs']), 'Game') === 'artemis')
check('NScripter 靠 nscript.dat', detectEngine(entries(['nscript.dat']), 'onscripter') === 'nscripter')
check('认不出来就是 null', detectEngine(entries(['readme.txt', 'Game.exe']), 'Game') === null)
// 0.txt 太普通，不能作为判据 —— 否则一堆文件夹会被认成 NScripter。
check('单个 0.txt 不算 NScripter', detectEngine(entries(['0.txt']), 'Game') === null)

console.log('\n[6] DLL 搜索路径')

{
  const dirs32 = searchDirsFor('C:\\g', 'x86', 'C:\\Windows', ['C:\\tools'])
  const dirs64 = searchDirsFor('C:\\g', 'x64', 'C:\\Windows', ['C:\\tools'])
  check('游戏目录排第一', dirs32[0] === 'C:\\g' && dirs64[0] === 'C:\\g')
  // 32 位进程访问 System32 会被重定向到 SysWOW64，查错地方会把系统 DLL 全报成缺失。
  check('32 位先查 SysWOW64', dirs32[1] === path.join('C:\\Windows', 'SysWOW64'))
  check('64 位先查 System32', dirs64[1] === path.join('C:\\Windows', 'System32'))
  check('PATH 排在最后', dirs32[dirs32.length - 1] === 'C:\\tools')
}

console.log('\n[7] 崩溃日志的位置')

check('Unity 要去 LocalLow 找', logHintsFor('unity').localLow)
check('其它引擎不去 LocalLow', !logHintsFor('kirikiri').localLow && !logHintsFor(null).localLow)
check('Ren’Py 认 traceback.txt', logHintsFor('renpy').inGameDir.some((re) => re.test('traceback.txt')))
check('通用规则认 error.log', logHintsFor(null).inGameDir.some((re) => re.test('error.log')))
check('通用规则不认随便一个 .log', !logHintsFor(null).inGameDir.some((re) => re.test('install.log')))

console.log('\n[8] PE 解析 —— 拿真实系统二进制验，仓库里不放样本')

{
  const notepad = 'C:\\Windows\\System32\\notepad.exe'
  const info = fs.existsSync(notepad) ? readPe(notepad) : null
  if (!info) {
    check('能读到 notepad.exe', false, '这台机器上没有，跳过')
  } else {
    check('架构判定为 x64', info.arch === 'x64', info.arch)
    check('不是 16 位', !info.is16bit)
    check('导入表读得出来', info.imports.length > 10, `${info.imports.length} 个`)
    check('导入里有 gdi32', info.imports.includes('gdi32.dll'))
    check('延迟导入读得出来', info.delayImports.length > 0)
    check('manifest 判定为不需要管理员', info.requiresAdmin === false)

    // 真正的意义所在：系统 DLL 必须全部能在搜索路径里找到。任何一个找不到，
    // 就说明搜索顺序写错了，而那会让每个游戏都报出一堆假的缺失。
    const windir = process.env.SystemRoot ?? 'C:\\Windows'
    const dirs = searchDirsFor(path.dirname(notepad), info.arch, windir, [])
    const missing = info.imports
      .filter((d) => !isVirtualDll(d))
      .filter((d) => !dirs.some((dir) => fs.existsSync(path.join(dir, d))))
    check('真实 DLL 一个都不缺', missing.length === 0, missing.join('、'))
  }
}

{
  const wow = 'C:\\Windows\\SysWOW64\\notepad.exe'
  if (fs.existsSync(wow)) {
    check('32 位版本判定为 x86', readPe(wow)?.arch === 'x86')
  } else {
    check('32 位版本判定为 x86', true, '这台机器上没有 SysWOW64，跳过')
  }
}

{
  // requireAdministrator 的正例。System32 里必有若干个。
  const admin = ['diskpart.exe', 'msconfig.exe', 'dcomcnfg.exe']
    .map((n) => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', n))
    .filter((p) => fs.existsSync(p))
  if (admin.length === 0) {
    check('能认出要求管理员权限的程序', true, '找不到样本，跳过')
  } else {
    check(
      '能认出要求管理员权限的程序',
      admin.every((p) => readPe(p)?.requiresAdmin === true),
      admin.map((p) => `${path.basename(p)}=${readPe(p)?.requiresAdmin}`).join(' ')
    )
  }
}

{
  const junk = path.join(os.tmpdir(), `diag-test-${process.pid}.bin`)
  fs.writeFileSync(junk, 'this is definitely not an executable')
  check('不是 PE 的文件返回 null', readPe(junk) === null)
  fs.rmSync(junk, { force: true })
  check('不存在的文件返回 null', readPe(path.join(os.tmpdir(), 'nope-' + Date.now())) === null)
}

console.log('\n[9] 乱码还原 —— 引擎的报错是日文，系统按中文码页显示')

{
  // 这两句是从一台 936 系统上的 BGI 引擎窗口里原样读出来的。
  const iplErr = '巜掕偝傟偨僼傽僀儖 [ bgi.exe : ipl._bp ] 偼懚嵼偟傑偣傫'
  const dvdErr = '岆摦嶌夞旔僼傽僀儖僟僂儞儘乕僪'
  check(
    '还原 BGI 的「找不到文件」',
    unmojibake(iplErr) === '指定されたファイル [ bgi.exe : ipl._bp ] は存在しません',
    String(unmojibake(iplErr))
  )
  check('还原 BGI 的「误动作回避」', unmojibake(dvdErr) === '誤動作回避ファイルダウンロード', String(unmojibake(dvdErr)))

  // 反例才是关键：不该动的一律返回 null，宁可让人看原文也不能改坏。
  check('正常日文不动它', unmojibake('ゲームを起動できません') === null)
  check('正常中文不动它', unmojibake('无法启动游戏') === null)
  check('英文不动它', unmojibake('Cannot open data file') === null)
  check('空串不动它', unmojibake('') === null)
  check('纯数字符号不动它', unmojibake('[ 12345 ] $0000') === null)
  // 中文句子若被硬解成 Shift-JIS 会出一堆假名碎片，必须被守卫拦下。
  check('中文长句不动它', unmojibake('这个游戏无法正常启动请检查安装目录') === null)
}

console.log('\n[10] 报错窗口的挑选')

{
  const dlg = (className: string, title: string, controls: string[]): ForeignWindow => ({
    className,
    title,
    controls
  })

  const stuck = [
    dlg('BGI - Main window', 'Ethornell - BURIKO General Interpreter', []),
    dlg('#32770', 'Error!!', ['确定', '巜掕偝傟偨僼傽僀儖 [ bgi.exe : ipl._bp ] 偼懚嵼偟傑偣傫'])
  ]
  const found = pickErrorDialog(stuck)
  check('从一堆窗口里挑出对话框', found !== null)
  check('挑的是正文不是按钮', found?.message.includes('存在しません') === true, found?.message)
  check('顺手把乱码还原了', found?.message.includes('指定された') === true)
  check('原样也留着', found?.raw?.includes('巜掕') === true)
  check('带上窗口标题', found?.title === 'Error!!')

  check('只有主窗口时不报', pickErrorDialog([dlg('BGI - Main window', 'Ethornell', [])]) === null)
  check('没有窗口时不报', pickErrorDialog([]) === null)
  // 空对话框没有可说的，不该硬凑一条结论出来。
  check('对话框没文字时不报', pickErrorDialog([dlg('#32770', '', ['确定'])]) === null)
  check(
    '自定义类名的报错框也认',
    pickErrorDialog([dlg('ErrorMessageBoxClass', 'BGI', ['磁盘读取失败'])])?.message === '磁盘读取失败'
  )
  check(
    '游戏自己的窗口类不会被当成对话框',
    pickErrorDialog([dlg('BAIDU_CLASS_IME_87C946A9', 'stateBar', ['输入法'])]) === null
  )
}

console.log('\n[11] 端到端 —— 造一个真起不来的游戏，跑完整诊断')

/**
 * Make an executable that genuinely cannot load.
 *
 * A real binary with one import name overwritten in place, same bytes or fewer plus a
 * NUL. The result is a file Windows would actually refuse to start, which is the only
 * fixture worth testing against — a hand-rolled fake PE would only prove the parser
 * agrees with my idea of one.
 */
function breakImport(source: string, dest: string, victim: string, replacement: string): boolean {
  const buf = fs.readFileSync(source)
  const at = buf.indexOf(Buffer.from(victim + '\0', 'latin1'))
  if (at < 0 || replacement.length >= victim.length) return false
  buf.fill(0, at, at + victim.length + 1)
  buf.write(replacement, at, 'latin1')
  fs.writeFileSync(dest, buf)
  return true
}

/** Everything about a folder that a read-only operation must leave alone. */
function snapshot(dir: string): string {
  const out: string[] = []
  const walk = (cur: string): void => {
    for (const d of fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const full = path.join(cur, d.name)
      if (d.isDirectory()) {
        out.push(`D ${path.relative(dir, full)}`)
        walk(full)
      } else {
        const st = fs.statSync(full)
        out.push(`F ${path.relative(dir, full)} ${st.size} ${st.mtimeMs}`)
      }
    }
  }
  walk(dir)
  return out.join('\n')
}

{
  const { diagnoseGame } = await import('../src/main/diagnose.ts')
  const source = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-e2e-'))

  const gameDir = path.join(root, 'サンプル')
  fs.mkdirSync(gameDir)
  const exe = path.join(gameDir, 'Game.exe')
  // KiriKiri 布局，配上一个日文目录名 —— 顺带把区域模拟器那条规则也拉进来。
  fs.writeFileSync(path.join(gameDir, 'data.xp3'), 'x'.repeat(4096))

  const game = {
    id: 'test',
    name: 'サンプル',
    dir: gameDir,
    exe,
    kind: 'installed',
    sizeBytes: 4096,
    iconPath: null,
    coverPath: null,
    groupId: null,
    order: 0,
    wishlist: false,
    playing: false,
    played: false,
    tier: null,
    tierOrder: 0,
    rating: null,
    tags: [],
    lastLaunchedAt: null,
    launchCount: 0,
    playtimeMs: 0,
    sessions: [],
    mtimeMs: 0,
    childCount: 2
  }

  // 缺一个能映射到具体运行库的 DLL。挑 d3dx9_00 是因为它确定不存在 ——
  // D3DX9 的真实版本号从 24 起，而 msvcr100 这类在装过 VC++ 运行库的机器上是有的，
  // 拿它做样本会让这个测试在一部分机器上假通过。
  const broke =
    fs.existsSync(source) &&
    breakImport(source, exe, 'api-ms-win-crt-runtime-l1-1-0.dll', 'd3dx9_00.dll')

  if (!broke) {
    check('能造出缺 DLL 的可执行文件', false, '找不到 notepad.exe 或没有可替换的导入名')
  } else {
    const before = snapshot(gameDir)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await diagnoseGame(game as any)

    const codes = result.checks.map((c) => c.code)
    check('认出缺运行库', codes.includes('missing-runtime'), codes.join(','))
    const runtime = result.checks.find((c) => c.code === 'missing-runtime')
    check('指名 DirectX 运行库', runtime?.title.includes('DirectX') === true, runtime?.title)
    check('依据里写明缺哪个 DLL', runtime?.reasons.join(' ').includes('d3dx9_00.dll') === true)
    check('缺运行库算拦路', runtime?.severity === 'blocker')
    check('引擎认出是 KiriKiri', result.engine === 'kirikiri', String(result.engine))
    check('拦路的排在最前', result.checks[0]?.severity === 'blocker')
    check('checked 里记下了查过什么', result.checked.length >= 4, `${result.checked.length} 项`)

    // 这一条是整个功能的安全底线：诊断只读，不许碰游戏文件夹。
    check('诊断没有改动游戏文件夹', snapshot(gameDir) === before)

    // 干净的可执行文件不许报出任何 blocker —— 误报比不报更伤。
    const cleanDir = path.join(root, 'Clean Game')
    fs.mkdirSync(cleanDir)
    const cleanExe = path.join(cleanDir, 'Clean Game.exe')
    fs.copyFileSync(source, cleanExe)
    const clean = await diagnoseGame({
      ...game,
      id: 'clean',
      name: 'Clean Game',
      dir: cleanDir,
      exe: cleanExe
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    check(
      '正常的游戏不报任何拦路项',
      clean.checks.every((c) => c.severity !== 'blocker'),
      clean.checks.map((c) => `${c.code}/${c.severity}`).join(',')
    )
    check(
      '正常的游戏也不建议区域模拟器',
      !clean.checks.some((c) => c.code === 'needs-locale'),
      clean.checks.map((c) => c.code).join(',')
    )
  }

  fs.rmSync(root, { recursive: true, force: true })
}

console.log(`\n${pass} 通过 · ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
