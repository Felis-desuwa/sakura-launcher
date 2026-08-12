/**
 * Which executable starts the game — classification and ranking, without the app.
 * scan-core has no electron import, so it runs straight under node.
 *
 * The main fixture is the file listing of a real release, with the title replaced by a
 * placeholder: twelve executables in one folder — engine, two uninstallers, a dated
 * translation patch, a NoDVD build, two settings tools and a locale emulator. Exactly
 * the case a user cannot resolve by looking. The listing is written out here rather than
 * read from disk, so the test needs no game installed and names nobody's library.
 */
import {
  classifyExes,
  exeKindOf,
  parseSidecar,
  rankExes,
  renderSidecar,
  splitArgs,
  type DirEntry,
  type ExeKind
} from '../src/main/scan-core.ts'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const MB = 1024 * 1024
const file = (name: string, mb: number): DirEntry => ({ name, isDir: false, size: mb * MB })
const dir = (name: string): DirEntry => ({ name, isDir: true, size: 0 })

// ---------------------------------------------------------------- a real folder ----

console.log('\nサンプルゲーム —— 12 个 exe 的分类')

// Only the last segment matters — it is what the folder-name heuristic compares against.
const SAMPLE_DIR = 'D:\\games\\[110101][サークル] サンプルゲーム\\示例游戏'
const eustia: DirEntry[] = [
  file('BGI.exe', 4.3),
  file('BGI_CHS_130321.exe', 0.04),
  file('BHVC.exe', 0.04),
  file('ESUforGame.exe', 0.95),
  file('ISESUforGame.exe', 1.05),
  file('NTLEA.exe', 0.17),
  file('ntleac.exe', 0.01),
  file('PCInformationViewer.exe', 0.8),
  file('Uninstaller.exe', 0.92),
  file('uninst_cn.exe', 0.62),
  file('サンプルゲーム NoDVD.EXE', 0.02),
  dir('backup')
]

const verdicts = classifyExes(SAMPLE_DIR, eustia)
const kindOf = (name: string): ExeKind | undefined =>
  verdicts.find((v) => v.name === name)?.kind

check('每个 exe 都有判定', verdicts.length === 11, `${verdicts.length} 条`)

const expected: [string, ExeKind][] = [
  ['BGI.exe', 'main'],
  ['BHVC.exe', 'main'],
  ['NTLEA.exe', 'locale'],
  ['ntleac.exe', 'locale'],
  // Not locale emulators despite the name: their version resources read
  // 環境設定ツール / 初期画面設定ツール, company BURIKO — the engine's own utilities.
  ['ESUforGame.exe', 'tool'],
  ['ISESUforGame.exe', 'tool'],
  ['PCInformationViewer.exe', 'tool'],
  ['BGI_CHS_130321.exe', 'patch'],
  ['サンプルゲーム NoDVD.EXE', 'patch'],
  ['Uninstaller.exe', 'uninstall'],
  ['uninst_cn.exe', 'uninstall']
]
for (const [name, want] of expected) {
  check(`${name} → ${want}`, kindOf(name) === want, kindOf(name) ?? '没有判定')
}

const ranked = rankExes(SAMPLE_DIR, eustia)
check('排第一的是引擎主程序', ranked[0]?.name === 'BGI.exe', ranked[0]?.name ?? '空')
check(
  '卸载程序被排除在候选之外',
  !ranked.some((r) => /unins/i.test(r.name)),
  ranked.map((r) => r.name).join(', ')
)
check(
  '区域模拟器不参与主程序竞争',
  !ranked.some((r) => /ntlea/i.test(r.name)),
  ranked.map((r) => r.name).join(', ')
)

const bgi = verdicts.find((v) => v.name === 'BGI.exe')
check(
  'BGI.exe 说得出自己凭什么排第一',
  !!bgi && bgi.reasons.some((r) => r.includes('体积最大')),
  bgi?.reasons.join(' · ') ?? '没有理由'
)

// ------------------------------------------------- ranking is unchanged ----

console.log('\n既有形态的挑选结果没有被这次重构改动')

const unity: DirEntry[] = [
  file('MyGame.exe', 0.6),
  file('UnityCrashHandler64.exe', 1.2),
  dir('MyGame_Data')
]
check(
  'Unity：同名 _Data 目录压倒体积',
  rankExes('X:\\games\\Whatever', unity)[0]?.name === 'MyGame.exe',
  rankExes('X:\\games\\Whatever', unity)[0]?.name ?? '空'
)

const rpg: DirEntry[] = [file('Game.exe', 0.5), file('nw.exe', 1.4), dir('www')]
check(
  'RPG Maker：Game.exe 胜过更大的 nw.exe',
  rankExes('X:\\games\\Some RPG', rpg)[0]?.name === 'Game.exe',
  rankExes('X:\\games\\Some RPG', rpg)[0]?.name ?? '空'
)

const renpy: DirEntry[] = [file('TheStory.exe', 0.3), dir('renpy'), dir('game')]
check(
  "Ren'Py：认出唯一的主程序",
  rankExes('X:\\games\\TheStory', renpy)[0]?.name === 'TheStory.exe',
  rankExes('X:\\games\\TheStory', renpy)[0]?.name ?? '空'
)

const onlyWeak: DirEntry[] = [file('launcher.exe', 0.4), file('setup.exe', 2)]
check(
  '只剩弱候选时仍然给得出一个',
  rankExes('X:\\games\\Thing', onlyWeak)[0]?.name === 'launcher.exe',
  rankExes('X:\\games\\Thing', onlyWeak)[0]?.name ?? '空'
)

const nothing: DirEntry[] = [file('unins000.exe', 1), file('vcredist_x86.exe', 4)]
check('全是黑名单时不硬凑一个', rankExes('X:\\games\\Empty', nothing).length === 0)

check('folder-name match still counts', exeKindOf('SomeGame') === 'main')

// -------------------------------------------------------- launch arguments ----

console.log('\n组合启动的参数')

check('带空格的目标仍是一个参数', splitArgs('"C:\\a b\\game.exe"').length === 1, splitArgs('"C:\\a b\\game.exe"').join(' | '))
check('两个参数拆成两项', splitArgs('-applaunch 123').join('|') === '-applaunch|123')
check('多余空白不产生空参数', splitArgs('  -a   -b  ').join('|') === '-a|-b')
check('空串给出空数组', splitArgs('').length === 0)

// ------------------------------------------------------ sidecar round-trip ----

console.log('\n主程序写进 sakura-launcher.md 再读回来')

const withExe = renderSidecar({
  name: 'サンプルゲーム',
  exe: 'NTLEA.exe',
  launchArgs: ['C:\\games\\a b\\BGI.exe']
})
const back = parseSidecar(withExe)
check('主程序读得回来', back.exe === 'NTLEA.exe', back.exe ?? '没有')
check(
  '带空格的参数没有被拆开',
  back.launchArgs?.length === 1 && back.launchArgs[0] === 'C:\\games\\a b\\BGI.exe',
  JSON.stringify(back.launchArgs)
)

const withoutExe = parseSidecar(renderSidecar({ name: '别的游戏' }))
check('没人工选过就不写这一行', withoutExe.exe === undefined, String(withoutExe.exe))

console.log(`\n${pass} 通过 · ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
