import { contextBridge, ipcRenderer } from 'electron'
import type {
  Breakdown,
  DiskInfo,
  Game,
  Group,
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

  scan: (): Promise<ScanOutcome> => ipcRenderer.invoke('scan:run'),
  recomputeSizes: (): Promise<boolean> => ipcRenderer.invoke('scan:recomputeSizes'),

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

  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder'),
  pickExe: (): Promise<Game | null> => ipcRenderer.invoke('dialog:pickExe'),
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
  }
}

export type SakuraApi = typeof api

contextBridge.exposeInMainWorld('sakura', api)
