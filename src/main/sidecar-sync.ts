import fs from 'node:fs'
import path from 'node:path'
import type { Game, Tier } from '../shared/types'
import { MAX_SESSIONS, normalizeStatus, TIERS } from '../shared/types'
import * as db from './db'
import { readSidecar, SIDECAR, writeSidecarIfChanged, type SidecarData } from './scan-core'

/**
 * Keeping the per-game Markdown files in step with the database.
 *
 * The database is what the app reads at startup — one file, one parse, instant. The
 * sidecars are the durable, human-readable copy, and they are only touched at three
 * moments: an explicit scan, and the start and end of a play session. Reading every
 * sidecar on every launch would mean a disk round-trip per game for data we already
 * have.
 *
 * When the two disagree, the more recently modified one wins. Since the app rewrites
 * the sidecar after every change it makes, a sidecar that is newer than our record of
 * writing it can only mean one thing: the user edited it by hand.
 */

/**
 * Slack between writing a file and recording its mtime. Some filesystems only keep
 * whole-second precision, so an exact comparison would read every write back as an
 * edit by the user.
 */
const MTIME_TOLERANCE_MS = 2000

function statMtime(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return null
  }
}

export function toSidecar(game: Game): SidecarData {
  return {
    name: game.name,
    wishlist: game.wishlist,
    playing: game.playing,
    played: game.played,
    rating: game.rating,
    tier: game.tier,
    tags: game.tags,
    playtimeMs: game.playtimeMs,
    launchCount: game.launchCount,
    lastLaunchedAt: game.lastLaunchedAt,
    sessions: game.sessions
  }
}

/** Only fields the file actually carried are applied; the rest keep their stored value. */
function applySidecar(game: Game, data: SidecarData): void {
  if (data.name && data.name !== game.name) {
    game.name = data.name
    // The sidecar is the source of truth for the title, so the database-only
    // override that `renamed` represents no longer applies.
    game.renamed = false
  }

  const status: Partial<Game> = {}
  if (typeof data.wishlist === 'boolean') status.wishlist = data.wishlist
  if (typeof data.playing === 'boolean') status.playing = data.playing
  if (typeof data.played === 'boolean') status.played = data.played
  if (Object.keys(status).length > 0) {
    // A hand-edited file can easily claim both 想玩 and 在玩; hold it to the same
    // rule the UI enforces rather than letting an impossible state into the library.
    Object.assign(game, normalizeStatus(game, status))
  }

  if (data.rating !== undefined) {
    game.rating = typeof data.rating === 'number' ? Math.min(5, Math.max(0, data.rating)) : null
  }
  if (data.tier !== undefined) {
    game.tier = TIERS.includes(data.tier as Tier) ? (data.tier as Tier) : null
  }
  if (data.tags !== undefined) game.tags = data.tags
  if (data.playtimeMs !== undefined) game.playtimeMs = data.playtimeMs
  if (data.launchCount !== undefined) game.launchCount = data.launchCount
  if (data.lastLaunchedAt !== undefined) game.lastLaunchedAt = data.lastLaunchedAt
  if (data.sessions !== undefined) {
    game.sessions = [...data.sessions]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, MAX_SESSIONS)
  }
}

/**
 * Re-take the folder fingerprint the incremental scan compares against.
 *
 * Writing the sidecar changes the folder's own mtime and child count, so without this
 * every game we just wrote to looks "changed" on the next scan — which would re-extract
 * its icon and re-read its sidecar for no reason at all. Our own file appearing is not
 * the folder changing.
 */
function refreshFingerprint(game: Game): void {
  try {
    game.mtimeMs = fs.statSync(game.dir).mtimeMs
    game.childCount = fs.readdirSync(game.dir).length
  } catch {
    /* folder went away between writing and stating it */
  }
}

function syncable(game: Game): boolean {
  // Archives have no folder of their own to write into, and missing entries point at
  // a path that is not there — writing would either fail or recreate a stray file.
  return game.kind === 'installed' && !game.missing && fs.existsSync(game.dir)
}

/** Push one game out to its sidecar. Used when a play session starts and ends. */
export function writeGameSidecar(game: Game): void {
  if (!syncable(game)) return
  const result = writeSidecarIfChanged(game.dir, toSidecar(game))
  if (result.ok && result.mtimeMs !== undefined) {
    game.sidecarSyncedAt = result.mtimeMs
    if (!result.skipped) refreshFingerprint(game)
  }
}

export interface SyncOutcome {
  /** Sidecars that had been hand-edited and were read back in. */
  imported: number
  /** Sidecars rewritten from the database. */
  exported: number
}

/**
 * Reconcile every installed game with its sidecar. Called only from an explicit scan.
 */
export function syncAll(): SyncOutcome {
  let imported = 0
  let exported = 0

  for (const game of db.getGames()) {
    if (!syncable(game)) continue
    const file = path.join(game.dir, SIDECAR)
    const mtime = statMtime(file)

    if (mtime !== null && mtime > (game.sidecarSyncedAt ?? 0) + MTIME_TOLERANCE_MS) {
      const data = readSidecar(game.dir)
      if (data) {
        applySidecar(game, data)
        imported++
        // Rewrite so formatting is normalised and the recorded mtime is ours again.
        const result = writeSidecarIfChanged(game.dir, toSidecar(game))
        game.sidecarSyncedAt = result.mtimeMs ?? statMtime(file) ?? Date.now()
        if (!result.skipped) refreshFingerprint(game)
        continue
      }
    }

    const result = writeSidecarIfChanged(game.dir, toSidecar(game))
    if (result.ok && result.mtimeMs !== undefined) {
      if (!result.skipped) {
        exported++
        refreshFingerprint(game)
      }
      game.sidecarSyncedAt = result.mtimeMs
    }
  }

  db.saveNow()
  return { imported, exported }
}
