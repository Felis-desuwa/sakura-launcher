/**
 * Checks the parts of downloading that do not need a window or a network: which links
 * are accepted, what command line each downloader is given, and when a folder is judged
 * to have finished receiving a download.
 *
 * Run with `npm run downloader-test` (Node's own TypeScript stripping, no build step).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  archiveSets,
  buildCommand,
  buildCustomArgs,
  checkUrl,
  disownFiles,
  firstVolumeOf,
  isInProgressFile,
  newWatchState,
  parseAria2Percent,
  pollFolder,
  STABLE_TICKS,
  type FolderEntry
} from '../src/main/download-core.ts'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++
  else failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function section(title: string): void {
  console.log(`\n— ${title} —`)
}

/* ---------------------------------------------------------------- URL checking */

section('链接校验')

for (const url of [
  'http://example.com/game.7z',
  'https://example.com/a/b/game.part1.rar',
  'ftp://example.com/game.zip'
]) {
  check(`接受 ${url.split(':')[0]}`, checkUrl(url).ok, url)
}

for (const [url, why] of [
  ['file:///C:/Windows/System32/calc.exe', '本地文件'],
  ['javascript:alert(1)', '脚本'],
  ['magnet:?xt=urn:btih:abc', '磁力链'],
  ['thunder://QUFo', '迅雷专用链'],
  ['data:text/html,<h1>x', 'data URL'],
  ['不是链接', '纯文本'],
  ['   ', '空白']
] as [string, string][]) {
  const result = checkUrl(url)
  check(`拒绝${why}`, !result.ok, result.error ?? '竟然通过了')
}

check(
  '从路径推断文件名',
  checkUrl('https://example.com/dl/%E6%B8%B8%E6%88%8F.7z.001').name === '游戏.7z.001',
  String(checkUrl('https://example.com/dl/%E6%B8%B8%E6%88%8F.7z.001').name)
)
check(
  '没有文件名时不硬凑',
  checkUrl('https://example.com/download?id=42').name === undefined,
  String(checkUrl('https://example.com/download?id=42').name)
)
check(
  '带路径分隔符的名字被丢弃',
  checkUrl('https://example.com/a/..%2Fevil.exe').name === undefined,
  String(checkUrl('https://example.com/a/..%2Fevil.exe').name)
)

/* ------------------------------------------------------------ command building */

section('命令行构造')

const job = { url: 'https://example.com/g.7z', dir: 'D:\\Games Library', name: 'g.7z' }

const idm = buildCommand('idm', 'C:\\IDM\\IDMan.exe', '', job)
check('IDM 用 /d /p /f /n', idm !== null && idm.args.join(' ') === `/d ${job.url} /p ${job.dir} /f g.7z /n`, idm?.args.join(' '))
check('IDM 未指定路径时构造不出命令', buildCommand('idm', null, '', job) === null)

const aria = buildCommand('aria2', 'aria2c.exe', '', job)
check('aria2 指定目录与文件名', aria !== null && aria.args.includes('-d') && aria.args.includes(job.dir), aria?.args.join(' '))

check('系统默认没有自己的命令', buildCommand('system', null, '', job) === null)

// The point of splitting first and substituting after.
const nasty = {
  url: 'https://example.com/a b.7z" --output=C:\\evil',
  dir: 'D:\\Games Library',
  name: 'x.7z'
}
const custom = buildCustomArgs('{url} -o {dir}', nasty)
check(
  '含空格和引号的链接仍是单个参数',
  custom.length === 3 && custom[0] === nasty.url,
  `${custom.length} 个参数：${JSON.stringify(custom)}`
)
check('带空格的目录不会被拆开', custom[2] === nasty.dir, custom[2])
check(
  '模板里的多余空白不产生空参数',
  buildCustomArgs('  {url}    -d   {dir}  ', nasty).length === 3
)

/* -------------------------------------------------------------- aria2 progress */

section('aria2 进度解析')

check(
  '取最后一个百分比',
  parseAria2Percent('[#1 1MiB/10MiB(10%)] [#1 4MiB/10MiB(42%)]') === 42,
  String(parseAria2Percent('[#1 1MiB/10MiB(10%)] [#1 4MiB/10MiB(42%)]'))
)
check('没有百分比时返回 null', parseAria2Percent('nothing here') === null)

/* --------------------------------------------------------------- watching */

section('下载完成判定')

for (const name of ['a.7z.part', 'b.zip.tmp', 'c.rar.crdownload', 'd.7z.aria2', 'e.exe.td']) {
  check(`识别在途文件 ${name}`, isInProgressFile(name))
}
check('正常文件不算在途', !isInProgressFile('game.7z.001'))

const entry = (name: string, size: number, mtimeMs = 1000): FolderEntry => ({ name, size, mtimeMs })

/** Feed the same listing in repeatedly, the way the real poller would. */
function poll(state: ReturnType<typeof newWatchState>, entries: FolderEntry[], times: number) {
  let last = { done: [] as string[], active: true }
  for (let i = 0; i < times; i++) last = pollFolder(state, entries)
  return last
}

{
  const state = newWatchState(['old.zip'])
  const result = poll(state, [entry('old.zip', 100)], STABLE_TICKS + 2)
  check('只有开始前就有的文件时不触发', result.done.length === 0)
}

{
  const state = newWatchState([])
  const result = poll(state, [entry('game.7z.part', 500)], STABLE_TICKS + 2)
  check('在途文件不会被当成完成', result.done.length === 0 && result.active)
}

{
  const state = newWatchState([])
  // Size still climbing: never stable, so never done.
  let result = { done: [] as string[], active: true }
  for (let i = 1; i <= STABLE_TICKS + 3; i++) result = pollFolder(state, [entry('game.zip', i * 1000)])
  check('体积还在涨就不算稳定', result.done.length === 0)
}

{
  const state = newWatchState([])
  const result = poll(state, [entry('game.zip', 4096)], STABLE_TICKS)
  check('单个文件稳定后触发', result.done.join(',') === 'game.zip', result.done.join(','))
}

{
  const state = newWatchState([])
  // Two of three volumes present and stable — the set is incomplete, but nothing tells
  // us a third is coming, so this is the case the largest-group rule has to handle.
  poll(state, [entry('g.7z.001', 100), entry('g.7z.002', 100)], STABLE_TICKS)
  const result = poll(
    state,
    [entry('g.7z.001', 100), entry('g.7z.002', 100), entry('g.7z.003', 100)],
    STABLE_TICKS
  )
  check(
    '分卷齐了才一起交出',
    result.done.join(',') === 'g.7z.001,g.7z.002,g.7z.003',
    result.done.join(',')
  )
}

{
  const state = newWatchState([])
  // A late-arriving volume resets the picture: the new file is not stable yet.
  poll(state, [entry('g.7z.001', 100)], STABLE_TICKS)
  const result = pollFolder(state, [entry('g.7z.001', 100), entry('g.7z.002', 50)])
  check('新分卷出现时不再判定为完成', result.done.length === 0 && result.active)
}

{
  const state = newWatchState(['unrelated.zip'])
  const result = poll(
    state,
    [entry('unrelated.zip', 9), entry('g.7z.001', 100), entry('g.7z.002', 100)],
    STABLE_TICKS
  )
  check(
    '开始前就存在的压缩包不混进来',
    result.done.join(',') === 'g.7z.001,g.7z.002',
    result.done.join(',')
  )
}

check('分卷取第一卷', firstVolumeOf(['g.7z.003', 'g.7z.001', 'g.7z.002']) === 'g.7z.001')
check('没有压缩包时没有第一卷', firstVolumeOf(['setup.exe', 'readme.txt']) === null)

/* --------------------------------------------------------- one set or several */

section('分卷与分包的区别')

check(
  '分卷是一套',
  archiveSets(['g.7z.001', 'g.7z.003', 'g.7z.002']).length === 1,
  JSON.stringify(archiveSets(['g.7z.001', 'g.7z.003', 'g.7z.002']))
)
check(
  '一套分卷按卷序交出',
  archiveSets(['g.7z.003', 'g.7z.001', 'g.7z.002'])[0].join(',') === 'g.7z.001,g.7z.002,g.7z.003'
)
check('partN.rar 也是一套', archiveSets(['g.part1.rar', 'g.part2.rar']).length === 1)

{
  // The shape that started this: one release arriving as a body plus five appendices,
  // every one of them a complete archive of its own.
  const shipped = [
    'サンプルゲーム 本体.rar',
    'サンプルゲーム 追加1.rar',
    'サンプルゲーム 追加2.rar',
    'サンプルゲーム 追加3.rar',
    'サンプルゲーム 特典.rar',
    'サンプルゲーム 修正.rar'
  ]
  const sets = archiveSets(shipped)
  check('六个独立压缩包是六套', sets.length === 6, String(sets.length))
  check('每套都只有一卷', sets.every((s) => s.length === 1))
}

{
  const mixed = archiveSets(['g.7z.001', 'g.7z.002', 'readme.zip'])
  check('分卷与另一个包是两套', mixed.length === 2, String(mixed.length))
  check('大的一套排在前面', mixed[0].length === 2, JSON.stringify(mixed[0]))
}

check('没有压缩包就没有分套', archiveSets(['setup.exe', 'readme.txt']).length === 0)

{
  const state = newWatchState([])
  const result = poll(state, [entry('a.zip', 10), entry('b.zip', 20)], STABLE_TICKS)
  check(
    '判定结果里带上了所有分套',
    result.sets !== undefined && result.sets.length === 2,
    String(result.sets?.length)
  )
  check('done 仍然只是其中一套', result.done.length === 1, result.done.join(','))
}

/* ------------------------------------------------- two downloads, one folder */

section('同一文件夹里的两个任务')

{
  // The bug this exists for: B starts while A is still downloading into its own temp
  // directory, so A's finished archive is in nobody's baseline and looks like B's.
  const a = newWatchState([])
  const b = newWatchState(['b.7z.part'])

  const both = [entry('a.7z', 100), entry('b.7z', 200)]
  const forA = poll(a, both, STABLE_TICKS)
  check('先落盘的一方按最大分组规则拿到了两个候选之一', forA.done.length === 1, forA.done.join(','))

  // Without the claim, B settles on whatever group sorts first — which is A's.
  const naive = newWatchState(['b.7z.part'])
  check(
    '不通知就会抢走别人的包',
    poll(naive, both, STABLE_TICKS).done.join(',') === 'a.7z',
    poll(newWatchState(['b.7z.part']), both, STABLE_TICKS).done.join(',')
  )

  disownFiles(b, forA.done)
  const forB = poll(b, both, STABLE_TICKS)
  check('认领之后各拿各的', forB.done.join(',') === 'b.7z', forB.done.join(','))
  check('两边没有交集', forA.done.every((n) => !forB.done.includes(n)))
}

{
  // Claiming mid-flight must also drop what the poller had already counted ticks for.
  const state = newWatchState([])
  poll(state, [entry('mine.zip', 10), entry('theirs.zip', 20)], STABLE_TICKS - 1)
  disownFiles(state, ['theirs.zip'])
  const result = poll(state, [entry('mine.zip', 10), entry('theirs.zip', 20)], STABLE_TICKS)
  check('半路认领会清掉已经攒下的稳定计数', result.done.join(',') === 'mine.zip', result.done.join(','))
}

{
  const state = newWatchState([])
  disownFiles(state, ['g.7z.001'])
  const result = poll(state, [entry('g.7z.001', 100), entry('g.7z.002', 100)], STABLE_TICKS)
  check('被认领的分卷不会再被当作自己的', result.done.join(',') === 'g.7z.002', result.done.join(','))
}

/* ------------------------------------------------------------ against real files */

section('真实文件夹')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-dl-'))
try {
  fs.writeFileSync(path.join(tmp, 'before.txt'), 'x')
  const { listFiles } = await import('../src/main/download-core.ts')
  const baseline = listFiles(tmp).map((f) => f.name)
  check('拍到基线快照', baseline.join(',') === 'before.txt', baseline.join(','))

  fs.writeFileSync(path.join(tmp, 'new.zip'), Buffer.alloc(2048))
  const state = newWatchState(baseline)
  const result = poll(state, listFiles(tmp), STABLE_TICKS)
  check('真实目录里认出新文件', result.done.join(',') === 'new.zip', result.done.join(','))

  check('读取不存在的目录不抛错', listFiles(path.join(tmp, 'nope')).length === 0)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${passed} 通过 · ${failed} 失败`)
process.exit(failed > 0 ? 1 : 0)
