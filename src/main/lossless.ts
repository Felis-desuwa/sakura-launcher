import { app, shell } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Game, LosslessStatus, MachineFacts, UpscaleNotice } from '../shared/types'
import { losslessPresetFor, normalizeUpscaleMode } from '../shared/types'
import * as db from './db'
import { cachedDisplays, ensureDisplays } from './display-info'
import { hdrActive, mainGpu, primaryDisplay, wholeMultiple } from './display-rules'
import {
  activeHdrSupport,
  buildSettingsXml,
  countOurProfiles,
  listProfiles,
  parseProfiles,
  startsElevated
} from './lossless-config'
import { LS_APP_ID, LS_EXE, installDirOf, looksLikeLossless, steamLibraries } from './lossless-rules'
import { playingIds } from './playtime'
import { readWindowsIn } from './window-text'
import { effectiveUpscale, upscaleTargets } from './upscale-rules'

/**
 * Driving the user's own Lossless Scaling.
 *
 * The judgement lives in `lossless-rules.ts` and `lossless-config.ts`; this file is the
 * part that touches disks and processes. It is the counterpart of `magpie.ts`, and reading
 * the two side by side is the fastest way to understand why it is shaped differently:
 * every difference comes from the same fact, which is that **there is no copy of ours**.
 *
 * Magpie is GPLv3 and travels with this program. A private copy goes under `%APPDATA%`, a
 * `config\config.json` beside it holds it in portable mode, and from then on it is a
 * process this program started, configured and may stop — the user's own Magpie, if they
 * have one, is never even read.
 *
 * Lossless Scaling is paid, closed software bought on Steam. This program cannot ship it
 * and does not try. So:
 *
 *  - **It has to be found**, not placed. A Steam library is the usual answer and an
 *    unreliable one, which is why `Settings.losslessPath` exists and outranks it.
 *  - **Its configuration is the user's.** `Settings.xml` is written only when Lossless
 *    Scaling is not running, only after the original has been copied aside, and only ever
 *    by adding and removing profiles this program named itself.
 *  - **It is not ours to stop.** Only a copy this program spawned, whose handle it still
 *    holds, is ever ended. A copy the user started, or one that raised itself to
 *    administrator and left us without a handle, is left alone for as long as it likes.
 */

/**
 * Where the user's copy keeps its settings. Not configurable — it is not our file.
 *
 * `%LOCALAPPDATA%` rather than one of Electron's named paths, because none of them is it:
 * `appData` is Roaming and `userData` is this program's own corner of it. The environment
 * variable is the direct answer, and the join is only there for a session that somehow
 * lost it.
 */
function settingsPath(): string {
  const local =
    process.env['LOCALAPPDATA'] ?? path.join(app.getPath('home'), 'AppData', 'Local')
  return path.join(local, 'Lossless Scaling', 'Settings.xml')
}

/** Our own corner, which holds one thing: the copy of their file taken before the first write. */
function ourDir(): string {
  return path.join(app.getPath('userData'), 'lossless')
}

function backupPath(): string {
  return path.join(ourDir(), 'Settings.backup.xml')
}

/**
 * How long a Lossless Scaling asked to close is given before it is ended outright.
 *
 * The same two seconds `magpie.ts` allows, for the same reason: one window and a
 * configuration file to write.
 */
const GRACEFUL_EXIT_MS = 2_000

/** Our own child, when we have one. Null covers "never started it" and "lost the handle". */
let child: ChildProcess | null = null
/**
 * Set when the copy we started raised itself to administrator.
 *
 * Lossless Scaling does that on its own, from its `<StartAsAdmin>`; nothing here asks for
 * it. The consequence is what has to be remembered: the process the shell hands back is
 * not the one that ends up running, so the handle is worthless and the copy can never be
 * stopped by us. Recorded rather than inferred, because the alternative is calling `kill`
 * on a stale handle and reporting a stop that did not happen.
 */
let startedElevated = false
/** Cleared only on restart, so one missing install is not reported on every launch. */
let toldNotFound = false

const listeners = new Set<(notice: UpscaleNotice) => void>()

/** Returns the unsubscribe, as every other `onX` in the program does. */
export function onLosslessNotice(fn: (notice: UpscaleNotice) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notice(key: UpscaleNotice['key'], vars?: UpscaleNotice['vars']): void {
  for (const fn of listeners) fn({ key, vars })
}

/**
 * One writer at a time.
 *
 * Same arrangement as `magpie.ts`: everything that touches the settings file or the
 * process goes through here, so double-clicking a tile cannot interleave two sequences.
 * Failures are swallowed into the chain rather than breaking it.
 */
let chain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => undefined)
  return run
}

/** Read the Steam registry key, or null when it is not there to read. */
function steamPath(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
          "(Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam' -Name SteamPath " +
          '-ErrorAction SilentlyContinue).SteamPath'
      ],
      { windowsHide: true, timeout: 20_000 },
      (err, stdout) => {
        const line = stdout.trim()
        resolve(err || line === '' ? null : line)
      }
    )
  })
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8').replace(/^﻿/, '')
  } catch {
    return null
  }
}

/**
 * The last automatic answer, so the settings page's five-second poll does not spawn a
 * PowerShell for the registry every time it asks.
 *
 * Invalidated by the only two things that can make it wrong: the file going away, and the
 * user pinning or unpinning a path. Deliberately *not* invalidated on a timer — an install
 * does not move while the program is open, and a cache that expired for its own reasons
 * would put the cost back without making any answer more correct.
 */
let found: { path: string; pinned: boolean } | null = null
/**
 * Whether the search has been run at all.
 *
 * Kept separately from `found` so that **not finding it is remembered too**. Without this,
 * the one machine where the answer costs the most — no Steam, or no Lossless Scaling — is
 * the one that pays for a registry query every five seconds, because a null result is
 * indistinguishable from never having looked.
 */
let searched = false

/**
 * Where Lossless Scaling is, or null.
 *
 * Three answers in order, and the order is the point. A path the user pinned wins over
 * anything worked out here, because the automatic route has several perfectly ordinary
 * ways to be wrong — Steam installed somewhere unusual, a library folder moved after the
 * fact, the install folder copied out whole, the registry cleaned by a tidying tool — and
 * every one of them ends with this program insisting it knows better than the person
 * looking at the folder.
 *
 * The automatic route reads Steam's own bookkeeping rather than guessing at paths: the
 * registry gives the client, the client's `libraryfolders.vdf` gives every library, and
 * each library's `appmanifest_993090.acf` gives the folder name under `common\`. That last
 * step matters — the folder is not the app's name and is not derivable from the id, and
 * hard-coding today's answer would break silently on the day it changed.
 */
async function findLossless(): Promise<{ path: string; pinned: boolean } | null> {
  const pinned = db.getSettings().losslessPath
  if (pinned && fs.existsSync(pinned)) return { path: pinned, pinned: true }
  if (searched && (found === null || fs.existsSync(found.path))) return found
  found = await searchLossless()
  searched = true
  return found
}

/** Clear the memo. Called when the pin changes, which is the one thing that invalidates it. */
function forgetLossless(): void {
  found = null
  searched = false
}

async function searchLossless(): Promise<{ path: string; pinned: boolean } | null> {
  const steam = await steamPath()
  if (!steam) return null

  const vdf = readText(path.join(steam, 'steamapps', 'libraryfolders.vdf'))
  // The client's own folder is a library even when the file cannot be read, and on many
  // machines it is the only one.
  const libraries = vdf ? steamLibraries(vdf) : [steam]
  for (const library of libraries.length > 0 ? libraries : [steam]) {
    const acf = readText(path.join(library, 'steamapps', `appmanifest_${LS_APP_ID}.acf`))
    if (!acf) continue
    const dir = installDirOf(acf)
    if (!dir) continue
    const exe = path.join(library, 'steamapps', 'common', dir, LS_EXE)
    if (fs.existsSync(exe)) return { path: exe, pinned: false }
  }
  return null
}

/**
 * Every running Lossless Scaling's image path, or **null when the question could not be
 * asked**.
 *
 * The same shape as `magpie.ts`'s process query, including the forced output encoding and
 * the refusal to collapse "nothing is running" into "the query failed". `Get-CimInstance`
 * rather than `Get-Process` for the reason that matters even more here than it does there:
 * reading `.Path` off a process means opening it, which Windows refuses across integrity
 * levels, and Lossless Scaling ships with `StartAsAdmin` on for many people. An elevated
 * copy would come back with an empty path and be filtered out — invisible exactly when it
 * matters, since that is the copy whose configuration must not be written underneath.
 */
function runningLossless(): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
          `Get-CimInstance Win32_Process -Filter "Name = '${LS_EXE}'" ` +
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
 * Whether one is running, treating an unanswerable query as "yes".
 *
 * The cautious direction is the one that writes nothing. A query that timed out and was
 * read as "nothing is running" would authorise rewriting a file a live Lossless Scaling
 * is going to save over from memory, and the user would lose the edit without ever seeing
 * an error — the failure this whole file is arranged around.
 */
async function isRunning(): Promise<boolean> {
  const paths = await runningLossless()
  return paths === null || paths.length > 0
}

/** Write through a temporary file, so an interrupted write cannot truncate the original. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, text, 'utf-8')
  fs.renameSync(tmp, file)
}

/**
 * Copy their file aside, once, before it is ever written to.
 *
 * Once and only once: the point of the copy is to hold the file as it was *before this
 * program touched it*, and refreshing it on every write would replace that with our own
 * last output — a backup of the thing being backed up against. If it fails, the write
 * ahead of it does not happen.
 */
function backupOnce(xml: string): boolean {
  try {
    if (fs.existsSync(backupPath())) return true
    fs.mkdirSync(ourDir(), { recursive: true })
    writeAtomic(backupPath(), xml)
    return true
  } catch {
    return false
  }
}

/** Games already told, so a library played through does not repeat itself. */
const toldNoFit = new Set<string>()

/**
 * Look once at the window the game actually put on screen, and say out loud what
 * whole-multiple scaling is about to do in silence.
 *
 * That mode does not fall back and does not report anything: when no whole multiple fits
 * inside the screen it presents the picture at its original size, which reads as the
 * upscaler having failed to start. Diagnosing it by hand took a screenshot of Lossless
 * Scaling's own overlay, because nothing in this program had ever measured how big the
 * window being scaled was — a 1280×720 game in a bordered window has a client area of
 * 1284×724, and eight pixels is the whole difference.
 *
 * **Not a third folder watcher.** `playtime.ts` and `launch-watch.ts` are kept apart
 * because they ask questions that need different timing, and this asks neither of theirs:
 * it samples once, reads a rectangle, and stops. Nothing is stored — not in the database,
 * not in the sidecar. It runs only for the one mode that can fail this way, so a library
 * on any other preset never pays for it.
 */
function checkWholeMultipleFit(game: Game, mode: string, delaySeconds: number): void {
  if (losslessPresetFor(mode)?.fields.ScalingType !== 'Integer') return
  const screen = primaryDisplay(cachedDisplays())
  if (screen === null) return

  // After Lossless Scaling's own auto-scale delay has run out, so the window has been
  // through whatever resizing the engine does on the way up and is the size that was
  // actually scaled — the same reason that delay is a setting rather than a constant.
  const timer = setTimeout(
    () => {
      void readWindowsIn(game.dir).then((windows) => {
        if (windows === null) return
        // The largest, not the first. A minimised or helper window reports a client area
        // of zero or one pixel, and these engines put several on screen.
        let best = { width: 0, height: 0 }
        for (const w of windows) {
          const width = w.clientWidth ?? 0
          const height = w.clientHeight ?? 0
          if (width * height > best.width * best.height) best = { width, height }
        }
        if (best.width <= 0 || best.height <= 0) return
        if (wholeMultiple(best, screen) > 1) return
        if (toldNoFit.has(game.id)) return
        toldNoFit.add(game.id)
        notice('lossless.integerNoFit', {
          window: `${best.width}×${best.height}`,
          needed: `${best.width * 2}×${best.height * 2}`,
          screen: `${screen.width}×${screen.height}`
        })
      })
    },
    (delaySeconds + 3) * 1000
  )
  // Never a reason to hold the process open. If the app is quit before it fires there is
  // nothing left worth telling anybody.
  timer.unref()
}

/**
 * What our profiles should claim about HDR, or null to leave the clone's own answer alone.
 *
 * `auto` is the display's word, and the two overrides exist because that reading — that
 * Lossless Scaling's HDR switch describes the screen rather than the game — was worked out
 * from the way the picture went wrong rather than from anything its authors wrote down. A
 * conclusion reached that way earns an escape hatch, the same way the hand-picked path to
 * Lossless Scaling outranks the automatic search.
 *
 * On `auto` with nothing measured the answer is null, which writes nothing at all.
 */
function resolveHdr(facts: MachineFacts | null): boolean | null {
  const mode = db.getSettings().losslessHdr
  if (mode === 'on') return true
  if (mode === 'off') return false
  return hdrActive(facts)
}

/**
 * Bring the user's profiles up to date, if that can be done safely.
 *
 * Returns what the caller has to tell the user, and nothing else happens on the way.
 */
type SyncResult = 'ok' | 'unreadable' | 'locked' | 'backup-failed' | 'write-failed'

interface SyncReport {
  result: SyncResult
  missing: string[]
  noBase: boolean
}

async function syncProfiles(): Promise<SyncReport> {
  const settings = db.getSettings()
  const file = settingsPath()
  const xml = readText(file)
  // No file yet means Lossless Scaling has never been run. Creating one would mean
  // authoring their entire configuration, which is not this program's to author.
  if (xml === null) return { result: 'unreadable', missing: [], noBase: false }

  // Asked here rather than read from the cache: this is the one moment the answer is
  // written down, and a launch is worth waiting a couple of seconds for. Normally it is
  // already known — `warmLossless` asks at startup and the answer only goes stale when
  // Windows says a display changed.
  const built = buildSettingsXml(xml, {
    targets: upscaleTargets(settings, db.getGames()),
    delaySeconds: settings.losslessDelay,
    hdr: resolveHdr(await ensureDisplays())
  })

  const carried = { missing: built.missing, noBase: built.noBase }
  if (!built.changed) return { result: 'ok', ...carried }

  // The rule this file exists for. Lossless Scaling saves this whole file from memory, so
  // anything written underneath a running copy is gone the moment the user closes it —
  // silently, and long after the action that caused it. Magpie has the same trap and
  // `magpie.ts` answers it by stopping Magpie first; there is no such answer here, because
  // stopping the user's own paid software to edit its configuration is not something this
  // program gets to do. So it waits, and says so.
  if (await isRunning()) return { result: 'locked', ...carried }

  if (!backupOnce(xml)) return { result: 'backup-failed', ...carried }
  try {
    writeAtomic(file, built.xml)
  } catch {
    return { result: 'write-failed', ...carried }
  }
  return { result: 'ok', ...carried }
}

/** Say what the sync could not do. Silent on success and on a state that resolves itself. */
function reportSync(result: SyncResult): void {
  if (result === 'locked') notice('lossless.configLocked')
  else if (result === 'unreadable') notice('lossless.noSettings')
  else if (result === 'backup-failed' || result === 'write-failed') notice('lossless.writeFailed')
}

/**
 * Start their copy.
 *
 * **No `windowsHide`, ever.** That flag is `SW_HIDE` in the `STARTUPINFO`, and the lesson
 * is written down in CLAUDE.md because it was learned the hard way on Magpie: a GUI
 * program started that way still creates its main window and merely leaves it unshown, and
 * its own "show me" path then finds a window it believes is already open and does nothing.
 * Magpie has `-t` to come up in the notification area properly; Lossless Scaling has no
 * equivalent, so its window appears. That is a wart and it is the honest one — the game is
 * spawned before this is called and takes the foreground when it finally draws.
 */
function start(exe: string, elevated: boolean): void {
  try {
    const proc = spawn(exe, [], { cwd: path.dirname(exe), stdio: 'ignore' })
    proc.once('error', () => {
      if (child === proc) child = null
      notice('lossless.startFailed')
    })
    proc.once('exit', () => {
      if (child === proc) child = null
    })
    child = proc
    // Not a request of ours — it is their `<StartAsAdmin>`. Recorded because the handle
    // above then belongs to a process that has already handed off to an elevated one, and
    // stopping it later would kill nothing while reporting success.
    startedElevated = elevated
  } catch {
    notice('lossless.startFailed')
  }
}

/** Whether any game currently being played wants scaling. */
function anyScaledPlaying(playing: string[]): boolean {
  const settings = db.getSettings()
  if (!settings.upscale || settings.upscaler !== 'lossless') return false
  const ids = new Set(playing)
  return db.getGames().some((g) => ids.has(g.id) && effectiveUpscale(settings, g).on)
}

/**
 * Bring Lossless Scaling up for a game about to start.
 *
 * Not awaited by `launchGame`, for the reason `magpieBeforeLaunch` is not: the profile
 * fires when the window appears, so arriving a moment after the game costs nothing, while
 * making every launch wait on a process listing is a delay the user would feel.
 */
export function losslessBeforeLaunch(game: Game, opts: { elevated: boolean }): Promise<void> {
  // Answered before joining the queue. `launchElevated` awaits this call, and a game with
  // scaling switched off must not wait behind work that has nothing to do with it.
  if (!effectiveUpscale(db.getSettings(), game).on) return Promise.resolve()

  return serial(async () => {
    const settings = db.getSettings()
    if (!effectiveUpscale(settings, game).on) return

    const found = await findLossless()
    if (!found) {
      // Said once per session. The user cannot act on it without leaving the program, and
      // repeating it on every launch of every game would bury everything else.
      if (!toldNotFound) {
        toldNotFound = true
        notice('lossless.notFound')
      }
      return
    }

    const { result, missing, noBase } = await syncProfiles()
    reportSync(result)
    // Named rather than counted: the whole use of this message is to let the user go and
    // look for a profile they thought they had.
    if (missing.length > 0) notice('lossless.noProfile', { modes: missing.join('、') })
    // A different problem with a different answer — see `LosslessConfigResult.noBase`.
    if (noBase) notice('lossless.noBaseProfile')

    const elevated = startsElevated(readText(settingsPath()) ?? '')
    // Windows will not let an unelevated program capture an administrator's window, so an
    // elevated game needs an elevated Lossless Scaling. Unlike Magpie's `magpieElevate`
    // there is no switch to offer: whether it elevates is its own setting, in its own
    // configuration, and this program neither changes it nor should.
    if (opts.elevated && !elevated) {
      notice('lossless.needsElevation')
      return
    }

    if (!(await isRunning())) start(found.path, elevated)

    // Scheduled here rather than awaited: the game is already running and this looks at a
    // window that does not exist yet. It answers for exactly one preset and stays silent
    // for every other, so nothing normal pays for it.
    checkWholeMultipleFit(game, effectiveUpscale(settings, game).mode, settings.losslessDelay)
  })
}

/**
 * React to a session ending.
 *
 * Lossless Scaling registers a global hotkey, and a launcher that leaves one live over
 * whatever window the user tabs to next has overstepped — the same reasoning that has
 * `magpieSessionsChanged` stop Magpie. What is different is how narrow the permission is:
 * only a copy this program started, whose handle it still holds, and which did not raise
 * itself out of reach. Anything else is the user's, running for the user's reasons.
 */
export function losslessSessionsChanged(playing: string[]): void {
  if (anyScaledPlaying(playing)) return
  const proc = child
  if (!proc || startedElevated) return
  void serial(async () => {
    // Asked again inside the queue: a launch may have arrived while this waited its turn,
    // and stopping it out from under a game that just started would be worse than leaving
    // it up a while longer.
    if (anyScaledPlaying(playingIds())) return
    if (child !== proc) return
    child = null
    if (proc.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const done = setTimeout(() => {
        proc.kill()
        resolve()
      }, GRACEFUL_EXIT_MS)
      proc.once('exit', () => {
        clearTimeout(done)
        resolve()
      })
      // Asks the window to close, which is what lets it save. `taskkill` without `/F` is
      // the polite form and the only one available from outside.
      execFile('taskkill', ['/PID', String(proc.pid)], { windowsHide: true }, () => undefined)
    })
  })
}

/**
 * Called from `before-quit`.
 *
 * A hard end, and only ever of our own child. `before-quit` is not a place to wait two
 * seconds on another process, and Lossless Scaling saves each of its settings as it is
 * changed rather than at exit, so there is nothing here to lose.
 */
export function shutdownLossless(): void {
  const proc = child
  child = null
  if (proc && !startedElevated) proc.kill()
}

/**
 * Copy their file aside ahead of time, and clear a stale pin.
 *
 * Only ever when the feature is on and pointed at this backend, so a library that never
 * uses it pays nothing. The backup is taken now rather than at the first write because
 * this is the moment the file is certainly still theirs alone.
 */
export function warmLossless(): void {
  const settings = db.getSettings()
  if (!settings.upscale || settings.upscaler !== 'lossless') return
  // Off the queue on purpose: it answers a question about the machine, not about their
  // file, and nothing downstream should wait on a PowerShell to take a backup.
  void ensureDisplays()
  void serial(async () => {
    const xml = readText(settingsPath())
    if (xml !== null) backupOnce(xml)
  })
}

export async function losslessStatus(): Promise<LosslessStatus> {
  const found = await findLossless()
  const xml = readText(settingsPath()) ?? ''
  const playing = new Set(playingIds())
  const settings = db.getSettings()
  const forGame = db
    .getGames()
    .find((g) => playing.has(g.id) && effectiveUpscale(settings, g).on)

  const paths = found ? await runningLossless() : null

  // The cache and never a fresh query: the settings page polls this every five seconds,
  // and spawning a PowerShell on a poll is a bug this program has already shipped once.
  const facts = cachedDisplays()
  const want = resolveHdr(facts)
  const mode = normalizeUpscaleMode(settings.upscaleMode)
  const active = activeHdrSupport(xml, mode)

  // Recomputed rather than remembered from the last sync, because the reasons it can
  // become true are mostly outside this program: the user edits a profile, changes the
  // preset, or switches HDR on while Lossless Scaling is up. Pure arithmetic over a file
  // of a few kilobytes that has already been read.
  const pending =
    xml !== ''
      ? buildSettingsXml(xml, {
          targets: upscaleTargets(settings, db.getGames()),
          delaySeconds: settings.losslessDelay,
          hdr: want
        }).changed
      : false

  return {
    backend: 'lossless',
    installed: found !== null,
    path: found?.path,
    pinned: found?.pinned ?? false,
    // A query that failed reads as "not running" here and nowhere else. This line is a
    // display; every other caller treats the same uncertainty as a reason not to act.
    running: (paths?.length ?? 0) > 0,
    forGame: (paths?.length ?? 0) > 0 ? forGame?.name : undefined,
    startsElevated: startsElevated(xml),
    profiles: countOurProfiles(xml),
    modes: listProfiles(xml),
    display: primaryDisplay(facts),
    gpu: mainGpu(facts),
    pendingWrite: pending,
    // Both sides have to be known. An unmeasured screen disagrees with nothing, and a mode
    // with no profile of ours yet has nothing to disagree with.
    hdrMismatch: active !== null && want !== null && active !== want
  }
}

/** Their profile titles — the modes this backend offers. Empty when the file cannot be read. */
export function losslessModes(): string[] {
  return listProfiles(readText(settingsPath()) ?? '')
}

/**
 * Open their window: everything this program does not put a control on.
 *
 * One knob per game is offered here deliberately, exactly as with Magpie. Which shader,
 * how much sharpening, whether frames are generated and how many — those are Lossless
 * Scaling's subject and its interface is already written. This is the door to it.
 *
 * The profiles are brought up to date *first*, when it is not already running, for the
 * reason `openMagpieSettings` does the same: whatever the user changes in there is saved
 * over this file, and a launch afterwards that found the profiles stale would want to
 * write them while it was running — which here means not writing them at all.
 */
export function openLosslessSettings(): void {
  void serial(async () => {
    const found = await findLossless()
    if (!found) {
      notice('lossless.notFound')
      return
    }
    if (await isRunning()) {
      // Already up. Starting a second copy is how its single-instance check is asked to
      // raise the first one's window; the process that does the asking exits immediately,
      // which is why it is deliberately not recorded as our child.
      try {
        const proc = spawn(found.path, [], {
          cwd: path.dirname(found.path),
          stdio: 'ignore',
          detached: true
        })
        proc.once('error', () => notice('lossless.startFailed'))
        proc.unref()
      } catch {
        notice('lossless.startFailed')
      }
      return
    }
    reportSync((await syncProfiles()).result)
    start(found.path, startsElevated(readText(settingsPath()) ?? ''))
  })
}

/** Show the user the folder their copy lives in. */
export async function revealLossless(): Promise<void> {
  const found = await findLossless()
  if (found) void shell.openPath(path.dirname(found.path))
}

/**
 * Take a path the user picked and either keep it or say why not.
 *
 * The check is on the file name alone, and only catches the mistake the dialog invites:
 * picking the game's executable, or Steam's, out of a list of every `.exe` on the machine.
 * Where they keep it is their business — somebody who copied the install folder out of
 * Steam is doing something reasonable and this must not stop them.
 *
 * A bad path is refused rather than stored. Storing it would outrank the automatic route
 * from then on and leave the feature permanently pointed at nothing, with the one control
 * that could fix it showing the wrong path as though it were working.
 */
export function pinLossless(exe: string | null): { ok: boolean } {
  if (exe === null) {
    db.setSettings({ losslessPath: null })
    forgetLossless()
    return { ok: true }
  }
  if (!looksLikeLossless(exe) || !fs.existsSync(exe)) return { ok: false }
  db.setSettings({ losslessPath: exe })
  forgetLossless()
  return { ok: true }
}

/**
 * Remove every profile of ours from their file.
 *
 * The way out. Switching the backend away, or off altogether, leaves profiles behind in a
 * program this one may never open again, and a user who cannot find where they came from
 * has been left with litter in software they paid for. Subject to the same rule as every
 * other write: not while it is running.
 */
export async function clearLosslessProfiles(): Promise<void> {
  const xml = readText(settingsPath())
  if (xml === null || parseProfiles(xml).every((p) => !p.ours)) return
  // Running, so the file is theirs until it exits — and unlike a launch, nothing will come
  // back later to finish the job: the backend has just been switched away, so no future
  // launch takes this path. Said out loud for that reason. Litter left silently in software
  // the user paid for, under a name they never chose, is the worst version of this.
  if (await isRunning()) {
    notice('lossless.clearLocked')
    return
  }
  // Null, not the measured answer: there is nothing left to write it into, and a value
  // here would only be a chance to get an empty result wrong.
  const built = buildSettingsXml(xml, { targets: [], delaySeconds: 0, hdr: null })
  if (!built.changed) return
  if (!backupOnce(xml)) return
  try {
    writeAtomic(settingsPath(), built.xml)
  } catch {
    notice('lossless.clearLocked')
  }
}
