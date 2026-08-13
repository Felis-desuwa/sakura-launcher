import fs from 'node:fs'
import path from 'node:path'
// Extension spelled out: the harnesses in scripts/ import this file straight into node,
// where nothing fills the extension in for them.
import type { MessageKey } from '../shared/i18n.ts'
import { formatDuration, parseDuration, type AutoTag, type EngineId } from '../shared/types.ts'
import { mainLang, t } from './i18n.ts'

export const MAX_DEPTH = 4

/**
 * Whether `child` is `parent` itself or lives inside it.
 *
 * Compared case-insensitively and with a trailing separator, so `H:\games2` does not
 * count as being inside `H:\games` — a prefix test alone gets that wrong.
 */
export function isUnder(child: string, parent: string): boolean {
  const a = path.resolve(child).toLowerCase()
  const b = path.resolve(parent).toLowerCase()
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep)
}

/** Archives smaller than this are game assets (mods, save packs), not installers. */
export const ARCHIVE_MIN_BYTES = 200 * 1024 * 1024

/**
 * What an executable in a game folder actually is.
 *
 * A folder like サンプルゲーム ships twelve of them — engine, two uninstallers, a
 * Chinese patch, a NoDVD build, four locale emulators and a couple of tools — and the
 * filenames alone tell the user nothing. Naming each one is what lets the picker
 * explain itself instead of presenting twelve identical rows.
 */
export type ExeKind = 'main' | 'launcher' | 'locale' | 'patch' | 'uninstall' | 'tool' | 'sub'

const EXE_UNINSTALL: RegExp[] = [/^unins/i, /^uninstall/i, /^卸载/]

/** Patches that are never the way in, so they stay out of the ranking entirely. */
const EXE_PATCH_STRICT: RegExp[] = [/^补丁/, /^patch/i, /^更新/, /^update/i, /^汉化/]

/**
 * Named like a patch, but still allowed to compete: a NoDVD build is occasionally the
 * executable a game is genuinely started from.
 *
 * The `chs`/`cht` rule insists on a build number after the marker, because that is what
 * separates the two things it would otherwise conflate: `BGI_CHS_130321.exe` is a dated
 * translation patch, while `nine_haruiro_CHS.exe` is the Chinese build of the game
 * itself — the executable the user actually plays. Matching the bare suffix demoted the
 * latter across the library.
 */
const EXE_PATCH_LOOSE: RegExp[] = [/nodvd/i, /crack/i, /(^|[_\-\s])(chs|cht)[_\-]?\d{4,}/i]

const EXE_TOOL_STRICT: RegExp[] = [
  /^unitycrashhandler/i,
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
  /^密码/
]

/**
 * Labelled as a tool without being excluded — the name is suggestive, not conclusive.
 *
 * `ESUforGame` / `ISESUforGame` look like locale emulators and are not: their
 * version resources read 環境設定ツール and 初期画面設定ツール, company BURIKO — they are
 * the engine's own settings utilities, shipped next to the game.
 */
const EXE_TOOL_LOOSE: RegExp[] = [/viewer$/i, /^i?s?esu(for|[_\-\s]|$)/i]

/**
 * Locale emulators. Japanese games on a Chinese system are routinely started through
 * one of these rather than directly, so they are worth naming — and worth demoting,
 * since a 1 MB wrapper otherwise competes with the engine on size alone.
 */
const EXE_LOCALE: RegExp[] = [
  /^ntlea/i,
  /^localeemulator/i,
  /^leproc/i,
  /^alpharomdie/i,
  /^apploc/i,
  /转区/
]

const EXE_BLACKLIST: RegExp[] = [...EXE_UNINSTALL, ...EXE_PATCH_STRICT, ...EXE_TOOL_STRICT]

/** Demoted rather than excluded — used only when nothing better exists in the folder. */
const EXE_WEAK: RegExp[] = [/^nw$/i, /launcher$/i, /^launcher/i, /^start$/i, /^游戏启动/]

export function isBlacklistedExe(basename: string): boolean {
  return EXE_BLACKLIST.some((re) => re.test(basename))
}

function isWeakExe(basename: string): boolean {
  return EXE_WEAK.some((re) => re.test(basename))
}

function isLocaleExe(basename: string): boolean {
  return EXE_LOCALE.some((re) => re.test(basename))
}

const KIND_LABELS: Record<ExeKind, MessageKey> = {
  main: 'exeKind.main',
  launcher: 'exeKind.launcher',
  locale: 'exeKind.locale',
  patch: 'exeKind.patch',
  uninstall: 'exeKind.uninstall',
  tool: 'exeKind.tool',
  sub: 'exeKind.sub'
}

export function exeKindLabel(kind: ExeKind): string {
  return t(KIND_LABELS[kind])
}

/**
 * What an executable says about itself, from its VS_VERSIONINFO resource.
 *
 * Filenames lie; descriptions rarely do. `ESUforGame.exe` reads like a locale-emulator
 * wrapper and is in fact the engine's own 「環境設定ツール」 by BURIKO, and
 * `サンプルゲーム NoDVD.EXE` declares itself 「Update for Windows95」 by a different
 * company altogether.
 */
export interface ExeVersionInfo {
  description?: string
  product?: string
  company?: string
  originalName?: string
}

/** Everything the scanner and the picker want to know about an exe, read in one pass. */
export interface ExeMeta {
  /** Largest embedded icon dimension, 0 when it has none. */
  maxIconSize: number
  version: ExeVersionInfo | null
}

/**
 * Self-descriptions that settle what an executable is for.
 *
 * Japanese, Chinese and English forms all appear, often in the same folder. Matched
 * against FileDescription / ProductName / OriginalFilename — written by whoever built
 * the thing, rather than by whoever repacked it.
 */
const VERSION_HINTS: [RegExp, ExeKind][] = [
  [/uninstall|アンインストール|卸载|反安装/i, 'uninstall'],
  [/\b(update|patch)\b|補丁|补丁|汉化|crack|nodvd/i, 'patch'],
  [
    /設定|设定|设置|環境設定|初期画面|\bconfig(uration)?\b|\bsettings?\b|\bsetup\b|viewer|\butility\b|ツール/i,
    'tool'
  ],
  [/\blocale\b|applocale|转区|轉區/i, 'locale']
]

/**
 * What the executable's own version resource says it is, or null when it says nothing
 * useful — which includes the common case of there being no resource at all.
 *
 * This only ever rules candidates *out*. The real main program frequently has no
 * readable version info: resedit declines some valid PE layouts outright, and the BGI
 * engine binary in サンプルゲーム is one of them. Treating "no description" as a mark
 * against a file would eliminate exactly the executable we are looking for.
 */
export function exeKindFromVersion(version: ExeVersionInfo | null | undefined): ExeKind | null {
  if (!version) return null
  // The company name is left out on purpose: it identifies who built the file, which is
  // not the same question, and matching keywords in it produces nonsense.
  const said = [version.description, version.product, version.originalName]
    .filter(Boolean)
    .join(' ')
  if (!said) return null
  for (const [pattern, kind] of VERSION_HINTS) {
    if (pattern.test(said)) return kind
  }
  return null
}

/** What an executable looks like, judged by name alone. */
export function exeKindOf(basename: string): ExeKind {
  if (EXE_UNINSTALL.some((re) => re.test(basename))) return 'uninstall'
  if ([...EXE_PATCH_STRICT, ...EXE_PATCH_LOOSE].some((re) => re.test(basename))) return 'patch'
  if ([...EXE_TOOL_STRICT, ...EXE_TOOL_LOOSE].some((re) => re.test(basename))) return 'tool'
  if (isLocaleExe(basename)) return 'locale'
  if (isWeakExe(basename)) return 'launcher'
  return 'main'
}

/** Strip decorations so "示例游戏-副标题(汉化组) Ver1.1" and its folder still match. */
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

export interface ExeVerdict extends ExeCandidate {
  kind: ExeKind
  /** Why it scored what it did, in words — this is what the picker shows the user. */
  reasons: string[]
  /** Whether it is allowed to compete for the main slot at all. */
  rankable: boolean
  /** What the file says about itself, when it says anything. */
  version?: ExeVersionInfo
}

/**
 * Optional hook so scoring can consult what is inside the executable — its icon size
 * and its version resource. Skipped in the CLI harness, which has no PE parser.
 */
export type ExeMetaProbe = (exePath: string) => ExeMeta

/**
 * Judge every executable in a folder: what it is, how likely it is to be the main
 * program, and why.
 *
 * Engine layout signals (Unity `_Data`, RPG Maker `www`, Ren'Py `renpy`) beat name
 * matching, because folder names are frequently unrelated to the executable.
 *
 * Nothing is dropped here — uninstallers and redistributables come back labelled rather
 * than silently missing, since the picker has to account for every file the user can
 * see in Explorer. `rankExes` is the filtered view of this, and scanning uses that, so
 * both answer to one set of rules.
 */
export function classifyExes(
  dir: string,
  entries: DirEntry[],
  probeMeta?: ExeMetaProbe
): ExeVerdict[] {
  const dirName = path.basename(dir)
  const exes = entries.filter((e) => !e.isDir && /\.exe$/i.test(e.name))
  if (exes.length === 0) return []

  const dirNames = new Set(entries.filter((e) => e.isDir).map((e) => e.name.toLowerCase()))
  const fileNames = entries.filter((e) => !e.isDir).map((e) => e.name.toLowerCase())
  const hasXp3 = fileNames.some((n) => n.endsWith('.xp3'))
  const hasRpgMaker = dirNames.has('www') || dirNames.has('data')
  const hasRenpy = dirNames.has('renpy')
  const maxSize = Math.max(...exes.map((e) => e.size), 1)

  const out: ExeVerdict[] = []
  for (const exe of exes) {
    const base = exe.name.replace(/\.exe$/i, '')
    const reasons: string[] = []
    let score = 0

    if (dirNames.has(`${base.toLowerCase()}_data`)) {
      score += 100
      reasons.push(t('exeWhy.dataDir', { base }))
    }
    if (fuzzyMatch(base, dirName)) {
      score += 50
      reasons.push(t('exeWhy.sameName'))
    }
    if (hasXp3) {
      score += 20
      reasons.push(t('exeWhy.xp3'))
    }
    if (hasRpgMaker && /^game$/i.test(base)) {
      score += 40
      reasons.push(t('exeWhy.rpgmaker'))
    }
    if (hasRenpy) {
      score += 20
      reasons.push(t('exeWhy.renpy'))
    }
    if (exe.size === maxSize && exes.length > 1) reasons.push(t('exeWhy.biggest'))
    score += Math.round((exe.size / maxSize) * 10)

    const fullPath = path.join(dir, exe.name)
    const meta = probeMeta?.(fullPath)
    if (meta) {
      const px = meta.maxIconSize
      if (px >= 256) {
        score += 30
        reasons.push(t('exeWhy.icon', { px }))
      } else if (px >= 128) {
        score += 15
        reasons.push(t('exeWhy.icon', { px }))
      } else if (px >= 64) {
        score += 5
        reasons.push(t('exeWhy.icon', { px }))
      } else if (px === 0) {
        reasons.push(t('exeWhy.noIcon'))
      }
    }

    // What the file says about itself outranks what its name suggests, but only when it
    // says something: a missing version resource is not evidence of anything, and the
    // engine binary we are hunting for is often the one that has none.
    const said = exeKindFromVersion(meta?.version)
    const named = exeKindOf(base)
    const kind = said ?? named
    if (meta?.version?.description) {
      reasons.push(t('exeWhy.describes', { text: meta.version.description }))
    } else if (meta?.version?.product) {
      reasons.push(t('exeWhy.product', { text: meta.version.product }))
    }
    if (said && said !== named && said !== 'main') {
      reasons.push(t('exeWhy.byDescription', { kind: t(KIND_LABELS[said]) }))
    }

    out.push({
      name: exe.name,
      fullPath,
      size: exe.size,
      score,
      kind,
      reasons,
      rankable: !isBlacklistedExe(base),
      version: meta?.version ?? undefined
    })
  }
  return out
}

/**
 * Rank every plausible main program in a folder, best first — the filtered view of
 * `classifyExes` that scanning uses.
 *
 * Blacklisted names (uninstallers, redistributables, patches) are dropped outright.
 * Everything the classifier judged to be something other than the game — a launcher, a
 * locale emulator, a settings tool it recognised from the file's own description — is
 * demoted, and only offered when nothing else qualifies. That last part is what stops a
 * folder of nothing but tools from coming back empty.
 */
export function rankExes(
  dir: string,
  entries: DirEntry[],
  probeMeta?: ExeMetaProbe
): ExeCandidate[] {
  const strong: ExeVerdict[] = []
  const weak: ExeVerdict[] = []
  for (const verdict of classifyExes(dir, entries, probeMeta)) {
    if (!verdict.rankable) continue
    if (verdict.kind === 'main') strong.push(verdict)
    else weak.push(verdict)
  }

  const pool = strong.length > 0 ? strong : weak
  pool.sort((a, b) => b.score - a.score || b.size - a.size)
  return pool.map(({ name, fullPath, size, score }) => ({ name, fullPath, size, score }))
}

/** The single best candidate, which is what scanning cares about. */
export function pickMainExe(
  dir: string,
  entries: DirEntry[],
  probeMeta?: ExeMetaProbe
): ExeCandidate | null {
  return rankExes(dir, entries, probeMeta)[0] ?? null
}

/** Folders below a game that hold copies rather than the game itself. */
const SUB_NOISE = /^(node_modules|\.git|__pycache__|temp|tmp|cache)$/i

/**
 * Executables below the game folder, for the picker to offer as a last resort.
 *
 * These never compete for the main slot — a `backup\BGI.exe` outranking the real one on
 * size would be a bad joke — but they have to be visible, because occasionally the game
 * really does live one level down.
 */
export function collectSubExes(
  dir: string,
  maxDepth = 2,
  cap = 60
): { rel: string; fullPath: string; size: number }[] {
  const out: { rel: string; fullPath: string; size: number }[] = []
  const walk = (current: string, depth: number): void => {
    if (depth > maxDepth || out.length >= cap) return
    for (const entry of readDirSafe(current)) {
      if (out.length >= cap) return
      const full = path.join(current, entry.name)
      if (entry.isDir) {
        if (!SUB_NOISE.test(entry.name)) walk(full, depth + 1)
      } else if (/\.exe$/i.test(entry.name)) {
        out.push({ rel: path.relative(dir, full), fullPath: full, size: entry.size })
      }
    }
  }
  // Start one level in: the folder's own executables are `classifyExes`'s job.
  for (const entry of readDirSafe(dir)) {
    if (entry.isDir && !SUB_NOISE.test(entry.name)) walk(path.join(dir, entry.name), 1)
  }
  return out
}

/**
 * Which engine built this folder, as far as the layout gives it away.
 *
 * Deliberately **not** the same function as `hasEngineSignature` below, and deliberately
 * not implemented in terms of it. The two answer different questions and have opposite
 * failure costs:
 *
 * - `hasEngineSignature` decides whether a folder counts as a game at all. Widening it
 *   changes what lands in someone's library, so it has to stay exactly as conservative
 *   as it was.
 * - `detectEngine` only informs the launch diagnosis. It recognises a much broader set —
 *   BGI, Siglus, Majiro and the rest never vouched for a folder and still must not — and
 *   a wrong guess here costs one unhelpful hint, not a wrong library.
 *
 * Folding them together would mean every engine added for diagnosis silently redefined
 * what a game is. So they share nothing but the directory listing.
 *
 * Order matters: the most specific layout wins, because engines nest (a Ren'Py game is
 * also a folder full of Python, an RPG Maker MV game is also NW.js).
 */
export function detectEngine(entries: DirEntry[], exeBase: string): EngineId | null {
  const dirs = new Set(entries.filter((e) => e.isDir).map((e) => e.name.toLowerCase()))
  const files = new Set(entries.filter((e) => !e.isDir).map((e) => e.name.toLowerCase()))
  const names = [...files]
  const ext = (suffix: string): boolean => names.some((n) => n.endsWith(suffix))

  // Unity names its payload after the executable, which is as specific as a signature gets.
  if (dirs.has(`${exeBase.toLowerCase()}_data`)) return 'unity'
  if (files.has('unityplayer.dll') || files.has('gameassembly.dll')) return 'unity'
  if (dirs.has('monobleedingedge')) return 'unity'

  if (dirs.has('renpy') || ext('.rpa')) return 'renpy'
  if (ext('.xp3') || files.has('krkr.exe') || files.has('krkrz.exe') || ext('.tjs')) {
    return 'kirikiri'
  }

  // Ethornell keeps its script table in a file named exactly this, next to the .arc data.
  if (files.has('bgi.gdb') || files.has('bgi.exe') || files.has('sysgrp.arc')) return 'bgi'
  if (files.has('siglusengine.exe') || files.has('gameexe.dat')) return 'siglus'
  if (ext('.mjo') || files.has('majiro.exe')) return 'majiro'
  // `0.txt` is also an NScripter script, but it is far too ordinary a filename to key on.
  if (files.has('nscript.dat') || files.has('arc.nsa')) return 'nscripter'
  if (ext('.pfs') || files.has('root.pfs')) return 'artemis'

  if (dirs.has('tyrano')) return 'tyrano'
  if (dirs.has('engine') || names.some((n) => n.startsWith('manifest_ufsfiles'))) {
    return 'unreal'
  }

  // RPG Maker: `www` is MV, the packed archives are XP through VX Ace.
  if (dirs.has('www') || ext('.rgssad') || ext('.rgss2a') || ext('.rgss3a')) return 'rpgmaker'
  if (ext('.wolf') || files.has('guruguru.dll') || files.has('gurugurusmf4.dll')) return 'wolf'
  if (dirs.has('data') && dirs.has('graphics') && dirs.has('audio')) return 'rpgmaker'

  // Last, because half the engines above ship on top of it.
  if (files.has('package.json') && dirs.has('node_modules')) return 'nwjs'
  if (files.has('nw.dll') || files.has('nw.pak')) return 'nwjs'

  return null
}

/**
 * `detectEngine` for callers holding a path rather than a listing.
 *
 * One extra directory read per game. Everything that calls this is already walking the
 * disk, and the diagnosis calls it again rather than trusting a stored value, so a
 * library recorded before engines existed still reports one.
 */
export function detectEngineAt(dir: string, exePath: string): EngineId | null {
  const base = path.basename(exePath || '').replace(/\.exe$/i, '')
  return detectEngine(readDirSafe(dir), base)
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
 * Sidecar that records everything the user decided about a game: its title, status,
 * rating, tags and play history.
 *
 * Renaming the folder itself is not an option — plenty of these games resolve assets
 * by path, or ship shortcuts and save files that point at the original name — so the
 * title is written beside the game instead. Everything else lives here too because it
 * makes the record portable: reinstall Windows, point the launcher at the same drive,
 * and one scan brings the whole library back.
 *
 * It is Markdown, editable by hand, and explains itself — whoever opens it later will
 * not remember what put it there.
 */
export const SIDECAR = 'sakura-launcher.md'

/** v0.1.0 stored only the display name, in a plain-text file. Migrated on first sync. */
export const LEGACY_SIDECAR = 'sakura-launcher.txt'

/**
 * What a fetched cover is called, inside the game folder.
 *
 * Fixed, so the picture is findable twice over: the sidecar names it, and failing that a
 * scan can simply look for this. A cover is worth a second route — it is the one piece of
 * this that took a download, and a file called `sakura-cover.jpg` sitting beside the game
 * explains itself to a person browsing the folder in a way `a9f3c1.jpg` never would.
 *
 * The extension varies with what the catalogue actually sent, which is why the name is
 * written down rather than assumed.
 */
export const COVER_BASE = 'sakura-cover'

/**
 * Extensions a cover can have, in the order a folder is searched when the file is unnamed.
 *
 * Wider than what a download can produce (jpg / png / webp are the only three the byte
 * sniffer accepts) because a cover the user chose by hand is copied in under whatever
 * extension it arrived with, and this list is also what finds and tidies those.
 */
export const COVER_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'] as const

/**
 * The cover sitting in a game folder, if there is one.
 *
 * The fallback for a sidecar that never mentioned one — deleted, hand-edited, or written
 * by a version that did not record it. Returns a file name, not a path, because that is
 * what everything downstream stores.
 */
export function findCoverIn(dir: string): string | null {
  for (const ext of COVER_EXTS) {
    const name = `${COVER_BASE}.${ext}`
    try {
      if (fs.statSync(path.join(dir, name)).isFile()) return name
    } catch {
      /* not this one */
    }
  }
  return null
}

export interface SidecarSession {
  startedAt: number
  ms: number
}

/**
 * The cover, as the file next to the game.
 *
 * A **file name**, never a path. The folder it sits in is the folder this sidecar sits
 * in, so the two travel together: rename the folder, move it to another drive, hand the
 * whole thing to somebody else — the name still resolves, because it is resolved against
 * wherever the file was found rather than against where it once was. An absolute path
 * would be a fact about this machine, and would be wrong the first time anything moved.
 *
 * `from` is carried for one reason: a cover the user chose must not be replaced by a
 * catalogue pass. Without it here, that protection would live only in the database and
 * would be lost exactly when the sidecar is doing its job.
 */
export interface SidecarCover {
  name: string
  /**
   * Absent when nobody knows — a file found sitting in the folder with nothing recorded
   * about it. Which is not the same claim as "the user chose this", and writing that down
   * would be inventing a fact. Read back, an unattributed cover is *treated* as the
   * user's, because that reading protects it and the other one overwrites it.
   */
  from?: 'user' | 'dlsite' | 'vndb'
}

/** Every field is optional: a key missing from the file leaves the database value alone. */
export interface SidecarData {
  name?: string
  /** File name of the chosen main program, relative to the game folder. */
  exe?: string
  /** Arguments it is started with — how a locale-emulator entry is recorded. */
  launchArgs?: string[]
  wishlist?: boolean
  playing?: boolean
  played?: boolean
  rating?: number | null
  tier?: string | null
  tags?: string[]
  playtimeMs?: number
  launchCount?: number
  lastLaunchedAt?: number | null
  sessions?: SidecarSession[]

  /* ---- what the catalogue said, so a lookup is not paid for twice ---- */

  /**
   * The catalogue entry this game was matched to.
   *
   * The most valuable line in the file: it is the game's identity in somebody else's
   * database, and everything below can be fetched again from it in one request. A folder
   * that turns up on another machine carries it and needs no matching at all.
   */
  work?: { source: string; workId: string; title?: string }
  /** Genre tags, by the name each was shown under. */
  autoTags?: AutoTag[]
  /** The catalogue's description, as text. */
  summary?: string
  /** Who wrote it — the line under the description says so, here and on screen. */
  summaryFrom?: string
  /** It was machine-translated. Written down so a reader is never misled about which. */
  summaryTranslated?: boolean
  cover?: SidecarCover
}

/**
 * The note at the top of every sidecar.
 *
 * A function rather than a constant: the language is not known when this module is
 * loaded, and an array evaluated at import time would freeze whichever language happened
 * to be set first — which is how an English library ends up with Chinese explanations at
 * the top of every file.
 */
function header(): string[] {
  return mainLang() === 'en'
    ? [
        '> Maintained by Sakura Launcher: what you set for this game, and how long you played.',
        '> It changes no file the game itself uses and does not affect starting it — keeping',
        '> these here is exactly how renaming the folder is avoided.',
        '>',
        '> Edit it freely; Refresh in the launcher reads it back. Delete it to reset to defaults.'
      ]
    : [
        '> 这个文件由 Sakura Launcher 维护，记录你对这个游戏的设置与游玩记录。',
        '> 它不会改动游戏本身的任何文件，也不影响游戏启动 —— 正是为了避免直接',
        '> 重命名文件夹导致游戏找不到资源，才把这些记在这里。',
        '>',
        '> 可以直接编辑，下次在启动器里点「扫描」就会读回去。删掉文件即恢复默认。'
      ]
}

/**
 * Status flags, with the word written for each language.
 *
 * The file is read in both regardless of the current setting: a library recorded in
 * Chinese and later switched to English must still round-trip, and so must a file the
 * user hand-edited before ever touching the language menu.
 */
const STATUS_LABELS: { key: keyof SidecarData; zh: string; en: string }[] = [
  { key: 'wishlist', zh: '想玩', en: 'Wishlist' },
  { key: 'playing', zh: '在玩', en: 'Playing' },
  { key: 'played', zh: '玩过', en: 'Played' }
]

/**
 * Field names in the sidecar, in both languages.
 *
 * These are the parse keys, not decoration — which is why every one of them is read in
 * both forms while only the current language is ever written. Changing the interface
 * language rewrites these files on the next sync; it never orphans one.
 */
const SIDECAR_FIELDS = {
  name: { zh: '显示名称', en: 'Display name' },
  status: { zh: '状态', en: 'Status' },
  rating: { zh: '评分', en: 'Rating' },
  tier: { zh: '评级', en: 'Tier' },
  tags: { zh: '标签', en: 'Tags' },
  exe: { zh: '主程序', en: 'Main program' },
  args: { zh: '启动参数', en: 'Launch arguments' },
  playtime: { zh: '总时长', en: 'Total playtime' },
  launches: { zh: '启动次数', en: 'Times launched' },
  last: { zh: '最后游玩', en: 'Last played' },
  work: { zh: '作品', en: 'Work' },
  cover: { zh: '封面', en: 'Cover' },
  // Three lines rather than one with markers on it. What separates them is not decoration:
  // the launcher hides the second and third by default, and a file that flattened them
  // into one list would put an explicit tag back on screen — or spoil an ending — the
  // first time it was read back.
  autoTags: { zh: '题材标签', en: 'Genre tags' },
  adultTags: { zh: 'R18 标签', en: 'Adult tags' },
  spoilerTags: { zh: '剧透标签', en: 'Spoiler tags' }
} as const

type SidecarField = keyof typeof SIDECAR_FIELDS

/** The label to write for a field, in whichever language is set. */
function fieldLabel(key: SidecarField): string {
  return SIDECAR_FIELDS[key][mainLang() === 'en' ? 'en' : 'zh']
}

/** Sentinels that stand in for an empty value, written per language and read in both. */
const SENTINELS = {
  none: { zh: '无', en: 'none' },
  unrated: { zh: '未评分', en: 'unrated' },
  untiered: { zh: '未评级', en: 'no tier' },
  never: { zh: '从未', en: 'never' },
  /** A cover the user chose, which no catalogue pass may replace. */
  byHand: { zh: '自己设的', en: 'set by hand' }
} as const

/**
 * Catalogue names, written as the catalogues spell themselves.
 *
 * Proper nouns, so they are the same in both languages and are not translated. Read back
 * case-insensitively, since this is a file people edit.
 */
const SOURCE_LABELS: Record<string, string> = {
  dlsite: 'DLsite',
  vndb: 'VNDB',
  bangumi: 'Bangumi'
}

function sentinel(key: keyof typeof SENTINELS): string {
  return SENTINELS[key][mainLang() === 'en' ? 'en' : 'zh']
}

function isSentinel(key: keyof typeof SENTINELS, value: string): boolean {
  const v = value.trim().toLowerCase()
  return v === SENTINELS[key].zh.toLowerCase() || v === SENTINELS[key].en.toLowerCase()
}

function stars(rating: number): string {
  return '★'.repeat(rating) + '☆'.repeat(5 - rating)
}

/** Quote only what needs it, so a hand-editable file stays readable. */
function quoteArg(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '')}"` : arg
}

/**
 * Split an argument line the way Windows does: quotes group, whitespace separates.
 * Shared with the shortcut reader in the main process, so a line typed into the sidecar
 * and a line taken from a .lnk are broken up identically.
 */
export function splitArgs(line: string): string[] {
  const args: string[] = []
  let current = ''
  let quoted = false
  let started = false

  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted
      started = true
      continue
    }
    if (!quoted && /\s/.test(ch)) {
      if (started) args.push(current)
      current = ''
      started = false
      continue
    }
    current += ch
    started = true
  }
  if (started) args.push(current)
  return args
}

function formatStamp(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function parseStamp(text: string): number | null {
  const m = /(\d{4})-(\d{1,2})-(\d{1,2})[ T]+(\d{1,2}):(\d{2})/.exec(text)
  if (!m) return null
  const ms = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5])
  ).getTime()
  return isFinite(ms) ? ms : null
}

/** Accepts both ASCII and full-width separators — hand-edited files use either. */
function splitList(value: string): string[] {
  return value
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function renderSidecar(data: SidecarData): string {
  const en = mainLang() === 'en'
  const status = STATUS_LABELS.filter((f) => data[f.key] === true).map((f) => (en ? f.en : f.zh))
  const title = en ? `# ${data.name ?? ''}` : `# 《${data.name ?? ''}》`
  const lines: string[] = [title, '', ...header(), '', en ? '## Settings' : '## 设置', '']

  lines.push(`- ${fieldLabel('name')}: ${data.name ?? ''}`)
  lines.push(`- ${fieldLabel('status')}: ${status.length > 0 ? status.join(', ') : sentinel('none')}`)
  lines.push(
    `- ${fieldLabel('rating')}: ${
      typeof data.rating === 'number' ? `${stars(data.rating)} (${data.rating})` : sentinel('unrated')
    }`
  )
  lines.push(`- ${fieldLabel('tier')}: ${data.tier ?? sentinel('untiered')}`)
  lines.push(
    `- ${fieldLabel('tags')}: ${
      data.tags && data.tags.length > 0 ? data.tags.join(', ') : sentinel('none')
    }`
  )
  // Only written once the user has picked one by hand. A line stating the scanner's own
  // guess would read as a decision they made, and would come back as one on re-import.
  if (data.exe) {
    lines.push(`- ${fieldLabel('exe')}: ${data.exe}`)
    if (data.launchArgs && data.launchArgs.length > 0) {
      lines.push(`- ${fieldLabel('args')}: ${data.launchArgs.map(quoteArg).join(' ')}`)
    }
  }

  // Everything a catalogue said, so that losing the database does not mean paying for the
  // lookup again — and so that a folder handed to somebody else arrives knowing what it is.
  const cover = data.cover
  const tags = data.autoTags ?? []
  const plain = tags.filter((tag) => !tag.adult && !tag.spoiler)
  const adult = tags.filter((tag) => tag.adult)
  const spoiler = tags.filter((tag) => !tag.adult && tag.spoiler)
  const summary = (data.summary ?? '').trim()

  if (data.work || cover || tags.length > 0 || summary) {
    lines.push('', en ? '## From the catalogue' : '## 目录站资料', '')
    if (data.work) {
      const label = SOURCE_LABELS[data.work.source] ?? data.work.source
      const title = data.work.title ? ` · ${data.work.title}` : ''
      lines.push(`- ${fieldLabel('work')}: ${label} ${data.work.workId}${title}`)
    }
    if (cover) {
      const from = !cover.from
        ? ''
        : cover.from === 'user'
          ? ` (${sentinel('byHand')})`
          : ` (${SOURCE_LABELS[cover.from] ?? cover.from})`
      lines.push(`- ${fieldLabel('cover')}: ${cover.name}${from}`)
    }
    const tagLine = (key: SidecarField, list: AutoTag[]): void => {
      if (list.length > 0) lines.push(`- ${fieldLabel(key)}: ${list.map((x) => x.label).join(', ')}`)
    }
    tagLine('autoTags', plain)
    tagLine('adultTags', adult)
    tagLine('spoilerTags', spoiler)

    if (summary) {
      lines.push('', en ? '### Description' : '### 简介', '')
      if (data.summaryFrom) {
        const label = SOURCE_LABELS[data.summaryFrom] ?? data.summaryFrom
        const mark = data.summaryTranslated ? (en ? ' (machine-translated)' : '（机翻）') : ''
        lines.push(en ? `> From ${label}${mark}` : `> 来自 ${label}${mark}`, '')
      }
      // Somebody else's paragraph, kept as they wrote it — the line breaks in a blurb are
      // the author's and reflowing them here would be editing it.
      lines.push(...summary.split('\n'))
    }
  }

  lines.push('', en ? '## Statistics' : '## 统计', '')
  lines.push(`- ${fieldLabel('playtime')}: ${formatDuration(data.playtimeMs ?? 0, mainLang())}`)
  lines.push(`- ${fieldLabel('launches')}: ${data.launchCount ?? 0}`)
  lines.push(
    `- ${fieldLabel('last')}: ${
      data.lastLaunchedAt ? formatStamp(data.lastLaunchedAt) : sentinel('never')
    }`
  )

  const sessions = data.sessions ?? []
  if (sessions.length > 0) {
    lines.push(
      '',
      en ? '## Play history' : '## 游玩记录',
      '',
      en ? '| Started | Length |' : '| 开始时间 | 时长 |',
      '| --- | --- |'
    )
    for (const s of sessions) {
      lines.push(`| ${formatStamp(s.startedAt)} | ${formatDuration(s.ms, mainLang())} |`)
    }
  }

  lines.push('')
  return lines.join('\r\n')
}

/**
 * A whole section of prose, rather than one `key: value` line.
 *
 * The description is a paragraph somebody else wrote and cannot be squeezed onto a line,
 * so it gets a heading of its own and everything up to the next heading belongs to it.
 * The attribution rides in a leading blockquote, which reads as a citation to a person
 * and parses as one line to us.
 */
function readSection(
  raw: string,
  headings: string[]
): { text: string; from?: string; translated?: boolean } | null {
  const lines = raw.split(/\r?\n/)
  const pattern = new RegExp(`^\\s*#{2,4}\\s*(?:${headings.join('|')})\\s*$`, 'i')
  const start = lines.findIndex((line) => pattern.test(line))
  if (start < 0) return null

  const body: string[] = []
  let from: string | undefined
  let translated = false
  for (const line of lines.slice(start + 1)) {
    if (/^\s*#{1,6}\s/.test(line)) break
    const cite = /^\s*>\s*(?:来自|From)\s+(.+?)\s*$/i.exec(line)
    if (cite) {
      const said = cite[1].trim()
      translated = /（机翻）|\(machine-translated\)/i.test(said)
      from = said.replace(/（机翻）|\s*\(machine-translated\)/i, '').trim().toLowerCase()
      continue
    }
    // A hand-editor may or may not keep the quote markers; either way the text is the text.
    body.push(line.replace(/^\s*>\s?/, ''))
  }

  const text = body.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!text) return null
  return {
    text,
    from: from && SOURCE_LABELS[from] ? from : undefined,
    translated: translated || undefined
  }
}

export function parseSidecar(text: string): SidecarData {
  const raw = text.replace(/^﻿/, '')
  const data: SidecarData = {}

  // Tolerant of both colon forms and of the `键 = 值` shape the v0.1.0 file used.
  const field = (key: SidecarField): string | null => {
    const { zh, en } = SIDECAR_FIELDS[key]
    // Either language's label, whichever the file happens to use.
    const m = new RegExp(
      `^[ \\t]*[-*]?[ \\t]*(?:${zh}|${en})[ \\t]*[:：=][ \\t]*(.+?)[ \\t]*$`,
      'mi'
    ).exec(raw)
    return m ? m[1].trim() : null
  }

  const name = field('name')
  if (name) data.name = name

  const status = field('status')
  if (status !== null) {
    const parts = splitList(status).map((x) => x.toLowerCase())
    for (const flag of STATUS_LABELS) {
      ;(data as Record<string, unknown>)[flag.key] =
        parts.includes(flag.zh.toLowerCase()) || parts.includes(flag.en.toLowerCase())
    }
  }

  const rating = field('rating')
  if (rating !== null) {
    // The digit in parentheses is authoritative; the stars are decoration for the reader.
    const digit = /\((\d)\)/.exec(rating) ?? /^\s*(\d)\s*$/.exec(rating)
    if (digit) data.rating = Math.min(5, Math.max(0, Number(digit[1])))
    else if (/★/.test(rating)) data.rating = (rating.match(/★/g) ?? []).length
    else data.rating = null
  }

  const tier = field('tier')
  if (tier !== null) {
    const value = tier.trim()
    data.tier = /^(T[0-3]|trash)$/i.test(value)
      ? value.toLowerCase() === 'trash'
        ? 'trash'
        : value.toUpperCase()
      : null
  }

  const tags = field('tags')
  if (tags !== null) data.tags = isSentinel('none', tags) ? [] : splitList(tags)

  const exe = field('exe')
  if (exe) data.exe = exe.replace(/^["']|["']$/g, '')

  const args = field('args')
  if (args !== null) data.launchArgs = splitArgs(args)

  const playtime = field('playtime')
  if (playtime !== null) {
    const ms = parseDuration(playtime)
    if (ms !== null) data.playtimeMs = ms
  }

  const launches = field('launches')
  if (launches !== null) {
    const n = Number(launches.trim())
    if (isFinite(n) && n >= 0) data.launchCount = Math.round(n)
  }

  const last = field('last')
  if (last !== null) data.lastLaunchedAt = parseStamp(last)

  /* ---- what a catalogue said ---- */

  const work = field('work')
  if (work) {
    // `VNDB v16044 · サノバウィッチ` — the source, the id, and a title for the reader.
    const m = /^\s*([A-Za-z]+)\s+(\S+)(?:\s*[·・|-]\s*(.+))?$/.exec(work)
    if (m && SOURCE_LABELS[m[1].toLowerCase()]) {
      data.work = {
        source: m[1].toLowerCase(),
        workId: m[2],
        title: m[3]?.trim() || undefined
      }
    }
  }

  const cover = field('cover')
  if (cover) {
    // `sakura-cover.jpg (VNDB)`. A name only, never a path: anything with a separator in
    // it came from somewhere else and cannot be trusted to point inside this folder.
    const m = /^(.+?)\s*(?:\(([^)]*)\))?\s*$/.exec(cover)
    const name = (m?.[1] ?? '').trim().replace(/^["']|["']$/g, '')
    if (name && !/[\\/]/.test(name) && name !== '..') {
      const from = (m?.[2] ?? '').trim().toLowerCase()
      // A catalogue names itself. "Set by hand" is the user saying so. Anything else —
      // a word somebody typed, or no parenthesis at all — leaves the question open, and
      // an open question is treated as the user's wherever it is used, which is the
      // reading that protects the file rather than overwriting it.
      data.cover = {
        name,
        from:
          from === 'dlsite' || from === 'vndb'
            ? from
            : isSentinel('byHand', from)
              ? 'user'
              : undefined
      }
    }
  }

  const autoTags: AutoTag[] = []
  const readTags = (key: SidecarField, extra: Partial<AutoTag>): void => {
    const value = field(key)
    if (value === null || isSentinel('none', value)) return
    for (const label of splitList(value)) {
      // A four-digit label is the release year, which the tag bar treats as its own facet
      // — one year at a time, because a work does not have two. Reading it back as a
      // genre would put it in the wrong row and make the filter behave like a genre.
      const year = /^\d{4}$/.test(label)
      autoTags.push({
        id: year ? `year:${label}` : `genre:${label.toLowerCase()}`,
        facet: year ? 'year' : 'genre',
        label,
        // Said plainly rather than repeating the catalogue's own reasoning, which is not
        // in the file: this tag is here because the file next to the game says so.
        reasonKey: 'tag.why.sidecar',
        ...extra
      })
    }
  }
  readTags('autoTags', {})
  readTags('adultTags', { adult: true })
  readTags('spoilerTags', { spoiler: true })
  if (autoTags.length > 0) data.autoTags = autoTags

  const description = readSection(raw, ['简介', 'Description'])
  if (description) {
    data.summary = description.text
    if (description.from) data.summaryFrom = description.from
    if (description.translated) data.summaryTranslated = true
  }

  const sessions: SidecarSession[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim())
    // cells[0] is the empty string before the leading pipe.
    const startedAt = parseStamp(cells[1] ?? '')
    const ms = parseDuration(cells[2] ?? '')
    if (startedAt !== null && ms !== null) sessions.push({ startedAt, ms })
  }
  if (sessions.length > 0) data.sessions = sessions

  return data
}

export function readSidecar(dir: string): SidecarData | null {
  try {
    return parseSidecar(fs.readFileSync(path.join(dir, SIDECAR), 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Read just the display name, without parsing the rest. Scanning calls this for every
 * folder it finds, so it stays deliberately cheap; the full read happens only on an
 * explicit sync. Falls back to the v0.1.0 plain-text file.
 */
export function readSidecarName(dir: string): string | null {
  for (const file of [SIDECAR, LEGACY_SIDECAR]) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf-8').replace(/^﻿/, '')
      const m = new RegExp(
        `^[ \\t]*[-*]?[ \\t]*(?:${SIDECAR_FIELDS.name.zh}|${SIDECAR_FIELDS.name.en})` +
          `[ \\t]*[:：=][ \\t]*(.+?)[ \\t]*$`,
        'mi'
      ).exec(raw)
      const value = m?.[1]?.trim()
      if (value) return value
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

export function writeSidecar(
  dir: string,
  data: SidecarData
): { ok: boolean; mtimeMs?: number; error?: string } {
  const file = path.join(dir, SIDECAR)
  const body = renderSidecar(data)
  try {
    // Written with a BOM: this file is meant to be opened by a person, and Windows
    // editors fall back to the ANSI codepage without one, turning Chinese into mojibake.
    fs.writeFileSync(file, '﻿' + body, 'utf-8')
    // Drop the file the previous version wrote, now that its content lives here.
    try {
      fs.unlinkSync(path.join(dir, LEGACY_SIDECAR))
    } catch {
      /* absent, which is the common case */
    }
    return { ok: true, mtimeMs: fs.statSync(file).mtimeMs }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Skip the write when nothing changed, so mtimes stay meaningful as an edit signal. */
export function writeSidecarIfChanged(
  dir: string,
  data: SidecarData
): { ok: boolean; mtimeMs?: number; error?: string; skipped?: boolean } {
  const file = path.join(dir, SIDECAR)
  try {
    const existing = fs.readFileSync(file, 'utf-8').replace(/^﻿/, '')
    if (existing === renderSidecar(data)) {
      return { ok: true, mtimeMs: fs.statSync(file).mtimeMs, skipped: true }
    }
  } catch {
    /* missing or unreadable: fall through and write it */
  }
  return writeSidecar(dir, data)
}

export function removeSidecar(dir: string): void {
  for (const file of [SIDECAR, LEGACY_SIDECAR]) {
    try {
      fs.unlinkSync(path.join(dir, file))
    } catch {
      /* already gone */
    }
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
export function archiveBaseName(fileName: string): string | null {
  const vol = VOLUME_RE.exec(fileName)
  if (vol) return vol[1].replace(/\.7z$/i, '')
  if (ARCHIVE_RE.test(fileName)) return fileName.replace(ARCHIVE_RE, '')
  return null
}

export function isArchiveFile(fileName: string): boolean {
  return archiveBaseName(fileName) !== null
}

/**
 * Walk a root looking for game folders.
 * A folder that directly holds a usable .exe is a game and we stop descending;
 * otherwise we keep going down to MAX_DEPTH. That handles libraries where games sit
 * at wildly different depths.
 *
 * `readNames` controls whether each folder's sidecar is consulted for a display name.
 * A rescan already knows the name of every folder it has seen before, so it turns this
 * off and resolves names only for what actually changed — leaving a routine startup
 * scan with no sidecar reads at all.
 */
export function walkRoot(
  root: string,
  probeMeta?: ExeMetaProbe,
  readNames = true
): WalkResult {
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

    const main = pickMainExe(dir, entries, probeMeta)
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
          name: (readNames ? readSidecarName(dir) : null) ?? displayNameFor(dir),
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
