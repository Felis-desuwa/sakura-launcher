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

export interface Game {
  id: string
  name: string
  /** Set once the user renames a tile, so rescans stop overwriting their choice. */
  renamed?: boolean
  /** Folder that holds the game (for archives: folder holding the volumes). */
  dir: string
  /** Main executable. Empty for archive entries. */
  exe: string
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

  lastLaunchedAt: number | null
  launchCount: number

  /** Folder modification time — doubles as the incremental-scan fingerprint and as
   *  the "installed / last updated" timestamp shown and sorted on. */
  mtimeMs: number
  childCount: number

  /** Archive entries only: every volume that makes up the archive. */
  archiveVolumes?: string[]
}

export interface Group {
  id: string
  name: string
  order: number
  /** Built-in groups (e.g. the archive bucket) cannot be renamed or dissolved. */
  builtin?: boolean
}

export type SortKey = 'manual' | 'name' | 'size' | 'mtime' | 'recent'

export const SORT_META: Record<SortKey, string> = {
  manual: '手动',
  name: '名称',
  size: '体积',
  mtime: '安装/修改时间',
  recent: '最近启动'
}

export interface Settings {
  /** Scan roots. Starts empty — no path is ever pre-seeded. */
  roots: string[]
  defaultTab: TabKey
  sortKey: SortKey
  tileSize: number
  petals: boolean
  geekPath: string | null
  /** Set once the first-run onboarding has been dismissed. */
  onboarded: boolean
  /** Parent folders already offered for auto-grouping, so we only ask once each. */
  groupingPrompted: string[]
}

export const DEFAULT_SETTINGS: Settings = {
  roots: [],
  defaultTab: 'all',
  sortKey: 'manual',
  tileSize: 180,
  petals: true,
  geekPath: null,
  onboarded: false,
  groupingPrompted: []
}

export interface Database {
  version: number
  games: Game[]
  groups: Group[]
  settings: Settings
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
