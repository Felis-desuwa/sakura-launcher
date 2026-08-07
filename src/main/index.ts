import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Breakdown, Game, Group, Settings } from '../shared/types'
import { ARCHIVE_GROUP_ID, normalizeStatus } from '../shared/types'
import { defaultDestFor, extractArchive, find7z } from './archive'
import * as db from './db'
import { diskInfo, redundantArchives, trashArchives } from './disk'
import { launchGame, revealInExplorer } from './launcher'
import { onPlaytimeChange, playingIds, shutdownPlaytime } from './playtime'
import { listDirShallow, removeSidecar, SIDECAR, writeSidecar } from './scan-core'
import { addGameByExe, importFolder, previewFolder, rescan } from './scanner'
import { syncAll, toSidecar as sidecarFrom } from './sidecar-sync'
import { performUninstall, planUninstall, trashLeftovers } from './uninstaller'
import { computeBreakdown, computeSize, shutdown as shutdownWorkers } from './worker-pool'

const ASSET_SCHEME = 'sakura-asset'

protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

let mainWindow: BrowserWindow | null = null

/**
 * Window icon for development runs. In a packaged build Windows takes the icon from
 * the executable itself, which electron-builder stamps from build/icon.ico.
 */
function devWindowIcon(): string | undefined {
  const candidate = path.join(__dirname, '../../build/icon.png')
  return fs.existsSync(candidate) ? candidate : undefined
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    icon: devWindowIcon(),
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#fff5f9',
    title: 'Sakura Launcher',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    void maybeCapture()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

/**
 * Development aid: render the window offscreen to a PNG and exit.
 * `SAKURA_CAPTURE` holds the output path; `SAKURA_CAPTURE_DELAY` how long to wait for
 * the scan to settle, and `SAKURA_CAPTURE_SCRIPT` optional JS to run before capturing.
 * Captures only this window's own contents — never the desktop.
 */
async function maybeCapture(): Promise<void> {
  const target = process.env['SAKURA_CAPTURE']
  if (!target || !mainWindow) return
  const delay = Number(process.env['SAKURA_CAPTURE_DELAY'] ?? 4000)
  await new Promise((r) => setTimeout(r, delay))
  const script = process.env['SAKURA_CAPTURE_SCRIPT']
  if (script) {
    try {
      const value = await mainWindow.webContents.executeJavaScript(script)
      console.log('capture script ->', value)
      await new Promise((r) => setTimeout(r, 900))
    } catch (err) {
      console.error('capture script failed:', err)
    }
  }
  const image = await mainWindow.webContents.capturePage()
  fs.writeFileSync(target, image.toPNG())
  console.log('captured ->', target)
  app.quit()
}

/**
 * Serve cached icons and user cover images to the renderer.
 * Only files under the app's own data directory, or a path already recorded on a game,
 * are readable — the renderer cannot ask for arbitrary files.
 */
function allowedAssetPath(target: string): boolean {
  const resolved = path.resolve(target)
  const userData = path.resolve(app.getPath('userData'))
  if (resolved.toLowerCase().startsWith(userData.toLowerCase())) return true
  return db
    .getGames()
    .some(
      (g) =>
        (g.coverPath && path.resolve(g.coverPath).toLowerCase() === resolved.toLowerCase()) ||
        (g.iconPath && path.resolve(g.iconPath).toLowerCase() === resolved.toLowerCase())
    )
}

function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, (request) => {
    const url = new URL(request.url)
    const target = decodeURIComponent(url.searchParams.get('p') ?? '')
    if (!target || !allowedAssetPath(target) || !fs.existsSync(target)) {
      return new Response('not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(target).toString())
  })
}

/** Recompute sizes in the background and push each result to the UI as it lands. */
async function refreshSizes(force = false): Promise<void> {
  const targets = db
    .getGames()
    .filter((g) => g.kind === 'installed' && (force || g.sizeBytes === null))
  for (const game of targets) {
    const size = await computeSize(game.dir)
    if (size === null) continue
    db.updateGame(game.id, { sizeBytes: size })
    mainWindow?.webContents.send('games:size', { id: game.id, sizeBytes: size })
  }
}

function breakdownCachePath(dir: string): string {
  const key = crypto.createHash('sha1').update(dir.toLowerCase()).digest('hex').slice(0, 16)
  return path.join(db.breakdownCacheDir(), `${key}.json`)
}

async function getBreakdown(dir: string): Promise<Breakdown | null> {
  let mtimeMs = 0
  try {
    mtimeMs = fs.statSync(dir).mtimeMs
  } catch {
    return null
  }

  const cachePath = breakdownCachePath(dir)
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as Breakdown & {
      mtimeMs: number
    }
    if (cached.mtimeMs === mtimeMs) return cached
  } catch {
    /* cache miss */
  }

  const result = await computeBreakdown(dir)
  if (!result) return null
  const breakdown: Breakdown = { path: dir, totalBytes: result.totalBytes, entries: result.entries }
  try {
    fs.writeFileSync(cachePath, JSON.stringify({ ...breakdown, mtimeMs }), 'utf-8')
  } catch {
    /* cache is best-effort */
  }
  return breakdown
}

function registerIpc(): void {
  ipcMain.handle('db:snapshot', () => ({
    games: db.getGames(),
    groups: db.getGroups(),
    settings: db.getSettings()
  }))

  ipcMain.handle('settings:update', (_e, patch: Partial<Settings>) => db.setSettings(patch))

  /**
   * `sync` distinguishes the scan the user asked for from the quiet one at startup.
   * Reconciling every sidecar means a stat (and sometimes a read and a write) per game;
   * that belongs behind a deliberate click, not in the path between launching the app
   * and seeing the library.
   */
  ipcMain.handle('scan:run', async (_e, sync = false) => {
    const outcome = rescan()
    const sidecars = sync ? syncAll() : null
    db.saveNow()
    void refreshSizes()
    return { ...outcome, games: db.getGames(), sidecars }
  })

  ipcMain.handle('scan:recomputeSizes', async () => {
    await refreshSizes(true)
    return true
  })

  ipcMain.handle('game:launch', (_e, id: string) => launchGame(id))

  ipcMain.handle('game:update', (_e, id: string, patch: Partial<Game>) => {
    const game = db.findGame(id)
    if (!game) return undefined
    return db.updateGame(id, normalizeStatus(game, patch))
  })

  /**
   * `ids` is only the subset the user can currently see — one tab, one group, or a
   * search result. Numbering it 0..n-1 would give those games the same order values as
   * everything else in the library, so an arrangement made in 「在玩」 would scramble
   * 「全部」. Instead the subset is rearranged within the slots it already occupies,
   * leaving every other game exactly where it was.
   */
  ipcMain.handle('game:reorder', (_e, ids: string[]) => {
    const byId = new Map(db.getGames().map((g) => [g.id, g]))
    const targets = ids.map((id) => byId.get(id)).filter((g): g is Game => g !== undefined)
    const slots = targets.map((g) => g.order).sort((a, b) => a - b)
    targets.forEach((g, i) => {
      g.order = slots[i]
    })
    db.setGames([...byId.values()])
    return true
  })

  /**
   * Rename a game. The chosen title is written to a sidecar file inside the game's own
   * folder rather than by renaming the folder, which would risk breaking games that
   * resolve their assets by path. If the folder cannot be written to (read-only media,
   * permissions), fall back to storing the name in the database only.
   */
  ipcMain.handle('game:rename', (_e, id: string, name: string) => {
    const game = db.findGame(id)
    if (!game) return { ok: false, error: '找不到该游戏' }

    const trimmed = name.trim()
    if (!trimmed) return { ok: false, error: '名称不能为空' }

    // Archives are loose files with no folder of their own to annotate.
    if (game.kind !== 'installed' || !fs.existsSync(game.dir)) {
      db.updateGame(id, { name: trimmed, renamed: true })
      return { ok: true, sidecar: false }
    }

    const result = writeSidecar(game.dir, { ...sidecarFrom(game), name: trimmed })
    if (!result.ok) {
      db.updateGame(id, { name: trimmed, renamed: true })
      return { ok: true, sidecar: false, error: result.error }
    }
    // The sidecar is now the source of truth, so drop the database-only override.
    db.updateGame(id, { name: trimmed, renamed: false, sidecarSyncedAt: result.mtimeMs })
    return { ok: true, sidecar: true, file: path.join(game.dir, SIDECAR) }
  })

  ipcMain.handle('game:setTags', (_e, id: string, tags: string[]) => {
    const clean = [...new Set(tags.map((t) => t.trim()).filter(Boolean))]
    return db.updateGame(id, { tags: clean })
  })

  /**
   * Remove a tile from the library without touching anything on disk.
   * This is for entries that are not games at all — installers, tools, stray folders.
   * The path is remembered so the next scan does not add it straight back.
   */
  ipcMain.handle('game:remove', (_e, id: string) => {
    const game = db.findGame(id)
    if (!game) return { ok: false, error: '找不到该条目' }
    const settings = db.getSettings()
    const key = game.dir
    if (!settings.ignoredDirs.some((d) => d.toLowerCase() === key.toLowerCase())) {
      db.setSettings({ ignoredDirs: [...settings.ignoredDirs, key] })
    }
    db.removeGame(id)
    return { ok: true, name: game.name }
  })

  ipcMain.handle('library:unignore', (_e, dir: string) => {
    const settings = db.getSettings()
    db.setSettings({
      ignoredDirs: settings.ignoredDirs.filter((d) => d.toLowerCase() !== dir.toLowerCase())
    })
    rescan()
    void refreshSizes()
    return db.getSettings()
  })

  ipcMain.handle('game:resetName', (_e, id: string) => {
    const game = db.findGame(id)
    if (!game) return { ok: false }
    if (game.kind === 'installed' && fs.existsSync(game.dir)) {
      // Drop the whole sidecar rather than just the name line: the user is asking for
      // the default, and everything else in it is recoverable from the database.
      removeSidecar(game.dir)
      db.updateGame(id, { sidecarSyncedAt: undefined })
    }
    db.updateGame(id, { renamed: false })
    rescan()
    return { ok: true }
  })

  ipcMain.handle('game:reveal', (_e, id: string) => {
    const game = db.findGame(id)
    if (game) revealInExplorer(game.exe || game.dir)
    return true
  })

  ipcMain.handle('game:breakdown', (_e, dir: string) => getBreakdown(dir))

  ipcMain.handle('fs:list', (_e, dir: string) => ({
    path: dir,
    parent: path.dirname(dir) === dir ? null : path.dirname(dir),
    entries: listDirShallow(dir)
  }))

  /** Run an executable the user picked inside the in-app folder browser. */
  ipcMain.handle('fs:runExe', (_e, exePath: string) => {
    if (!/\.(exe|bat|cmd)$/i.test(exePath) || !fs.existsSync(exePath)) {
      return { ok: false, error: '不是可执行文件' }
    }
    try {
      const child = spawn(exePath, [], {
        cwd: path.dirname(exePath),
        detached: true,
        stdio: 'ignore'
      })
      child.unref()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('game:setCover', async (_e, id: string) => {
    const game = db.findGame(id)
    if (!game || !mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择封面图片',
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
      properties: ['openFile']
    })
    if (res.canceled || res.filePaths.length === 0) return null
    const src = res.filePaths[0]
    // Copy into app data so the cover survives the source file moving away.
    const dest = path.join(db.coverDir(), `${game.id}${path.extname(src)}`)
    try {
      fs.copyFileSync(src, dest)
    } catch {
      return null
    }
    return db.updateGame(id, { coverPath: dest })
  })

  ipcMain.handle('game:clearCover', (_e, id: string) => db.updateGame(id, { coverPath: null }))

  ipcMain.handle('uninstall:plan', (_e, id: string) => planUninstall(id))
  ipcMain.handle('uninstall:perform', (_e, id: string) => performUninstall(id))
  ipcMain.handle('uninstall:leftovers', (_e, id: string) => trashLeftovers(id))

  ipcMain.handle('groups:set', (_e, groups: Group[]) => {
    db.setGroups(groups)
    return db.getGroups()
  })

  ipcMain.handle('disk:info', () => diskInfo())
  ipcMain.handle('disk:redundant', () => redundantArchives())
  ipcMain.handle('disk:trashArchives', (_e, volumes: string[]) => trashArchives(volumes))

  ipcMain.handle('archive:has7z', () => find7z() !== null)
  ipcMain.handle('archive:extract', (_e, id: string) => {
    const game = db.findGame(id)
    if (!game || game.kind !== 'archive') return { ok: false, error: '不是压缩包条目' }
    const first = (game.archiveVolumes ?? [game.dir])[0]
    const dest = defaultDestFor(first)
    extractArchive(
      first,
      dest,
      (percent) => mainWindow?.webContents.send('archive:progress', { id, percent }),
      (result) => {
        mainWindow?.webContents.send('archive:done', { id, ...result })
        if (result.ok) {
          rescan()
          void refreshSizes()
          mainWindow?.webContents.send('db:changed')
        }
      }
    )
    return { ok: true, dest }
  })

  ipcMain.handle('dialog:pickFolder', async () => {
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择游戏库文件夹',
      properties: ['openDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  /** Scan a folder without touching the library, so the user can vet what goes in. */
  ipcMain.handle('scan:preview', (_e, folder: string) => previewFolder(folder))

  ipcMain.handle(
    'scan:commitImport',
    (_e, folder: string, accept: string[], reject: string[]) => {
      const outcome = importFolder(folder, accept, reject)
      void refreshSizes()
      return outcome
    }
  )

  ipcMain.handle('dialog:pickExe', async () => {
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择游戏主程序',
      filters: [{ name: '可执行文件', extensions: ['exe'] }],
      properties: ['openFile']
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return addGameByExe(res.filePaths[0])
  })

  /** Pick an executable path without registering it as a game (used for external tools). */
  ipcMain.handle('dialog:pickExePath', async () => {
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择可执行文件',
      filters: [{ name: '可执行文件', extensions: ['exe'] }],
      properties: ['openFile']
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  ipcMain.handle('shell:openPath', (_e, target: string) => {
    revealInExplorer(target)
    return true
  })

  /** Which games are running right now, so a reload of the UI does not lose the badge. */
  ipcMain.handle('playtime:active', () => playingIds())
}

app.whenReady().then(() => {
  db.initPaths()
  registerAssetProtocol()
  registerIpc()
  onPlaytimeChange((payload) => mainWindow?.webContents.send('playtime:changed', payload))
  createWindow()

  // Ensure the built-in bucket for not-yet-installed archives always exists.
  const groups = db.getGroups()
  if (!groups.some((g) => g.id === ARCHIVE_GROUP_ID)) {
    db.setGroups([
      ...groups,
      { id: ARCHIVE_GROUP_ID, name: '待安装', order: 9999, builtin: true }
    ])
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // Settle open sessions first: it writes playtime that the flush then commits.
  shutdownPlaytime()
  db.saveNow()
  shutdownWorkers()
})
