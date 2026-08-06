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
}

/**
 * Rescan every root and merge into the database.
 *
 * User-owned fields (status flags, tier, grouping, custom cover, launch stats) are keyed
 * by directory and carried across, so a rescan never costs the user their markings.
 * Folders whose mtime and child count are unchanged reuse the cached record and skip
 * the expensive icon work entirely.
 */
export function rescan(): ScanOutcome {
  const settings = db.getSettings()
  const existing = new Map(db.getGames().map((g) => [g.dir.toLowerCase(), g]))
  const next: Game[] = []
  const groupCandidates: ScanOutcome['groupCandidates'] = []
  const seenArchives: FoundArchive[] = []
  const allGameDirs: string[] = []
  let order = 0

  for (const root of settings.roots) {
    if (!fs.existsSync(root)) continue
    const result = walkRoot(root, probeMaxIconSize)
    allGameDirs.push(...result.games.map((g) => g.dir))
    seenArchives.push(...result.archives)

    for (const found of result.games) {
      const prev = existing.get(found.dir.toLowerCase())
      const unchanged =
        prev &&
        prev.kind === 'installed' &&
        prev.mtimeMs === found.mtimeMs &&
        prev.childCount === found.childCount

      if (unchanged) {
        // Names still refresh, so improvements to the naming heuristic reach existing entries.
        next.push({ ...prev, name: prev.renamed ? prev.name : found.name, order: order++ })
        continue
      }

      const art = resolveArtwork(found.dir, found.exe)
      next.push({
        id: prev?.id ?? idFor(found.dir),
        name: prev?.renamed ? prev.name : found.name,
        dir: found.dir,
        exe: found.exe,
        kind: 'installed',
        // Keep the cached size; the worker recomputes it in the background.
        sizeBytes: prev?.sizeBytes ?? null,
        iconPath: art.iconPath,
        coverPath: prev?.coverPath ?? art.coverPath,
        groupId: prev?.groupId ?? null,
        order: order++,
        wishlist: prev?.wishlist ?? false,
        playing: prev?.playing ?? false,
        played: prev?.played ?? false,
        tier: prev?.tier ?? null,
        tierOrder: prev?.tierOrder ?? 0,
        lastLaunchedAt: prev?.lastLaunchedAt ?? null,
        launchCount: prev?.launchCount ?? 0,
        mtimeMs: found.mtimeMs,
        childCount: found.childCount
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
      dir: key,
      exe: '',
      kind: 'archive',
      sizeBytes: archive.sizeBytes,
      iconPath: null,
      coverPath: prev?.coverPath ?? null,
      groupId: ARCHIVE_GROUP_ID,
      order: order++,
      wishlist: prev?.wishlist ?? false,
      playing: false,
      played: prev?.played ?? false,
      tier: prev?.tier ?? null,
      tierOrder: prev?.tierOrder ?? 0,
      lastLaunchedAt: null,
      launchCount: 0,
      mtimeMs: archiveMtime,
      childCount: archive.volumes.length,
      archiveVolumes: archive.volumes
    })
  }

  // Manually added games live outside every root, so preserve them verbatim.
  const scannedDirs = new Set(next.map((g) => g.dir.toLowerCase()))
  for (const [key, game] of existing) {
    if (scannedDirs.has(key)) continue
    if (game.kind === 'archive') continue
    if (!fs.existsSync(game.dir)) continue
    const inRoot = settings.roots.some((r) =>
      game.dir.toLowerCase().startsWith(r.toLowerCase() + path.sep)
    )
    if (inRoot) continue // vanished from a scanned root: drop it
    next.push({ ...game, order: order++ })
  }

  db.setGames(next)
  return { games: next, groupCandidates }
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
    order: games.length,
    wishlist: false,
    playing: false,
    played: false,
    tier: null,
    tierOrder: 0,
    lastLaunchedAt: null,
    launchCount: 0,
    mtimeMs: info.mtimeMs,
    childCount: info.childCount
  }
  db.setGames([...games, game])
  return game
}
