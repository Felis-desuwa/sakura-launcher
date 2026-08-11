import { execFile } from 'node:child_process'
import type { ForeignWindow } from './diagnose-rules.ts'

/**
 * Reading what a stuck game is showing on screen.
 *
 * When a game does not start, the engine very often says why — in a message box nobody
 * reads back, because by the time anyone looks the window has been clicked away, and
 * because on a machine whose codepage is not the engine's the sentence arrives as
 * unreadable han. Every other check in the diagnosis infers a cause; this one just asks.
 *
 * Done through PowerShell for the same reason `playtime.ts` queries processes that way:
 * it is the only route to the Win32 API from here that costs no native dependency. The
 * script is handed over as `-EncodedCommand`, which is UTF-16 base64 — the one form that
 * carries a path like `H:\ero game\秽翼的尤斯蒂娅` without a quoting or codepage argument.
 */

/** Long enough for PowerShell to compile the interop stub on a cold run. */
const TIMEOUT_MS = 25_000

const PS_TEMPLATE = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$dir = '__DIR__'

$sig = @(
  '[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
  '[DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);',
  '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);',
  '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int n);',
  '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  'public delegate bool EnumProc(IntPtr h, IntPtr l);'
) -join [Environment]::NewLine

if (-not ('SakuraWin.Api' -as [type])) {
  Add-Type -Name Api -Namespace SakuraWin -MemberDefinition $sig | Out-Null
}
$W = [SakuraWin.Api]

function Get-T($h) {
  $sb = New-Object System.Text.StringBuilder 2048
  [void]$W::GetWindowTextW($h, $sb, 2048)
  $sb.ToString()
}
function Get-C($h) {
  $sb = New-Object System.Text.StringBuilder 256
  [void]$W::GetClassNameW($h, $sb, 256)
  $sb.ToString()
}

$pids = @(Get-Process | Where-Object { $_.Path -like "$dir\\*" } | ForEach-Object { [uint32]$_.Id })
$out = New-Object System.Collections.ArrayList

if ($pids.Count -gt 0) {
  $cb = [SakuraWin.Api+EnumProc] {
    param($h, $l)
    $wpid = [uint32]0
    [void]$W::GetWindowThreadProcessId($h, [ref]$wpid)
    if (($pids -contains $wpid) -and $W::IsWindowVisible($h)) {
      $kids = New-Object System.Collections.ArrayList
      $ccb = [SakuraWin.Api+EnumProc] {
        param($c, $m)
        $t = Get-T $c
        if ($t) { [void]$kids.Add($t) }
        return $true
      }
      [void]$W::EnumChildWindows($h, $ccb, [IntPtr]::Zero)
      [void]$out.Add([pscustomobject]@{
        className = Get-C $h
        title = Get-T $h
        controls = @($kids)
      })
    }
    return $true
  }
  [void]$W::EnumWindows($cb, [IntPtr]::Zero)
}

ConvertTo-Json -Compress -Depth 4 -InputObject @($out)
`

/**
 * Every visible window belonging to a process running out of `dir`.
 *
 * Returns null when the query itself failed. That must never be read as "no windows" —
 * the difference between "it is showing nothing" and "we could not look" is the
 * difference between a finding and a fabrication.
 */
export function readWindowsIn(dir: string): Promise<ForeignWindow[] | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)

  const script = PS_TEMPLATE.replace('__DIR__', dir.replace(/'/g, "''"))
  const encoded = Buffer.from(script, 'utf16le').toString('base64')

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout.trim()) return resolve(null)
        try {
          const parsed: unknown = JSON.parse(stdout.trim() || '[]')
          if (!Array.isArray(parsed)) return resolve([])
          resolve(
            parsed.map((w) => {
              const row = w as Partial<ForeignWindow>
              return {
                className: String(row.className ?? ''),
                title: String(row.title ?? ''),
                // A single-element array comes back from PowerShell as a bare value.
                controls: Array.isArray(row.controls)
                  ? row.controls.map(String)
                  : row.controls
                    ? [String(row.controls)]
                    : []
              }
            })
          )
        } catch {
          resolve(null)
        }
      }
    )
  })
}
