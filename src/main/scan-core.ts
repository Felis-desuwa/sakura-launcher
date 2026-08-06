import fs from 'node:fs'
import path from 'node:path'

export const MAX_DEPTH = 4

/** Archives smaller than this are game assets (mods, save packs), not installers. */
export const ARCHIVE_MIN_BYTES = 200 * 1024 * 1024

const EXE_BLACKLIST: RegExp[] = [
  /^unitycrashhandler/i,
  /^unins/i,
  /^uninstall/i,
  /^卸载/,
  /^vcredist/i,
  /^dxsetup$/i,
  /^dxwebsetup$/i,
  /^directx/i,
  /^setup$/i,
  /^install$/i,
  /^config$/i,
  /^settings$/i,
  /^7z/i,
  /^notepad/i,
  /^crashreport/i,
  /^crashpad/i,
  /^ffmpeg$/i,
  /^python\w*$/i,
  /^node$/i,
  /^补丁/,
  /^patch/i,
  /^更新/,
  /^update/i,
  /^汉化/,
  /^密码/
]

/** Demoted rather than excluded — used only when nothing better exists in the folder. */
const EXE_WEAK: RegExp[] = [/^nw$/i, /launcher$/i, /^launcher/i, /^start$/i, /^游戏启动/]

export function isBlacklistedExe(basename: string): boolean {
  return EXE_BLACKLIST.some((re) => re.test(basename))
}

function isWeakExe(basename: string): boolean {
  return EXE_WEAK.some((re) => re.test(basename))
}

/** Strip decorations so "9-nine-雪色雪花雪余痕(樱空) Ver1.1" and its folder still match. */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.(7z|zip|rar|exe)$/i, '')
    .replace(/\.(part\d+|\d{3})$/i, '')
    .replace(/[（(\[【][^）)\]】]*[）)\]】]/g, '')
    .replace(/\b(v|ver|version)[\s._-]*\d+(\.\d+)*[a-z]?\b/gi, '')
    .replace(/[\s._\-~～+]/g, '')
    .trim()
}

export function fuzzyMatch(a: string, b: string): boolean {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (!na || !nb) return false
  return na === nb || na.includes(nb) || nb.includes(na)
}

export interface DirEntry {
  name: string
  isDir: boolean
  size: number
}

function readDirSafe(dir: string): DirEntry[] {
  let dirents: fs.Dirent[]
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: DirEntry[] = []
  for (const d of dirents) {
    if (d.name.startsWith('$') || d.name === 'System Volume Information') continue
    let size = 0
    const isDir = d.isDirectory()
    if (!isDir) {
      try {
        size = fs.statSync(path.join(dir, d.name)).size
      } catch {
        size = 0
      }
    }
    out.push({ name: d.name, isDir, size })
  }
  return out
}

export interface ExeCandidate {
  name: string
  fullPath: string
  size: number
  score: number
}

/** Optional hook so scoring can consult embedded icon size; skipped in the CLI harness. */
export type IconSizeProbe = (exePath: string) => number

/**
 * Rank the executables in a folder and return the most likely main program.
 * Engine layout signals (Unity `_Data`, RPG Maker `www`, Ren'Py `renpy`) beat name matching,
 * because folder names are frequently unrelated to the executable.
 */
export function pickMainExe(
  dir: string,
  entries: DirEntry[],
  probeIconSize?: IconSizeProbe
): ExeCandidate | null {
  const dirName = path.basename(dir)
  const exes = entries.filter((e) => !e.isDir && /\.exe$/i.test(e.name))
  if (exes.length === 0) return null

  const dirNames = new Set(entries.filter((e) => e.isDir).map((e) => e.name.toLowerCase()))
  const fileNames = entries.filter((e) => !e.isDir).map((e) => e.name.toLowerCase())
  const hasXp3 = fileNames.some((n) => n.endsWith('.xp3'))
  const hasRpgMaker = dirNames.has('www') || dirNames.has('data')
  const hasRenpy = dirNames.has('renpy')
  const maxSize = Math.max(...exes.map((e) => e.size), 1)

  const strong: ExeCandidate[] = []
  const weak: ExeCandidate[] = []

  for (const exe of exes) {
    const base = exe.name.replace(/\.exe$/i, '')
    if (isBlacklistedExe(base)) continue

    let score = 0
    if (dirNames.has(`${base.toLowerCase()}_data`)) score += 100
    if (fuzzyMatch(base, dirName)) score += 50
    if (hasXp3) score += 20
    if (hasRpgMaker && /^game$/i.test(base)) score += 40
    if (hasRenpy) score += 20
    score += Math.round((exe.size / maxSize) * 10)

    if (probeIconSize) {
      const px = probeIconSize(path.join(dir, exe.name))
      if (px >= 256) score += 30
      else if (px >= 128) score += 15
      else if (px >= 64) score += 5
    }

    const cand: ExeCandidate = {
      name: exe.name,
      fullPath: path.join(dir, exe.name),
      size: exe.size,
      score
    }
    if (isWeakExe(base)) weak.push(cand)
    else strong.push(cand)
  }

  const pool = strong.length > 0 ? strong : weak
  if (pool.length === 0) return null
  pool.sort((a, b) => b.score - a.score || b.size - a.size)
  return pool[0]
}

/** Engines that legitimately ship tiny payloads — their presence vouches for a folder. */
export function hasEngineSignature(entries: DirEntry[], exeBase: string): boolean {
  const dirs = new Set(entries.filter((e) => e.isDir).map((e) => e.name.toLowerCase()))
  const files = entries.filter((e) => !e.isDir).map((e) => e.name.toLowerCase())
  return (
    dirs.has(`${exeBase.toLowerCase()}_data`) ||
    dirs.has('www') ||
    dirs.has('renpy') ||
    dirs.has('tyrano') ||
    dirs.has('bepinex') ||
    dirs.has('monobleedingedge') ||
    dirs.has('engine') || // Unreal Engine — ships a tiny launcher stub next to a huge payload
    files.some((n) => n.endsWith('.xp3')) ||
    files.some((n) => n === 'unityplayer.dll' || n === 'gameassembly.dll') ||
    files.some((n) => n.startsWith('manifest_ufsfiles')) ||
    files.some((n) => n === 'package.json' && dirs.has('node_modules'))
  )
}

/** Walk until the byte budget or file cap is hit — enough to tell "tiny stub" from "real game". */
function approxSize(dir: string, capFiles = 4000, capBytes = 64 * 1024 * 1024): number {
  let total = 0
  let seen = 0
  const stack = [dir]
  while (stack.length > 0) {
    if (total >= capBytes || seen >= capFiles) return total
    const cur = stack.pop()!
    let dirents: fs.Dirent[]
    try {
      dirents = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of dirents) {
      const full = path.join(cur, d.name)
      if (d.isDirectory()) {
        stack.push(full)
      } else if (d.isFile()) {
        seen++
        try {
          total += fs.statSync(full).size
        } catch {
          /* skip */
        }
        if (total >= capBytes || seen >= capFiles) return total
      }
    }
  }
  return total
}

const STUB_EXE_BYTES = 1024 * 1024
const MIN_PAYLOAD_BYTES = 20 * 1024 * 1024
const STAGING_ARCHIVE_BYTES = 100 * 1024 * 1024

/**
 * Reject folders that look like a game but aren't: archive staging areas, decoy stub
 * executables shipped alongside download links, and re-shared package remnants that
 * carry the launcher but none of the game data.
 */
export function rejectReason(
  dir: string,
  entries: DirEntry[],
  main: ExeCandidate
): string | null {
  const exeBase = main.name.replace(/\.exe$/i, '')
  const engine = hasEngineSignature(entries, exeBase)

  // An engine layout is proof enough — such a folder is a game even if it also happens
  // to sit next to a big archive, and even if its launcher stub is tiny.
  if (engine) return null

  let archiveBytes = 0
  let otherBytes = 0
  for (const e of entries) {
    if (e.isDir) continue
    if (isArchiveFile(e.name)) archiveBytes += e.size
    else otherBytes += e.size
  }
  if (archiveBytes >= STAGING_ARCHIVE_BYTES && archiveBytes > otherBytes * 4) {
    return 'archive staging folder'
  }

  // Judge by payload rather than by executable size: launcher stubs are common and a
  // 150 KB exe in front of a 2 GB tree is a real game, while a 4 MB folder is a leftover.
  const size = approxSize(dir)
  if (size < MIN_PAYLOAD_BYTES) {
    const note = main.size < STUB_EXE_BYTES ? ', stub exe' : ''
    return `payload too small (${(size / 1024 / 1024).toFixed(1)} MB${note})`
  }

  return null
}

/** Folder names that describe a build target rather than the game. */
const GENERIC_DIR_NAMES =
  /^(pc|game|games|bin|x64|x86|win|win32|win64|windows|app|release|data|本体|游戏|游戏本体)$/i

/**
 * Prefer the nearest meaningful folder name.
 * Layouts like `<title>/PC/game.exe` would otherwise surface a tile called "PC".
 */
export function displayNameFor(dir: string): string {
  let current = dir
  for (let i = 0; i < 3; i++) {
    const base = path.basename(current)
    if (!GENERIC_DIR_NAMES.test(base)) return base
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return path.basename(dir)
}

/**
 * Sidecar that records how a game should be titled in the launcher.
 *
 * Renaming the folder itself is not an option — plenty of these games resolve assets
 * by path, or ship shortcuts and save files that point at the original name — so the
 * chosen title is written beside the game instead. The file is plain text and explains
 * itself, because whoever opens it later will not remember what put it there.
 */
export const NAME_SIDECAR = 'sakura-launcher.txt'

const SIDECAR_KEY = /^\s*显示名称\s*=\s*(.+?)\s*$/m

export function readSidecarName(dir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(dir, NAME_SIDECAR), 'utf-8').replace(/^﻿/, '')
    const m = SIDECAR_KEY.exec(raw)
    const value = m?.[1]?.trim()
    return value ? value : null
  } catch {
    return null
  }
}

export function writeSidecarName(dir: string, name: string): { ok: boolean; error?: string } {
  const body = [
    '# Sakura Launcher 显示名称',
    '#',
    '# 这个文件只决定该游戏在 Sakura Launcher 里显示成什么名字。',
    '# 它不会改动游戏本身的任何文件，也不影响游戏启动 —— 正是为了避免',
    '# 直接重命名文件夹导致游戏找不到资源，才把名字记在这里。',
    '#',
    '# 想改名，直接改下面这一行；把这个文件删掉，启动器就会重新使用文件夹名。',
    '',
    `显示名称 = ${name}`,
    ''
  ].join('\r\n')

  try {
    // Written with a BOM: this file is meant to be opened by a person, and Windows
    // editors fall back to the ANSI codepage without one, turning Chinese into mojibake.
    fs.writeFileSync(path.join(dir, NAME_SIDECAR), '﻿' + body, 'utf-8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function removeSidecarName(dir: string): void {
  try {
    fs.unlinkSync(path.join(dir, NAME_SIDECAR))
  } catch {
    /* already gone */
  }
}

export interface FoundGame {
  dir: string
  exe: string
  name: string
  mtimeMs: number
  childCount: number
}

export interface RejectedFolder {
  dir: string
  exe: string
  reason: string
}

export interface FoundArchive {
  /** Name with volume suffix stripped. */
  name: string
  dir: string
  volumes: string[]
  sizeBytes: number
}

export interface WalkResult {
  games: FoundGame[]
  archives: FoundArchive[]
  /** Parent folders that directly contain 2+ games — candidates for auto-grouping. */
  collections: Map<string, string[]>
  /** Folders that held an exe but failed the sanity checks; kept for diagnostics. */
  rejected: RejectedFolder[]
}

const VOLUME_RE = /^(.*?)(?:\.7z\.\d{3}|\.part\d+\.rar|\.z\d{2}|\.\d{3})$/i
const ARCHIVE_RE = /\.(7z|zip|rar)$/i

/** `X.7z.001` and `X.part2.rar` both collapse to `X` so split sets become one entry. */
function archiveBaseName(fileName: string): string | null {
  const vol = VOLUME_RE.exec(fileName)
  if (vol) return vol[1].replace(/\.7z$/i, '')
  if (ARCHIVE_RE.test(fileName)) return fileName.replace(ARCHIVE_RE, '')
  return null
}

function isArchiveFile(fileName: string): boolean {
  return archiveBaseName(fileName) !== null
}

/**
 * Walk a root looking for game folders.
 * A folder that directly holds a usable .exe is a game and we stop descending;
 * otherwise we keep going down to MAX_DEPTH. That handles libraries where games sit
 * at wildly different depths.
 */
export function walkRoot(root: string, probeIconSize?: IconSizeProbe): WalkResult {
  const games: FoundGame[] = []
  const archiveParts = new Map<string, { dir: string; volumes: string[]; size: number }>()
  const collections = new Map<string, string[]>()
  const rejected: RejectedFolder[] = []

  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return
    const entries = readDirSafe(dir)
    if (entries.length === 0) return

    // Collect archives at every level — they live alongside extracted folders.
    for (const e of entries) {
      if (e.isDir || !isArchiveFile(e.name)) continue
      const base = archiveBaseName(e.name)!
      // Key on base name only, so volumes split across sibling folders still merge.
      const key = normalizeName(base)
      if (!key) continue
      const rec = archiveParts.get(key) ?? { dir, volumes: [], size: 0 }
      rec.volumes.push(path.join(dir, e.name))
      rec.size += e.size
      archiveParts.set(key, rec)
    }

    const main = pickMainExe(dir, entries, probeIconSize)
    if (main) {
      const reason = rejectReason(dir, entries, main)
      if (reason) {
        rejected.push({ dir, exe: main.fullPath, reason })
        // A staging folder may still hide real content deeper, so keep descending.
      } else {
        let stat: fs.Stats | null = null
        try {
          stat = fs.statSync(dir)
        } catch {
          /* ignore */
        }
        games.push({
          dir,
          exe: main.fullPath,
          // The sidecar, when present, is the user's explicit choice and wins.
          name: readSidecarName(dir) ?? displayNameFor(dir),
          mtimeMs: stat?.mtimeMs ?? 0,
          childCount: entries.length
        })
        return // this folder is the game; don't descend into its asset tree
      }
    }

    for (const e of entries) {
      if (!e.isDir) continue
      visit(path.join(dir, e.name), depth + 1)
    }
  }

  visit(root, 0)

  // Group by the top-level folder each game sits under, not by its immediate parent:
  // library folders like "galgame/<title>/<title>/game.exe" put every game under a
  // different parent, so an immediate-parent check would never see them as a set.
  for (const g of games) {
    const rel = path.relative(root, g.dir)
    if (!rel || rel.startsWith('..')) continue
    const [top] = rel.split(path.sep)
    const topDir = path.join(root, top)
    // A game sitting directly in the root is not part of a collection.
    if (topDir === g.dir) continue
    const list = collections.get(topDir) ?? []
    list.push(g.dir)
    collections.set(topDir, list)
  }
  for (const [parent, list] of [...collections]) {
    if (list.length < 2) collections.delete(parent)
  }

  const archives: FoundArchive[] = []
  for (const [, rec] of archiveParts) {
    if (rec.size < ARCHIVE_MIN_BYTES) continue
    rec.volumes.sort()
    const first = path.basename(rec.volumes[0])
    archives.push({
      name: archiveBaseName(first)!,
      dir: rec.dir,
      volumes: rec.volumes,
      sizeBytes: rec.size
    })
  }

  return { games, archives, collections, rejected }
}

/**
 * Decide whether an archive has already been extracted next to it.
 * Exact sibling-folder match first, then a fuzzy pass — extracted folders are often
 * renamed to the full title while the archive keeps a short name.
 */
export function findExtractedDir(
  archive: FoundArchive,
  gameDirs: string[]
): string | null {
  const exact = path.join(archive.dir, archive.name)
  if (fs.existsSync(exact) && fs.statSync(exact).isDirectory()) return exact

  const target = normalizeName(archive.name)
  if (!target) return null

  // A known game folder inside the archive's directory whose name fuzzy-matches.
  for (const gd of gameDirs) {
    if (!gd.startsWith(archive.dir + path.sep)) continue
    const rel = path.relative(archive.dir, gd).split(path.sep)[0]
    const cand = normalizeName(rel)
    if (!cand) continue
    if (cand === target || cand.includes(target) || target.includes(cand)) {
      return path.join(archive.dir, rel)
    }
  }

  for (const e of readDirSafe(archive.dir)) {
    if (!e.isDir) continue
    const cand = normalizeName(e.name)
    if (!cand) continue
    if (cand === target || cand.includes(target) || target.includes(cand)) {
      return path.join(archive.dir, e.name)
    }
  }
  return null
}

export function dirSize(dir: string): number {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()!
    let dirents: fs.Dirent[]
    try {
      dirents = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of dirents) {
      const full = path.join(cur, d.name)
      if (d.isDirectory()) {
        stack.push(full)
      } else if (d.isFile()) {
        try {
          total += fs.statSync(full).size
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  return total
}

export interface ListedEntry {
  name: string
  path: string
  isDir: boolean
  sizeBytes: number
  mtimeMs: number
  ext: string
}

/**
 * Shallow directory listing for the in-app folder browser.
 * Folder sizes are left at 0 — recursing here would stall navigation on large trees;
 * the size donut is where recursive totals belong.
 */
export function listDirShallow(dir: string): ListedEntry[] {
  let dirents: fs.Dirent[]
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: ListedEntry[] = []
  for (const d of dirents) {
    if (d.name === 'System Volume Information' || d.name.startsWith('$')) continue
    const full = path.join(dir, d.name)
    let size = 0
    let mtimeMs = 0
    try {
      const st = fs.statSync(full)
      mtimeMs = st.mtimeMs
      if (!d.isDirectory()) size = st.size
    } catch {
      /* unreadable entry still gets listed */
    }
    out.push({
      name: d.name,
      path: full,
      isDir: d.isDirectory(),
      sizeBytes: size,
      mtimeMs,
      ext: d.isDirectory() ? '' : path.extname(d.name).toLowerCase()
    })
  }
  // Folders first, then by name — the ordering people expect from a file list.
  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
  return out
}

export interface RawBreakdownEntry {
  name: string
  path: string
  sizeBytes: number
  isDir: boolean
}

/** Direct children of `dir`, folders summed recursively, sorted largest first. */
export function breakdownOf(dir: string): { totalBytes: number; entries: RawBreakdownEntry[] } {
  const entries: RawBreakdownEntry[] = []
  let total = 0
  for (const e of readDirSafe(dir)) {
    const full = path.join(dir, e.name)
    const size = e.isDir ? dirSize(full) : e.size
    total += size
    entries.push({ name: e.name, path: full, sizeBytes: size, isDir: e.isDir })
  }
  entries.sort((a, b) => b.sizeBytes - a.sizeBytes)
  return { totalBytes: total, entries }
}
