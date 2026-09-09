import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  expandEnv,
  hitLimitFor,
  packMatches,
  parseFixBytes,
  parseSig,
  readFixPack
} from '../src/main/binfix-rules.ts'

/**
 * Run a fix pack against a real game, once, and print what it did.
 *
 * `binfix-test` proves the rules refuse what they should. It cannot prove that a signature
 * is anywhere in a real image, that a packed executable decrypts within the timeout, or
 * that `WriteProcessMemory` is allowed to land — and those are the three things that
 * actually decide whether this feature works. So this takes a pack and an executable, the
 * same way `scan-test` and `diagnose-probe` take a folder, and nothing here is hardcoded.
 *
 * It drives the **shipped** artifacts: the PowerShell is lifted out of `src/main/binfix.ts`
 * as it stands rather than copied here, because a copy would go on passing after the real
 * one had rotted.
 *
 *   npm run binfix-probe -- <pack.json> <game.exe>
 *   npm run binfix-probe -- <pack.json>              # read the pack, start nothing
 *
 * **It starts the game.** That is the point — the bytes only exist once the packer has
 * decrypted them — and it stops it again afterwards. Nothing is written to the game
 * folder by this or by the patcher: the whole fix lives in one process's memory.
 */

const [packFile, exe] = process.argv.slice(2)
if (!packFile) {
  console.log('usage: npm run binfix-probe -- <pack.json> [game.exe]')
  process.exit(2)
}

const here = path.dirname(fileURLToPath(import.meta.url))

/* ------------------------------- the pack ------------------------------- */

let raw: unknown
try {
  raw = JSON.parse(fs.readFileSync(packFile, 'utf-8'))
} catch (err) {
  console.log(`cannot read ${packFile}: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

const read = readFixPack(raw)
if (!read.ok) {
  console.log('pack refused:')
  for (const problem of read.problems) console.log(`  ${problem}`)
  process.exit(1)
}
const pack = read.pack
console.log(`pack     ${pack.name}`)
console.log(`patches  ${pack.patches.length}`)
console.log(`built for sha256 ${pack.exeSha256}${pack.exeSize ? `, ${pack.exeSize} bytes` : ''}`)
for (const p of pack.patches) {
  const sig = parseSig(p.sig)!
  const fixed = sig.mask.filter(Boolean).length
  console.log(
    `  ${p.name.padEnd(28)} ${sig.bytes.length} bytes (${fixed} fixed)` +
      `  +${p.offset} <- ${p.fix}  max ${hitLimitFor(p)}${p.required ? '  required' : ''}`
  )
}

if (!exe) {
  console.log('\nno executable given — the pack reads cleanly and nothing was started.')
  process.exit(0)
}

/* ---------------------- does it belong to this build ---------------------- */

let buf: Buffer
try {
  buf = fs.readFileSync(exe)
} catch (err) {
  console.log(`cannot read ${exe}: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
const identity = { sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length }
console.log(`\nexe      ${exe}`)
console.log(`sha256   ${identity.sha256}, ${identity.size} bytes`)
if (!packMatches(pack, identity)) {
  console.log('MISMATCH — this pack was not written for this executable. Nothing was started.')
  process.exit(1)
}
console.log('match    yes')

/* ------------------ the plan, built by the shipped rules ------------------ */

const scan = pack.scan!
const plan = {
  // The script starts the game itself. That ordering is the fix for a race this probe
  // found: compiled first, game second, so a gate decided inside `WinMain` cannot beat it.
  exe,
  cwd: path.dirname(exe),
  from: Number(scan.from),
  to: Number(scan.to),
  timeoutMs: scan.timeoutMs,
  patches: pack.patches.map((p) => {
    const condition = p.unless?.skipIfFileExists
    const target = condition ? expandEnv(condition, process.env) : ''
    const skip = target !== '' && fs.existsSync(target)
    if (skip) console.log(`skip     "${p.name}" — ${target} is present`)
    return {
      name: p.name,
      bytes: parseSig(p.sig)!.bytes,
      mask: parseSig(p.sig)!.mask,
      offset: p.offset,
      fix: parseFixBytes(p.fix)!,
      maxHits: hitLimitFor(p),
      required: p.required === true,
      skip
    }
  })
}

/* ------------- the script, lifted out of the module that ships it ------------- */

const source = fs.readFileSync(path.join(here, '..', 'src', 'main', 'binfix.ts'), 'utf-8')
const opener = 'const PS_SCRIPT = `'
const start = source.indexOf(opener)
const end = start < 0 ? -1 : source.indexOf('\n`\n', start + opener.length)
if (start < 0 || end < 0) {
  console.log('could not find PS_SCRIPT in src/main/binfix.ts — has it moved?')
  process.exit(1)
}
const script = source.slice(start + opener.length, end)
console.log(`script   ${script.length} chars, lifted from src/main/binfix.ts`)

const dir = path.join(os.tmpdir(), 'sakura-binfix-probe')
fs.mkdirSync(dir, { recursive: true })
const scriptPath = path.join(dir, 'patch.ps1')
const planPath = path.join(dir, 'plan.json')
// PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
fs.writeFileSync(scriptPath, '﻿' + script, 'utf-8')
fs.writeFileSync(planPath, JSON.stringify(plan), 'utf-8')

/* --------------------------- start, patch, stop --------------------------- */

console.log('\nstarting the game through the patcher…')
const began = Date.now()
const ps = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
  {
    encoding: 'utf-8',
    windowsHide: true,
    timeout: 90_000,
    env: {
      ...process.env,
      SAKURA_FIX_PLAN: planPath,
      // PROCESS_VM_OPERATION | VM_READ | VM_WRITE | QUERY_INFORMATION | SUSPEND_RESUME
      SAKURA_FIX_ACCESS: String(0x0008 | 0x0010 | 0x0020 | 0x0400 | 0x0800)
    }
  }
)
console.log(`patcher  finished in ${Date.now() - began} ms`)

const stderr = (ps.stderr ?? '').trim()
if (stderr) console.log(`stderr\n${stderr.slice(0, 2000)}`)

const line = (ps.stdout ?? '')
  .split(/\r?\n/)
  .reverse()
  .find((l) => l.startsWith('SAKURAFIX '))

let failed = false
let pid: number | undefined
if (!line) {
  console.log(`\nNO ANSWER. raw stdout:\n${(ps.stdout ?? '').slice(0, 2000)}`)
  failed = true
} else {
  const answer = JSON.parse(line.slice('SAKURAFIX '.length)) as Record<string, unknown>
  if (typeof answer.pid === 'number') pid = answer.pid
  console.log(`\npid      ${pid ?? '(none)'}`)
  console.log(`state    ${String(answer.state)}`)
  if (answer.error) console.log(`error    ${String(answer.error)}`)
  const rows = Array.isArray(answer.patches) ? answer.patches : []
  for (const row of rows as Record<string, unknown>[]) {
    const at = Array.isArray(row.at) && row.at.length > 0 ? `  ${row.at.join(' ')}` : ''
    console.log(
      `  ${String(row.state).padEnd(11)} hits=${String(row.hits ?? '?').padEnd(3)} ` +
        `${String(row.name)}${at}`
    )
    if (row.state === 'notFound' || row.state === 'ambiguous' || row.state === 'writeFailed') {
      failed = true
    }
  }
}

// A probe that leaves a game running is a probe nobody runs twice.
if (pid !== undefined) {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  console.log('game     stopped')
}

process.exit(failed ? 1 : 0)
