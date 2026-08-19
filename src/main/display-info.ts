import { execFile } from 'node:child_process'
import type { DisplayFacts, GpuFacts, MachineFacts } from '../shared/types.ts'

/**
 * Asking Windows what is actually plugged in.
 *
 * Written because a scaling backend was quietly producing wrong colour and nothing in this
 * program could see why: the picture was being captured off a display running HDR, and the
 * profile driving it said the display was not. That is not a matter of taste, it is a fact
 * about the machine, and the only reason it was ever guessed is that nobody had asked.
 *
 * Done through PowerShell for the same reason `window-text.ts` and `playtime.ts` are: it is
 * the only route to the Win32 API from here that costs no native dependency. The script goes
 * over as `-EncodedCommand` — UTF-16 base64 — which is the one form that carries a monitor
 * named in han or kana without a quoting or codepage argument.
 *
 * `DisplayConfigGetDeviceInfo` is the authoritative answer, and the reason this is not read
 * out of the registry, where the HDR toggle lives under a hashed per-configuration key that
 * moves when a monitor is unplugged. It is also why this is not taken from Chromium's own
 * `screen` module: that reports the colour space of a *window*, and the window this program
 * shows is not the one being scaled.
 */

/** Long enough for PowerShell to compile the interop stub on a cold run. */
const TIMEOUT_MS = 25_000

/**
 * The query, with `QDC_ONLY_ACTIVE_PATHS` (2) as its flags.
 *
 * Inactive paths describe monitors that are attached and switched off, and reporting those
 * would put displays nobody can see into the answer — including, on a machine like the one
 * this was written on, the phantom outputs that remote-desktop and headset software install.
 *
 * The two `DisplayConfigGetDeviceInfo` calls are the monitor's advertised name (type 2) and
 * its advanced-colour state (type 9). Bit 0 of the latter's packed `value` is "this display
 * can do HDR", bit 1 is "it is switched on right now", and only the second one matters here.
 */
const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$src = @'
using System;
using System.Runtime.InteropServices;
public static class SakuraDisplay {
  [StructLayout(LayoutKind.Sequential)] public struct LUID { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] public struct SRC { public LUID adapterId; public uint id; public uint modeIdx; public uint statusFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct RAT { public uint num; public uint den; }
  [StructLayout(LayoutKind.Sequential)] public struct TGT { public LUID adapterId; public uint id; public uint modeIdx; public uint outTech; public uint rot; public uint scaling; public RAT rr; public uint slo; public int avail; public uint statusFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct PATH { public SRC s; public TGT t; public uint flags; }
  [StructLayout(LayoutKind.Sequential, Size=64)] public struct MODE { public uint infoType; public uint id; public LUID adapterId; public uint w; public uint h; public uint pixfmt; public int px; public int py; }
  [StructLayout(LayoutKind.Sequential)] public struct HDRINFO { public uint type; public uint size; public LUID adapterId; public uint id; public uint value; public uint colorEncoding; public uint bits; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct TARGETNAME { public uint type; public uint size; public LUID adapterId; public uint id; public uint flags; public uint outTech; public ushort edidMfg; public ushort edidProd; public uint conn; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string friendly; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string devPath; }
  [DllImport("user32.dll")] public static extern int GetDisplayConfigBufferSizes(uint flags, out uint np, out uint nm);
  [DllImport("user32.dll")] public static extern int QueryDisplayConfig(uint flags, ref uint np, [Out] PATH[] pa, ref uint nm, [Out] MODE[] ma, IntPtr topo);
  [DllImport("user32.dll")] public static extern int DisplayConfigGetDeviceInfo(ref HDRINFO p);
  [DllImport("user32.dll")] public static extern int DisplayConfigGetDeviceInfo(ref TARGETNAME p);
}
'@

if (-not ('SakuraDisplay' -as [type])) {
  Add-Type -TypeDefinition $src | Out-Null
}
$D = [SakuraDisplay]
$M = [System.Runtime.InteropServices.Marshal]

$displays = New-Object System.Collections.ArrayList
$np = 0
$nm = 0
if (($D::GetDisplayConfigBufferSizes(2, [ref]$np, [ref]$nm) -eq 0) -and ($np -gt 0)) {
  $pa = New-Object 'SakuraDisplay+PATH[]' $np
  $ma = New-Object 'SakuraDisplay+MODE[]' $nm
  if ($D::QueryDisplayConfig(2, [ref]$np, $pa, [ref]$nm, $ma, [IntPtr]::Zero) -eq 0) {
    for ($i = 0; $i -lt $np; $i++) {
      $info = New-Object 'SakuraDisplay+HDRINFO'
      $info.type = 9
      $info.size = $M::SizeOf([type]'SakuraDisplay+HDRINFO')
      $info.adapterId = $pa[$i].t.adapterId
      $info.id = $pa[$i].t.id
      $irc = $D::DisplayConfigGetDeviceInfo([ref]$info)

      $tn = New-Object 'SakuraDisplay+TARGETNAME'
      $tn.type = 2
      $tn.size = $M::SizeOf([type]'SakuraDisplay+TARGETNAME')
      $tn.adapterId = $pa[$i].t.adapterId
      $tn.id = $pa[$i].t.id
      $nrc = $D::DisplayConfigGetDeviceInfo([ref]$tn)

      $w = 0
      $ht = 0
      $isPrimary = $false
      $mi = $pa[$i].s.modeIdx
      if (($mi -lt $nm) -and ($ma[$mi].infoType -eq 1)) {
        $w = [int]$ma[$mi].w
        $ht = [int]$ma[$mi].h
        $isPrimary = (($ma[$mi].px -eq 0) -and ($ma[$mi].py -eq 0))
      }

      $hz = 0
      if ($pa[$i].t.rr.den -ne 0) { $hz = [int][math]::Round($pa[$i].t.rr.num / $pa[$i].t.rr.den) }

      [void]$displays.Add([pscustomobject]@{
        name = $(if ($nrc -eq 0) { [string]$tn.friendly } else { '' })
        width = $w
        height = $ht
        refreshHz = $hz
        primary = $isPrimary
        hdrSupported = $(if ($irc -eq 0) { ($info.value -band 1) -ne 0 } else { $false })
        hdrEnabled = $(if ($irc -eq 0) { ($info.value -band 2) -ne 0 } else { $false })
        bitsPerChannel = $(if ($irc -eq 0) { [int]$info.bits } else { 0 })
      })
    }
  }
}

$gpus = New-Object System.Collections.ArrayList
foreach ($v in @(Get-CimInstance Win32_VideoController)) {
  [void]$gpus.Add([pscustomobject]@{
    name = [string]$v.Name
    memoryMb = $(if ($v.AdapterRAM -gt 0) { [int][math]::Round($v.AdapterRAM / 1MB) } else { 0 })
  })
}

ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ displays = @($displays); gpus = @($gpus) })
`

/** PowerShell hands a one-element array back as a bare object. */
function rows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return value === null || value === undefined ? [] : [value]
}

function toDisplay(row: unknown): DisplayFacts {
  const r = row as Record<string, unknown>
  return {
    name: String(r.name ?? '').trim(),
    width: Number(r.width) || 0,
    height: Number(r.height) || 0,
    refreshHz: Number(r.refreshHz) || 0,
    primary: r.primary === true,
    hdrSupported: r.hdrSupported === true,
    hdrEnabled: r.hdrEnabled === true,
    bitsPerChannel: Number(r.bitsPerChannel) || 0
  }
}

function toGpu(row: unknown): GpuFacts {
  const r = row as Record<string, unknown>
  return { name: String(r.name ?? '').trim(), memoryMb: Number(r.memoryMb) || 0 }
}

function query(): Promise<MachineFacts | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64')

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout.trim()) return resolve(null)
        try {
          const parsed = JSON.parse(stdout.trim() || 'null') as Record<string, unknown> | null
          if (parsed === null) return resolve(null)
          const displays = rows(parsed.displays).map(toDisplay).filter((d) => d.width > 0)
          // No readable display is not the same as no display; it is a query that answered
          // nothing useful. Reporting "HDR is off" on that basis is exactly the fabrication
          // this module exists to stop, so the whole result is discarded instead.
          if (displays.length === 0) return resolve(null)
          resolve({ displays, gpus: rows(parsed.gpus).map(toGpu) })
        } catch {
          resolve(null)
        }
      }
    )
  })
}

/**
 * The last answer that came back, kept even after it goes stale.
 *
 * **A failed query never clears this.** Falling back to null would make the HDR decision
 * flip between "on" and "not known" as the query succeeded or timed out, and every flip
 * rewrites Lossless Scaling's configuration — a file that can only be written while that
 * program is closed. An unstable answer would mean it could never be brought up to date
 * once the first game of a session had started it.
 */
let known: MachineFacts | null = null

/** Whether a query has finished since the last invalidation. Failures count. */
let asked = false

/** One query at a time; a second caller waits on the first rather than starting another. */
let inFlight: Promise<MachineFacts | null> | null = null

/**
 * What is already known, without asking.
 *
 * The settings page polls status every five seconds and every one of those has to be free.
 * Spawning a PowerShell on a poll is a bug this program has already shipped once.
 */
export function cachedDisplays(): MachineFacts | null {
  return known
}

/**
 * Mark what is known as stale without throwing it away.
 *
 * Wired to Electron's own display events in `index.ts`, which fire when a monitor is added,
 * removed or reconfigured — switching HDR on is a reconfiguration, so the free signal
 * arrives exactly when the expensive answer stops being true.
 */
export function forgetDisplays(): void {
  asked = false
}

/** Ask once. Later calls are free until something invalidates the answer. */
export function ensureDisplays(): Promise<MachineFacts | null> {
  if (asked) return Promise.resolve(known)
  if (inFlight) return inFlight
  inFlight = query().then((facts) => {
    if (facts !== null) known = facts
    asked = true
    inFlight = null
    return known
  })
  return inFlight
}

/** Ask again regardless — the settings page's own button, and nothing else. */
export function refreshDisplays(): Promise<MachineFacts | null> {
  asked = false
  return ensureDisplays()
}
