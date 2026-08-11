import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { diagnoseGame } from '../src/main/diagnose.ts'
import { hasKana, isVirtualDll, looksLikeMojibake, searchDirsFor } from '../src/main/diagnose-rules.ts'
import { readPe } from '../src/main/pe-imports.ts'
import { classifyExes, detectEngineAt, listDirShallow } from '../src/main/scan-core.ts'

/**
 * Dump everything the launch diagnosis can see about one game folder.
 *
 * For the case the diagnosis got wrong. When it reports nothing and the game still will
 * not start, the useful question is not "what else could I guess" but "what did it
 * actually see" — so this prints the raw material: every executable, its imports, what
 * resolves, what the engine detector made of the folder, and what the diagnosis concludes
 * for each candidate rather than only the one currently selected.
 *
 * Read-only. Takes the folder as an argument; nothing is stored in the repository.
 *
 *   node scripts/diagnose-probe.mts "H:\games\某游戏"
 */

const dir = process.argv[2]
if (!dir || !fs.existsSync(dir)) {
  console.error('用法: node scripts/diagnose-probe.mts "<游戏文件夹>"')
  process.exit(1)
}

/** Packers rename their sections, and the names are the giveaway. */
const PACKER_SECTIONS = /^(upx|\.aspack|\.adata|\.themida|\.vmp|\.enigma|\.petite|\.mpress|\.nsp|\.taz|\.winlice|\.yp)/i

function acp(): number | null {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'],
      { windowsHide: true, encoding: 'latin1' }
    )
    const m = /ACP\s+REG_SZ\s+(\d+)/i.exec(out)
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

const entries = listDirShallow(dir).map((e) => ({
  name: e.name,
  isDir: e.isDir,
  size: e.sizeBytes
}))

console.log('\n=== 文件夹 ===')
console.log(`路径      ${dir}`)
console.log(`名称      ${path.basename(dir)}`)
console.log(`假名      ${hasKana(path.basename(dir))}`)
console.log(`乱码      ${looksLikeMojibake(path.basename(dir))}`)
console.log(`系统 ACP  ${acp()}  ${acp() === 932 ? '(日文)' : '(非日文)'}`)

console.log('\n=== 引擎 ===')
const exes = entries.filter((e) => !e.isDir && /\.exe$/i.test(e.name))
for (const exe of exes.slice(0, 1)) {
  console.log(`detectEngine -> ${detectEngineAt(dir, path.join(dir, exe.name))}`)
}
console.log(
  '目录里的目录: ' + entries.filter((e) => e.isDir).map((e) => e.name).join(', ')
)
console.log(
  '非 exe 文件(前 30): ' +
    entries
      .filter((e) => !e.isDir && !/\.exe$/i.test(e.name))
      .slice(0, 30)
      .map((e) => e.name)
      .join(', ')
)

const kanaNames = entries.map((e) => e.name).filter(hasKana)
const mojiNames = entries.map((e) => e.name).filter(looksLikeMojibake)
console.log(`含假名的文件名: ${kanaNames.length} 个 ${kanaNames.slice(0, 5).join(', ')}`)
console.log(`疑似乱码的文件名: ${mojiNames.length} 个 ${mojiNames.slice(0, 5).join(', ')}`)

console.log('\n=== 每个可执行文件 ===')
const windir = process.env.SystemRoot ?? 'C:\\Windows'
const verdicts = classifyExes(dir, entries)

for (const exe of exes) {
  const full = path.join(dir, exe.name)
  const pe = readPe(full)
  const verdict = verdicts.find((v) => v.name.toLowerCase() === exe.name.toLowerCase())
  console.log(`\n--- ${exe.name}  (${(exe.size / 1024).toFixed(0)} KB)`)
  console.log(`  分类      ${verdict?.kind ?? '?'}  ${(verdict?.reasons ?? []).join(' · ')}`)
  if (!pe) {
    console.log('  PE        解析不出来（不是可执行文件？）')
    continue
  }
  const real = pe.imports.filter((d) => !isVirtualDll(d))
  const dirs = searchDirsFor(path.dirname(full), pe.arch, windir, [])
  const missing = real.filter((d) => !dirs.some((s) => fs.existsSync(path.join(s, d))))
  const delayReal = pe.delayImports.filter((d) => !isVirtualDll(d))
  const delayMissing = delayReal.filter((d) => !dirs.some((s) => fs.existsSync(path.join(s, d))))
  const packed = pe.sections.filter((s) => PACKER_SECTIONS.test(s))

  console.log(`  架构      ${pe.arch}${pe.is16bit ? ' (16 位)' : ''}${pe.isDotNet ? ' .NET' : ''}`)
  console.log(`  管理员    ${pe.requiresAdmin}`)
  console.log(`  节区      ${pe.sections.join(' ')}${packed.length > 0 ? '   ← 疑似加壳' : ''}`)
  console.log(`  导入      ${real.length} 个真实 / ${pe.imports.length} 个总计`)
  console.log(`            ${real.join(', ') || '(空)'}`)
  console.log(`  缺失      ${missing.join(', ') || '无'}`)
  console.log(`  延迟导入  ${delayReal.join(', ') || '无'}   缺: ${delayMissing.join(', ') || '无'}`)
  // 导入表太小说明它什么都没告诉我们 —— 加壳，或者全靠 LoadLibrary 动态加载。
  if (real.length <= 3) {
    console.log('  ⚠ 导入表几乎是空的：加壳或全走 LoadLibrary，「没缺 DLL」在这里不代表任何事')
  }
}

console.log('\n=== 诊断对每个候选的结论 ===')
for (const exe of exes) {
  const full = path.join(dir, exe.name)
  const game = {
    id: 'probe',
    name: path.basename(dir),
    dir,
    exe: full,
    kind: 'installed',
    sizeBytes: 0,
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
    childCount: 0
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await diagnoseGame(game as any)
  const summary =
    result.checks.length === 0
      ? '没查出问题'
      : result.checks.map((c) => `[${c.severity}] ${c.title}`).join(' | ')
  console.log(`  ${exe.name.padEnd(28)} ${summary}`)
}

console.log('')
