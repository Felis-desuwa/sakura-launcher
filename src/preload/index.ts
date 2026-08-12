import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  Breakdown,
  Diagnosis,
  DiskInfo,
  DownloaderKey,
  ExeChoices,
  Game,
  Group,
  LaunchTrouble,
  PendingDownload,
  RedundantArchive,
  Settings,
  SaveBackupJob,
  SaveBackupResult,
  SavePlan,
  ShareJob,
  ShareOptions,
  SharePlan,
  ShareResult,
  PendingMatch,
  WorkMatch
} from '../shared/types'

/** How far along a tagging pass is. */
export interface TagProgress {
  done: number
  total: number
  name: string
}

export interface TagRunResult {
  ok: boolean
  /** A pass was already running; nothing was started. */
  busy?: boolean
  /** How many games were looked up. */
  looked?: number
  /** How many came back with a confident answer. */
  matched?: number
  /** Title searches too uncertain to adopt — the user settles these. */
  pending?: PendingMatch[]
  /** Every lookup failed, so the UI can say so once rather than per game. */
  offline?: boolean
  cancelled?: boolean
}

export interface CoverRunResult {
  ok: boolean
  /** A run was already going, or the catalogue/cover switch is off. */
  busy?: boolean
  off?: boolean
  /** Covers actually written. */
  fetched?: number
  /** Left alone because the user had chosen that cover themselves. */
  keptUser?: number
  /** No picture in the catalogue, or the download failed. */
  missed?: number
  /** Games nothing could be matched to — these need the manual dialog. */
  pending?: PendingMatch[]
  offline?: boolean
  cancelled?: boolean
}

/** A launch that produced no game, pushed the moment the watcher gives up on it. */
export interface LaunchTroubleEvent {
  id: string
  name: string
  trouble: LaunchTrouble
  /** When the launch was made — the diagnosis needs it to date any crash log. */
  startedAt: number
}

export interface ListedEntry {
  name: string
  path: string
  isDir: boolean
  sizeBytes: number
  mtimeMs: number
  ext: string
}

export interface ScanOutcome {
  games: Game[]
  groupCandidates: { parent: string; name: string; dirs: string[] }[]
  /** Entries kept but not found this time. */
  missing: number
  /** Present only when the scan was asked to reconcile the sidecar files. */
  sidecars: { imported: number; exported: number } | null
}

export interface ImportCandidate {
  dir: string
  exe: string
  name: string
  sizeBytes: number | null
  /** Why the scanner passed this folder over. Absent for accepted entries. */
  reason?: string
  volumes?: string[]
}

export interface ImportPreview {
  folder: string
  games: ImportCandidate[]
  rejected: ImportCandidate[]
  archives: ImportCandidate[]
}

export interface PlaytimeUpdate {
  id: string
  playtimeMs: number
  playing: boolean
}

export interface UninstallPlan {
  method: 'uninstaller' | 'geek' | 'trash'
  tool?: string
  sizeBytes: number
}

export interface UninstallResult {
  ok: boolean
  method: 'uninstaller' | 'geek' | 'trash'
  leftoverBytes?: number
  error?: string
}

const api = {
  /*
   * The window buttons. There is no frame, so minimise / maximise / close are ordinary
   * clicks in the top bar and have to come back here to be carried out.
   */
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('win:minimize'),
  toggleMaximizeWindow: (): Promise<void> => ipcRenderer.invoke('win:toggleMaximize'),
  closeWindow: (): Promise<void> => ipcRenderer.invoke('win:close'),
  isWindowMaximized: (): Promise<boolean> => ipcRenderer.invoke('win:isMaximized'),
  /** Fires for every route to maximised, including Win+↑ and a double-click on the bar. */
  onMaximizeChange: (cb: (maximized: boolean) => void): (() => void) => {
    const handler = (_e: unknown, maximized: boolean): void => cb(maximized)
    ipcRenderer.on('win:maximized', handler)
    return () => ipcRenderer.off('win:maximized', handler)
  },

  snapshot: (): Promise<{ games: Game[]; groups: Group[]; settings: Settings }> =>
    ipcRenderer.invoke('db:snapshot'),
  updateSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('settings:update', patch),

  /** `sync` also reconciles the per-game sidecar files; reserve it for explicit scans. */
  scan: (sync = false): Promise<ScanOutcome> => ipcRenderer.invoke('scan:run', sync),
  recomputeSizes: (): Promise<boolean> => ipcRenderer.invoke('scan:recomputeSizes'),

  previewFolder: (folder: string): Promise<ImportPreview> =>
    ipcRenderer.invoke('scan:preview', folder),
  commitImport: (
    folder: string,
    accept: string[],
    reject: string[]
  ): Promise<ScanOutcome & { added: number }> =>
    ipcRenderer.invoke('scan:commitImport', folder, accept, reject),

  launch: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('game:launch', id),
  launchElevated: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('game:launchElevated', id),
  diagnose: (id: string, since?: number): Promise<Diagnosis | null> =>
    ipcRenderer.invoke('game:diagnose', id, since),
  cancelLaunchWatch: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('game:cancelWatch', id),
  updateGame: (id: string, patch: Partial<Game>): Promise<Game | undefined> =>
    ipcRenderer.invoke('game:update', id, patch),
  reorder: (ids: string[]): Promise<boolean> => ipcRenderer.invoke('game:reorder', ids),
  rename: (
    id: string,
    name: string
  ): Promise<{ ok: boolean; sidecar?: boolean; file?: string; error?: string }> =>
    ipcRenderer.invoke('game:rename', id, name),
  resetName: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('game:resetName', id),
  setTags: (id: string, tags: string[]): Promise<Game | undefined> =>
    ipcRenderer.invoke('game:setTags', id, tags),

  /**
   * Work out the automatic tags. Pass `null` for the whole library.
   *
   * Touches no game folder at all — only a folder's name is read, and only to pull a work
   * number or a title out of it. Does nothing unless `settings.onlineTags` is on.
   */
  computeTags: (ids: string[] | null): Promise<TagRunResult> =>
    ipcRenderer.invoke('tags:compute', ids),
  /** How many games a pass would look up — everything without a catalogue match yet. */
  pendingTagCount: (): Promise<number> => ipcRenderer.invoke('tags:pendingCount'),
  cancelTags: (): Promise<boolean> => ipcRenderer.invoke('tags:cancel'),
  /**
   * Look a work up by hand.
   *
   * Takes a title in any language, or an id pasted straight in — `v1234`, `RJ01234567`,
   * or a link to either. The last resort for folders named `123456`, which nothing can
   * match on its own.
   */
  searchWorks: (query: string): Promise<WorkMatch[]> => ipcRenderer.invoke('tags:search', query),
  applyMatch: (gameId: string, match: WorkMatch): Promise<Game | undefined> =>
    ipcRenderer.invoke('tags:applyMatch', gameId, match),
  setTagHidden: (gameId: string, tagId: string, hidden: boolean): Promise<Game | undefined> =>
    ipcRenderer.invoke('tags:setHidden', gameId, tagId, hidden),
  onTagProgress: (cb: (progress: TagProgress) => void): (() => void) => {
    const handler = (_e: unknown, progress: TagProgress): void => cb(progress)
    ipcRenderer.on('tags:progress', handler)
    return () => ipcRenderer.off('tags:progress', handler)
  },

  /**
   * Fetch cover art for the games named, from the catalogue each is matched to.
   *
   * `scope` is not a hint: `'bulk'` leaves a cover the user chose by hand alone, while
   * `'single'` replaces it, because picking one game out of its own menu says so.
   * Requires both `settings.onlineTags` and `settings.onlineCovers`; the main process
   * checks again rather than trusting this side.
   */
  fetchCovers: (ids: string[], scope: 'single' | 'bulk'): Promise<CoverRunResult> =>
    ipcRenderer.invoke('covers:fetch', ids, scope),
  cancelCovers: (): Promise<boolean> => ipcRenderer.invoke('covers:cancel'),
  onCoverProgress: (cb: (progress: TagProgress) => void): (() => void) => {
    const handler = (_e: unknown, progress: TagProgress): void => cb(progress)
    ipcRenderer.on('covers:progress', handler)
    return () => ipcRenderer.off('covers:progress', handler)
  },
  removeTile: (id: string): Promise<{ ok: boolean; name?: string; error?: string }> =>
    ipcRenderer.invoke('game:remove', id),
  unignore: (dir: string): Promise<Settings> => ipcRenderer.invoke('library:unignore', dir),
  /** Forget removal records. Omit `dirs` to clear the whole list. */
  clearIgnored: (dirs?: string[]): Promise<Settings> =>
    ipcRenderer.invoke('library:clearIgnored', dirs),
  /** Drop a scan folder together with every game that came from it. */
  removeRoot: (
    folder: string
  ): Promise<{ removed: number; games: Game[]; settings: Settings }> =>
    ipcRenderer.invoke('library:removeRoot', folder),
  /** Every executable in the game folder, named and explained. */
  exeCandidates: (id: string): Promise<ExeChoices | null> =>
    ipcRenderer.invoke('game:exeCandidates', id),
  setExe: (
    id: string,
    exePath: string,
    args?: string[]
  ): Promise<{ ok: boolean; game?: Game; error?: string }> =>
    ipcRenderer.invoke('game:setExe', id, exePath, args ?? []),
  /** Run a candidate once without adopting it or recording a play session. */
  tryExe: (
    id: string,
    exePath: string,
    args?: string[]
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('game:tryExe', id, exePath, args ?? []),
  /** Whether anything is running out of the game folder. `null` if the query failed. */
  probeRunning: (id: string): Promise<boolean | null> =>
    ipcRenderer.invoke('game:probeRunning', id),

  /**
   * Tell the main process the library is on screen, which is what dismisses the splash.
   * Fire-and-forget: nothing is waiting on a reply, and a reply that never came would
   * only be another way to keep the window hidden.
   */
  ready: (): void => ipcRenderer.send('app:ready'),

  reveal: (id: string): Promise<boolean> => ipcRenderer.invoke('game:reveal', id),
  breakdown: (dir: string): Promise<Breakdown | null> => ipcRenderer.invoke('game:breakdown', dir),
  setCover: (id: string): Promise<Game | undefined | null> => ipcRenderer.invoke('game:setCover', id),
  clearCover: (id: string): Promise<Game | undefined> => ipcRenderer.invoke('game:clearCover', id),

  planUninstall: (id: string): Promise<UninstallPlan | null> =>
    ipcRenderer.invoke('uninstall:plan', id),
  performUninstall: (id: string): Promise<UninstallResult> =>
    ipcRenderer.invoke('uninstall:perform', id),
  trashLeftovers: (id: string): Promise<UninstallResult> =>
    ipcRenderer.invoke('uninstall:leftovers', id),

  setGroups: (groups: Group[]): Promise<Group[]> => ipcRenderer.invoke('groups:set', groups),

  diskInfo: (): Promise<DiskInfo[]> => ipcRenderer.invoke('disk:info'),
  redundantArchives: (): Promise<RedundantArchive[]> => ipcRenderer.invoke('disk:redundant'),
  trashArchives: (volumes: string[]): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('disk:trashArchives', volumes),

  has7z: (): Promise<boolean> => ipcRenderer.invoke('archive:has7z'),
  extract: (id: string): Promise<{ ok: boolean; dest?: string; error?: string }> =>
    ipcRenderer.invoke('archive:extract', id),

  /** What a shared copy of each game would leave out. Reads the folders; writes nothing. */
  sharePlan: (ids: string[]): Promise<SharePlan[]> => ipcRenderer.invoke('share:plan', ids),
  shareStart: (
    jobs: ShareJob[],
    options: ShareOptions
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('share:start', jobs, options),
  shareCancel: (): Promise<boolean> => ipcRenderer.invoke('share:cancel'),
  shareFreeSpace: (dir: string): Promise<number | null> =>
    ipcRenderer.invoke('share:freeSpace', dir),
  /** Pick a file or folder to exclude; returns null unless it sits inside `dir`. */
  pickInside: (dir: string, kind: 'file' | 'dir'): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pickInside', dir, kind),
  onShareProgress: (
    cb: (payload: { gameId: string; percent: number; index: number; total: number }) => void
  ): (() => void) => {
    const handler = (
      _e: unknown,
      payload: { gameId: string; percent: number; index: number; total: number }
    ): void => cb(payload)
    ipcRenderer.on('share:progress', handler)
    return () => ipcRenderer.off('share:progress', handler)
  },
  onShareDone: (cb: (results: ShareResult[]) => void): (() => void) => {
    const handler = (_e: unknown, results: ShareResult[]): void => cb(results)
    ipcRenderer.on('share:done', handler)
    return () => ipcRenderer.off('share:done', handler)
  },

  /**
   * Where each game's saves appear to be, and how sure we are.
   *
   * Reads the game folder and the handful of places Windows lets a game write; writes
   * nothing anywhere. Slower than most calls here — it walks AppData once — so the caller
   * should expect to wait rather than call it on a hover.
   */
  savePlan: (ids: string[]): Promise<SavePlan[]> => ipcRenderer.invoke('saves:plan', ids),
  /**
   * Copy the ticked saves out to `destRoot`.
   *
   * Copies only: nothing under a game folder is written, moved or deleted, and there is
   * no counterpart that puts anything back. The main process re-derives the plan rather
   * than trusting the paths in `jobs`, so a path this side invented is not copied.
   */
  startSaveBackup: (
    jobs: SaveBackupJob[],
    destRoot: string
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('saves:start', jobs, destRoot),
  cancelSaveBackup: (): Promise<boolean> => ipcRenderer.invoke('saves:cancel'),
  /** The folder backups go to: the user's choice, else the one under Documents. */
  backupDir: (): Promise<string> => ipcRenderer.invoke('saves:dir'),
  pickBackupDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickBackupDir'),
  /**
   * Point at a save the search did not find. Anywhere on disk, deliberately — the whole
   * reason this exists is that saves are routinely nowhere near the game.
   */
  pickSaveSource: (gameId: string, kind: 'file' | 'dir'): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pickSaveSource', gameId, kind),
  onSaveBackupProgress: (
    cb: (payload: { gameId: string; percent: number; index: number; total: number }) => void
  ): (() => void) => {
    const handler = (
      _e: unknown,
      payload: { gameId: string; percent: number; index: number; total: number }
    ): void => cb(payload)
    ipcRenderer.on('saves:progress', handler)
    return () => ipcRenderer.off('saves:progress', handler)
  },
  onSaveBackupDone: (cb: (results: SaveBackupResult[]) => void): (() => void) => {
    const handler = (_e: unknown, results: SaveBackupResult[]): void => cb(results)
    ipcRenderer.on('saves:done', handler)
    return () => ipcRenderer.off('saves:done', handler)
  },

  listDir: (
    dir: string
  ): Promise<{ path: string; parent: string | null; entries: ListedEntry[] }> =>
    ipcRenderer.invoke('fs:list', dir),
  runExe: (exePath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('fs:runExe', exePath),

  startDownload: (
    url: string,
    dir?: string
  ): Promise<{ ok: boolean; id?: string; error?: string }> =>
    ipcRenderer.invoke('download:start', url, dir),
  listDownloads: (): Promise<PendingDownload[]> => ipcRenderer.invoke('download:list'),
  cancelDownload: (id: string): Promise<boolean> => ipcRenderer.invoke('download:cancel', id),
  clearFinishedDownloads: (): Promise<boolean> => ipcRenderer.invoke('download:clearFinished'),
  detectDownloader: (key: DownloaderKey): Promise<string | null> =>
    ipcRenderer.invoke('download:detect', key),
  onDownloads: (cb: (list: PendingDownload[]) => void): (() => void) => {
    const handler = (_e: unknown, list: PendingDownload[]): void => cb(list)
    ipcRenderer.on('download:changed', handler)
    return () => ipcRenderer.off('download:changed', handler)
  },

  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder'),
  pickDownloadDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDownloadDir'),
  pickExe: (): Promise<Game | null> => ipcRenderer.invoke('dialog:pickExe'),
  importPath: (
    filePath: string,
    patch?: Partial<Game>
  ): Promise<{ ok: boolean; game?: Game; alreadyKnown?: boolean; error?: string }> =>
    ipcRenderer.invoke('game:importPath', filePath, patch ?? {}),
  /**
   * The path behind a dropped File. Electron removed `File.path` in v32, so this is the
   * only way the renderer can learn where a dropped file actually lives.
   */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  pickExePath: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickExePath'),
  openPath: (target: string): Promise<boolean> => ipcRenderer.invoke('shell:openPath', target),

  /** Build a URL the renderer can put in an <img src>. */
  assetUrl: (filePath: string): string =>
    `sakura-asset://local/?p=${encodeURIComponent(filePath)}`,

  onSize: (cb: (payload: { id: string; sizeBytes: number }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { id: string; sizeBytes: number }): void => cb(payload)
    ipcRenderer.on('games:size', handler)
    return () => ipcRenderer.off('games:size', handler)
  },
  onArchiveProgress: (cb: (payload: { id: string; percent: number }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { id: string; percent: number }): void => cb(payload)
    ipcRenderer.on('archive:progress', handler)
    return () => ipcRenderer.off('archive:progress', handler)
  },
  onArchiveDone: (
    cb: (payload: { id: string; ok: boolean; error?: string; destDir: string }) => void
  ): (() => void) => {
    const handler = (
      _e: unknown,
      payload: { id: string; ok: boolean; error?: string; destDir: string }
    ): void => cb(payload)
    ipcRenderer.on('archive:done', handler)
    return () => ipcRenderer.off('archive:done', handler)
  },
  onDbChanged: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('db:changed', handler)
    return () => ipcRenderer.off('db:changed', handler)
  },

  activeSessions: (): Promise<string[]> => ipcRenderer.invoke('playtime:active'),
  onPlaytime: (cb: (payload: PlaytimeUpdate) => void): (() => void) => {
    const handler = (_e: unknown, payload: PlaytimeUpdate): void => cb(payload)
    ipcRenderer.on('playtime:changed', handler)
    return () => ipcRenderer.off('playtime:changed', handler)
  },

  onLaunchTrouble: (cb: (payload: LaunchTroubleEvent) => void): (() => void) => {
    const handler = (_e: unknown, payload: LaunchTroubleEvent): void => cb(payload)
    ipcRenderer.on('launch:trouble', handler)
    return () => ipcRenderer.off('launch:trouble', handler)
  }
}

export type SakuraApi = typeof api

contextBridge.exposeInMainWorld('sakura', api)
