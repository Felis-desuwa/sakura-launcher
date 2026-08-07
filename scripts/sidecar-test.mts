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

console.log('\n— 删除 —')
removeSidecar(dir)
check('删除后文件不在', !fs.existsSync(path.join(dir, SIDECAR)))
check('删除后读回 null', readSidecar(dir) === null && readSidecarName(dir) === null)

fs.rmSync(dir, { recursive: true, force: true })
fs.rmSync(legacyDir, { recursive: true, force: true })

console.log(`\n${pass} 通过 · ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
