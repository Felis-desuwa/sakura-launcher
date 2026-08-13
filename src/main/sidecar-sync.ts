import fs from 'node:fs'
import path from 'node:path'
import type { Game, Tier } from '../shared/types'
import { MAX_SESSIONS, normalizeStatus, TIERS } from '../shared/types'
import { adoptCover } from './covers'
import * as db from './db'
import {
  findCoverIn,
  isUnder,
  readSidecar,
  SIDECAR,
  writeSidecarIfChanged,
  type SidecarData
} from './scan-core'

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

/**
 * Paths inside the game folder are written relative to it.
 *
 * The whole point of this file is that it travels with the folder — an absolute path
 * baked into it stops being true the moment the library moves to another drive.
 * Anything that is not a path into this folder (`-applaunch 123`) is left alone.
 */
function relativizeArgs(game: Game, args: string[] | undefined): string[] | undefined {
  if (!args || args.length === 0) return undefined
  return args.map((arg) =>
    path.isAbsolute(arg) && isUnder(arg, game.dir) ? path.relative(game.dir, arg) : arg
  )
}

/** The inverse, applied only to arguments that name a file actually sitting there. */
function absolutizeArgs(game: Game, args: string[] | undefined): string[] | undefined {
  if (!args || args.length === 0) return undefined
  return args.map((arg) => {
    if (path.isAbsolute(arg) || !/\.[a-z0-9]{1,5}$/i.test(arg)) return arg
    const resolved = path.resolve(game.dir, arg)
    return isUnder(resolved, game.dir) && fs.existsSync(resolved) ? resolved : arg
  })
}

/**
 * Move a cover that lives elsewhere in beside the game.
 *
 * For the ones that predate covers being kept in the game folder: they sit under
 * `%APPDATA%`, pointed at by an absolute path, and nothing would ever bring them across
 * on their own — a catalogue pass leaves a hand-picked cover alone, which is exactly the
 * cover most worth keeping. So the copy happens here, once, the next time the folder is
 * written to anyway.
 */
function ensurePortableCover(game: Game): void {
  const cover = game.coverPath
  if (!cover || isUnder(cover, game.dir) || !fs.existsSync(cover)) return
  const dest = adoptCover(game, cover)
  if (dest) db.updateGame(game.id, { coverPath: dest })
}

/**
 * The cover, as a name to write down — only when the file is in the game folder.
 *
 * A cover elsewhere on this machine is a fact about this machine: the sidecar's whole
 * job is to still be true after the folder moves, and a path into somebody's Pictures
 * folder would not be. Fetched covers are written into the folder precisely so they can
 * be recorded here.
 */
function coverFor(game: Game): SidecarData['cover'] {
  if (!game.coverPath) return undefined
  const resolved = path.resolve(game.coverPath)
  if (!isUnder(resolved, game.dir)) return undefined
  const name = path.relative(game.dir, resolved)
  // Only a file sitting directly in the folder — a name, not a path with steps in it.
  if (!name || name.includes(path.sep)) return undefined
  // No source recorded means nobody knows, and the file says so by staying silent rather
  // than by claiming the user picked it.
  return { name, from: game.coverFrom }
}

export function toSidecar(game: Game): SidecarData {
  return {
    name: game.name,
    // Only a deliberate choice is recorded. Writing the scanner's own guess would turn
    // it into a decision the user appears to have made, and it would come back as one.
    exe: game.exePinned && game.exe ? path.relative(game.dir, game.exe) : undefined,
    launchArgs: game.exePinned ? relativizeArgs(game, game.launchArgs) : undefined,
    wishlist: game.wishlist,
    playing: game.playing,
    played: game.played,
    rating: game.rating,
    tier: game.tier,
    tags: game.tags,
    playtimeMs: game.playtimeMs,
    launchCount: game.launchCount,
    lastLaunchedAt: game.lastLaunchedAt,
    sessions: game.sessions,
    // What the catalogue said. Derived, in the sense that it could be fetched again —
    // but only by somebody with the switch on, a working connection, and the patience for
    // a paced pass over the library. That is not "derivable" in any sense that helps
    // whoever has just moved this folder to another machine.
    work: game.work,
    autoTags: game.autoTags,
    summary: game.summary,
    summaryFrom: game.summaryFrom,
    cover: coverFor(game)
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

  // A hand-written path is only honoured if it actually resolves inside the game folder.
  // Anything else — a typo, a leftover from another machine — would leave the tile
  // pointing at nothing, which is worse than ignoring the line.
  if (data.exe) {
    const resolved = path.resolve(game.dir, data.exe)
    if (isUnder(resolved, game.dir) && fs.existsSync(resolved)) {
      game.exe = resolved
      game.exePinned = true
      game.launchArgs = absolutizeArgs(game, data.launchArgs)
    }
  }

  const status: Partial<Game> = {}
  if (typeof data.wishlist === 'boolean') status.wishlist = data.wishlist
  if (typeof data.playing === 'boolean') status.playing = data.playing
  if (typeof data.played === 'boolean') status.played = data.played
  if (Object.keys(status).length > 0) {
    // A hand-edited file can easily claim both wishlist and playing; hold it to the same
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

  /* ---- what a catalogue said, coming back ---- */

  if (data.work && (data.work.source === 'dlsite' || data.work.source === 'vndb')) {
    game.work = {
      source: data.work.source,
      workId: data.work.workId,
      title: data.work.title ?? data.work.workId
    }
    // A game carrying a work has been looked up, whatever this database remembers. Without
    // this, a folder arriving with a full record would still queue itself for a lookup it
    // does not need.
    game.taggedAt = game.taggedAt ?? Date.now()
  }
  if (data.autoTags !== undefined) {
    game.autoTags = data.autoTags.map((tag) => ({
      ...tag,
      // The catalogue that named the work also named these, and the drawer says so.
      source: game.work?.source ?? tag.source
    }))
  }
  if (data.summary !== undefined) game.summary = data.summary
  if (data.summaryFrom === 'dlsite' || data.summaryFrom === 'bangumi') {
    game.summaryFrom = data.summaryFrom
  }

  // The picture is looked for where the file says, and failing that where it would be.
  // Two routes on purpose: this is the one part of the record that took a download, and
  // the file naming it is also the file most likely to have been edited by hand.
  const coverName = data.cover?.name ?? findCoverIn(game.dir)
  if (coverName) {
    const resolved = path.resolve(game.dir, coverName)
    if (isUnder(resolved, game.dir) && fs.existsSync(resolved)) {
      game.coverPath = resolved
      // Left unset when the file did not say. `coverSourceOf` reads that as the user's
      // when it matters, so an unattributed picture is protected without being relabelled.
      game.coverFrom = data.cover?.from
    }
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
  ensurePortableCover(game)
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
    ensurePortableCover(game)
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
