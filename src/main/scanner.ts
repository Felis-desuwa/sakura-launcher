import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Game } from '../shared/types'
import { ARCHIVE_GROUP_ID } from '../shared/types'
import * as db from './db'
import { resolveArtwork } from './icon'
import { probeMaxIconSize } from './pe-icon'
import {
  displayNameFor,
  findExtractedDir,
  listDirShallow,
  pickMainExe,
  readSidecarName,
  walkRoot,
  type FoundArchive
} from './scan-core'

function idFor(key: string): string {
  return crypto.createHash('sha1').update(key.toLowerCase()).digest('hex').slice(0, 16)
}

function statDir(dir: string): { mtimeMs: number; childCount: number } | null {
  try {
    const st = fs.statSync(dir)
    if (!st.isDirectory()) return null
    return { mtimeMs: st.mtimeMs, childCount: fs.readdirSync(dir).length }
  } catch {
    return null
  }
}

export interface ScanOutcome {
  games: Game[]
  /** Parent dirs holding 2+ games that the user has not been asked about yet. */
  groupCandidates: { parent: string; name: string; dirs: string[] }[]
  /** Entries kept but not found this time — an unmounted drive, or content moved away. */
  missing: number
}

/**
 * Rescan every root and merge into the database.
 *
 * User-owned fields (status flags, tier, rating, tags, grouping, custom cover, play
 * stats, and the manual tile order) are keyed by directory and carried across, so a
 * rescan never costs the user their markings. Folders whose mtime and child count are
 * unchanged reuse the cached record and skip the expensive icon work entirely.
 */
export function rescan(): ScanOutcome {
  const settings = db.getSettings()
  const previous = db.getGames()
  const existing = new Map(previous.map((g) => [g.dir.toLowerCase(), g]))
  const ignored = new Set(settings.ignoredDirs.map((d) => d.toLowerCase()))
  const next: Game[] = []
  const groupCandidates: ScanOutcome['groupCandidates'] = []
  const seenArchives: FoundArchive[] = []
  const allGameDirs: string[] = []

  // The tile order is the user's arrangement. Scanning has no business rewriting it,
  // so existing entries keep the order they had and only new ones are assigned a slot.
  let nextOrder = previous.reduce((max, g) => Math.max(max, g.order ?? 0), -1) + 1
  const orderFor = (prev?: Game): number => prev?.order ?? nextOrder++

  for (const root of settings.roots) {
    if (!fs.existsSync(root)) continue
    // Names are resolved below, only for folders that are new or have changed —
    // so a scan where nothing moved touches no sidecar files at all.
    const result = walkRoot(root, probeMaxIconSize, false)
    allGameDirs.push(...result.games.map((g) => g.dir))
    seenArchives.push(...result.archives)

    for (const found of result.games) {
      if (ignored.has(found.dir.toLowerCase())) continue
      const prev = existing.get(found.dir.toLowerCase())
      const unchanged =
        prev &&
        prev.kind === 'installed' &&
        prev.mtimeMs === found.mtimeMs &&
        prev.childCount === found.childCount

      if (unchanged) {
        // Names still refresh, so improvements to the naming heuristic reach existing entries.
        next.push({
          ...prev,
          name: prev.renamed ? prev.name : found.name,
          order: orderFor(prev),
          missing: false
        })
        continue
      }

      const art = resolveArtwork(found.dir, found.exe)
      next.push({
        id: prev?.id ?? idFor(found.dir),
        // New or changed, so the sidecar is worth a read here: it may hold a title the
        // database has never seen (a fresh install, or a library restored elsewhere).
        name: prev?.renamed ? prev.name : readSidecarName(found.dir) ?? found.name,
        // Without this the flag is dropped on any rescan that touches the folder, and
        // the next one after that resets a hand-picked name back to the folder name.
        renamed: prev?.renamed,
        dir: found.dir,
        exe: found.exe,
        kind: 'installed',
        // Keep the cached size; the worker recomputes it in the background.
        sizeBytes: prev?.sizeBytes ?? null,
        iconPath: art.iconPath,
        coverPath: prev?.coverPath ?? art.coverPath,
        groupId: prev?.groupId ?? null,
        order: orderFor(prev),
        wishlist: prev?.wishlist ?? false,
        playing: prev?.playing ?? false,
        played: prev?.played ?? false,
        tier: prev?.tier ?? null,
        tierOrder: prev?.tierOrder ?? 0,
        rating: prev?.rating ?? null,
        tags: prev?.tags ?? [],
        lastLaunchedAt: prev?.lastLaunchedAt ?? null,
        launchCount: prev?.launchCount ?? 0,
        playtimeMs: prev?.playtimeMs ?? 0,
        sessions: prev?.sessions ?? [],
        sidecarSyncedAt: prev?.sidecarSyncedAt,
        mtimeMs: found.mtimeMs,
        childCount: found.childCount,
        missing: false
      })
    }

    for (const [parent, dirs] of result.collections) {
      if (settings.groupingPrompted.includes(parent)) continue
      groupCandidates.push({ parent, name: path.basename(parent), dirs })
    }
  }

  // Archives with no extracted copy show up as "not installed" tiles.
  for (const archive of seenArchives) {
    if (findExtractedDir(archive, allGameDirs)) continue
    const key = archive.volumes[0]
    if (ignored.has(key.toLowerCase())) continue
    const prev = existing.get(key.toLowerCase())
    // Give archives a real timestamp too, so time-based sorting includes them.
    let archiveMtime = 0
    try {
      archiveMtime = fs.statSync(key).mtimeMs
    } catch {
      /* volume vanished between walk and stat */
    }
    next.push({
      id: prev?.id ?? idFor(key),
      name: prev?.name ?? archive.name,
      renamed: prev?.renamed,
      dir: key,
      exe: '',
      kind: 'archive',
      sizeBytes: archive.sizeBytes,
      iconPath: null,
      coverPath: prev?.coverPath ?? null,
      groupId: ARCHIVE_GROUP_ID,
      order: orderFor(prev),
      wishlist: prev?.wishlist ?? false,
      playing: false,
      played: prev?.played ?? false,
      tier: prev?.tier ?? null,
      tierOrder: prev?.tierOrder ?? 0,
      rating: prev?.rating ?? null,
      tags: prev?.tags ?? [],
      lastLaunchedAt: null,
      launchCount: 0,
      playtimeMs: prev?.playtimeMs ?? 0,
      sessions: prev?.sessions ?? [],
      mtimeMs: archiveMtime,
      childCount: archive.volumes.length,
      missing: false,
      archiveVolumes: archive.volumes
    })
  }

  // Everything the scan did not produce this time.
  const scannedDirs = new Set(next.map((g) => g.dir.toLowerCase()))
  let missing = 0
  for (const [key, game] of existing) {
    if (scannedDirs.has(key)) continue
    if (game.kind === 'archive') continue

    const inRoot = settings.roots.some((r) =>
      game.dir.toLowerCase().startsWith(r.toLowerCase() + path.sep)
    )
    // Manually added games live outside every root, so preserve them verbatim.
    if (!inRoot && fs.existsSync(game.dir)) {
      next.push({ ...game, missing: false })
      continue
    }

    // Inside a root but not found: an unmounted drive, a folder renamed outside the
    // launcher, or a heuristic that judged differently this time. Dropping the entry
    // would take the user's tier, rating, tags and play history with it, so keep it
    // and let the tile show it needs attention.
    missing++
    next.push({ ...game, missing: true })
  }

  db.setGames(next)
  return { games: next, groupCandidates, missing }
}

export interface ImportCandidate {
  dir: string
  exe: string
  name: string
  sizeBytes: number | null
  /** Why the scanner did not treat this as a game. Absent for accepted entries. */
  reason?: string
  /** Archive entries only. */
  volumes?: string[]
}

export interface ImportPreview {
  folder: string
  games: ImportCandidate[]
  rejected: ImportCandidate[]
  archives: ImportCandidate[]
}

/**
 * Report what a folder would contribute, without changing anything.
 *
 * The rejected folders are shown alongside the accepted ones with the reason attached.
 * The heuristics are good but not infallible, and it is far easier to tick a box now
 * than to notice a missing game later and have no idea why it never appeared.
 */
export function previewFolder(folder: string): ImportPreview {
  const empty: ImportPreview = { folder, games: [], rejected: [], archives: [] }
  if (!fs.existsSync(folder)) return empty

  const result = walkRoot(folder, probeMaxIconSize)
  const known = new Set(db.getGames().map((g) => g.dir.toLowerCase()))
  const allGameDirs = result.games.map((g) => g.dir)

  return {
    folder,
    games: result.games
      .filter((g) => !known.has(g.dir.toLowerCase()))
      .map((g) => ({ dir: g.dir, exe: g.exe, name: g.name, sizeBytes: null })),
    rejected: result.rejected
      .filter((r) => !known.has(r.dir.toLowerCase()))
      .map((r) => ({
        dir: r.dir,
        exe: r.exe,
        name: displayNameFor(r.dir),
        sizeBytes: null,
        reason: describeReason(r.reason)
      })),
    archives: result.archives
      .filter((a) => !findExtractedDir(a, allGameDirs))
      .filter((a) => !known.has(a.volumes[0].toLowerCase()))
      .map((a) => ({
        dir: a.volumes[0],
        exe: '',
        name: a.name,
        sizeBytes: a.sizeBytes,
        volumes: a.volumes
      }))
  }
}

/** The scanner's internal reasons, said in a way that explains the decision. */
function describeReason(reason: string): string {
  const size = /\(([\d.]+) MB(, stub exe)?\)/.exec(reason)
  if (reason.startsWith('payload too small')) {
    return `内容太少（${size?.[1] ?? '?'} MB${size?.[2] ? '，主程序也很小' : ''}）`
  }
  if (reason === 'archive staging folder') return '看起来是压缩包暂存目录'
  return reason
}

/**
 * Register a vetted folder: accepted paths become games, rejected ones are remembered
 * so later scans do not keep offering them, and the folder joins the scan roots.
 */
export function importFolder(
  folder: string,
  accept: string[],
  reject: string[]
): ScanOutcome & { added: number } {
  const settings = db.getSettings()
  const before = new Set(db.getGames().map((g) => g.dir.toLowerCase()))

  const ignoredDirs = [...settings.ignoredDirs]
  const seen = new Set(ignoredDirs.map((d) => d.toLowerCase()))
  for (const dir of reject) {
    if (seen.has(dir.toLowerCase())) continue
    ignoredDirs.push(dir)
    seen.add(dir.toLowerCase())
  }

  const roots = settings.roots.includes(folder) ? settings.roots : [...settings.roots, folder]
  db.setSettings({ roots, ignoredDirs, onboarded: true })

  const outcome = rescan()

  // A folder the user accepted that the scanner still would not take on its own —
  // one of the rejected candidates, ticked back in. Add it directly.
  const known = new Set(db.getGames().map((g) => g.dir.toLowerCase()))
  for (const dir of accept) {
    if (known.has(dir.toLowerCase())) continue
    const entries = listDirShallow(dir).map((e) => ({
      name: e.name,
      isDir: e.isDir,
      size: e.sizeBytes
    }))
    const main = pickMainExe(dir, entries, probeMaxIconSize)
    if (main) addGameByExe(main.fullPath)
  }

  const games = db.getGames()
  return {
    ...outcome,
    games,
    added: games.filter((g) => !before.has(g.dir.toLowerCase())).length
  }
}

/** Add a single executable the user picked by hand. */
export function addGameByExe(exePath: string): Game | null {
  const dir = path.dirname(exePath)
  const info = statDir(dir)
  if (!info) return null

  const games = db.getGames()
  const already = games.find((g) => g.dir.toLowerCase() === dir.toLowerCase())
  if (already) return already

  const art = resolveArtwork(dir, exePath)
  const game: Game = {
    id: idFor(dir),
    name: readSidecarName(dir) ?? displayNameFor(dir),
    dir,
    exe: exePath,
    kind: 'installed',
    sizeBytes: null,
    iconPath: art.iconPath,
    coverPath: art.coverPath,
    groupId: null,
    // Past the highest slot in use, so it lands at the end. Array length would collide
    // with an existing order once anything has been removed.
    order: games.reduce((max, g) => Math.max(max, g.order ?? 0), -1) + 1,
    wishlist: false,
    playing: false,
    played: false,
    tier: null,
    tierOrder: 0,
    rating: null,
    tags: [],
    lastLaunchedAt: null,
    launchCount: 0,
    playtimeMs: 0,
    sessions: [],
    mtimeMs: info.mtimeMs,
    childCount: info.childCount
  }
  db.setGames([...games, game])
  return game
}
