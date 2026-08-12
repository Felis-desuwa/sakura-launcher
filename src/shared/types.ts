// Extension spelled out so the harnesses in scripts/ can import this straight into node.
import type { Lang, MessageKey, Vars } from './i18n.ts'
import { looksAdult, vndbTagZh } from './vndb-tags.ts'

export type Tier = 'T0' | 'T1' | 'T2' | 'T3' | 'trash'

export const TIERS: Tier[] = ['T0', 'T1', 'T2', 'T3', 'trash']

/**
 * Tier colours. The names T0..trash are the same in both languages and stay here;
 * only "unrated" is a word, and that one is looked up as `tier.unrated`.
 */
export const TIER_META: Record<Tier | 'unrated', { label: string; color: string }> = {
  T0: { label: 'T0', color: '#E75480' },
  T1: { label: 'T1', color: '#FF8FB1' },
  T2: { label: 'T2', color: '#FFB07C' },
  T3: { label: 'T3', color: '#FFD98E' },
  trash: { label: 'trash', color: '#9E9E9E' },
  unrated: { label: '', color: '#D8CBD2' }
}

/** Main-desktop tabs. Games can hold several of the three status flags at once. */
export type TabKey = 'all' | 'wishlist' | 'playing' | 'played'

/**
 * Tab order. The label is not here — it is looked up as `tab.<key>` in the dictionary,
 * so a language switch repaints it without anything having to invalidate a copy.
 */
export const TAB_KEYS: TabKey[] = ['all', 'wishlist', 'playing', 'played']

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
  /**
   * Which engine the folder was built on, when the layout says so plainly.
   * Re-derived on every scan and refresh — it describes the folder, not the user's
   * choices, so it is never carried across a remove-and-re-add.
   */
  engine?: EngineId | null
  sizeBytes: number | null
  /** Absolute path to a cached PNG, or null while pending / when falling back to placeholder. */
  iconPath: string | null
  /** User-chosen cover overrides the extracted icon. */
  coverPath: string | null
  /**
   * Where the cover came from.
   *
   * `'user'` is a decision about their own library and a pass over many games must never
   * quietly undo it — the same protection `renamed` gives a hand-typed title. Absent on
   * covers set before this field existed, which are treated as the user's, because that
   * is what they were: nothing else could set one.
   */
  coverFrom?: 'user' | TagSource
  /**
   * The cover is explicit, by the catalogue's own account.
   *
   * Stored rather than re-derived: it is blurred at display time under the same switch as
   * the tags, so turning the switch on is instant and costs no traffic.
   */
  coverAdult?: boolean
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

  /**
   * Tags the launcher worked out. Recomputed wholesale and never written to the sidecar —
   * anything in here can be derived again, which is exactly what the sidecar is not for.
   */
  autoTags?: AutoTag[]
  /** Ids of auto tags the user judged wrong. Survives every recomputation. */
  hiddenTags?: string[]
  /** When the auto tags were last worked out. Absent means never — not "none found". */
  taggedAt?: number
  /** The catalogue entry the genre tags came from, once one has been settled on. */
  work?: { source: TagSource; workId: string; title: string }

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

  /**
   * When this folder entered the library.
   *
   * The baseline the save backup dates everything against: a save file older than the
   * moment the game was added cannot be this user's progress, because they had not
   * started yet — it came inside the download. Only ever stamped on a genuinely new
   * entry; an entry that predates this field keeps `undefined`, and the absence is
   * reported rather than filled in, since a made-up baseline would declare every real
   * save to be somebody else's.
   */
  addedAt?: number
  /**
   * Save locations the user named by hand.
   *
   * Kept because detection cannot be complete: a game that writes to a folder named
   * after its brand, or to the root of C:, is not reachable by any rule that starts
   * from the game folder. Absolute paths, and they survive every rescan.
   */
  saveDirs?: string[]
  /** When the saves were last copied out. Absent means never. */
  savesBackedUpAt?: number

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
  autoTags: [] as AutoTag[],
  hiddenTags: [] as string[],
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
export function formatDuration(ms: number, lang: Lang = 'zh'): string {
  const zh = lang !== 'en'
  if (ms <= 0) return zh ? '0 分' : '0 min'
  const totalMinutes = Math.round(ms / 60_000)
  if (totalMinutes < 1) return zh ? '不到 1 分' : 'under a minute'
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return zh ? `${minutes} 分` : `${minutes} min`
  if (minutes === 0) return zh ? `${hours} 小时` : `${hours} h`
  return zh ? `${hours} 小时 ${minutes} 分` : `${hours} h ${minutes} min`
}

/** Coarser form for tiles, where there is only room for the headline number. */
export function formatDurationShort(ms: number, lang: Lang = 'zh'): string {
  if (ms <= 0) return ''
  const zh = lang !== 'en'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return zh ? `${minutes} 分` : `${minutes}m`
  const hours = minutes / 60
  // One decimal below ten hours, so "3.5 小时" does not round away to "4 小时".
  const value = hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours)
  return zh ? `${value} 小时` : `${value}h`
}

/** Inverse of formatDuration, forgiving enough for hand-written values. */
export function parseDuration(text: string): number | null {
  // Both languages, always — a library written under one and read under the other has to
  // round-trip, and so does a file the user hand-edited before ever switching.
  if (text.includes('不到') || /under a minute/i.test(text)) return 0
  const hours = /(\d+)\s*(?:小时|h(?:ours?|rs?)?\b)/i.exec(text)
  // The \b belongs only to the Latin forms. A word boundary cannot follow 分, which
  // is not a word character, so anchoring the whole group on it never matched Chinese.
  const minutes = /(\d+)\s*(?:分钟|分|m(?:in(?:utes?)?)?\b)/i.exec(text)
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

/* ---------- which engine a game was built on ---------- */

/**
 * Engines worth telling apart.
 *
 * Not trivia. The engine is what says where a crash log lands, whether the title comes
 * from the era that assumed a Japanese system codepage, and which executable in a folder
 * of twelve is the one that starts the game. Everything the launch diagnosis knows that
 * a generic tool cannot know, it knows through this.
 */
export type EngineId =
  | 'kirikiri'
  | 'bgi'
  | 'siglus'
  | 'majiro'
  | 'nscripter'
  | 'artemis'
  | 'renpy'
  | 'rpgmaker'
  | 'wolf'
  | 'unity'
  | 'unreal'
  | 'tyrano'
  | 'nwjs'

/** Engine names are proper nouns and identical in both languages. Notes are `engine.<id>.note`. */
export const ENGINE_LABEL: Record<EngineId, string> = {
  kirikiri: 'KiriKiri',
  bgi: 'BGI / Ethornell',
  siglus: 'SiglusEngine',
  majiro: 'Majiro',
  nscripter: 'NScripter',
  artemis: 'Artemis',
  renpy: 'Ren’Py',
  rpgmaker: 'RPG Maker',
  wolf: 'Wolf RPG Editor',
  unity: 'Unity',
  unreal: 'Unreal Engine',
  tyrano: 'TyranoScript',
  nwjs: 'NW.js'
}

/* ---------- tags the launcher works out for itself ---------- */

/**
 * Which shelf of the tag bar a tag belongs on.
 *
 * Both come from a catalogue. Tags derived from the files — engine, size, whether the
 * filenames were Japanese — used to live here too and were removed: they answered
 * questions the tile and the drawer already answer, and working them out meant walking
 * every game folder, which is what made the pass look like a hang.
 */
export type TagFacet = 'genre' | 'year'

export const TAG_FACETS: TagFacet[] = ['genre', 'year']

/**
 * A tag the launcher applied on its own.
 *
 * Kept apart from `Game.tags`, which belongs to the user. Merging the two would mean a
 * tag the user deleted coming back on the next pass, and machine-written text landing in
 * the Markdown file that travels inside the game folder — a file whose whole value is
 * that a person can read and edit it.
 *
 * What is stored is a *key*, not a sentence. Engine names, circle names and catalogue
 * genres are proper nouns and carry their own text; everything else names an entry in
 * the dictionary, so switching language repaints the tags without recomputing anything.
 */
export interface AutoTag {
  /** Stable across recomputation: `genre:high school`, `year:2016`. */
  id: string
  facet: TagFacet
  /**
   * Which catalogue said so.
   *
   * Decides whether the label goes through the VNDB translation table. Carried explicitly
   * rather than inferred from `reasonKey`, so adding a source later is a change in one
   * place instead of a string comparison nobody remembers is load-bearing.
   */
  source?: TagSource
  /** Proper nouns — an engine, a circle, a catalogue's own genre name. */
  label?: string
  /** Everything else, looked up at display time. */
  labelKey?: MessageKey
  /** Why it was applied, in the user's words. The same contract as `ExeChoice.reasons`. */
  reasonKey: MessageKey
  vars?: Record<string, string | number>
  /**
   * The tag gives away a plot point. VNDB marks these and they are hidden by default —
   * a library screen is the last place someone wants a story spoiled.
   */
  spoiler?: boolean
  /**
   * The tag is explicit.
   *
   * Set from the catalogue where it says so — VNDB's `ero` category, DLsite's
   * locale-independent genre name. Absent on tags stored before this existed, which is
   * why `isAdultTag()` has a fallback rather than trusting the field alone.
   */
  adult?: boolean
}

/**
 * Whether a tag is explicit.
 *
 * The catalogue's own word where there is one, and the name otherwise. The fallback is
 * what makes the switch trustworthy on a library tagged before the switch existed —
 * without it, turning it off would quietly leave the old tags on screen.
 */
export function isAdultTag(tag: AutoTag): boolean {
  if (tag.adult !== undefined) return tag.adult
  return looksAdult(tag.label ?? tag.id)
}

/**
 * The auto tags a game should actually show.
 *
 * Hiding is applied here rather than when the tags are stored, and that is the whole
 * reason "restore" can work at all: a tag struck out of the record has nothing left to
 * restore, and would not come back until the next full pass — which, for the genre tags,
 * means another round trip to a catalogue. So the record keeps everything and every
 * reader filters, which also keeps the tile grid, the tag bar and the drawer agreeing on
 * what is visible without each having to remember the rule.
 *
 * The same goes for the explicit ones: they stay in the record and are filtered on the
 * way out, so the switch takes effect the moment it is flipped rather than on the next
 * pass over the catalogue.
 */
export function visibleTags(game: Game, showSpoilers: boolean, showAdult = true): AutoTag[] {
  const hidden = new Set(game.hiddenTags ?? [])
  return (game.autoTags ?? []).filter(
    (tag) =>
      !hidden.has(tag.id) &&
      (showSpoilers || !tag.spoiler) &&
      (showAdult || !isAdultTag(tag))
  )
}

/**
 * Facets where holding two chips at once can only ever match nothing.
 *
 * A game has exactly one release year, so the tag bar's usual "narrow with each chip"
 * reading turns 2016 + 2017 into an empty screen — the one filter combination that
 * cannot be what anybody meant by clicking it. Genres stack because a game genuinely is
 * both 校园 and 催泪.
 */
const EXCLUSIVE_FACETS: TagFacet[] = ['year']

/** The facet a tag id belongs to, read off its prefix. `null` for anything unrecognised. */
export function tagFacetOf(tagId: string): TagFacet | null {
  const colon = tagId.indexOf(':')
  if (colon < 0) return null
  const prefix = tagId.slice(0, colon)
  return (TAG_FACETS as string[]).includes(prefix) ? (prefix as TagFacet) : null
}

/**
 * The selection after clicking a chip.
 *
 * Clicking a second year *replaces* the first rather than adding to it, which is the only
 * behaviour that leaves the click meaning something. Deselecting is always plain removal,
 * so a year can still be cleared by clicking it again.
 */
export function toggleTagFilter(active: string[], tagId: string): string[] {
  if (active.includes(tagId)) return active.filter((id) => id !== tagId)
  const facet = tagFacetOf(tagId)
  if (facet && EXCLUSIVE_FACETS.includes(facet)) {
    return [...active.filter((id) => tagFacetOf(id) !== facet), tagId]
  }
  return [...active, tagId]
}

/**
 * What a tag is called on screen.
 *
 * VNDB's tag names are English and stay English in the record — they are the stable
 * identity a tag is keyed by, and translating them on the way in would freeze whatever
 * the table happened to hold that day. The Chinese reading is looked up here instead, so
 * extending the table improves every tag already stored without asking a catalogue
 * anything. A name the table does not carry is shown as VNDB wrote it: no guessing, and
 * certainly no machine translation.
 *
 * DLsite needs none of this — it is asked in the interface language and answers in it.
 */
export function tagLabel(
  tag: AutoTag,
  t: (key: MessageKey, vars?: Vars) => string,
  lang: Lang = 'zh'
): string {
  if (tag.label) {
    if (lang === 'zh' && tag.source === 'vndb') return vndbTagZh(tag.label)
    return tag.label
  }
  return tag.labelKey ? t(tag.labelKey, tag.vars) : tag.id
}

export function tagReason(tag: AutoTag, t: (key: MessageKey, vars?: Vars) => string): string {
  return t(tag.reasonKey, tag.vars)
}

/** Where a genre tag came from. Shown so the user can judge how much to trust it. */
export type TagSource = 'dlsite' | 'vndb'

export const TAG_SOURCE_LABEL: Record<TagSource, string> = {
  dlsite: 'DLsite',
  vndb: 'VNDB'
}

/** A catalogue entry the launcher believes is this game. */
export interface WorkMatch {
  source: TagSource
  /** `RJ01234567` on DLsite, `v1234` on VNDB, `999999` on Bangumi. */
  workId: string
  title: string
  /**
   * The original Japanese name.
   *
   * Always the catalogue's own record — never derived from the title and never
   * translated. It is shown beside the Chinese name because between the two, one of them
   * is the one the user will recognise, and which one that is depends on the game.
   */
  altTitle?: string
  /** The Chinese name the work is released under, when the catalogue records one. */
  zhTitle?: string
  released?: string
  /** 0–1. An exact id match is 1 and is never put to the user. */
  score: number
  /** The genres this entry would apply. */
  tags: AutoTag[]
  /**
   * The catalogue's picture for this work, if it has one.
   *
   * Carried as an address, never fetched here — the renderer receives this object and
   * must not open a socket, or confirming a match would quietly download an image per
   * candidate. Only `covers.ts`, in the main process, ever follows it.
   */
  cover?: { url: string; adult: boolean }
}

/**
 * A game whose match was not certain enough to adopt without being asked.
 *
 * An id read out of the folder name identifies one work and cannot be wrong, so those
 * are taken silently. A title search can land on a fan disc, a sequel or an unrelated
 * game with a similar name, and a wrong genre tag is worse than none — so those are
 * collected and put in front of the user.
 */
export interface PendingMatch {
  gameId: string
  gameName: string
  /** May be empty: a game nothing matched still needs a way into the dialog. */
  candidates: WorkMatch[]
  /**
   * What to put in the manual box to start with.
   *
   * The Japanese name when a catalogue resolved one, otherwise the cleaned folder name.
   * Either way it is a better opening move than the raw folder name, which is the string
   * that already failed.
   */
  suggestion?: string
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
/** Names and notes live in the dictionary as `theme.<key>` and `theme.<key>.note`. */
export const THEMES: { key: ThemeKey; swatch: [string, string, string] }[] = [
  { key: 'sakura', swatch: ['#ffe0ec', '#ff8fb1', '#e75480'] },
  { key: 'midnight', swatch: ['#241a2a', '#ff8fb1', '#ff6f9d'] },
  { key: 'miku', swatch: ['#d4f1ee', '#6fdcd4', '#39c5bb'] },
  { key: 'matcha', swatch: ['#e3f0d8', '#8fbf6a', '#4e8a3a'] },
  { key: 'ocean', swatch: ['#d8ebf7', '#6aabdd', '#2b6fa8'] },
  { key: 'lavender', swatch: ['#e7ddf6', '#a68ad4', '#6b4aa8'] }
]

export type SortKey = 'manual' | 'name' | 'size' | 'mtime' | 'recent' | 'playtime'

/** Sort order, labelled as `sort.<key>` in the dictionary. */
export const SORT_KEYS: SortKey[] = ['manual', 'name', 'size', 'mtime', 'recent', 'playtime']

/**
 * Which program fetches a link.
 *
 * Only aria2 can actually tell us it finished — we spawn it and read its exit code.
 * The rest hand the job to a program that outlives the call, so completion has to be
 * inferred by watching the destination folder. See `downloader.ts`.
 */
export type DownloaderKey = 'idm' | 'aria2' | 'system' | 'custom'

/** Labels and notes are `downloader.<key>` and `downloader.<key>.note`. */
export const DOWNLOADERS: {
  key: DownloaderKey
  /** Whether it reports its own progress and completion. */
  reports: boolean
  /** Whether we can tell it where to save. */
  controlsDir: boolean
}[] = [
  { key: 'idm', reports: false, controlsDir: true },
  { key: 'aria2', reports: true, controlsDir: true },
  { key: 'system', reports: false, controlsDir: false },
  { key: 'custom', reports: false, controlsDir: true }
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
  /**
   * Interface language.
   *
   * Also decides the language of the `sakura-launcher.md` written into each game folder.
   * The parser reads both, so switching does not orphan files written under the other
   * one — it only means the next sync rewrites them.
   */
  language: Lang
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
  /**
   * Look after a launch and say something when no process ever appears.
   *
   * On by default. A diagnosis nobody knows to ask for is a diagnosis nobody gets, and
   * the moment it is worth having is the moment the screen stayed blank.
   */
  diagnoseOnLaunch: boolean

  /**
   * Reach a catalogue for genre tags.
   *
   * **Off by default, and the only thing in this program that ever opens a socket.**
   * Everything else here is deliberately local, and a story's genre is the one fact that
   * cannot be read off a disk — so this is the single place the promise is negotiable,
   * and it is the user who negotiates it. When off, nothing is sent anywhere; the fact
   * tags (engine, size, locale) still work, because they never needed the network.
   */
  onlineTags: boolean
  /**
   * Show genre tags that VNDB marks as spoilers.
   *
   * Off by default. Nobody browsing their own shelf wants to learn how a story ends from
   * a tag under the cover art.
   */
  spoilerTags: boolean
  /**
   * Show explicit tags.
   *
   * Off by default. The tags are fetched and stored either way — this decides whether
   * they are drawn, so flipping it is instant and costs no catalogue traffic. Off means
   * a shelf that can be looked at with somebody standing behind you.
   */
  adultTags: boolean
  /**
   * Allow cover art to be downloaded from the same catalogues.
   *
   * A sub-switch of `onlineTags`, not a second master: with the catalogue off, nothing
   * here can happen. It exists because covers change *what* leaves the machine — the
   * genre lookups only ever send a work number or a title, while a cover means asking an
   * image host for a file — and somebody may want the tags without that. On by default,
   * since it does nothing at all until the catalogue is switched on.
   *
   * Even then, no cover is ever fetched on its own: it takes an explicit menu action.
   */
  onlineCovers: boolean

  /**
   * Where copied-out saves land. `null` means the folder under Documents we suggest.
   *
   * Deliberately outside the library: a backup written inside the game folder is not a
   * backup, it is a second copy that gets deleted with the first.
   */
  backupDir: string | null

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
  language: 'zh',
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
  diagnoseOnLaunch: true,
  onlineTags: false,
  spoilerTags: false,
  adultTags: false,
  onlineCovers: true,
  backupDir: null,
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

/* ---------- why nothing happened when you double-clicked ---------- */

export type DiagnosisCode =
  | 'exe-missing'
  | 'bad-arch'
  | 'missing-runtime'
  | 'missing-dll'
  | 'delay-missing'
  | 'needs-admin'
  | 'wrong-exe'
  | 'needs-locale'
  | 'crash-log'
  | 'error-dialog'

/**
 * How much weight to give a finding.
 *
 * `blocker` means the game provably cannot start as things stand. `likely` is a real
 * suspicion with evidence behind it. `note` is worth knowing and probably not the cause.
 * The distinction exists so a long list still leads with the answer.
 */
export type DiagnosisSeverity = 'blocker' | 'likely' | 'note'

/** Something the dialog can offer to do about a finding. */
export type DiagnosisAction = 'pickExe' | 'runAsAdmin' | 'openLog' | 'revealDir'

export interface DiagnosisCheck {
  code: DiagnosisCode
  severity: DiagnosisSeverity
  title: string
  detail: string
  /** Why we concluded this — same idea as `ExeChoice.reasons`, and the same voice. */
  reasons: string[]
  action?: DiagnosisAction
  /** What the action operates on: a log file, a folder. */
  actionPath?: string
  /** Verbatim text worth showing as-is — the tail of a crash log. */
  excerpt?: string
}

export interface Diagnosis {
  gameId: string
  exe: string
  engine: EngineId | null
  /** Null when the file could not be parsed as an executable at all. */
  arch: string | null
  /**
   * Everything that was examined, in the user's words.
   *
   * Carried even when `checks` is empty, because "we found nothing" is only worth
   * anything alongside "here is what we looked at".
   */
  checked: string[]
  checks: DiagnosisCheck[]
}

/**
 * Why the launch watcher woke up.
 *
 * `dialog` is its own case rather than a flavour of the others because the process is
 * still very much alive — the game is sitting on a message box, which looks like success
 * to anything counting processes.
 */
export type LaunchTrouble = 'noshow' | 'earlyexit' | 'dialog'

/* ---------- sharing a game ---------- */

/** Which pile a candidate lands in, which is also what decides its default state. */
export type ShareCategory = 'launcher' | 'save' | 'noise' | 'config'

/** Titles and hints are `share.cat.<key>` and `share.cat.<key>.hint`. */
export const SHARE_CATEGORIES: ShareCategory[] = ['launcher', 'save', 'noise', 'config']

/** One thing that could be kept out of a shared copy. */
export interface ShareCandidate {
  /** Absolute path. */
  path: string
  /** Path relative to the game folder, which is what the user reads. */
  rel: string
  isDir: boolean
  sizeBytes: number
  category: ShareCategory
  /** Why it was proposed, in the user's words. */
  reason: string
  /** Whether it starts ticked. */
  checked: boolean
  /** Set when the size alone is grounds for suspicion. */
  oversized?: boolean
}

export type ShareFormat = '7z' | 'zip'

/** The names are the same in both languages; notes are `share.format.<key>.note`. */
export const SHARE_FORMATS: { key: ShareFormat; label: string }[] = [
  { key: '7z', label: '7z' },
  { key: 'zip', label: 'zip' }
]

/** One game's proposal: what it would be called and what would be left out. */
export interface SharePlan {
  gameId: string
  gameName: string
  /** The folder being packed. */
  dir: string
  /** Default archive name, already stripped of characters Windows rejects. */
  suggestedName: string
  /** Default output folder — the game folder's parent. */
  suggestedDir: string
  sizeBytes: number
  candidates: ShareCandidate[]
  /** Set when the entry cannot be shared at all, with the reason. */
  blocked?: string
}

/** What the user settled on for one game. */
export interface ShareJob {
  gameId: string
  /** Archive name without extension. */
  name: string
  outDir: string
  /** Absolute paths to keep out of the archive. */
  exclude: string[]
}

export interface ShareOptions {
  format: ShareFormat
  /** Empty string means no encryption. */
  password: string
  /** 7z only: encrypt the file list as well as the contents. */
  encryptNames: boolean
  overwrite: boolean
}

export interface ShareResult {
  gameId: string
  ok: boolean
  /** The archive that was written. */
  file?: string
  error?: string
  /** Set when the user stopped the queue before this one ran. */
  skipped?: boolean
}

/* ---------- copying the saves out ---------- */

/**
 * A place Windows lets a game keep its saves.
 *
 * Named rather than spelled out because the actual path is a per-machine question —
 * Documents can be redirected onto another drive, and `%APPDATA%` is not `%LOCALAPPDATA%`
 * even though half the engines act as if it were. `saves.ts` resolves these through
 * Electron; `save-rules.ts` only ever reasons about the names, which is what keeps it
 * testable without a machine to test on.
 */
export type SaveRoot =
  | 'game'
  | 'appdata'
  | 'localappdata'
  | 'locallow'
  | 'documents'
  | 'savedgames'
  | 'systemdrive'

export const SAVE_ROOTS: SaveRoot[] = [
  'game',
  'appdata',
  'localappdata',
  'locallow',
  'documents',
  'savedgames',
  'systemdrive'
]

/**
 * How sure we are that something is this game's save data.
 *
 * `strong` is a save folder inside the game, or a folder named after the game sitting
 * exactly where this engine is known to put its saves. `weak` is everything else that
 * still looked worth showing — a name match somewhere the engine has no business writing
 * to, or a folder called `Save` at the root of C: that could belong to anything. Only
 * `strong` starts ticked; `weak` is offered, explained, and left to the user.
 */
export type SaveConfidence = 'strong' | 'weak'

/** One place this game's saves might be. */
export interface SaveCandidate {
  /** Absolute path to the file or folder that would be copied. */
  path: string
  /** What the user reads: relative to the game folder, or the absolute path. */
  label: string
  isDir: boolean
  sizeBytes: number
  fileCount: number
  /** The newest mtime anywhere inside, in epoch ms. Zero when nothing could be read. */
  newestMs: number
  root: SaveRoot
  confidence: SaveConfidence
  /** Why it is being proposed, in the user's words. Same contract as `ShareCandidate`. */
  reason: string
  /** Whether it starts ticked. */
  checked: boolean
  /**
   * Nothing in here has been written since before the game entered the library, so it
   * cannot be this user's progress — it arrived with the download. Shown anyway, and
   * unticked: backing up somebody else's completed save is merely useless, but hiding it
   * would be lying about what is on disk.
   */
  prepacked?: boolean
  /** Large enough relative to the game that the rule has probably caught game data. */
  oversized?: boolean
  /** The user named this one themselves. */
  byHand?: boolean
}

/** What would be copied for one game. */
export interface SavePlan {
  gameId: string
  gameName: string
  dir: string
  engine: EngineId | null
  candidates: SaveCandidate[]
  /**
   * The moment the game entered the library. `null` for entries added before the
   * baseline existed, which is reported rather than guessed at — without it there is
   * no way to tell a bundled save from a played one.
   */
  baselineMs: number | null
  /** Set when this entry cannot be backed up at all, with the reason. */
  blocked?: string
}

/** What the user settled on for one game. */
export interface SaveBackupJob {
  gameId: string
  /** Absolute paths to copy. */
  include: string[]
}

export interface SaveBackupResult {
  gameId: string
  ok: boolean
  /** The folder that was written. */
  dest?: string
  files?: number
  bytes?: number
  /** Files that could not be read, which is not a reason to fail the whole job. */
  unreadable?: number
  error?: string
  /** The user stopped the queue before this one ran. */
  skipped?: boolean
}

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
    // The auto tags themselves are derived and can be worked out again; the user's verdict
    // that one of them is wrong cannot, so that is the half worth carrying.
    hiddenTags: game.hiddenTags,
    work: game.work,
    // The baseline is the one field here that is *about* the folder yet cannot be
    // re-derived from it: re-stamping it on a re-add would silently move it forward and
    // reclassify every save the user has written since as having come with the download.
    addedAt: game.addedAt,
    saveDirs: game.saveDirs,
    savesBackedUpAt: game.savesBackedUpAt,
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
