import { app, shell } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Game, MagpieStatus, UpscaleNotice } from '../shared/types'
import * as db from './db'
import { buildConfig, listModes, parseConfig } from './magpie-config'
import {
  MAGPIE_VERSION,
  instanceVerdict,
  mayStop,
  needsReinstall,
  supportsMagpie,
  type InstanceVerdict
} from './magpie-rules'
import { effectiveUpscale, upscaleTargets } from './upscale-rules'
import { playingIds } from './playtime'

/**
 * Running Magpie on the library's behalf.
 *
 * The judgement lives in `magpie-rules.ts` and `magpie-config.ts`; this file is the part
 * that touches disks and processes. Three things shape it:
 *
 *  - **The copy is ours alone.** Magpie treats a `config\config.json` next to its
 *    executable as a signal to run in portable mode, so a copy laid down under
 *    `%APPDATA%` with that file present reads and writes nothing else. That is the whole
 *    reason a user's own Magpie installation is never disturbed, and `startMagpie`
 *    refuses to run without it.
 *  - **Never write that file while Magpie is running.** It rewrites it from memory on
 *    exit, so a profile written underneath a live Magpie vanishes the moment the user
 *    closes their game — silently, and long after the action that caused it.
 *  - **Everything is serialised.** Two launches in quick succession, or a launch while
 *    the settings page changes a mode, must not produce two writers.
 */

const MAGPIE_EXE = 'Magpie.exe'
const CONFIG_DIR = 'config'
const CONFIG_FILE = 'config.json'
const STAMP_FILE = 'sakura-stamp.json'
const OWNED_FILE = 'sakura-owned.json'

/**
 * Files of ours that a reinstall must not sweep away: the portable-mode marker and
 * everything the user has changed inside Magpie, plus our record of which profiles we
 * wrote. Everything else in the folder belongs to the release and is replaced wholesale,
 * so that a new version never runs against an old version's effect files.
 */
const KEEP_ON_REINSTALL = new Set([CONFIG_DIR.toLowerCase(), OWNED_FILE.toLowerCase()])

/**
 * How long to let Magpie finish writing after it says it has exited.
 *
 * Its final act is to save this config file, and the `exit` event does not promise the
 * write has reached the disk. The same order of magnitude as `SPAWN_GRACE_MS` in
 * `launcher.ts`, and the same kind of debt: a fraction of a second spent not corrupting
 * something.
 */
const SETTLE_MS = 400

/** A Magpie that dies this fast never really started. Cf. `launch-watch.ts`. */
const EARLY_EXIT_MS = 3_000

/**
 * How long a Magpie asked to close is given before it is ended outright.
 *
 * It has one window and a configuration file to write; two seconds is generous for that
 * and short enough that a game waiting on a restart is not left hanging.
 */
const GRACEFUL_EXIT_MS = 2_000

let child: ChildProcess | null = null
/** Set when the running copy was started through UAC, which means we cannot stop it. */
let startedElevated = false
/**
 * True while this program is deliberately ending Magpie.
 *
 * Read by the early-exit watch, which otherwise cannot tell a Magpie that failed to start
 * from one that was stopped on purpose two seconds after starting — a routine sequence
 * when a second game is launched with a different mode.
 */
let stopping = false
/** Cleared only on restart: a failed copy must not be retried on every single launch. */
let installFailure: string | null = null
/**
 * A set rather than one slot, for the reason `playtime.ts` uses one: a second subscriber
 * assigning over the first would silently take the toasts away, and the fault would be
 * blamed on whatever stopped appearing rather than on the thing that displaced it.
 */
const listeners = new Set<(notice: UpscaleNotice) => void>()

/** Returns the unsubscribe, as every other `onX` in the program does. */
export function onMagpieNotice(fn: (notice: UpscaleNotice) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notice(key: UpscaleNotice['key'], vars?: UpscaleNotice['vars']): void {
  for (const fn of listeners) fn({ key, vars })
}

/**
 * One writer at a time.
 *
 * Everything that touches the config file or the process goes through here, so that
 * double-clicking a tile cannot interleave two stop-write-start sequences. Failures are
 * swallowed into the chain rather than breaking it — a launch that went wrong must not
 * wedge every launch after it.
 */
let chain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => undefined)
  return run
}

/** Where the release was unpacked at build time, or in the repo during development. */
function bundledDir(): string | null {
  const roots = app.isPackaged
    ? [path.join(process.resourcesPath, 'magpie')]
    : [
        path.join(app.getAppPath(), 'resources', 'magpie'),
        path.join(process.cwd(), 'resources', 'magpie')
      ]
  for (const root of roots) {
    if (fs.existsSync(path.join(root, MAGPIE_EXE))) return root
  }
  return null
}

function installDir(): string {
  return path.join(app.getPath('userData'), 'magpie')
}

function ourExe(): string {
  return path.join(installDir(), MAGPIE_EXE)
}

function configPath(): string {
  return path.join(installDir(), CONFIG_DIR, CONFIG_FILE)
}

/** Write through a temporary file, so an interrupted write cannot truncate the original. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, text, 'utf-8')
  fs.renameSync(tmp, file)
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

function readOwned(): string[] {
  const raw = readJson(path.join(installDir(), OWNED_FILE))
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
}

/**
 * Every running Magpie's image path, or **null when the question could not be asked**.
 *
 * Same shape as `playtime.ts`'s process query, including the forced output encoding —
 * this program's own copy lives under a user profile path that may well contain
 * characters the console codepage cannot carry — and, for the same reason as there, the
 * difference between "nothing is running" and "the query failed" is kept. Collapsing them
 * would let a PowerShell that timed out authorise deleting the folder of a live Magpie.
 *
 * `Get-CimInstance` rather than `Get-Process`: reading `.Path` off a process means opening
 * it, which Windows refuses across integrity levels, so an **elevated** Magpie would come
 * back with an empty path and be filtered out — invisible exactly when it matters most,
 * since that is the copy this program cannot stop. WMI answers from a service context and
 * reports the path either way.
 */
function runningMagpies(): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
          "Get-CimInstance Win32_Process -Filter \"Name = 'Magpie.exe'\" " +
          '-ErrorAction SilentlyContinue | ForEach-Object { $_.ExecutablePath }'
      ],
      { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve(null)
        resolve(
          stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
        )
      }
    )
  })
}

/**
 * What is running, or null when that could not be established.
 *
 * Every caller has to answer null the cautious way — not starting, not stopping, not
 * copying over — because the alternative is acting on a guess about another process.
 */
async function verdict(): Promise<InstanceVerdict | null> {
  const paths = await runningMagpies()
  return paths === null ? null : instanceVerdict(paths, ourExe())
}

/**
 * Lay the release down under `%APPDATA%`, if it is not already there.
 *
 * The copy has to be somewhere writable: Magpie keeps its configuration next to its own
 * executable in portable mode, and the installed program directory is read-only for a
 * per-user install under Program Files. So the ten megabytes are copied once, on first
 * use rather than at startup — a program that made every launch wait on I/O for a feature
 * most libraries will never switch on would be a poor trade.
 */
async function ensureInstalled(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (installFailure) return { ok: false, error: installFailure }

  const dir = installDir()
  const stamp = readJson(path.join(dir, STAMP_FILE))
  const exeThere = fs.existsSync(path.join(dir, MAGPIE_EXE))
  if (exeThere && !needsReinstall(stamp, MAGPIE_VERSION)) return { ok: true }

  const source = bundledDir()
  if (!source) {
    // Running from source without `npm run magpie:fetch`, or a build that shipped without
    // the release. Not a failure worth remembering — the next start may well have it.
    return { ok: false, error: 'not bundled' }
  }

  // Replacing files underneath a running Magpie would be a fine way to produce a crash
  // nobody can explain. It will be reinstalled on a later launch instead — and a query
  // that failed counts as "possibly running", since this is the destructive branch.
  const before = await verdict()
  if (before === null || before.kind !== 'none') return { ok: false, error: 'running' }

  try {
    // Asynchronous throughout: this moves thirty megabytes, and the synchronous form runs
    // on the thread that services every IPC call — the window would sit frozen mid-toggle,
    // with nothing on screen to say why. The enclosing queue already keeps it to one at a
    // time, which was the only thing the blocking calls were buying.
    if (exeThere) {
      for (const entry of await fs.promises.readdir(dir)) {
        if (KEEP_ON_REINSTALL.has(entry.toLowerCase())) continue
        await fs.promises.rm(path.join(dir, entry), { recursive: true, force: true })
      }
    }
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.cp(source, dir, { recursive: true })

    // Written before Magpie is ever started: without it Magpie would run in its ordinary
    // mode and read — and on exit rewrite — the user's own configuration under
    // %LOCALAPPDATA%. Everything else here depends on this file existing.
    //
    // Seeded properly rather than left as `{}`, because an empty config is not a harmless
    // default: Magpie only creates its built-in scaling modes when there is no config file
    // at all, and its importer returns early on a missing list rather than filling one in.
    // A user who switches this on and opens Magpie by hand before ever launching a game
    // would otherwise find it with no scaling modes whatsoever.
    if (!fs.existsSync(configPath())) {
      const settings = db.getSettings()
      const seed = buildConfig(
        null,
        { profiles: [], defaultMode: settings.upscaleMode, language: settings.language },
        []
      )
      writeAtomic(configPath(), JSON.stringify(seed.config, null, 2))
    }

    writeAtomic(
      path.join(dir, STAMP_FILE),
      JSON.stringify(
        { magpieVersion: MAGPIE_VERSION, appVersion: app.getVersion(), copiedAt: Date.now() },
        null,
        2
      )
    )
    return { ok: true }
  } catch (err) {
    installFailure = err instanceof Error ? err.message : String(err)
    return { ok: false, error: installFailure }
  }
}

/**
 * Magpie's own switch for starting into the notification area without its interface.
 *
 * It is honoured only when the tray icon is on, which is why `buildConfig` forces
 * `showNotifyIcon` — the two are one decision, not two.
 *
 * Reaching for this rather than hiding the window from outside is not a matter of taste.
 * A process started with `SW_HIDE` in its `STARTUPINFO` still *creates* its main window
 * and merely leaves it unshown, and Magpie's own "show me" path then finds a window it
 * believes is already open and does nothing further — so a Magpie started that way could
 * never be brought on screen again by any means this program has. With `-t` no window is
 * made at all, and the first request for one produces a real, visible window.
 */
const TRAY_ONLY = '-t'

/**
 * Start our copy, and notice if it dies on the spot.
 *
 * `showWindow` is the difference between the two reasons this program starts Magpie. A
 * game wants none: an interface opening over a game that is still loading, taking the
 * focus with it, is a worse fault than no scaling at all. The settings button wants one,
 * because the window is the entire point of the click.
 */
function startMagpie(elevated: boolean, showWindow: boolean): Promise<void> {
  return new Promise((resolve) => {
    const dir = installDir()
    const exe = ourExe()
    const args = showWindow ? [] : [TRAY_ONLY]

    // The guarantee that this copy will not touch the user's own configuration. If the
    // marker is somehow gone, not starting is the only safe answer.
    if (!fs.existsSync(configPath())) {
      notice('magpie.startFailed')
      return resolve()
    }

    if (elevated) {
      // Only PowerShell's `runas` verb raises the prompt; a plain spawn inherits our token
      // and would be refused. Single-quoted with doubled quotes, as in `launcher.ts`.
      const ps = (s: string): string => `'${s.replace(/'/g, "''")}'`
      const list = args.length > 0 ? ` -ArgumentList ${args.map(ps).join(',')}` : ''
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Start-Process -FilePath ${ps(exe)} -WorkingDirectory ${ps(dir)} -Verb RunAs${list}`
        ],
        { windowsHide: true, timeout: 120_000 },
        (err) => {
          if (err) notice('magpie.startFailed')
          else startedElevated = true
          resolve()
        }
      )
      return
    }

    let proc: ChildProcess
    try {
      // No `windowsHide`: Magpie is a GUI program with no console to suppress, so the flag
      // buys nothing and costs the `SW_HIDE` described above — which is exactly how this
      // went wrong the first time. What it shows is decided by `args`, and only by `args`.
      proc = spawn(exe, args, { cwd: dir, stdio: 'ignore' })
    } catch {
      notice('magpie.startFailed')
      return resolve()
    }

    const startedAt = Date.now()
    child = proc
    startedElevated = false

    proc.once('error', () => {
      if (child === proc) child = null
      notice('magpie.startFailed')
      resolve()
    })

    proc.once('exit', () => {
      if (child === proc) child = null
      if (Date.now() - startedAt >= EARLY_EXIT_MS) return
      // A stop this program asked for is not a crash. Without this, changing a mode and
      // starting a second game inside three seconds ends Magpie on purpose and then blames
      // the graphics card for it — a diagnosis about hardware that is simply untrue.
      if (stopping) return
      // Gone as soon as it appeared. Either the user's own copy holds the single-instance
      // lock, or the machine cannot give it the Direct3D feature level it needs — and we
      // have no way to ask about the latter, so it is the remaining explanation.
      void runningMagpies().then((paths) => {
        // The query failed; there is nothing to report but a guess, so nothing is said.
        if (paths === null) return
        const v = instanceVerdict(paths, exe)
        if (v.kind === 'foreign') notice('magpie.foreign', { path: v.path })
        else notice('magpie.exited')
      })
    })

    // Long enough for a refusal to surface as an `error`, as in `spawnDetached`.
    setTimeout(resolve, 300)
  })
}

/**
 * Ask the Magpie that is already running to show its window.
 *
 * A second process is started and exits on the spot, by design: Magpie's single-instance
 * check posts `WM_MAGPIE_SHOWME` to the copy already holding the lock, which answers by
 * bringing its main window up. That is Magpie's own published route, and the reason
 * `startMagpie` is careful to keep the running copy in a state where it still works —
 * see `TRAY_ONLY`.
 *
 * Deliberately **not** tracked: writing it into `child` would throw away the handle for
 * the Magpie that is actually running — every later stop would then kill an object that
 * had already exited, wait out the timeout and report failure — and watching it exit
 * would report a crash that did not happen.
 */
function surfaceMagpieWindow(): void {
  try {
    const proc = spawn(ourExe(), [], {
      cwd: installDir(),
      stdio: 'ignore',
      detached: true
    })
    proc.once('error', () => notice('magpie.startFailed'))
    proc.unref()
  } catch {
    notice('magpie.startFailed')
  }
}

/**
 * Stop the copy we started, and wait for it to finish writing.
 *
 * Returns false when it could not be stopped, which in practice means an elevated Magpie
 * and an unelevated launcher: Windows refuses the request and the caller must not go on
 * to rewrite a config file that is still owned by a live process.
 */
async function stopMagpie(): Promise<boolean> {
  const v = await verdict()
  // Could not be established. Reporting a stop that may not have happened is what lets the
  // caller go on to rewrite the config file underneath a live Magpie.
  if (v === null) return false
  if (v.kind === 'none') {
    child = null
    return true
  }
  // Never anything but our own copy — matched on the whole path, because matching on the
  // name would end the Magpie the user is running for their own reasons.
  if (!mayStop(v)) return false

  stopping = true
  try {
    const exe = ourExe()
    const proc = child

    // Asked to close before being ended. `taskkill` without `/F` posts WM_CLOSE, which is
    // the polite form and the only one available from outside.
    //
    // It has been measured not to end this program's Magpie, and cannot: closing Magpie's
    // main window hides it to the notification area rather than quitting, and a copy
    // started with `TRAY_ONLY` has no main window for the message to reach in the first
    // place. So the wait below always runs its course and the force branch always fires.
    // Kept because it costs a bounded wait and would be the right thing if that ever
    // changed — and it is no longer load-bearing: Magpie's own settings are saved the
    // moment they are changed, not at exit, so ending it outright loses nothing the user
    // did in its interface.
    await psStop(exe, false)

    // The close it was asked for, then the one it is not asked about. Waiting on the child
    // handle where there is one costs nothing; the fixed wait is for a copy we did not
    // start, or an elevated one, where there is no handle to wait on.
    if (proc && !startedElevated) {
      // `exitCode` is checked before waiting, every time: a Magpie that took the close and
      // went during the call above has already emitted `exit`, and a listener attached
      // afterwards would never hear it — turning the common, successful case into the full
      // two-second wait followed by a five-second one on a process that is already gone.
      const closed =
        proc.exitCode !== null ||
        (await new Promise<boolean>((resolve) => {
          const done = setTimeout(() => resolve(false), GRACEFUL_EXIT_MS)
          proc.once('exit', () => {
            clearTimeout(done)
            resolve(true)
          })
        }))
      if (!closed && proc.exitCode === null) {
        await new Promise<void>((resolve) => {
          const done = setTimeout(resolve, 5_000)
          proc.once('exit', () => {
            clearTimeout(done)
            resolve()
          })
          proc.kill()
        })
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, GRACEFUL_EXIT_MS))
      const mid = await verdict()
      if (mid === null || mid.kind === 'ours') await psStop(exe, true)
    }
    child = null

    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
    const after = await verdict()
    if (after === null || after.kind === 'ours') return false
    startedElevated = false
    return true
  } finally {
    stopping = false
  }
}

/**
 * End every Magpie whose image is our copy — by path, never by name.
 *
 * `force` picks between asking the window to close (which lets Magpie save) and ending the
 * process outright. Matched through the same CIM query as `runningMagpies`, so an elevated
 * copy is at least attempted rather than silently skipped.
 */
function psStop(exe: string, force: boolean): Promise<void> {
  return new Promise((resolve) => {
    const ps = `'${exe.replace(/'/g, "''")}'`
    const end = force
      ? 'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
      : 'ForEach-Object { taskkill /PID $_.ProcessId | Out-Null }'
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name = 'Magpie.exe'" ` +
          `-ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq ${ps} } | ${end}`
      ],
      { windowsHide: true, timeout: 20_000 },
      () => resolve()
    )
  })
}

/**
 * Whether a failed copy is worth saying anything about.
 *
 * `running` and `not bundled` are internal sentinels, not sentences — one is a state that
 * resolves itself, the other is a development checkout. Neither has ever been translated,
 * so putting either inside a message would print a bare English word in the middle of a
 * Chinese one.
 *
 * A genuine failure is said **once**. `installFailure` already stops the copy being retried
 * for the rest of the session; without this it would still raise the identical red toast on
 * every launch of every scaled game, about something the user cannot act on until they
 * restart the program and was already told.
 */
let installErrorTold = false
function reportableInstallError(error: string | undefined): error is string {
  if (error === undefined || error === 'running' || error === 'not bundled') return false
  if (installErrorTold) return false
  installErrorTold = true
  return true
}

/** Whether any game currently being played wants scaling. */
function anyScaledPlaying(playing: string[]): boolean {
  const settings = db.getSettings()
  if (!settings.upscale) return false
  const ids = new Set(playing)
  return db.getGames().some((g) => ids.has(g.id) && effectiveUpscale(settings, g).on)
}

/**
 * Bring Magpie up for a game about to start.
 *
 * Deliberately not awaited by `launchGame`: Magpie checks the foreground window when it
 * starts, so arriving a fraction of a second after the game is harmless, whereas making
 * every launch wait on it is the one cost the user would actually feel. Anything that
 * goes wrong is reported afterwards, the way a launch that never appears is.
 */
export function magpieBeforeLaunch(game: Game, opts: { elevated: boolean }): Promise<void> {
  // Answered before joining the queue, not inside it. `launchElevated` awaits this call —
  // it has to, so the two UAC prompts do not race — and the queue may be several seconds
  // deep behind a stop. A game with scaling switched off would sit there waiting for work
  // that has nothing to do with it, and its UAC prompt would not appear until it drained.
  if (!effectiveUpscale(db.getSettings(), game).on) return Promise.resolve()

  return serial(async () => {
    const settings = db.getSettings()
    if (!effectiveUpscale(settings, game).on) return

    if (!supportsMagpie(os.release())) {
      notice('magpie.unsupported')
      return
    }

    // An elevated game needs an elevated Magpie — Windows will not let an unelevated
    // process touch an administrator's window. Starting one anyway would leave a tray
    // icon that cannot do the one thing it was started for.
    const wantElevated = opts.elevated && settings.magpieElevate
    if (opts.elevated && !settings.magpieElevate) {
      notice('magpie.needsElevation')
      return
    }

    const installed = await ensureInstalled()
    if (!installed.ok) {
      if (reportableInstallError(installed.error)) {
        notice('magpie.installFailed', { error: installed.error })
      }
      return
    }

    const before = await verdict()
    // Nothing could be learned about what is running. Starting a second Magpie on that
    // basis is the one move that makes things worse, so this launch simply goes unscaled.
    if (before === null) return
    if (before.kind === 'foreign') {
      // Starting ours would lose the single-instance race and merely pull their window to
      // the front. Say whose it is instead; the game starts either way.
      notice('magpie.foreign', { path: before.path })
      return
    }

    const existing = parseConfig(
      fs.existsSync(configPath()) ? fs.readFileSync(configPath(), 'utf-8') : ''
    )
    const result = buildConfig(
      existing,
      {
        profiles: upscaleTargets(settings, db.getGames()),
        defaultMode: settings.upscaleMode,
        language: settings.language
      },
      readOwned()
    )

    const running = before.kind === 'ours'
    // Elevation cannot be changed under a running copy, so a mismatch is a restart too.
    const mustRestart = running && startedElevated !== wantElevated

    if (result.changed || mustRestart) {
      if (running && !(await stopMagpie())) {
        // An elevated Magpie this program cannot end. Rewriting the file now would only
        // have it overwritten again when that copy exits.
        notice('magpie.configLocked')
        return
      }
      writeAtomic(configPath(), JSON.stringify(result.config, null, 2))
      writeAtomic(path.join(installDir(), OWNED_FILE), JSON.stringify(result.owned, null, 2))
    }

    // Into the notification area, not onto the screen: the game is what the user is
    // waiting for, and Magpie's interface has nothing to say at this moment.
    if ((await verdict())?.kind === 'none') await startMagpie(wantElevated, false)
  })
}

/**
 * React to a session ending.
 *
 * Magpie is kept for as long as a scaled game is being played and no longer. It is not
 * left running the whole time the launcher is open because its global hotkey stays live,
 * and a launcher that reaches into whatever window the user tabs to next has overstepped.
 *
 * The signal this rides on arrives a minute or two after the game actually closed —
 * playtime's grace period. That lateness is harmless here, and cheap: the alternative is
 * a second process poll running alongside the one playtime already does.
 */
export function magpieSessionsChanged(playing: string[]): void {
  if (anyScaledPlaying(playing)) return
  if (!child && !startedElevated) return
  void serial(async () => {
    // Asked again inside the queue: a launch may have arrived while this was waiting its
    // turn, and stopping Magpie out from under a game that just started would be worse
    // than leaving it up a while longer.
    if (anyScaledPlaying(playingIds())) return
    await stopMagpie()
  })
}

/**
 * Copy the release out ahead of time, and clear up after a crash.
 *
 * Only ever when the feature is switched on, so a library that never uses it pays
 * nothing at all.
 */
export function warmMagpie(): void {
  if (!db.getSettings().upscale) return
  void serial(async () => {
    // A Magpie left over from a launcher that crashed. Only ever our own copy, matched on
    // the full path.
    const v = await verdict()
    if (v?.kind === 'ours' && !child) await stopMagpie()
    await ensureInstalled()
  })
}

/**
 * Called from `before-quit`, after playtime has closed its sessions.
 *
 * A hard end, unlike `stopMagpie`: `before-quit` is not a place to wait two seconds on
 * another process, and a Magpie that ignored the close would hold the launcher's own exit
 * open. Nothing is lost by it — Magpie writes each setting as it is changed rather than at
 * exit, so its own interface has already saved whatever was done there.
 */
export function shutdownMagpie(): void {
  const proc = child
  child = null
  if (proc) proc.kill()
}

export async function magpieStatus(): Promise<MagpieStatus> {
  const settings = db.getSettings()
  const base = {
    backend: 'magpie' as const,
    supported: supportsMagpie(os.release()),
    installed: fs.existsSync(ourExe()),
    version: MAGPIE_VERSION
  }
  // With the master switch off nothing of ours can be running, and "off means off" is the
  // one guarantee that makes this answerable without asking the operating system. The
  // settings page still needs `supported` — it is what disables the switch on a machine too
  // old for Magpie — so the question is answered, just not at the price of a process query.
  if (!settings.upscale) return { ...base, running: false }

  const v = await verdict()
  const playing = new Set(playingIds())
  // Which game this copy is up for. Read from the sessions actually open rather than
  // remembered from the launch, so it stays right when one game is closed and another
  // started without Magpie ever stopping in between.
  const forGame = db.getGames().find((g) => playing.has(g.id) && effectiveUpscale(settings, g).on)
  return {
    ...base,
    // A query that failed reads as "not running" here and nowhere else. This line is a
    // display, and the next poll is five seconds away; every other caller of `verdict`
    // treats null as a reason not to act.
    running: v?.kind === 'ours',
    forGame: v?.kind === 'ours' ? forGame?.name : undefined,
    foreign: v?.kind === 'foreign' ? v.path : undefined
  }
}

/**
 * The scaling modes this copy's config file actually offers.
 *
 * Read from the file rather than answered from the built-in list, because Magpie's own
 * interface can build modes out of the shaders under `effects\` — far more of them than the
 * seven defaults use — and one built there is exactly the mode somebody went looking for.
 * A file read only, so the settings page can ask alongside its status poll without paying
 * for another process listing.
 */
export async function magpieModes(): Promise<string[]> {
  try {
    return listModes(parseConfig(await fs.promises.readFile(configPath(), 'utf-8')))
  } catch {
    // Not laid down yet, or unreadable. `listModes` answers with the built-ins.
    return listModes(null)
  }
}

/**
 * Open Magpie's own window — everything this program does not put a control on.
 *
 * The launcher offers one scaling knob per game, deliberately; the parameters inside a
 * shader, the capture method, the frame limiter and the making of new modes are Magpie's
 * subject and its interface is already written. This is the door to it, rather than a
 * second, worse copy of it here.
 *
 * The config is brought up to date *first*, when Magpie is not already running. That is
 * not tidiness: whatever the user changes in there is saved when Magpie exits, and a
 * launch afterwards that finds the config stale would stop Magpie to rewrite it — taking
 * their edits with it. Written now, the next launch finds nothing to change and leaves the
 * running copy alone.
 */
export function openMagpieSettings(): void {
  void serial(async () => {
    const settings = db.getSettings()
    if (!supportsMagpie(os.release())) {
      notice('magpie.unsupported')
      return
    }

    const before = await verdict()
    if (before === null) return
    if (before.kind === 'foreign') {
      notice('magpie.foreign', { path: before.path })
      return
    }

    if (before.kind === 'ours') {
      // Already up — brought up for a game, most likely, and therefore sitting in the
      // notification area with no window at all. Nothing to install or write: the file
      // belongs to that process until it exits. Only the window has to be asked for.
      surfaceMagpieWindow()
      return
    }

    // Only now, with nothing running: a reinstall would otherwise be refused for that
    // reason and reported as a failure to open the window.
    const installed = await ensureInstalled()
    if (!installed.ok) {
      if (reportableInstallError(installed.error)) {
        notice('magpie.installFailed', { error: installed.error })
      }
      return
    }

    const existing = parseConfig(
      fs.existsSync(configPath()) ? fs.readFileSync(configPath(), 'utf-8') : ''
    )
    const result = buildConfig(
      existing,
      {
        profiles: upscaleTargets(settings, db.getGames()),
        defaultMode: settings.upscaleMode,
        language: settings.language
      },
      readOwned()
    )
    if (result.changed) {
      writeAtomic(configPath(), JSON.stringify(result.config, null, 2))
      writeAtomic(path.join(installDir(), OWNED_FILE), JSON.stringify(result.owned, null, 2))
    }

    // The one place Magpie is started with its window on screen: it is what was clicked for.
    await startMagpie(false, true)
  })
}

/** Show the user where the copy lives — the folder they would delete to reclaim the space. */
export function openMagpieFolder(): void {
  const dir = installDir()
  if (fs.existsSync(dir)) void shell.openPath(dir)
}
