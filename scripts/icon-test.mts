/**
 * Verify PE icon extraction against real executables.
 *
 *   node scripts/icon-test.mts "<exe>" ["<exe>" ...]
 *   node scripts/icon-test.mts --scan "<library folder>"
 *
 * Writes each extracted .ico next to nothing — output goes to the scratch dir passed
 * via --out, or is discarded when only sizes are being checked.
 */
import fs from 'node:fs'
import path from 'node:path'
import { extractLargestIcon, probeMaxIconSize } from '../src/main/pe-icon.ts'
import { walkRoot } from '../src/main/scan-core.ts'

const args = process.argv.slice(2)
let outDir: string | null = null
const outIdx = args.indexOf('--out')
if (outIdx >= 0) {
  outDir = args[outIdx + 1]
  args.splice(outIdx, 2)
  fs.mkdirSync(outDir, { recursive: true })
}

let exes: string[] = []
if (args[0] === '--scan') {
  const root = args[1]
  if (!root) {
    console.error('usage: node scripts/icon-test.mts --scan "<library folder>"')
    process.exit(1)
  }
  exes = walkRoot(root).games.map((g) => g.exe)
} else {
  exes = args
}

if (exes.length === 0) {
  console.error('no executables given')
  process.exit(1)
}

let ok = 0
let small = 0
let none = 0

for (const exe of exes) {
  const probed = probeMaxIconSize(exe)
  const icon = extractLargestIcon(exe)
  const name = path.basename(exe)
  if (!icon) {
    none++
    console.log(`  ${'(none)'.padStart(9)}  ${name}`)
    continue
  }
  if (icon.width >= 128) ok++
  else small++

  if (outDir) {
    const safe = name.replace(/[^\w.-]/g, '_')
    fs.writeFileSync(path.join(outDir, `${safe}.ico`), icon.ico)
  }
  const flag = icon.width >= 128 ? ' ' : '!'
  console.log(
    `${flag} ${(icon.width + 'x' + icon.height).padStart(9)}  ${icon.ico.length.toString().padStart(8)}B  probe=${probed}  ${name}`
  )
}

console.log(`\n>=128px: ${ok}   <128px: ${small}   no icon: ${none}   total: ${exes.length}`)
