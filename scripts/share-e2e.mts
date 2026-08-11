import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { find7z } from '../src/main/archive.ts'
import { scanPersonalData } from '../src/main/share-rules.ts'
import { startShare } from '../src/main/share.ts'
import type { ShareJob, ShareOptions, ShareResult } from '../src/shared/types.ts'

/**
 * The sharing engine against a real 7-Zip, on a real folder.
 *
 * The assertion this file exists for is the last one: that the game folder is bit for
 * bit what it was before. Everything else about sharing is a convenience; not touching
 * the user's saves is the promise.
 */

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const exe = find7z()
if (!exe) {
  console.log('未找到 7-Zip，跳过端到端测试')
  process.exit(0)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'share-e2e-'))
const gameDir = path.join(root, 'Test Game 穢翼')
const outDir = path.join(root, 'out')

const files: Record<string, string> = {
  'game.exe': 'MZ-fake-executable',
  // BGI-style body: must survive.
  'data01000.dat': 'GAMEDATA'.repeat(200),
  'sysgrp.arc': 'ARC'.repeat(100),
  'assets/bg/room.png': 'PNG'.repeat(50),
  // All of these must be kept out.
  'sakura-launcher.md': '# 说明\n- 游玩时长: 12h',
  'save/slot1.sav': 'MYSAVE',
  'save/slot2.sav': 'MYSAVE2',
  'セーブ/1.dat': 'JPSAVE',
  'log/run.log': 'log line',
  'config.ini': 'name=me'
}
for (const [rel, body] of Object.entries(files)) {
  const full = path.join(gameDir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, body)
}

/** Every file under a folder, with size and mtime, so it can be compared afterwards. */
function snapshot(dir: string): string {
  const out: string[] = []
  const walk = (cur: string): void => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) walk(full)
      else {
        const st = fs.statSync(full)
        out.push(`${path.relative(dir, full)}|${st.size}|${st.mtimeMs}`)
      }
    }
  }
  walk(dir)
  return out.join('\n')
}

const before = snapshot(gameDir)

const candidates = scanPersonalData(gameDir)
console.log('\n[1] 扫描结果')
const relOf = (c: { rel: string }): string => c.rel.replace(/\\/g, '/')
const ticked = candidates.filter((c) => c.checked).map(relOf)
check('本体 data01000.dat 未被列为候选', !candidates.some((c) => relOf(c) === 'data01000.dat'))
check('sakura-launcher.md 默认排除', ticked.includes('sakura-launcher.md'), ticked.join(','))
check('save 默认排除', ticked.includes('save'), ticked.join(','))
check('セーブ 默认排除', ticked.includes('セーブ'), ticked.join(','))
check('log 默认排除', ticked.includes('log'), ticked.join(','))
check('config.ini 默认不排除', !ticked.includes('config.ini'), ticked.join(','))

const run = (job: ShareJob, options: ShareOptions): Promise<ShareResult[]> =>
  new Promise((resolve) => {
    startShare([{ job, gameDir }], options, () => {}, resolve)
  })

const exclude = candidates.filter((c) => c.checked).map((c) => c.path)

console.log('\n[2] 压缩（7z，无密码）')
const plain = await run(
  { gameId: 'g1', name: 'Test Game', outDir, exclude },
  { format: '7z', password: '', encryptNames: false, overwrite: true }
)
check('压缩成功', plain[0]?.ok === true, plain[0]?.error)

const archive = path.join(outDir, 'Test Game.7z')
const listing = plain[0]?.ok
  ? // `-sccUTF-8`: without it 7z prints its listing in the OEM codepage and every
  // non-ASCII path comes back as mojibake — the same trap the playtime probe hit.
    execFileSync(exe, ['l', '-ba', '-slt', '-sccUTF-8', archive], { encoding: 'utf-8' })
  : ''
const inside = [...listing.matchAll(/^Path = (.+)$/gm)].map((m) => m[1].replace(/\\/g, '/'))

console.log('\n[3] 包内容')
const has = (rel: string): boolean => inside.some((p) => p === `Test Game 穢翼/${rel}`)
check('包里有游戏本体 data01000.dat', has('data01000.dat'), inside.join(','))
check('包里有 game.exe', has('game.exe'))
check('包里有 assets/bg/room.png', has('assets/bg/room.png'))
check('包里有 config.ini（没勾就不排除）', has('config.ini'))
check('顶层是游戏文件夹本身', inside.some((p) => p === 'Test Game 穢翼'), inside.join(','))
check('包里没有 sakura-launcher.md', !has('sakura-launcher.md'))
check('包里没有 save/', !inside.some((p) => p.includes('/save')), inside.join(','))
check('包里没有 セーブ/（UTF-8 排除列表生效）', !inside.some((p) => p.includes('セーブ')), inside.join(','))
check('包里没有 log/', !inside.some((p) => p.includes('/log')), inside.join(','))

console.log('\n[4] 原文件夹必须分毫未动')
const after = snapshot(gameDir)
check('文件清单、大小、修改时间完全一致', before === after, '文件夹被改动了！')
check('存档还在', fs.existsSync(path.join(gameDir, 'save', 'slot1.sav')))
check('说明文件还在', fs.existsSync(path.join(gameDir, 'sakura-launcher.md')))

console.log('\n[5] 密码')
const secret = await run(
  { gameId: 'g1', name: 'Secret', outDir, exclude },
  { format: '7z', password: 'hunter2', encryptNames: true, overwrite: true }
)
check('加密压缩成功', secret[0]?.ok === true, secret[0]?.error)
const secretFile = path.join(outDir, 'Secret.7z')
let wrongFailed = false
try {
  execFileSync(exe, ['t', secretFile, '-pWRONG'], { stdio: 'pipe' })
} catch {
  wrongFailed = true
}
check('错误密码解不开', wrongFailed)
let rightWorked = true
try {
  execFileSync(exe, ['t', secretFile, '-phunter2'], { stdio: 'pipe' })
} catch {
  rightWorked = false
}
check('正确密码可以解开', rightWorked)

console.log('\n[6] zip 格式')
const zipped = await run(
  { gameId: 'g1', name: 'Zipped', outDir, exclude },
  { format: 'zip', password: '', encryptNames: false, overwrite: true }
)
check('zip 压缩成功', zipped[0]?.ok === true, zipped[0]?.error)
const zipList = zipped[0]?.ok
  ? execFileSync(exe, ['l', '-ba', '-slt', '-sccUTF-8', path.join(outDir, 'Zipped.zip')], { encoding: 'utf-8' })
  : ''
check('zip 里也没有存档', !zipList.includes('slot1.sav'))

console.log('\n[7] 取消会删掉残包')
const handle = startShare(
  [{ job: { gameId: 'g1', name: 'Cancelled', outDir, exclude }, gameDir }],
  { format: '7z', password: '', encryptNames: false, overwrite: true },
  () => {},
  () => {}
)
handle.cancel()
await new Promise((r) => setTimeout(r, 700))
check('取消后没有留下压缩包', !fs.existsSync(path.join(outDir, 'Cancelled.7z')))

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} 通过 · ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
