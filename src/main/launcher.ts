import { shell } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import * as db from './db'
import { t } from './i18n'
import { watchLaunch } from './launch-watch'
import { beginSession } from './playtime'

export interface LaunchResult {
  ok: boolean
  error?: string
}

/**
 * How long to wait for the operating system to reject a program before calling it
 * started. The `error` event lands as soon as CreateProcess fails, so this only has to
 * outlast the syscall — long enough to be reliable, short enough not to be felt.
 */
const SPAWN_GRACE_MS = 300

/** Turn the errno into something worth reading. */
function describeSpawnError(err: NodeJS.ErrnoException): string {
  if (err.code === 'EACCES' || err.code === 'EPERM') {
    return t('launch.refused')
  }
  if (err.code === 'ENOENT') return t('launch.notFound')
  if (err.code === 'UNKNOWN') return t('launch.notRunnable')
  return err.message
}

/**
 * Start a program detached, and give its immediate failures a chance to surface.
 *
 * `spawn` does not throw for EACCES, EPERM or a malformed binary — it reports them
 * through an `error` event some moments later. Returning as soon as the call comes back
 * therefore claims success for programs that never ran, which is exactly how a game can
 * announce that it is starting, light up the running badge, and do nothing whatsoever. Waiting out
 * that event costs a third of a second and turns silence into a reason.
 */
export function spawnDetached(exe: string, args: string[], cwd: string): Promise<LaunchResult> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(exe, args, { cwd, detached: true, stdio: 'ignore' })
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
      return
    }

    let settled = false
    const finish = (result: LaunchResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    child.once('error', (err: NodeJS.ErrnoException) => {
      finish({ ok: false, error: describeSpawnError(err) })
    })
    setTimeout(() => {
      // Only now: until the grace period is up this process object is what carries the
      // failure, and a detached child that started fine outlives us either way.
      child.unref()
      finish({ ok: true })
    }, SPAWN_GRACE_MS)
  })
}

/**
 * Launch a game detached, with the working directory set to the game folder.
 * Many doujin engines resolve their assets relative to cwd, so launching from
 * anywhere else silently breaks them.
 *
 * Arguments recorded from a dropped shortcut or chosen in the executable picker are
 * passed through. Without them a launcher-based entry starts the launcher and stops
 * there — `steam.exe` with no `-applaunch` just brings Steam to the front, which reads
 * as "it said it started and nothing happened".
 */
export async function launchGame(id: string): Promise<LaunchResult> {
  const game = db.findGame(id)
  if (!game) return { ok: false, error: t('err.gameNotFound') }
  if (!game.exe) return { ok: false, error: t('launch.noExe') }
  if (!fs.existsSync(game.exe)) return { ok: false, error: t('launch.exeMissing', { exe: game.exe }) }

  const cwd =
    game.launchCwd && fs.existsSync(game.launchCwd) ? game.launchCwd : path.dirname(game.exe)

  const result = await spawnDetached(game.exe, game.launchArgs ?? [], cwd)
  if (!result.ok) return result

  // Opens the play session, which is what bumps lastLaunchedAt and launchCount —
  // and closes it again once the game is gone, recording how long it ran.
  beginSession(game)
  // CreateProcess succeeding only means the file was accepted, not that a game appeared.
  // A missing runtime, a refused elevation and a launcher stub that exits all look exactly
  // like this from here, and all three used to end in silence.
  if (db.getSettings().diagnoseOnLaunch) watchLaunch(game)
  return { ok: true }
}

/**
 * Launch through the shell's `runas` verb, which is the only way to get the UAC prompt.
 *
 * `spawn` cannot elevate — it inherits our token, so an executable whose manifest demands
 * administrator rights is refused before it starts. PowerShell's `Start-Process -Verb
 * RunAs` asks the shell to do it properly. The user can still decline the prompt, and
 * declining is reported as such rather than as a failure.
 */
export async function launchElevated(id: string): Promise<LaunchResult> {
  const game = db.findGame(id)
  if (!game) return { ok: false, error: t('err.gameNotFound') }
  if (!game.exe || !fs.existsSync(game.exe)) return { ok: false, error: t('launch.exeMissingShort') }

  const cwd =
    game.launchCwd && fs.existsSync(game.launchCwd) ? game.launchCwd : path.dirname(game.exe)
  const args = game.launchArgs ?? []

  // Single-quoted PowerShell strings with doubled quotes: the only escaping that holds up
  // for the paths these games live in, which are full of spaces and brackets.
  const ps = (s: string): string => `'${s.replace(/'/g, "''")}'`
  const command =
    `Start-Process -FilePath ${ps(game.exe)} -WorkingDirectory ${ps(cwd)} -Verb RunAs` +
    (args.length > 0 ? ` -ArgumentList ${args.map(ps).join(',')}` : '')

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: 120_000 },
      (err, _stdout, stderr) => {
        if (!err) {
          beginSession(game)
          return resolve({ ok: true })
        }
        // Declining the UAC prompt is a choice, not a fault, and reads as one.
        const text = String(stderr || err.message)
        if (/canceled|cancelled|拒绝|操作已取消/i.test(text)) {
          return resolve({ ok: false, error: t('launch.uacDeclined') })
        }
        resolve({ ok: false, error: text.trim() || t('launch.elevateFailed') })
      }
    )
  })
}

/**
 * Wrap a path the way explorer.exe expects to read it.
 *
 * Explorer parses its own command line, so the quotes have to be part of the argument
 * and the child spawned verbatim. A trailing backslash would escape the closing quote,
 * and only a drive root ever ends in one — those have no spaces, so they need no quotes.
 */
function explorerArg(target: string): string {
  const clean = target.length > 3 && target.endsWith('\\') ? target.slice(0, -1) : target
  return /\s/.test(clean) ? `"${clean}"` : clean
}

/**
 * Show a path in Windows Explorer.
 *
 * A folder used to be handed to `shell.openPath`, which runs the "open" verb on it —
 * that is whatever program the machine has registered for folders, so on a machine with
 * a third-party file manager installed it was never Explorer at all. Naming explorer.exe
 * is the only way to mean the window the user is picturing. Files go through
 * `showItemInFolder`, which calls the shell API directly and lands on the file selected.
 */
export function revealInExplorer(target: string): void {
  if (!fs.existsSync(target)) return

  let isDir: boolean
  try {
    isDir = fs.statSync(target).isDirectory()
  } catch {
    return
  }

  if (!isDir || process.platform !== 'win32') {
    if (isDir) void shell.openPath(target)
    else shell.showItemInFolder(target)
    return
  }

  try {
    const child = spawn('explorer.exe', [explorerArg(target)], {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true
    })
    // Explorer exits with a non-zero code even when it opened the window, so only an
    // outright failure to start it is worth reacting to.
    child.once('error', () => void shell.openPath(target))
    child.unref()
  } catch {
    void shell.openPath(target)
  }
}
