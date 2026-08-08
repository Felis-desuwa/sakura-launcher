import fs from 'node:fs'
import path from 'node:path'
// Extension spelled out: the harnesses in scripts/ import this file straight into node,
// where nothing fills the extension in for them.
import { formatDuration, parseDuration } from '../shared/types.ts'

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
 * A folder like 穢翼のユースティア ships twelve of them — engine, two uninstallers, a
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
 * `ESUforEustia` / `ISESUforEustia` look like locale emulators and are not: their
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

const KIND_LABELS: Record<ExeKind, string> = {
  main: '主程序候选',
  launcher: '启动器',
  locale: '区域模拟器',
  patch: '补丁',
  uninstall: '卸载程序',
  tool: '工具',
  sub: '子目录'
}

export function exeKindLabel(kind: ExeKind): string {
  return KIND_LABELS[kind]
}

/**
 * What an executable says about itself, from its VS_VERSIONINFO resource.
 *
 * Filenames lie; descriptions rarely do. `ESUforEustia.exe` reads like a locale-emulator
 * wrapper and is in fact the engine's own 「環境設定ツール」 by BURIKO, and
 * `穢翼のユースティア NoDVD.EXE` declares itself 「Update for Windows95」 by a different
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
 * engine binary in 穢翼のユースティア is one of them. Treating "no description" as a mark
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
      reasons.push(`有同名的 ${base}_Data 目录`)
    }
    if (fuzzyMatch(base, dirName)) {
      score += 50
      reasons.push('文件名与游戏文件夹同名')
    }
    if (hasXp3) {
      score += 20
      reasons.push('目录里有 .xp3 引擎资源')
    }
    if (hasRpgMaker && /^game$/i.test(base)) {
      score += 40
      reasons.push('RPG Maker 的主程序名')
    }
    if (hasRenpy) {
      score += 20
      reasons.push('Ren’Py 引擎目录')
    }
    if (exe.size === maxSize && exes.length > 1) reasons.push('目录里体积最大的 exe')
    score += Math.round((exe.size / maxSize) * 10)

    const fullPath = path.join(dir, exe.name)
    const meta = probeMeta?.(fullPath)
    if (meta) {
      const px = meta.maxIconSize
      if (px >= 256) {
        score += 30
        reasons.push(`自带 ${px}px 图标`)
      } else if (px >= 128) {
        score += 15
        reasons.push(`自带 ${px}px 图标`)
      } else if (px >= 64) {
        score += 5
        reasons.push(`自带 ${px}px 图标`)
      } else if (px === 0) {
        reasons.push('没有内嵌图标')
      }
    }

    // What the file says about itself outranks what its name suggests, but only when it
    // says something: a missing version resource is not evidence of anything, and the
    // engine binary we are hunting for is often the one that has none.
    const said = exeKindFromVersion(meta?.version)
    const named = exeKindOf(base)
    const kind = said ?? named
    if (meta?.version?.description) {
      reasons.push(`自述：${meta.version.description}`)
    } else if (meta?.version?.product) {
      reasons.push(`自述产品：${meta.version.product}`)
    }
    if (said && said !== named && said !== 'main') {
      reasons.push(`按自述判定为${KIND_LABELS[said]}`)
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

export interface SidecarSession {
  startedAt: number
  ms: number
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
}

const HEADER = [
  '> 这个文件由 Sakura Launcher 维护，记录你对这个游戏的设置与游玩记录。',
  '> 它不会改动游戏本身的任何文件，也不影响游戏启动 —— 正是为了避免直接',
  '> 重命名文件夹导致游戏找不到资源，才把这些记在这里。',
  '>',
  '> 可以直接编辑，下次在启动器里点「扫描」就会读回去。删掉文件即恢复默认。'
]

const STATUS_LABELS: [keyof SidecarData, string][] = [
  ['wishlist', '想玩'],
  ['playing', '在玩'],
  ['played', '玩过']
]

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
  const status = STATUS_LABELS.filter(([key]) => data[key] === true).map(([, label]) => label)
  const lines: string[] = [`# 《${data.name ?? ''}》`, '', ...HEADER, '', '## 设置', '']

  lines.push(`- 显示名称: ${data.name ?? ''}`)
  lines.push(`- 状态: ${status.length > 0 ? status.join(', ') : '无'}`)
  lines.push(
    `- 评分: ${typeof data.rating === 'number' ? `${stars(data.rating)} (${data.rating})` : '未评分'}`
  )
  lines.push(`- 评级: ${data.tier ?? '未评级'}`)
  lines.push(`- 标签: ${data.tags && data.tags.length > 0 ? data.tags.join(', ') : '无'}`)
  // Only written once the user has picked one by hand. A line stating the scanner's own
  // guess would read as a decision they made, and would come back as one on re-import.
  if (data.exe) {
    lines.push(`- 主程序: ${data.exe}`)
    if (data.launchArgs && data.launchArgs.length > 0) {
      lines.push(`- 启动参数: ${data.launchArgs.map(quoteArg).join(' ')}`)
    }
  }

  lines.push('', '## 统计', '')
  lines.push(`- 总时长: ${formatDuration(data.playtimeMs ?? 0)}`)
  lines.push(`- 启动次数: ${data.launchCount ?? 0}`)
  lines.push(`- 最后游玩: ${data.lastLaunchedAt ? formatStamp(data.lastLaunchedAt) : '从未'}`)

  const sessions = data.sessions ?? []
  if (sessions.length > 0) {
    lines.push('', '## 游玩记录', '', '| 开始时间 | 时长 |', '| --- | --- |')
    for (const s of sessions) {
      lines.push(`| ${formatStamp(s.startedAt)} | ${formatDuration(s.ms)} |`)
    }
  }

  lines.push('')
  return lines.join('\r\n')
}

export function parseSidecar(text: string): SidecarData {
  const raw = text.replace(/^﻿/, '')
  const data: SidecarData = {}

  // Tolerant of both colon forms and of the `键 = 值` shape the v0.1.0 file used.
  const field = (key: string): string | null => {
    const m = new RegExp(`^[ \\t]*[-*]?[ \\t]*${key}[ \\t]*[:：=][ \\t]*(.+?)[ \\t]*$`, 'm').exec(raw)
    return m ? m[1].trim() : null
  }

  const name = field('显示名称')
  if (name) data.name = name

  const status = field('状态')
  if (status !== null) {
    const parts = splitList(status)
    for (const [key, label] of STATUS_LABELS) {
      ;(data as Record<string, unknown>)[key] = parts.includes(label)
    }
  }

  const rating = field('评分')
  if (rating !== null) {
    // The digit in parentheses is authoritative; the stars are decoration for the reader.
    const digit = /\((\d)\)/.exec(rating) ?? /^\s*(\d)\s*$/.exec(rating)
    if (digit) data.rating = Math.min(5, Math.max(0, Number(digit[1])))
    else if (/★/.test(rating)) data.rating = (rating.match(/★/g) ?? []).length
    else data.rating = null
  }

  const tier = field('评级')
  if (tier !== null) {
    const value = tier.trim()
    data.tier = /^(T[0-3]|trash)$/i.test(value)
      ? value.toLowerCase() === 'trash'
        ? 'trash'
        : value.toUpperCase()
      : null
  }

  const tags = field('标签')
  if (tags !== null) data.tags = tags === '无' ? [] : splitList(tags)

  const exe = field('主程序')
  if (exe) data.exe = exe.replace(/^["']|["']$/g, '')

  const args = field('启动参数')
  if (args !== null) data.launchArgs = splitArgs(args)

  const playtime = field('总时长')
  if (playtime !== null) {
    const ms = parseDuration(playtime)
    if (ms !== null) data.playtimeMs = ms
  }

  const launches = field('启动次数')
  if (launches !== null) {
    const n = Number(launches.trim())
    if (isFinite(n) && n >= 0) data.launchCount = Math.round(n)
  }

  const last = field('最后游玩')
  if (last !== null) data.lastLaunchedAt = parseStamp(last)

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
      const m = /^[ \t]*[-*]?[ \t]*显示名称[ \t]*[:：=][ \t]*(.+?)[ \t]*$/m.exec(raw)
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
