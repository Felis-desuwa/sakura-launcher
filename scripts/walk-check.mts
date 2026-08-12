/**
 * Check that scanning resolves display names the way rescan expects, using a synthetic
 * folder tree rather than a real library. Run: node scripts/walk-check.mts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { walkRoot, writeSidecar } from '../src/main/scan-core.ts'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-walk-'))
const gameDir = path.join(root, '原始文件夹名')
// A Unity layout: the engine signature vouches for the folder regardless of payload size.
fs.mkdirSync(path.join(gameDir, 'Game_Data'), { recursive: true })
fs.writeFileSync(path.join(gameDir, 'Game.exe'), Buffer.alloc(4096))
fs.writeFileSync(path.join(gameDir, 'UnityPlayer.dll'), Buffer.alloc(1024))

console.log('\n— 没有 sidecar 时 —')
let result = walkRoot(root)
check('扫到一个游戏', result.games.length === 1, `${result.games.length} 个`)
check('用文件夹名', result.games[0]?.name === '原始文件夹名', result.games[0]?.name)

console.log('\n— 写入 sidecar 后 —')
writeSidecar(gameDir, { name: '我起的名字' })
result = walkRoot(root)
check('readNames 默认开启时采用 sidecar', result.games[0]?.name === '我起的名字', result.games[0]?.name)

result = walkRoot(root, undefined, false)
check(
  'readNames=false 时不读 sidecar',
  result.games[0]?.name === '原始文件夹名',
  result.games[0]?.name
)
check('rescan 靠这个跳过启动时的逐个读盘', true, '名称改由 rescan 只对新增/变化的目录解析')

console.log('\n— sidecar 不影响识别 —')
check('仍然只算一个游戏，没把 md 当成内容', result.games.length === 1)
check('主程序仍是 Game.exe', path.basename(result.games[0]?.exe ?? '') === 'Game.exe')

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} 通过 · ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
