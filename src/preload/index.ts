import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  Breakdown,
  DiskInfo,
  DownloaderKey,
  ExeChoices,
  Game,
  Group,
  PendingDownload,
  RedundantArchive,
  Settings
} from '../shared/types'

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
  }
}

export type SakuraApi = typeof api

contextBridge.exposeInMainWorld('sakura', api)
