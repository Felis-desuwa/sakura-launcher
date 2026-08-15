import { execFile } from 'node:child_process'
import path from 'node:path'
import type { Game } from '../shared/types'
import { MAX_SESSIONS, MIN_SESSION_MS } from '../shared/types'
import * as db from './db'
import { writeGameSidecar } from './sidecar-sync'

/**
 * How long a game was actually played.
 *
 * Watching the process we spawned is not enough. A large share of these games ship a
 * launcher executable that starts the real program and exits immediately — the same
 * pattern `EXE_WEAK` in the scanner exists to cope with. Listening for that child's
 * exit would record most sessions as lasting two seconds.
 *
 * So instead of following a process, we watch the folder: as long as *any* running
 * process has its image inside the game directory, the game is being played. That also
 * survives games that relaunch themselves into a different binary, config tools opened
 * mid-session, and multi-process engines.
 */

interface Session {
  game: Game
  /** Start of the stretch not yet added to playtimeMs. */
  startedAt: number
  /** Start of the session as a whole, for the timeline entry. */
  openedAt: number
  /** Last time a process belonging to this game was seen. */
  lastSeen: number
  /** Consecutive polls with no process found. */
  misses: number
  /** How much of this session has already been added to playtimeMs. */
  banked: number
}

/**
 * A game may need a while to show up: archives self-extract, launchers hand off, UAC
 * prompts wait on the user. Never end a session inside this window.
 */
const GRACE_MS = 90_000

/** Consecutive empty polls before a session is considered over. */
const MAX_MISSES = 2

/** Bank the time so far this often, so a crash costs minutes rather than an evening. */
const CHECKPOINT_MS = 5 * 60_000

const active = new Map<string, Session>()
let timer: NodeJS.Timeout | null = null
const listeners = new Set<(payload: PlaytimeUpdate) => void>()

export interface PlaytimeUpdate {
  id: string
  playtimeMs: number
  playing: boolean
}

/**
 * Be told when a session opens or closes.
 *
 * A set rather than the single slot this used to be. For a long time the renderer bridge
 * was the only subscriber and a lone variable was enough — but a second caller assigning
 * over it would have silently stopped the play timer updating on screen, which is the
 * kind of fault that gets blamed on the timer rather than on the thing that displaced it.
 * Returns an unsubscribe function, matching the `onX` convention the preload bridge uses.
 */
export function onPlaytimeChange(fn: (payload: PlaytimeUpdate) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function emit(game: Game, playing: boolean): void {
  const payload: PlaytimeUpdate = { id: game.id, playtimeMs: game.playtimeMs, playing }
  for (const fn of listeners) fn(payload)
}

/**
 * Every running process's image path, or null if the query failed.
 *
 * The output encoding has to be forced. PowerShell otherwise writes stdout in the
 * console codepage — 936 on a Chinese system — and node decodes it as UTF-8, so every
 * path containing a Chinese character comes back as mojibake and matches nothing.
 * Since most of these games live in folders named in Chinese, that silently recorded
 * a playtime of zero for all of them.
 */
function runningPaths(): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
          'Get-Process | Where-Object { $_.Path } | ForEach-Object { $_.Path }'
      ],
      { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve(null)
        resolve(
          stdout
            .split(/\r?\n/)
            .map((line) => line.trim().toLowerCase())
            .filter(Boolean)
        )
      }
    )
  })
}

/** True when the executable lives inside the game folder rather than merely alongside it. */
function insideDir(exePath: string, dir: string): boolean {
  const prefix = dir.toLowerCase().replace(/[\\/]+$/, '') + path.sep
  return exePath.startsWith(prefix)
}

/**
 * Whether anything is running out of this folder right now.
 *
 * Exposed for the executable picker: after trying one, this is what turns "I clicked it
 * and I have no idea whether that did anything" into an answer. Returns null when the
 * process query itself failed, which must not be read as "nothing is running".
 */
export async function runningInDir(dir: string): Promise<boolean | null> {
  const paths = await runningPaths()
  if (paths === null) return null
  return paths.some((p) => insideDir(p, dir))
}

/** Move elapsed time into the stored total without ending the session. */
function bank(session: Session, until: number): void {
  const elapsed = until - session.startedAt
  if (elapsed <= 0) return
  session.game.playtimeMs += elapsed
  session.banked += elapsed
  session.startedAt = until
}

function finish(session: Session, endedAt: number): void {
  bank(session, endedAt)
  const total = endedAt - session.openedAt
  if (total >= MIN_SESSION_MS) {
    session.game.sessions = [
      { startedAt: session.openedAt, ms: total },
      ...session.game.sessions
    ].slice(0, MAX_SESSIONS)
  } else {
    // Too short to have been a real session — a mis-click, or a game that failed to
    // start. Keep it out of the timeline and take back whatever was already banked.
    session.game.playtimeMs = Math.max(0, session.game.playtimeMs - session.banked)
  }
  active.delete(session.game.id)
  db.saveNow()
  writeGameSidecar(session.game)
  emit(session.game, false)
}

async function poll(): Promise<void> {
  if (active.size === 0) return stopTimer()

  const paths = await runningPaths()
  const now = Date.now()

  for (const session of [...active.values()]) {
    // A failed query must not be read as "the game exited"; wait for the next round.
    const seen = paths === null || paths.some((p) => insideDir(p, session.game.dir))

    if (seen) {
      session.lastSeen = now
      session.misses = 0
      if (now - session.startedAt >= CHECKPOINT_MS) {
        bank(session, now)
        db.save()
        emit(session.game, true)
      }
      continue
    }

    if (now - session.openedAt < GRACE_MS) continue

    session.misses++
    if (session.misses >= MAX_MISSES) {
      // Credit up to the last sighting, not to now — the game has been closed for
      // most of the polls that led here.
      finish(session, session.lastSeen)
    }
  }

  if (active.size === 0) stopTimer()
}

function startTimer(): void {
  if (timer) return
  const seconds = Math.max(5, db.getSettings().playtimePollSeconds || 15)
  timer = setInterval(() => void poll(), seconds * 1000)
}

function stopTimer(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

/** Called once a game has been spawned successfully. */
export function beginSession(game: Game): void {
  const now = Date.now()
  const open = active.get(game.id)
  if (open) {
    // Launched again while still running: treat it as the same session rather than
    // double-counting the overlap.
    open.lastSeen = now
    open.misses = 0
    return
  }

  game.lastLaunchedAt = now
  game.launchCount += 1
  active.set(game.id, {
    game,
    startedAt: now,
    openedAt: now,
    lastSeen: now,
    misses: 0,
    banked: 0
  })
  db.saveNow()
  writeGameSidecar(game)
  emit(game, true)
  startTimer()
}

/**
 * Throw away a session that turned out not to be gameplay.
 *
 * Watching the folder rather than the process is what makes this tracker survive
 * launcher hand-offs and self-restarts, but it buys that with one blind spot: a game
 * sitting on a modal error box is a live process in the game folder, and every minute
 * the box goes unnoticed was being recorded as time played. An error message is not
 * playing a game.
 *
 * Nothing is written back beyond undoing what this session banked. `lastLaunchedAt` and
 * `launchCount` stay as they are — the launch did happen, it just did not become a game.
 *
 * Known trade-off: if the player dismisses the box and the game then runs after all,
 * that run goes untimed until they launch it again. That is the right way round. Time
 * that was never played is a number the user cannot spot and cannot correct, while a
 * missing session is visible and one relaunch away.
 */
export function voidSession(id: string): void {
  const session = active.get(id)
  if (!session) return
  session.game.playtimeMs = Math.max(0, session.game.playtimeMs - session.banked)
  active.delete(id)
  if (active.size === 0) stopTimer()
  db.saveNow()
  emit(session.game, false)
}

export function isPlaying(id: string): boolean {
  return active.has(id)
}

export function playingIds(): string[] {
  return [...active.keys()]
}

/** Settle every open session. Called before the app quits. */
export function shutdownPlaytime(): void {
  stopTimer()
  const now = Date.now()
  for (const session of [...active.values()]) finish(session, now)
}
