import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Game } from '../shared/types'
import { ARCHIVE_GROUP_ID, userFieldsOf } from '../shared/types'
import * as db from './db'
import { resolveArtwork } from './icon'
import { probeExeMeta } from './pe-icon'
import {
  displayNameFor,
  findExtractedDir,
  isUnder,
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

export interface RescanOptions {
  /**
   * Folders inside which newly found content may join the library.
   *
   * Empty — the default — makes this a refresh: entries already in the library are
   * brought up to date, and anything else found on the way is left alone. Discovering
   * games is a deliberate act with a preview attached to it (导入文件夹 / 重新扫描并添加),
   * not something the refresh button does behind the user's back.
   */
  discoverIn?: string[]
}

/**
 * Walk every root and merge into the database.
 *
 * User-owned fields (status flags, tier, rating, tags, grouping, custom cover, play
 * stats, and the manual tile order) are keyed by directory and carried across, so this
 * never costs the user their markings. Folders whose mtime and child count are
 * unchanged reuse the cached record and skip the expensive icon work entirely.
 */
export function rescan(options: RescanOptions = {}): ScanOutcome {
  const discoverIn = options.discoverIn ?? []
  const canAdd = (dir: string): boolean => discoverIn.some((root) => isUnder(dir, root))

  const settings = db.getSettings()
  const previous = db.getGames()
  const existing = new Map(previous.map((g) => [g.dir.toLowerCase(), g]))
  // A folder coming back into the library brings its old record with it, so a tile
  // removed by mistake and added again is the same tile — same cover, same rating,
  // same place in the grid.
  const ghosts = new Map(db.getRemoved().map((g) => [g.dir.toLowerCase(), g]))
  const revived: string[] = []

  // A folder that is both in the library and on the ignore list is a contradiction, and
  // one that resolves against the user: the entry is there because they put it there.
  // Left alone it gets skipped by every scan and then reported as 未找到 — present, yet
  // invisible to the scanner. The library wins, and the stale ignore entry goes.
  const stale = settings.ignoredDirs.filter((d) => existing.has(d.toLowerCase()))
  if (stale.length > 0) {
    const gone = new Set(stale.map((d) => d.toLowerCase()))
    db.setSettings({
      ignoredDirs: settings.ignoredDirs.filter((d) => !gone.has(d.toLowerCase()))
    })
  }
  const ignored = new Set(
    settings.ignoredDirs.filter((d) => !existing.has(d.toLowerCase())).map((d) => d.toLowerCase())
  )
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
    const result = walkRoot(root, probeExeMeta, false)
    allGameDirs.push(...result.games.map((g) => g.dir))
    seenArchives.push(...result.archives)

    for (const found of result.games) {
      const key = found.dir.toLowerCase()
      if (ignored.has(key)) continue
      const known = existing.get(key)
      if (!known && !canAdd(found.dir)) {
        // Not in the library, and this scan was not asked to look here.
        continue
      }
      // A folder coming back brings its removal record with it, so the tile is the same
      // tile it was: same cover, same rating, same place in the grid.
      const prev = known ?? ghosts.get(key)
      if (!known && prev) revived.push(found.dir)

      if (
        prev &&
        prev.kind === 'installed' &&
        prev.mtimeMs === found.mtimeMs &&
        prev.childCount === found.childCount
      ) {
        // Names still refresh, so improvements to the naming heuristic reach existing entries.
        next.push({
          ...prev,
          name: prev.renamed ? prev.name : found.name,
          order: orderFor(prev),
          missing: false
        })
        continue
      }

      // A hand-picked executable outranks whatever the heuristic would choose today.
      // Without this the choice lasts only until the folder next changes — the same
      // way a hand-typed name would be lost without `renamed`.
      const pinned = prev?.exePinned && prev.exe && fs.existsSync(prev.exe) ? prev.exe : null
      const exe = pinned ?? found.exe
      const art = resolveArtwork(found.dir, exe)
      next.push({
        id: prev?.id ?? idFor(found.dir),
        // New or changed, so the sidecar is worth a read here: it may hold a title the
        // database has never seen (a fresh install, or a library restored elsewhere).
        name: prev?.renamed ? prev.name : readSidecarName(found.dir) ?? found.name,
        // Without this the flag is dropped on any rescan that touches the folder, and
        // the next one after that resets a hand-picked name back to the folder name.
        renamed: prev?.renamed,
        dir: found.dir,
        exe,
        exePinned: pinned ? true : undefined,
        launchArgs: pinned ? prev?.launchArgs : undefined,
        launchCwd: pinned ? prev?.launchCwd : undefined,
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
    const knownArchive = existing.get(key.toLowerCase())
    if (!knownArchive && !canAdd(key)) continue
    const prev = knownArchive ?? ghosts.get(key.toLowerCase())
    if (!knownArchive && prev) revived.push(key)
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
  db.forgetRemoved(revived)
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

  const result = walkRoot(folder, probeExeMeta)
  // Both are reasons to leave a folder out: it is already a tile, or the user took it
  // out of the library on purpose. Offering removed folders again — pre-ticked, on every
  // rescan — would undo their decision for them. 设置 → 已移除的条目 is where those live,
  // with 恢复 to take one back and 清除 to have it offered here again.
  const known = new Set([
    ...db.getGames().map((g) => g.dir.toLowerCase()),
    ...db.getSettings().ignoredDirs.map((d) => d.toLowerCase())
  ])
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

  // Ticking a folder is the user overruling an earlier removal, so it has to come off
  // the ignore list — otherwise the scan keeps skipping it and the entry shows up as
  // 未找到 on the very next refresh.
  const accepted = new Set(accept.map((d) => d.toLowerCase()))
  const ignoredDirs = settings.ignoredDirs.filter((d) => !accepted.has(d.toLowerCase()))
  const seen = new Set(ignoredDirs.map((d) => d.toLowerCase()))
  for (const dir of reject) {
    if (seen.has(dir.toLowerCase())) continue
    ignoredDirs.push(dir)
    seen.add(dir.toLowerCase())
  }

  const roots = settings.roots.includes(folder) ? settings.roots : [...settings.roots, folder]
  db.setSettings({ roots, ignoredDirs, onboarded: true })

  // Discovery is confined to the folder being imported: this is the one moment the
  // user has been shown what would come in and said yes to it.
  const outcome = rescan({ discoverIn: [folder] })

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
    const main = pickMainExe(dir, entries, probeExeMeta)
    if (main) addGameByExe(main.fullPath)
  }

  const games = db.getGames()
  return {
    ...outcome,
    games,
    added: games.filter((g) => !before.has(g.dir.toLowerCase())).length
  }
}

/** Extra facts about an executable that only the caller knows — a shortcut's contents. */
export interface AddGameExtras {
  launchArgs?: string[]
  launchCwd?: string
  /** An icon file named by the shortcut, used when the executable has none worth showing. */
  iconPath?: string | null
}

/** Add a single executable the user picked by hand, or dropped on the window. */
export function addGameByExe(exePath: string, extras: AddGameExtras = {}): Game | null {
  const dir = path.dirname(exePath)
  const info = statDir(dir)
  if (!info) return null

  const games = db.getGames()
  const already = games.find((g) => g.dir.toLowerCase() === dir.toLowerCase())
  if (already) return already

  // Adding a folder back is the user reversing their own removal. Leaving it on the
  // ignore list would let the entry live until the next refresh and then be reported
  // as 未找到 — present in the library, skipped by every scan.
  const settings = db.getSettings()
  if (settings.ignoredDirs.some((d) => d.toLowerCase() === dir.toLowerCase())) {
    db.setSettings({
      ignoredDirs: settings.ignoredDirs.filter((d) => d.toLowerCase() !== dir.toLowerCase())
    })
  }

  const ghost = db.peekRemoved(dir)
  const art = resolveArtwork(dir, exePath)
  const game: Game = {
    id: idFor(dir),
    name: readSidecarName(dir) ?? displayNameFor(dir),
    dir,
    exe: exePath,
    launchArgs: extras.launchArgs,
    launchCwd: extras.launchCwd,
    kind: 'installed',
    sizeBytes: null,
    iconPath: art.iconPath ?? extras.iconPath ?? null,
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

  // What the user had recorded on this folder before wins over the freshly derived
  // defaults — including the cover, which nothing on disk can bring back on its own.
  if (ghost) {
    const fresh = game.name
    Object.assign(game, userFieldsOf(ghost))
    // The sidecar in the folder is newer than any name the removed record held,
    // unless that name was one the user typed in themselves.
    if (!ghost.renamed) game.name = fresh
    if (!game.iconPath) game.iconPath = ghost.iconPath
    // A shortcut dropped just now is a more recent statement of intent than whatever
    // launch setup the old record carried, so it wins.
    if (extras.launchArgs || extras.launchCwd) {
      game.launchArgs = extras.launchArgs
      game.launchCwd = extras.launchCwd
      game.exePinned = true
    }
    db.forgetRemoved([dir])
  }

  db.setGames([...games, game])
  return game
}
