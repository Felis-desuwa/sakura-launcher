import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fixPackDir } from './db'
import { t } from './i18n'
import {
  expandEnv,
  hitLimitFor,
  packMatches,
  parseFixBytes,
  parseSig,
  readFixPack
} from './binfix-rules.ts'
import type { FixPack, FixPatchOutcome, FixRun, FixRunState } from '../shared/types'

/**
 * Applying a build-specific byte fix to a game that has just started.
 *
 * The rules next door decide whether a pack is safe to run; this half does the two things
 * that need a machine under them — working out which pack belongs to an executable, and
 * getting the bytes into a process that is already going.
 *
 * **Nothing here writes to disk.** Not to the game folder, not to the executable, not
 * anywhere. The patch exists in one process's memory for as long as that process lives,
 * which is what makes "undo" mean "start it again without this" rather than a restore
 * procedure that has to work when it is least convenient.
 *
 * It is PowerShell hosting a C# delegate for the same reason `pointer-map.ts` is: it is
 * the only route to `ReadProcessMemory` and friends from here that costs no native
 * dependency, and it keeps the process doing the writing a Microsoft-signed one. The
 * script is a file rather than `-EncodedCommand` — the same length limit applies — written
 * UTF-8 **with a BOM**, because PowerShell 5.1 reads a BOM-less `.ps1` as ANSI.
 *
 * One thing is deliberately not done: **no debugger is ever attached.** The executables
 * this exists for are packed, and the packers answer a debugger by breaking in ways that
 * look like an unrelated crash — a VEH chain that stops working, a privileged-instruction
 * exception that is noise rather than a fault. Suspend, read, write, resume is the whole
 * repertoire.
 */

/** Long enough for PowerShell to compile the interop stub on a cold run, plus the sweep. */
const HARD_TIMEOUT_MS = 90_000

/**
 * `PROCESS_VM_OPERATION | VM_READ | VM_WRITE | QUERY_INFORMATION | SUSPEND_RESUME`.
 *
 * Spelled out rather than `PROCESS_ALL_ACCESS` because this handle is opened against
 * somebody's game and there is no reason for it to carry the right to terminate it.
 */
const PROCESS_ACCESS = 0x0008 | 0x0010 | 0x0020 | 0x0400 | 0x0800

/* -------------------------------------------------------------------------- */
/*  which pack, if any, belongs to this executable                             */
/* -------------------------------------------------------------------------- */

interface ExeIdentity {
  sha256: string
  size: number
}

/**
 * Hashing an executable, remembered for as long as the file does not change.
 *
 * A hash is the only thing that says "this is the build the fix was written against", and
 * these files run to a hundred megabytes, so it is worth not doing twice. The key carries
 * size and mtime: a patched or replaced executable therefore misses the cache rather than
 * inheriting the old answer, which is precisely the case that matters.
 */
const identityCache = new Map<string, ExeIdentity>()

function identify(exe: string): ExeIdentity | null {
  let st: fs.Stats
  try {
    st = fs.statSync(exe)
  } catch {
    return null
  }
  const key = `${exe.toLowerCase()}|${st.size}|${st.mtimeMs}`
  const hit = identityCache.get(key)
  if (hit) return hit
  try {
    const hash = crypto.createHash('sha256')
    hash.update(fs.readFileSync(exe))
    const identity = { sha256: hash.digest('hex'), size: st.size }
    identityCache.set(key, identity)
    return identity
  } catch {
    return null
  }
}

export interface LoadedPack {
  pack: FixPack
  file: string
}

/** A pack file that is on disk and could not be used, kept so it can be said out loud. */
export interface BrokenPack {
  file: string
  problems: string[]
}

export interface PackShelf {
  packs: LoadedPack[]
  broken: BrokenPack[]
}

/**
 * Every pack in the data directory, and every file there that is not one.
 *
 * The broken list is not decoration. A pack is hand-written, usually by somebody working
 * out a fix as they go, and a file with a typo in it that simply does not appear is the
 * worst possible feedback — the fix silently does not run and the game silently does not
 * work, with nothing connecting the two.
 */
export function loadPacks(): PackShelf {
  const dir = fixPackDir()
  const packs: LoadedPack[] = []
  const broken: BrokenPack[] = []
  let names: string[]
  try {
    names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json'))
  } catch {
    return { packs, broken }
  }
  for (const name of names) {
    const file = path.join(dir, name)
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    } catch (err) {
      broken.push({ file, problems: [err instanceof Error ? err.message : String(err)] })
      continue
    }
    const read = readFixPack(raw)
    if (read.ok) packs.push({ pack: read.pack, file })
    else broken.push({ file, problems: read.problems })
  }
  return { packs, broken }
}

/** The pack written for this executable, or null. Never a guess. */
export function packFor(exe: string): LoadedPack | null {
  const identity = identify(exe)
  if (!identity) return null
  for (const loaded of loadPacks().packs) {
    if (packMatches(loaded.pack, identity)) return loaded
  }
  return null
}

/* -------------------------------------------------------------------------- */
/*  telling somebody                                                           */
/* -------------------------------------------------------------------------- */

type FixReporter = (run: FixRun) => void

let reportFix: FixReporter | null = null

export function onFixRun(fn: FixReporter): void {
  reportFix = fn
}

/**
 * Patch a launch that has just happened, if this build has a pack written for it.
 *
 * Deliberately reports **every** outcome except "there is no pack for this game", including
 * the ones nobody wants to read. A launch that ran no fix and a launch whose fix matched
 * nothing look identical from the outside — the game starts and misbehaves either way —
 * and the whole value of this is that they stop looking identical.
 *
 * Not awaited by the caller. The sweep runs for as long as the packer takes to decrypt,
 * and holding up the launch for it would put a visible pause between the double-click and
 * the game on exactly the machines this is for.
 */
export function fixPackFor(exe: string): LoadedPack | null {
  try {
    return packFor(exe)
  } catch {
    return null
  }
}

/**
 * Start a game through the patcher, and report what the patch did.
 *
 * The patcher starts the game rather than being handed a running one, and that ordering
 * is not a detail — it is the difference between this working and not. A locale gate is
 * decided inside `WinMain`, so the process it needs to catch is gone inside a second,
 * while a cold PowerShell that has to compile an interop stub takes several. Attaching by
 * pid was tried first and lost the race every time: the report came back `exited`, which
 * was true, useless, and precisely the failure the fix exists to prevent. Compiling first
 * and starting the game afterwards removes the race instead of narrowing it.
 *
 * The cost is that a launch on this path goes through PowerShell, so its own failures have
 * to be carried back rather than coming from `spawn`. That is what `ok` is for.
 */
export function launchWithFix(
  gameId: string,
  exe: string,
  cwd: string,
  loaded: LoadedPack
): Promise<{ ok: boolean; error?: string; pid?: number }> {
  return new Promise((resolve) => {
    let answered = false
    // The double-click is answered the moment the game is up and the handle is held —
    // not when the sweep finishes. Waiting for the sweep would put its three seconds
    // between the double-click and any sign that anything happened, on exactly the games
    // that are hardest to be patient with.
    const attempt = applyFix(gameId, exe, cwd, loaded, (pid) => {
      if (answered) return
      answered = true
      resolve({ ok: true, pid })
    })
    void attempt.then((result) => {
      reportFix?.(result.run)
      if (answered) return
      answered = true
      // Only a failure to *start* is a launch failure. A pack that found nothing still
      // left a game running, and calling that a failed launch would be a second and
      // larger lie on top of the first.
      if (result.startFailed) resolve({ ok: false, error: result.run.error })
      else resolve({ ok: true, pid: result.pid })
    })
  })
}

/* -------------------------------------------------------------------------- */
/*  the patcher                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The sweep and the write, in C# so that nothing interpreted runs per byte.
 *
 * Three details are load-bearing and none is obvious:
 *
 * - **It polls before it suspends.** A packed image decrypts a moment after it starts, so
 *   the bytes are not there at t=0 and a single look finds nothing. Suspending first
 *   would freeze the process before it had decrypted anything at all.
 * - **It sweeps again after suspending.** Parts of an image decrypt later than others;
 *   measured on the build this was written against, the locale gate appears seconds before
 *   the string table does. Without the extra passes a pack applies half of itself.
 * - **It reads back what it wrote.** A `WriteProcessMemory` that returns true has written
 *   to *something*; an anti-tamper layer that restores the page immediately afterwards
 *   would leave every report saying "applied". Verifying is what makes the difference
 *   between reporting and claiming.
 */
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SakuraFix {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint a, bool i, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool WriteProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out int wrote);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool VirtualProtectEx(IntPtr h, IntPtr addr, IntPtr size, uint np, out uint op);
  [DllImport("kernel32.dll")] public static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr addr, out MBI mbi, IntPtr len);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);
  [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct MBI {
    public IntPtr BaseAddress, AllocationBase;
    public uint AllocationProtect, a1;
    public IntPtr RegionSize;
    public uint State, Protect, Type, a2;
  }
  public class Pat {
    public string Name; public byte[] Bytes; public bool[] Mask;
    public int Offset; public byte[] Fix; public int MaxHits; public bool Skip;
    public List<long> Hits = new List<long>();
    public List<long> Wrote = new List<long>();
    public bool WriteFailed;
    // Every match is counted, never just the first. Stopping early would make an
    // over-broad signature indistinguishable from an exact one.
    public bool Ambiguous { get { return Hits.Count > MaxHits; } }
  }
  static bool Match(byte[] hay, int off, Pat p) {
    for (int i = 0; i < p.Bytes.Length; i++) if (p.Mask[i] && hay[off + i] != p.Bytes[i]) return false;
    return true;
  }
  // One pass over every committed, readable, non-guard region in the range.
  public static void Sweep(IntPtr h, List<Pat> pats, long from, long to) {
    long addr = from;
    while (addr < to) {
      MBI mbi;
      if (VirtualQueryEx(h, (IntPtr)addr, out mbi, (IntPtr)Marshal.SizeOf(typeof(MBI))) == IntPtr.Zero) break;
      long baseA = mbi.BaseAddress.ToInt64();
      long size = mbi.RegionSize.ToInt64();
      bool readable = (mbi.Protect & 0xEE) != 0;
      bool guard = (mbi.Protect & 0x100) != 0;
      if (mbi.State == 0x1000 && readable && !guard && size > 0 && size < 0x4000000) {
        byte[] buf = new byte[size];
        IntPtr rd;
        if (ReadProcessMemory(h, mbi.BaseAddress, buf, mbi.RegionSize, out rd)) {
          int n = (int)rd;
          foreach (Pat p in pats) {
            if (p.Skip) continue;
            // No early exit even once a hit is in hand: the count is the check, and a
            // sweep that stops at the first match can never report an ambiguous one.
            // Bounded so a pathological signature cannot fill memory with addresses.
            if (p.Hits.Count > p.MaxHits + 8) continue;
            byte first = p.Bytes[0];
            for (int i = 0; i + p.Bytes.Length <= n; i++) {
              if (buf[i] != first) continue;
              if (!Match(buf, i, p)) continue;
              long at = baseA + i;
              if (!p.Hits.Contains(at)) p.Hits.Add(at);
              if (p.Hits.Count > p.MaxHits + 8) break;
            }
          }
        }
      }
      long next = baseA + size;
      if (next <= addr) break;
      addr = next;
    }
  }
  // Write, then read the same bytes back. A write nobody verified is a claim.
  public static void Apply(IntPtr h, Pat p) {
    foreach (long at in p.Hits) {
      IntPtr target = (IntPtr)(at + p.Offset);
      uint old;
      if (!VirtualProtectEx(h, target, (IntPtr)p.Fix.Length, 0x40, out old)) { p.WriteFailed = true; continue; }
      int wrote;
      bool ok = WriteProcessMemory(h, target, p.Fix, p.Fix.Length, out wrote);
      byte[] back = new byte[p.Fix.Length];
      IntPtr rd;
      if (ok && ReadProcessMemory(h, target, back, (IntPtr)p.Fix.Length, out rd)) {
        for (int i = 0; i < p.Fix.Length; i++) if (back[i] != p.Fix[i]) ok = false;
      } else ok = false;
      uint dummy;
      VirtualProtectEx(h, target, (IntPtr)p.Fix.Length, old, out dummy);
      if (ok) p.Wrote.Add(at); else p.WriteFailed = true;
    }
  }
}
'@

if (-not ('SakuraFix' -as [type])) { Add-Type -TypeDefinition $src | Out-Null }
$F = [SakuraFix]

# Flushed explicitly. The launcher resolves the double-click on the 'started' line while
# the sweep is still running, so a line that sat in a buffer until exit would put the whole
# patch run back in front of the user as a delay.
function Emit($obj) {
  Write-Output ('SAKURAFIX ' + ($obj | ConvertTo-Json -Depth 6 -Compress))
  [Console]::Out.Flush()
}

$planPath = $env:SAKURA_FIX_PLAN
$plan = Get-Content -LiteralPath $planPath -Raw -Encoding UTF8 | ConvertFrom-Json

# The game is started HERE, after the interop stub above has been compiled, and that
# ordering is the whole reason this script starts it at all rather than being handed a pid.
# A locale gate is decided inside WinMain and the process is gone inside a second; a
# PowerShell that starts cold and compiles C# takes several. Measured attaching by pid:
# the game had exited before the first sweep every time, and the honest report was
# "exited" — correct, useless, and exactly the failure the fix exists to prevent.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = [string]$plan.exe
$psi.WorkingDirectory = [string]$plan.cwd
# UseShellExecute, and not for convenience: with it false the game inherits this script's
# stdout handle, so the pipe the launcher is reading stays open for as long as the *game*
# runs. The patch lands either way, but the report never arrives — measured as a 90-second
# false timeout on a run whose seven patches had all applied in under three seconds.
$psi.UseShellExecute = $true
try {
  $proc = [System.Diagnostics.Process]::Start($psi)
} catch {
  Emit @{ state = 'failed'; error = 'start'; message = $_.Exception.Message }
  exit 0
}
$targetPid = $proc.Id

$h = $F::OpenProcess([uint32]$env:SAKURA_FIX_ACCESS, $false, $targetPid)
if ($h -eq [IntPtr]::Zero) {
  Emit @{ state = 'failed'; error = 'openProcess'; pid = $targetPid; code = [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
  exit 0
}

# The game is up and the handle is held. Say so now: the double-click is answered here,
# and everything below runs while the user is already looking at the game.
Emit @{ state = 'started'; pid = $targetPid }

$pats = New-Object 'System.Collections.Generic.List[SakuraFix+Pat]'
foreach ($p in $plan.patches) {
  $o = New-Object 'SakuraFix+Pat'
  $o.Name = [string]$p.name
  $o.Bytes = [byte[]]@($p.bytes)
  $o.Mask = [bool[]]@($p.mask)
  $o.Offset = [int]$p.offset
  $o.Fix = [byte[]]@($p.fix)
  $o.MaxHits = [int]$p.maxHits
  $o.Skip = [bool]$p.skip
  $pats.Add($o)
}

$from = [int64]$plan.from
$to = [int64]$plan.to
$deadline = (Get-Date).AddMilliseconds([int]$plan.timeoutMs)

# Poll until the packer has decrypted enough that the first required patch is visible.
# Anything with no required patch settles for the whole window and takes what it finds.
$anchor = $null
foreach ($p in $plan.patches) { if ($p.required -and -not $anchor) { $anchor = [string]$p.name } }

while ((Get-Date) -lt $deadline) {
  $proc.Refresh()
  if ($proc.HasExited) {
    Emit @{ state = 'failed'; error = 'exited'; pid = $targetPid; code = $proc.ExitCode }
    $F::CloseHandle($h) | Out-Null
    exit 0
  }
  $F::Sweep($h, $pats, $from, $to)
  if ($anchor) {
    $found = $false
    foreach ($o in $pats) { if ($o.Name -eq $anchor -and $o.Hits.Count -gt 0) { $found = $true } }
    if ($found) { break }
  } else {
    $all = $true
    foreach ($o in $pats) { if (-not $o.Skip -and $o.Hits.Count -eq 0) { $all = $false } }
    if ($all) { break }
  }
  Start-Sleep -Milliseconds 50
}

$F::NtSuspendProcess($h) | Out-Null
# Parts of an image decrypt later than others; without these a pack applies half of itself.
for ($i = 0; $i -lt 3; $i++) { $F::Sweep($h, $pats, $from, $to) }

$missingRequired = $false
foreach ($p in $plan.patches) {
  if (-not $p.required) { continue }
  foreach ($o in $pats) { if ($o.Name -eq [string]$p.name -and $o.Hits.Count -eq 0) { $missingRequired = $true } }
}

# A required patch that was not found aborts the whole pack. A half-patched engine is a
# state nobody has tested, and it would run without ever saying so.
if (-not $missingRequired) {
  foreach ($o in $pats) {
    if ($o.Skip) { continue }
    if ($o.Hits.Count -eq 0) { continue }
    # More matches than the pack said to expect. Write nothing and say so: the signature
    # is not specific enough to act on, which is a different fault from being absent.
    if ($o.Ambiguous) { continue }
    $F::Apply($h, $o)
  }
}

$F::NtResumeProcess($h) | Out-Null
$F::CloseHandle($h) | Out-Null

$out = @()
foreach ($o in $pats) {
  $state = 'notFound'
  if ($o.Skip) { $state = 'skipped' }
  elseif ($o.Ambiguous) { $state = 'ambiguous' }
  elseif ($o.Wrote.Count -gt 0) { $state = 'applied' }
  elseif ($o.WriteFailed) { $state = 'writeFailed' }
  $addrs = @()
  foreach ($a in $o.Wrote) { $addrs += ('0x' + $a.ToString('X8')) }
  $out += @{ name = $o.Name; at = $addrs; state = $state; hits = $o.Hits.Count }
}
$verdict = 'done'
if ($missingRequired) { $verdict = 'notFound' }
Emit @{ state = $verdict; pid = $targetPid; patches = $out }
`

/** Where the script and the plan live. Under the OS temp dir; neither outlives the run. */
function scratchDir(): string {
  const dir = path.join(os.tmpdir(), 'sakura-binfix')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Turn a validated pack into the plan the script executes.
 *
 * The hex is parsed **here**, by the same functions the harness drives, so the script gets
 * numbers and never has to understand the notation. That is the same division
 * `pointer-map.ts` failed to make and had to document: two copies of a parser is two
 * parsers to keep in step.
 */
function planFor(
  pack: FixPack,
  exe: string,
  cwd: string
): { plan: Record<string, unknown>; skipped: string[] } | null {
  const skipped: string[] = []
  const patches: Record<string, unknown>[] = []
  for (const patch of pack.patches) {
    const sig = parseSig(patch.sig)
    const fix = parseFixBytes(patch.fix)
    // Cannot happen for a pack that came through `readFixPack`, and is checked anyway
    // because the alternative is passing `undefined` into a memory writer.
    if (!sig || !fix) return null

    let skip = false
    const condition = patch.unless?.skipIfFileExists
    if (condition) {
      const target = expandEnv(condition, process.env)
      try {
        skip = target !== '' && fs.existsSync(target)
      } catch {
        skip = false
      }
      if (skip) skipped.push(patch.name)
    }

    patches.push({
      name: patch.name,
      bytes: sig.bytes,
      mask: sig.mask,
      offset: patch.offset,
      fix,
      maxHits: hitLimitFor(patch),
      required: patch.required === true,
      skip
    })
  }
  const scan = pack.scan ?? { from: '0x400000', to: '0x1000000', timeoutMs: 15_000 }
  return {
    plan: {
      exe,
      cwd,
      from: Number(scan.from),
      to: Number(scan.to),
      timeoutMs: scan.timeoutMs,
      patches
    },
    skipped
  }
}

/**
 * One word for the whole run.
 *
 * `ambiguous` outranks `notFound` when nothing was written, because they call for
 * different things: a signature that is absent means this is another build, and a
 * signature that matched too widely means the pack needs a longer one. Reporting the
 * second as the first sends whoever wrote the pack looking in the wrong place.
 */
function stateFrom(patches: FixPatchOutcome[], reported: string): FixRunState {
  const live = patches.filter((p) => p.state !== 'skipped')
  if (reported === 'notFound') return 'notFound'
  if (live.length === 0) return 'applied'
  if (live.every((p) => p.state === 'applied')) return 'applied'
  if (live.some((p) => p.state === 'applied')) return 'partial'
  if (live.some((p) => p.state === 'ambiguous')) return 'ambiguous'
  return 'notFound'
}

/** What `applyFix` learned, including whether the game ever started. */
interface FixAttempt {
  run: FixRun
  pid?: number
  /** True only when the game itself could not be started — a launch failure, not a fix one. */
  startFailed?: boolean
}

/**
 * Start the game under the patcher and report what the patch did.
 *
 * Returns a report in every case, including the uninteresting ones. A launch that ran no
 * fix and a launch whose fix found nothing look identical from the outside, and the whole
 * value of this feature is that they stop looking identical.
 */
function applyFix(
  gameId: string,
  exe: string,
  cwd: string,
  loaded: LoadedPack,
  onStarted?: (pid: number) => void
): Promise<FixAttempt> {
  const built = planFor(loaded.pack, exe, cwd)
  if (!built) {
    return Promise.resolve({
      run: {
        gameId,
        state: 'failed',
        packName: loaded.pack.name,
        patches: [],
        error: t('fix.err.plan')
      }
    })
  }

  return new Promise<FixAttempt>((resolve) => {
    let scriptPath: string
    let planPath: string
    try {
      const dir = scratchDir()
      scriptPath = path.join(dir, 'patch.ps1')
      planPath = path.join(dir, `plan-${gameId}.json`)
      // PowerShell 5.1 reads a BOM-less .ps1 as ANSI; the BOM is not optional.
      fs.writeFileSync(scriptPath, '﻿' + PS_SCRIPT, 'utf-8')
      fs.writeFileSync(planPath, JSON.stringify(built.plan), 'utf-8')
    } catch (err) {
      resolve({
        run: {
          gameId,
          state: 'failed',
          packName: loaded.pack.name,
          patches: [],
          error: err instanceof Error ? err.message : String(err)
        },
        startFailed: true
      })
      return
    }

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      {
        windowsHide: true,
        env: {
          ...process.env,
          SAKURA_FIX_PLAN: planPath,
          SAKURA_FIX_ACCESS: String(PROCESS_ACCESS)
        }
      }
    )

    let out = ''
    let settled = false
    let told = false
    const finish = (run: FixRun, extra: Omit<FixAttempt, 'run'> = {}): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        fs.unlinkSync(planPath)
      } catch {
        /* it is under the temp directory either way */
      }
      resolve({ run, ...extra })
    }

    const timer = setTimeout(() => {
      child.kill()
      finish({
        gameId,
        state: 'failed',
        packName: loaded.pack.name,
        patches: [],
        error: t('fix.err.timeout')
      })
    }, HARD_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf-8')
      // The 'started' line arrives seconds before the rest and is what answers the
      // double-click. Read it as it lands rather than at close.
      if (!told) {
        for (const line of out.split(/\r?\n/)) {
          if (!line.startsWith('SAKURAFIX ')) continue
          try {
            const early = JSON.parse(line.slice('SAKURAFIX '.length)) as Record<string, unknown>
            if (early.state === 'started' && typeof early.pid === 'number') {
              told = true
              onStarted?.(early.pid)
              break
            }
          } catch {
            /* a partial line; the next chunk completes it */
          }
        }
      }
    })
    child.once('error', (err) => {
      finish(
        {
          gameId,
          state: 'failed',
          packName: loaded.pack.name,
          patches: [],
          error: err.message
        },
        // PowerShell itself did not run, so neither did the game.
        { startFailed: true }
      )
    })
    // `exit`, not `close`. They differ exactly when a grandchild inherited a stdio handle,
    // which is the case here — and waiting for the pipe would mean waiting for the game.
    child.once('exit', () => {
      const line = out
        .split(/\r?\n/)
        .reverse()
        .find((l) => l.startsWith('SAKURAFIX '))
      if (!line) {
        finish({
          gameId,
          state: 'failed',
          packName: loaded.pack.name,
          patches: [],
          error: t('fix.err.noAnswer')
        })
        return
      }
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line.slice('SAKURAFIX '.length)) as Record<string, unknown>
      } catch {
        finish({
          gameId,
          state: 'failed',
          packName: loaded.pack.name,
          patches: [],
          error: t('fix.err.noAnswer')
        })
        return
      }

      const reportedPid = typeof parsed.pid === 'number' ? parsed.pid : undefined

      if (parsed.state === 'failed') {
        const reason =
          parsed.error === 'openProcess'
            ? t('fix.err.openProcess')
            : parsed.error === 'exited'
              ? t('fix.err.exited')
              : parsed.error === 'start'
                ? String(parsed.message ?? t('fix.err.noAnswer'))
                : String(parsed.error ?? '')
        finish(
          { gameId, state: 'failed', packName: loaded.pack.name, patches: [], error: reason },
          // Only `start` means no game. `exited` means it ran and then quit — which is the
          // very symptom this exists for, and reporting it as "the launch failed" would
          // hide that the game did start and did give up on its own.
          { ...(parsed.error === 'start' ? { startFailed: true } : {}), pid: reportedPid }
        )
        return
      }

      const raw = Array.isArray(parsed.patches) ? parsed.patches : []
      const patches: FixPatchOutcome[] = raw.map((p) => {
        const row = p as Record<string, unknown>
        return {
          name: String(row.name ?? ''),
          at: Array.isArray(row.at) ? row.at.map(String) : [],
          state: (row.state as FixPatchOutcome['state']) ?? 'notFound',
          ...(typeof row.hits === 'number' ? { hits: row.hits } : {})
        }
      })
      finish(
        {
          gameId,
          state: stateFrom(patches, String(parsed.state ?? '')),
          packName: loaded.pack.name,
          patches
        },
        { pid: reportedPid }
      )
    })
  })
}
