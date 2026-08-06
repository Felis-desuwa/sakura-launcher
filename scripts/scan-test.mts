/**
 * CLI harness for the scanner — run against a real library before wiring up any UI.
 *
 *   node scripts/scan-test.ts "<path to a game library folder>"
 *
 * Takes the root as an argument on purpose: no path is ever hardcoded here.
 */
import path from 'node:path'
import { walkRoot, findExtractedDir, ARCHIVE_MIN_BYTES } from '../src/main/scan-core.ts'

const root = process.argv[2]
if (!root) {
  console.error('usage: node scripts/scan-test.ts "<library folder>"')
  process.exit(1)
}

const gb = (n: number): string => (n / 1024 ** 3).toFixed(2) + ' GB'

console.log(`scanning: ${root}\n`)
const t0 = Date.now()
const { games, archives, collections, rejected } = walkRoot(root)
const elapsed = Date.now() - t0

console.log(`=== GAMES (${games.length}) — ${elapsed} ms ===`)
for (const g of games.sort((a, b) => a.dir.localeCompare(b.dir))) {
  const rel = path.relative(root, g.dir) || '.'
  const depth = rel === '.' ? 0 : rel.split(path.sep).length
  console.log(`  [d${depth}] ${rel}`)
  console.log(`         -> ${path.basename(g.exe)}`)
}

console.log(`\n=== REJECTED (${rejected.length}) — had an exe but failed sanity checks ===`)
for (const r of rejected.sort((a, b) => a.dir.localeCompare(b.dir))) {
  console.log(`  ${path.relative(root, r.dir)}`)
  console.log(`         -> ${path.basename(r.exe)}   [${r.reason}]`)
}

console.log(`\n=== COLLECTIONS (parents holding 2+ games) ===`)
if (collections.size === 0) console.log('  (none)')
for (const [parent, list] of collections) {
  console.log(`  ${path.relative(root, parent) || '.'}  (${list.length})`)
}

const gameDirs = games.map((g) => g.dir)
console.log(`\n=== ARCHIVES >${(ARCHIVE_MIN_BYTES / 1024 ** 2).toFixed(0)}MB (${archives.length}) ===`)
let redundant = 0
for (const a of archives.sort((x, y) => y.sizeBytes - x.sizeBytes)) {
  const extracted = findExtractedDir(a, gameDirs)
  if (extracted) redundant += a.sizeBytes
  const vols = a.volumes.length > 1 ? ` [${a.volumes.length} vols]` : ''
  const dirs = new Set(a.volumes.map((v) => path.dirname(v)))
  const spread = dirs.size > 1 ? ` (spread over ${dirs.size} folders)` : ''
  console.log(
    `  ${gb(a.sizeBytes).padStart(9)}  extracted=${extracted ? 'YES' : 'no '}  ${a.name}${vols}${spread}`
  )
}
console.log(`\n  redundant (already extracted): ${gb(redundant)}`)
