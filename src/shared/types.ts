export type Tier = 'T0' | 'T1' | 'T2' | 'T3' | 'trash'

export const TIERS: Tier[] = ['T0', 'T1', 'T2', 'T3', 'trash']

export const TIER_META: Record<Tier | 'unrated', { label: string; color: string }> = {
  T0: { label: 'T0', color: '#E75480' },
  T1: { label: 'T1', color: '#FF8FB1' },
  T2: { label: 'T2', color: '#FFB07C' },
  T3: { label: 'T3', color: '#FFD98E' },
  trash: { label: 'trash', color: '#9E9E9E' },
  unrated: { label: '未评级', color: '#D8CBD2' }
}

/** Main-desktop tabs. Games can hold several of the three status flags at once. */
export type TabKey = 'all' | 'wishlist' | 'playing' | 'played'

export const TAB_META: Record<TabKey, { label: string }> = {
  all: { label: '全部' },
  wishlist: { label: '想玩' },
  playing: { label: '在玩' },
  played: { label: '玩过' }
}

export type GameKind = 'installed' | 'archive'

/** One stretch of time the game was actually running. */
export interface PlaySession {
  /** Epoch milliseconds the session started. */
  startedAt: number
  /** How long it ran, in milliseconds. */
  ms: number
}

/** How many sessions to keep per game. Older ones fall off the timeline. */
export const MAX_SESSIONS = 50

/**
 * Sessions shorter than this are discarded. A mis-double-click or a game that
 * fails to start would otherwise litter the timeline with junk entries.
 */
export const MIN_SESSION_MS = 60_000

export interface Game {
  id: string
  name: string
  /** Set once the user renames a tile, so rescans stop overwriting their choice. */
  renamed?: boolean
  /** Folder that holds the game (for archives: folder holding the volumes). */
  dir: string
  /** Main executable. Empty for archive entries. */
  exe: string
  /**
   * Arguments the executable needs, taken from a dropped shortcut.
   *
   * A launcher shortcut is very often the *only* thing that starts the game —
   * `steam.exe` on its own just opens Steam, and a stub launcher with no arguments
   * frequently exits at once, which looks exactly like "it started and nothing
   * happened". Dropping the arguments would silently break those entries.
   */
  launchArgs?: string[]
  /** Working directory from the shortcut, when it differs from the exe's folder. */
  launchCwd?: string
  /**
   * The user picked this executable themselves, so rescans must leave it alone —
   * the same protection `renamed` gives a hand-typed title.
   */
  exePinned?: boolean
  kind: GameKind
  sizeBytes: number | null
  /** Absolute path to a cached PNG, or null while pending / when falling back to placeholder. */
  iconPath: string | null
  /** User-chosen cover overrides the extracted icon. */
  coverPath: string | null
  groupId: string | null
  order: number

  // Three independent status flags — a game may carry more than one at a time.
  wishlist: boolean
  playing: boolean
  played: boolean

  tier: Tier | null
  tierOrder: number

  /** 0–5 stars. `null` means unrated, which is not the same as a zero-star verdict. */
  rating: number | null
  /** Free-form user tags. Searched alongside the name. */
  tags: string[]

  lastLaunchedAt: number | null
  launchCount: number

  /** Total time played, in milliseconds. */
  playtimeMs: number
  /** Most recent first, capped at MAX_SESSIONS. */
  sessions: PlaySession[]

  /**
   * The sidecar file's mtime as of the last time we wrote it. A newer mtime means
   * the user edited the file by hand, and their edit wins on the next sync.
   */
  sidecarSyncedAt?: number

  /** Folder modification time — doubles as the incremental-scan fingerprint and as
   *  the "installed / last updated" timestamp shown and sorted on. */
  mtimeMs: number
  childCount: number

  /**
   * The folder was not found on the last scan — an unmounted drive, or content
   * moved away. The entry is kept (with everything the user recorded on it)
   * rather than dropped, and the tile greys out.
   */
  missing?: boolean

  /** Archive entries only: every volume that makes up the archive. */
  archiveVolumes?: string[]
}

/** Everything a Game carries that the user chose, rather than the scanner found. */
export const GAME_DEFAULTS = {
  renamed: false,
  coverPath: null,
  groupId: null,
  order: 0,
  wishlist: false,
  playing: false,
  played: false,
  tier: null,
  tierOrder: 0,
  rating: null,
  tags: [] as string[],
  lastLaunchedAt: null,
  launchCount: 0,
  playtimeMs: 0,
  sessions: [] as PlaySession[],
  mtimeMs: 0,
  childCount: 0,
  missing: false
} satisfies Partial<Game>

/**
 * Enforce the one rule between the three status flags: "想玩" means *not started yet*,
 * so it cannot hold at the same time as 在玩 or 玩过. Those two may still coexist —
 * finishing a game and starting a second run is a normal thing to record.
 *
 * Shared by the main process and the renderer so an optimistic UI update can never
 * disagree with what actually lands in the database.
 */
export function normalizeStatus(current: Game, patch: Partial<Game>): Partial<Game> {
  const next = { ...patch }
  if (patch.wishlist === true) {
    next.playing = false
    next.played = false
  }
  const startsPlaying = patch.playing === true || patch.played === true
  if (startsPlaying) next.wishlist = false
  return next
}

/**
 * Playtime as a person would say it. Used both on screen and in the sidecar file,
 * so the two always read the same and a hand-edited file round-trips.
 */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0 分'
  const totalMinutes = Math.round(ms / 60_000)
  if (totalMinutes < 1) return '不到 1 分'
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes} 分`
  if (minutes === 0) return `${hours} 小时`
  return `${hours} 小时 ${minutes} 分`
}

/** Coarser form for tiles, where there is only room for the headline number. */
export function formatDurationShort(ms: number): string {
  if (ms <= 0) return ''
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} 分`
  const hours = minutes / 60
  // One decimal below ten hours, so "3.5 小时" does not round away to "4 小时".
  return hours < 10 ? `${Math.round(hours * 10) / 10} 小时` : `${Math.round(hours)} 小时`
}

/** Inverse of formatDuration, forgiving enough for hand-written values. */
export function parseDuration(text: string): number | null {
  if (text.includes('不到')) return 0
  const hours = /(\d+)\s*(?:小时|h)/i.exec(text)
  // The \b belongs only to the Latin forms. A word boundary cannot follow 分, which
  // is not a word character, so anchoring the whole group on it never matched Chinese.
  const minutes = /(\d+)\s*(?:分钟|分|m(?:in)?\b)/i.exec(text)
  if (!hours && !minutes) {
    const bare = /^\s*(\d+)\s*$/.exec(text)
    return bare ? Number(bare[1]) * 60_000 : null
  }
  return (Number(hours?.[1] ?? 0) * 60 + Number(minutes?.[1] ?? 0)) * 60_000
}

/** One row in the "which executable actually starts this game" picker. */
export interface ExeChoice {
  /** Path relative to the game folder — `BGI.exe`, or `backup\BGI.exe`. */
  rel: string
  fullPath: string
  sizeBytes: number
  kind: 'main' | 'launcher' | 'locale' | 'patch' | 'uninstall' | 'tool' | 'sub'
  label: string
  /** Why the scanner scored it the way it did, in words. */
  reasons: string[]
  /** Allowed to compete for the main slot. */
  rankable: boolean
  /** This is the game's current main program. */
  current: boolean
}

export interface ExeChoices {
  dir: string
  /** The executable in use, relative to the folder. */
  current: string | null
  currentArgs: string[]
  /** True once the user has chosen by hand, so scans stop overruling it. */
  pinned: boolean
  choices: ExeChoice[]
}

export interface Group {
  id: string
  name: string
  order: number
  /** Built-in groups (e.g. the archive bucket) cannot be renamed or dissolved. */
  builtin?: boolean
}

export type ThemeKey = 'sakura' | 'midnight' | 'miku' | 'matcha' | 'ocean' | 'lavender'

/** `swatch` drives the preview chips in settings: [background, brand, accent]. */
export const THEMES: { key: ThemeKey; label: string; note: string; swatch: [string, string, string] }[] = [
  { key: 'sakura', label: '樱花', note: '默认', swatch: ['#ffe0ec', '#ff8fb1', '#e75480'] },
  { key: 'midnight', label: '夜樱', note: '深色', swatch: ['#241a2a', '#ff8fb1', '#ff6f9d'] },
  { key: 'miku', label: '初音', note: '青绿', swatch: ['#d4f1ee', '#6fdcd4', '#39c5bb'] },
  { key: 'matcha', label: '抹茶', note: '', swatch: ['#e3f0d8', '#8fbf6a', '#4e8a3a'] },
  { key: 'ocean', label: '海盐', note: '', swatch: ['#d8ebf7', '#6aabdd', '#2b6fa8'] },
  { key: 'lavender', label: '薰衣草', note: '', swatch: ['#e7ddf6', '#a68ad4', '#6b4aa8'] }
]

export type SortKey = 'manual' | 'name' | 'size' | 'mtime' | 'recent' | 'playtime'

export const SORT_META: Record<SortKey, string> = {
  manual: '手动',
  name: '名称',
  size: '体积',
  mtime: '安装/修改时间',
  recent: '最近启动',
  playtime: '游玩时长'
}

/**
 * Which program fetches a link.
 *
 * Only aria2 can actually tell us it finished — we spawn it and read its exit code.
 * The rest hand the job to a program that outlives the call, so completion has to be
 * inferred by watching the destination folder. See `downloader.ts`.
 */
export type DownloaderKey = 'idm' | 'aria2' | 'system' | 'custom'

export const DOWNLOADERS: {
  key: DownloaderKey
  label: string
  note: string
  /** Whether it reports its own progress and completion. */
  reports: boolean
  /** Whether we can tell it where to save. */
  controlsDir: boolean
}[] = [
  {
    key: 'idm',
    label: 'Internet Download Manager',
    note: '自动探测安装路径。IDM 不回报进度，完成靠监视下载目录判定。',
    reports: false,
    controlsDir: true
  },
  {
    key: 'aria2',
    label: 'aria2c',
    note: '唯一能给出真实进度和确切完成信号的选项，需要自备 aria2c.exe。',
    reports: true,
    controlsDir: true
  },
  {
    key: 'system',
    label: '系统默认 / 浏览器',
    note: '交给系统打开链接。兼容性最好，但保存位置由浏览器决定，未必是这里选的目录。',
    reports: false,
    controlsDir: false
  },
  {
    key: 'custom',
    label: '自定义命令行',
    note: '自己填可执行文件与参数模板，占位符 {url} {dir} {name}。',
    reports: false,
    controlsDir: true
  }
]

/** Links we are willing to hand to an external program. */
export const ALLOWED_URL_PROTOCOLS = ['http:', 'https:', 'ftp:']

export type DownloadStatus = 'downloading' | 'extracting' | 'importing' | 'done' | 'failed'

/**
 * A download the launcher is seeing through to the library.
 *
 * Stored in the database rather than held in memory: these run for hours, and closing
 * the app in the middle should not lose the extract-and-import half of the job.
 */
export interface PendingDownload {
  id: string
  url: string
  dir: string
  downloader: DownloaderKey
  /** Files already in `dir` when this started — they are not what we are waiting for. */
  baseline: string[]
  startedAt: number
  status: DownloadStatus
  /** Only set by a downloader that reports its own progress. */
  percent: number | null
  message?: string
  /** The files this download produced, once the watcher has settled on them. */
  volumes?: string[]
}

export interface Settings {
  /** Scan roots. Starts empty — no path is ever pre-seeded. */
  roots: string[]
  defaultTab: TabKey
  sortKey: SortKey
  theme: ThemeKey
  tileSize: number
  petals: boolean
  geekPath: string | null
  /**
   * Folders the user removed from the library. Kept so a rescan does not keep
   * re-adding things that are not games — installers, tools, stray folders.
   * Nothing on disk is touched.
   */
  ignoredDirs: string[]
  /** Set once the first-run onboarding has been dismissed. */
  onboarded: boolean
  /** Parent folders already offered for auto-grouping, so we only ask once each. */
  groupingPrompted: string[]
  /** How often to check whether a launched game is still running. */
  playtimePollSeconds: number

  /** Where downloads land. `null` means "follow the first scan root". */
  downloadDir: string | null
  downloader: DownloaderKey
  /** Auto-detected for IDM; must be given for aria2 and custom. */
  downloaderPath: string | null
  /** Custom downloader only: argument template, one argument per whitespace run. */
  downloaderArgs: string
  /** Send the archive to the recycle bin once it has been extracted. */
  trashArchiveAfterExtract: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  roots: [],
  defaultTab: 'all',
  sortKey: 'manual',
  theme: 'sakura',
  tileSize: 180,
  petals: true,
  geekPath: null,
  ignoredDirs: [],
  onboarded: false,
  groupingPrompted: [],
  playtimePollSeconds: 15,
  downloadDir: null,
  downloader: 'idm',
  downloaderPath: null,
  downloaderArgs: '{url} -o {dir}',
  trashArchiveAfterExtract: false
}

export const POLL_CHOICES = [15, 30, 60]

/** The folder downloads go to: an explicit choice, else the first library folder. */
export function downloadDirFor(settings: Settings): string | null {
  return settings.downloadDir ?? settings.roots[0] ?? null
}

export interface Database {
  version: number
  games: Game[]
  groups: Group[]
  settings: Settings
  downloads: PendingDownload[]
  /**
   * Records of tiles the user removed, kept so adding the same folder back restores
   * what they had recorded on it — cover, rating, tier, tags, playtime, tile position.
   * Removing is meant to be undoable; re-adding by hand should not quietly cost more
   * than removing did.
   */
  removed: Game[]
}

/** How many removal records to keep. Past this the oldest fall off. */
export const MAX_REMOVED = 300

/**
 * Everything on a game that came from the user rather than from disk.
 * Used to carry a record across a remove-and-re-add without dragging along stale
 * scan results (exe path, icon, folder fingerprint), which are re-derived instead.
 */
export function userFieldsOf(game: Game): Partial<Game> {
  return {
    name: game.name,
    renamed: game.renamed,
    exePinned: game.exePinned,
    launchArgs: game.launchArgs,
    launchCwd: game.launchCwd,
    coverPath: game.coverPath,
    groupId: game.groupId,
    order: game.order,
    wishlist: game.wishlist,
    playing: game.playing,
    played: game.played,
    tier: game.tier,
    tierOrder: game.tierOrder,
    rating: game.rating,
    tags: game.tags,
    lastLaunchedAt: game.lastLaunchedAt,
    launchCount: game.launchCount,
    playtimeMs: game.playtimeMs,
    sessions: game.sessions,
    sidecarSyncedAt: game.sidecarSyncedAt
  }
}

/** One slice of the size-composition donut. */
export interface BreakdownEntry {
  name: string
  path: string
  sizeBytes: number
  isDir: boolean
}

export interface Breakdown {
  /** Directory this listing describes. */
  path: string
  totalBytes: number
  entries: BreakdownEntry[]
}

export interface DiskInfo {
  drive: string
  totalBytes: number
  freeBytes: number
}

export interface ScanProgress {
  phase: 'walking' | 'sizing' | 'icons' | 'done'
  found: number
  current: string
}

export interface RedundantArchive {
  /** Display name after volume suffixes are stripped. */
  name: string
  volumes: string[]
  sizeBytes: number
  /** The extracted folder we matched it against. */
  extractedDir: string
}

export const ARCHIVE_GROUP_ID = '__archives__'
