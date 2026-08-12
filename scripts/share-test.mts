import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sanitizeArchiveName, scanPersonalData } from '../src/main/share-rules.ts'

/**
 * What a shared copy of a game must and must not contain.
 *
 * Weighted towards the false positives, because those are the expensive ones: a save
 * left in an archive is an embarrassment, a `.dat` taken out of a BGI game is an archive
 * that does not run and nobody finds out until it is already sent.
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

/** Build a folder tree from a {relative path: contents} map. */
function makeTree(tree: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'share-test-'))
  for (const [rel, body] of Object.entries(tree)) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body)
  }
  return root
}

const rels = (root: string): string[] =>
  scanPersonalData(root).map((c) => c.rel.replace(/\\/g, '/'))

const checkedRels = (root: string): string[] =>
  scanPersonalData(root)
    .filter((c) => c.checked)
    .map((c) => c.rel.replace(/\\/g, '/'))

const roots: string[] = []
const tree = (t: Record<string, string>): string => {
  const r = makeTree(t)
  roots.push(r)
  return r
}

console.log('\n[1] 游戏本体绝不能被当成个人数据')

{
  // BGI / Ethornell: the game itself lives in .dat files in the game folder.
  const root = tree({
    'BGI.exe': 'MZ',
    'data01000.dat': 'x'.repeat(4000),
    'data02000.dat': 'x'.repeat(4000),
    'sysgrp.arc': 'x'.repeat(1000)
  })
  const got = rels(root)
  check('根目录的 data01000.dat 不被命中', !got.includes('data01000.dat'), got.join(','))
  check('根目录的 .arc 不被命中', !got.includes('sysgrp.arc'), got.join(','))
}

{
  // KiriKiri keeps everything in .xp3, including a file literally named data.xp3.
  const root = tree({ 'game.exe': 'MZ', 'data.xp3': 'x'.repeat(9000), 'patch.xp3': 'x' })
  const got = rels(root)
  check('.xp3 不被命中', got.length === 0, got.join(','))
}

{
  // Ren'Py: .rpa is the game, .save is the save.
  const root = tree({
    'game/archive.rpa': 'x'.repeat(5000),
    'game/saves/1-1.save': 'y',
    'game/saves/persistent': 'y'
  })
  const got = rels(root)
  check('.rpa 不被命中', !got.some((r) => r.endsWith('.rpa')), got.join(','))
  check('嵌套的 game/saves 被命中', got.includes('game/saves'), got.join(','))
}

console.log('\n[2] 个人数据要被找出来')

{
  const root = tree({
    'game.exe': 'MZ',
    'save/1.sav': 'y',
    'save/2.sav': 'y',
    'sakura-launcher.md': '# 说明',
    'log/run.log': 'y',
    'config.ini': 'y'
  })
  const got = rels(root)
  check('save/ 目录被命中', got.includes('save'), got.join(','))
  check('sakura-launcher.md 被命中', got.includes('sakura-launcher.md'), got.join(','))
  check('log/ 目录被命中', got.includes('log'), got.join(','))
  check('config.ini 被命中', got.includes('config.ini'), got.join(','))

  const ticked = checkedRels(root)
  check('存档默认勾选', ticked.includes('save'))
  check('说明文件默认勾选', ticked.includes('sakura-launcher.md'))
  check('日志默认勾选', ticked.includes('log'))
  check('设置文件默认不勾选', !ticked.includes('config.ini'), ticked.join(','))
}

{
  // A matched directory is reported whole rather than file by file.
  const root = tree({
    'game.exe': 'MZ',
    'savedata/a.sav': 'y',
    'savedata/b.sav': 'y',
    'savedata/deep/c.sav': 'y'
  })
  const got = rels(root)
  check('存档目录整体上报，不逐个列文件', got.length === 1 && got[0] === 'savedata', got.join(','))
}

{
  const root = tree({ 'game.exe': 'MZ', 'セーブ/1.dat': 'y', '存档/2.dat': 'y' })
  const got = rels(root)
  check('日文セーブ目录被命中', got.includes('セーブ'), got.join(','))
  check('中文存档目录被命中', got.includes('存档'), got.join(','))
}

{
  // Save-ish extensions only count inside a save folder — this is the whole .dat rule.
  const root = tree({
    'game.exe': 'MZ',
    'system.dat': 'x'.repeat(3000),
    'save/slot.dat': 'y',
    'save1.dat': 'y'
  })
  const got = rels(root)
  check('存档目录里的 .dat 被命中（随目录一起）', got.includes('save'), got.join(','))
  check('根目录的 save1.dat 被命中', got.includes('save1.dat'), got.join(','))
  check(
    'system.dat 只作为设置候选，不作为存档',
    scanPersonalData(root).find((c) => c.rel === 'system.dat')?.category === 'config',
    JSON.stringify(scanPersonalData(root).map((c) => [c.rel, c.category]))
  )
}

{
  const root = tree({ 'www/save/file1.rpgsave': 'y', 'www/js/main.js': 'x' })
  const got = rels(root)
  check('RPG Maker 的 www/save 被命中', got.includes('www/save'), got.join(','))
  check('www/js 不被命中', !got.includes('www/js'), got.join(','))
}

console.log('\n[3] 体积保险')

{
  // A "save" folder that is most of the install is not a save folder.
  const root = tree({
    'game.exe': 'MZ',
    'save/huge.sav': 'x'.repeat(100_000),
    'tiny.txt': 'x'.repeat(100)
  })
  const found = scanPersonalData(root)
  const save = found.find((c) => c.rel === 'save')
  check('超大候选被标记 oversized', save?.oversized === true, JSON.stringify(save))
  check('超大候选默认不勾选', save?.checked === false, JSON.stringify(save))
}

{
  const root = tree({
    'game.exe': 'MZ',
    'data.pak': 'x'.repeat(100_000),
    'save/s.sav': 'x'.repeat(100)
  })
  const save = scanPersonalData(root).find((c) => c.rel === 'save')
  check('正常比例的存档仍然默认勾选', save?.checked === true, JSON.stringify(save))
}

console.log('\n[4] 空目录与异常输入')

{
  const root = tree({ 'game.exe': 'MZ' })
  check('干净的游戏没有候选项', scanPersonalData(root).length === 0)
}

check('不存在的目录返回空数组', scanPersonalData(path.join(os.tmpdir(), 'nope-' + Date.now())).length === 0)

console.log('\n[5] 压缩包文件名过滤')

check('去掉非法字符', sanitizeArchiveName('A/B:C*D?E"F<G>H|I') === 'ABCDEFGHI', sanitizeArchiveName('A/B:C*D?E"F<G>H|I'))
check('去掉结尾的点', sanitizeArchiveName('Game...') === 'Game', sanitizeArchiveName('Game...'))
check('折叠空白', sanitizeArchiveName('  A   B  ') === 'A B', `"${sanitizeArchiveName('  A   B  ')}"`)
check('保留中日文', sanitizeArchiveName('サンプルゲーム') === 'サンプルゲーム')

for (const root of roots) fs.rmSync(root, { recursive: true, force: true })

console.log(`\n${pass} 通过 · ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
