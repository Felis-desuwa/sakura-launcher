/**
 * Round-trip the Markdown sidecar without launching the app.
 * scan-core has no electron import, so it runs straight under node.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  LEGACY_SIDECAR,
  parseSidecar,
  readSidecar,
  readSidecarName,
  removeSidecar,
  renderSidecar,
  SIDECAR,
  writeSidecar,
  writeSidecarIfChanged,
  type SidecarData
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-sidecar-'))

const full: SidecarData = {
  name: '某某游戏～魔法のチカラで～',
  wishlist: false,
  playing: true,
  played: true,
  rating: 4,
  tier: 'T1',
  tags: ['战棋', '已打汉化补丁'],
  playtimeMs: (12 * 60 + 34) * 60_000,
  launchCount: 8,
  lastLaunchedAt: new Date(2026, 7, 5, 21, 30).getTime(),
  sessions: [
    { startedAt: new Date(2026, 7, 5, 21, 30).getTime(), ms: (2 * 60 + 10) * 60_000 },
    { startedAt: new Date(2026, 7, 3, 19, 2).getTime(), ms: 45 * 60_000 }
  ]
}

console.log('\n— 完整往返 —')
const back = parseSidecar(renderSidecar(full))
check('显示名称', back.name === full.name, back.name)
check('状态', back.playing === true && back.played === true && back.wishlist === false)
check('评分', back.rating === 4, String(back.rating))
check('评级', back.tier === 'T1', String(back.tier))
check('标签', JSON.stringify(back.tags) === JSON.stringify(full.tags), String(back.tags))
check('总时长', back.playtimeMs === full.playtimeMs, `${back.playtimeMs} vs ${full.playtimeMs}`)
check('启动次数', back.launchCount === 8, String(back.launchCount))
check('最后游玩', back.lastLaunchedAt === full.lastLaunchedAt)
check(
  '游玩记录',
  JSON.stringify(back.sessions) === JSON.stringify(full.sessions),
  `${back.sessions?.length ?? 0} 条`
)

console.log('\n— 手改容错 —')
const handEdited = `# 《随便写的》

- 显示名称：手改过的名字
- 状态： 想玩
- 评分: ★★★☆☆
- 评级 = t0
- 标签：галка，第二个、第三个
- 总时长: 90 分
- 启动次数: 3
`
const hand = parseSidecar(handEdited)
check('全角冒号', hand.name === '手改过的名字', String(hand.name))
check('状态只写一个', hand.wishlist === true && hand.playing === false)
check('只写星星没写数字', hand.rating === 3, String(hand.rating))
check('小写 tier 归一化', hand.tier === 'T0', String(hand.tier))
check('等号形式 + 混合分隔符', hand.tags?.length === 3, JSON.stringify(hand.tags))
check('纯分钟时长', hand.playtimeMs === 90 * 60_000, String(hand.playtimeMs))
check('缺失的键不产生字段', hand.lastLaunchedAt === undefined && hand.sessions === undefined)

const bogusTier = parseSidecar('- 评级: 随便写的\n')
check('无效 tier 归为未评级', bogusTier.tier === null, String(bogusTier.tier))
const noRating = parseSidecar('- 评分: 未评分\n')
check('未评分解析为 null', noRating.rating === null, String(noRating.rating))

console.log('\n— 落盘 —')
const w = writeSidecar(dir, full)
check('写入成功', w.ok && typeof w.mtimeMs === 'number')
const raw = fs.readFileSync(path.join(dir, SIDECAR))
check('带 UTF-8 BOM', raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf)
check('文件名为 .md', fs.existsSync(path.join(dir, SIDECAR)))
const fromDisk = readSidecar(dir)
check('从磁盘读回名称', fromDisk?.name === full.name, String(fromDisk?.name))
check('从磁盘读回时长', fromDisk?.playtimeMs === full.playtimeMs)
check('轻量读名与完整读一致', readSidecarName(dir) === full.name, String(readSidecarName(dir)))

const before = fs.statSync(path.join(dir, SIDECAR)).mtimeMs
const skip = writeSidecarIfChanged(dir, full)
check('内容未变时跳过写入', skip.skipped === true)
check(
  '跳过时 mtime 不变',
  fs.statSync(path.join(dir, SIDECAR)).mtimeMs === before,
  '否则每次扫描都会被当成用户手改'
)
const changed = writeSidecarIfChanged(dir, { ...full, rating: 5 })
check('内容变化时确实写入', changed.skipped !== true && changed.ok)
check('改后读回新值', readSidecar(dir)?.rating === 5)

console.log('\n— 旧版 .txt 迁移 —')
const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-legacy-'))
fs.writeFileSync(
  path.join(legacyDir, LEGACY_SIDECAR),
  '\ufeff# Sakura Launcher 显示名称\r\n\r\n显示名称 = 老版本的名字\r\n',
  'utf-8'
)
check('能读旧 txt 里的名字', readSidecarName(legacyDir) === '老版本的名字')
writeSidecar(legacyDir, { name: '老版本的名字' })
check('迁移后 .md 存在', fs.existsSync(path.join(legacyDir, SIDECAR)))
check('迁移后 .txt 已删除', !fs.existsSync(path.join(legacyDir, LEGACY_SIDECAR)))

console.log('\n— 目录站资料 —')

/*
 * 标签、简介、封面本来只活在 db.json 里：换台机器、换个版本、文件夹改个名，就全没了。
 * 现在它们跟着游戏文件夹走 —— 而封面记的是**文件名，不是路径**，因为路径是「这台机器上的
 * 事实」，文件夹一改名就不再成立。
 */
const catalogued: SidecarData = {
  name: '示例游戏',
  work: { source: 'vndb', workId: 'v1234', title: 'サンプルゲーム' },
  cover: { name: 'sakura-cover.jpg', from: 'vndb' },
  autoTags: [
    { id: 'genre:校园', facet: 'genre', label: '校园', reasonKey: 'tag.why.vndb' },
    { id: 'year:2016', facet: 'year', label: '2016', reasonKey: 'tag.why.year' },
    { id: 'genre:凌辱', facet: 'genre', label: '凌辱', reasonKey: 'tag.why.vndb', adult: true },
    { id: 'genre:结局', facet: 'genre', label: '结局', reasonKey: 'tag.why.vndb', spoiler: true }
  ],
  summary: '这是一段简介。\n第二行。\n\n隔一段之后还有一行。',
  summaryFrom: 'bangumi'
}

const round = parseSidecar(renderSidecar(catalogued))
check('作品编号回得来', round.work?.source === 'vndb' && round.work?.workId === 'v1234')
check('作品名也一起记着', round.work?.title === 'サンプルゲーム')
check('封面记的是文件名', round.cover?.name === 'sakura-cover.jpg')
check('封面来源也记着', round.cover?.from === 'vndb')
check('简介一字不差', round.summary === catalogued.summary, JSON.stringify(round.summary))
check('简介署名回得来', round.summaryFrom === 'bangumi')

const backTags = round.autoTags ?? []
check('四个标签都回来了', backTags.length === 4, String(backTags.length))
check('R18 标签仍然是 R18', backTags.find((t) => t.label === '凌辱')?.adult === true)
check('剧透标签仍然是剧透', backTags.find((t) => t.label === '结局')?.spoiler === true)
check('普通标签两样都不是', !backTags.find((t) => t.label === '校园')?.adult)
/* 年份是另一种筛选：一部作品只有一个年份，读回来必须还是年份，不能变成题材 */
check('年份读回来还是年份', backTags.find((t) => t.label === '2016')?.facet === 'year')
check('年份的 id 也对', backTags.find((t) => t.label === '2016')?.id === 'year:2016')

/* 三行分开写不是为了好看：读回来要是混成一行，R18 标签会直接出现在书架上 */
const rendered = renderSidecar(catalogued)
check('R18 标签单独一行', /R18 标签: 凌辱/.test(rendered))
check('剧透标签单独一行', /剧透标签: 结局/.test(rendered))
check('题材那行不含 R18 也不含剧透', /题材标签: 校园, 2016\r?\n/.test(rendered))

/* 封面那行只准是文件名。写着路径的（手改的、从别的机器抄来的）一律不认 */
const sneaky = parseSidecar('- 封面: ..\\..\\Windows\\System32\\evil.jpg (VNDB)')
check('带路径的封面不认', sneaky.cover === undefined)
const relative = parseSidecar('- 封面: 我自己的图.png')
/* 没写来源就是不知道，不是「用户设的」—— 用的时候按用户设的对待（不覆盖），但文件里不编。 */
check('没写来源就不编一个出来', relative.cover?.from === undefined)
check('文件名带中文也没问题', relative.cover?.name === '我自己的图.png')
check('不知道来源就不写括号', !/\(/.test(renderSidecar({ cover: { name: 'a.png' } })))
check(
  '自己设的会写明',
  /自己设的/.test(renderSidecar({ cover: { name: 'a.png', from: 'user' } }))
)
check(
  '自己设的也读得回来',
  parseSidecar('- 封面: a.png (自己设的)').cover?.from === 'user'
)

/* 还没查过的游戏，文件里不该多出这一节 */
const bare = renderSidecar({ name: '还没查过的游戏' })
check('没资料就没有这一节', !/目录站资料|From the catalogue/.test(bare))
check('也没有简介小节', !/### 简介/.test(bare))

/* 手改的文件：来源大小写随意，署名那行可以不写，引用符号可留可不留 */
const handWritten = parseSidecar(
  ['## 目录站资料', '', '- 作品: vndb v999', '', '### 简介', '', '> 手写的一段。', ''].join('\n')
)
check('小写的来源也认', handWritten.work?.source === 'vndb')
check('简介去掉了引用符号', handWritten.summary === '手写的一段。')
check('没署名就是没署名', handWritten.summaryFrom === undefined)

console.log('\n— 删除 —')
removeSidecar(dir)
check('删除后文件不在', !fs.existsSync(path.join(dir, SIDECAR)))
check('删除后读回 null', readSidecar(dir) === null && readSidecarName(dir) === null)

fs.rmSync(dir, { recursive: true, force: true })
fs.rmSync(legacyDir, { recursive: true, force: true })

console.log(`\n${pass} 通过 · ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
