import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  Breakdown,
  DownloaderKey,
  ExeChoice,
  ExeChoices,
  Game,
  Group,
  Settings,
  ShareCandidate,
  ShareJob,
  ShareOptions,
  SharePlan,
  WorkMatch
} from '../shared/types'
import { ARCHIVE_GROUP_ID, normalizeStatus } from '../shared/types'
import { defaultDestFor, extractArchive, find7z } from './archive'
import * as db from './db'
import { diskInfo, redundantArchives, trashArchives } from './disk'
import {
  cancelDownload,
  clearFinishedDownloads,
  detectDownloader,
  onDownloadsChanged,
  resumeDownloads,
  shutdownDownloads,
  startDownload
} from './downloader'
import { resolveArtwork } from './icon'
import { diagnoseGame } from './diagnose'
import { setMainLang, t } from './i18n'
import { cancelWatch, onLaunchTrouble } from './launch-watch'
import { launchElevated, launchGame, revealInExplorer, spawnDetached } from './launcher'
import { probeExeMeta } from './pe-icon'
import { onPlaytimeChange, playingIds, runningInDir, shutdownPlaytime } from './playtime'
import {
  classifyExes,
  collectSubExes,
  exeKindLabel,
  isUnder,
  listDirShallow,
  removeSidecar,
  SIDECAR,
  splitArgs,
  writeSidecar
} from './scan-core'
import {
  addGameByExe,
  importFolder,
  previewFolder,
  rescan,
  type AddGameExtras
} from './scanner'
import { startShare, type ShareHandle } from './share'
import {
  applyMatch,
  cancelTagRun,
  computeTags,
  pendingTargets,
  searchWorks,
  setTagHidden,
  tagRunActive
} from './tagger'
import { sanitizeArchiveName, scanPersonalData } from './share-rules'
import { syncAll, toSidecar as sidecarFrom, writeGameSidecar } from './sidecar-sync'
import { closeSplash, showSplash, splashStage } from './splash'
import { performUninstall, planUninstall, trashLeftovers } from './uninstaller'
import { computeBreakdown, computeSize, shutdown as shutdownWorkers } from './worker-pool'

/** Outcome of dropping a file onto the window. */
export interface ImportDropResult {
  ok: boolean
  game?: Game
  /** The folder was already in the library; only the status was applied. */
  alreadyKnown?: boolean
  error?: string
}

const ASSET_SCHEME = 'sakura-asset'

protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

let mainWindow: BrowserWindow | null = null
/** The share queue in flight, if any. One at a time — see `startShare`. */
let shareHandle: ShareHandle | null = null

/**
 * Window icon for development runs. In a packaged build Windows takes the icon from
 * the executable itself, which electron-builder stamps from build/icon.ico.
 */
function devWindowIcon(): string | undefined {
  const candidate = path.join(__dirname, '../../build/icon.png')
  return fs.existsSync(candidate) ? candidate : undefined
}

/**
 * How long the splash may hold the window back waiting for the renderer to say it has
 * the library. A renderer that crashed or hung must never leave the user with nothing
 * but a splash, so this is the point where the window goes up regardless.
 */
const LIBRARY_WAIT_MS = 6000

/** The window has painted its first frame. */
let painted = false
/** The renderer has the library in hand — or waited long enough to stop mattering. */
let libraryReady = false
let revealed = false

/** Hand the desktop over from the splash to the real window, once and once only. */
function revealMainWindow(): void {
  if (revealed || !painted || !libraryReady || !mainWindow) return
  revealed = true
  closeSplash()
  mainWindow.show()
  void maybeCapture()
}

function markLibraryReady(): void {
  libraryReady = true
  revealMainWindow()
}

function createWindow(): void {
  // A window recreated after the last one closed goes through the same handshake.
  painted = false
  libraryReady = false
  revealed = false

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
    painted = true
    // The window has drawn, but the library has not arrived in it yet. Staying behind
    // the splash for another moment is what turns startup into one transition instead
    // of an empty shelf that fills in while the user watches.
    if (!libraryReady) setTimeout(markLibraryReady, LIBRARY_WAIT_MS)
    revealMainWindow()
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
  ipcMain.handle('game:launchElevated', (_e, id: string) => launchElevated(id))

  /**
   * Why nothing happened. `since` is the moment of the launch that failed, which is what
   * separates the log the game just wrote from the one it wrote two years ago.
   */
  ipcMain.handle('game:diagnose', async (_e, id: string, since?: number) => {
    const game = db.findGame(id)
    if (!game) return null
    return diagnoseGame(game, since)
  })

  /** The user dismissed the "it did not start" card — stop watching this launch. */
  ipcMain.handle('game:cancelWatch', (_e, id: string) => {
    cancelWatch(id)
    return true
  })

  ipcMain.handle('game:update', (_e, id: string, patch: Partial<Game>) => {
    const game = db.findGame(id)
    if (!game) return undefined
    return db.updateGame(id, normalizeStatus(game, patch))
  })

  /**
   * `ids` is only the subset the user can currently see — one tab, one group, or a
   * search result. Numbering it 0..n-1 would give those games the same order values as
   * everything else in the library, so an arrangement made under Playing would scramble
   * All. Instead the subset is rearranged within the slots it already occupies,
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
    if (!game) return { ok: false, error: t('err.gameNotFound') }

    const trimmed = name.trim()
    if (!trimmed) return { ok: false, error: t('err.nameEmpty') }

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
   * Work out the automatic tags.
   *
   * Guarded against a second run while one is in flight: the pass writes to every game
   * record it touches, and two of them interleaving would have each overwriting the
   * other's work. The renderer disables the button, but a disabled button is a courtesy,
   * not a lock.
   */
  ipcMain.handle('tags:compute', async (e, ids: string[] | null) => {
    if (tagRunActive()) return { ok: false, busy: true }
    const run = await computeTags(ids, (progress) => {
      if (!e.sender.isDestroyed()) e.sender.send('tags:progress', progress)
    })
    mainWindow?.webContents.send('db:changed')
    return {
      ok: true,
      looked: run.looked,
      matched: run.matched,
      pending: run.pending,
      offline: run.offline,
      cancelled: run.cancelled
    }
  })

  /** How many games a pass would look up, so the button can say so before it is pressed. */
  ipcMain.handle('tags:pendingCount', () => pendingTargets(db.getGames()).length)

  /** The manual box: a title in any language, or an id pasted straight in. */
  ipcMain.handle('tags:search', (_e, query: string) => searchWorks(query))

  ipcMain.handle('tags:cancel', () => {
    cancelTagRun()
    return true
  })

  ipcMain.handle('tags:applyMatch', (_e, gameId: string, match: WorkMatch) =>
    applyMatch(gameId, match)
  )

  ipcMain.handle('tags:setHidden', (_e, gameId: string, tagId: string, hidden: boolean) =>
    setTagHidden(gameId, tagId, hidden)
  )

  /**
   * Remove a tile from the library without touching anything on disk.
   * This is for entries that are not games at all — installers, tools, stray folders.
   * The path is remembered so the next scan does not add it straight back.
   */
  ipcMain.handle('game:remove', (_e, id: string) => {
    const game = db.findGame(id)
    if (!game) return { ok: false, error: t('err.entryNotFound') }
    const settings = db.getSettings()
    const key = game.dir
    if (!settings.ignoredDirs.some((d) => d.toLowerCase() === key.toLowerCase())) {
      db.setSettings({ ignoredDirs: [...settings.ignoredDirs, key] })
    }
    // Keep the record itself, not just the path: removing is reversible, and adding the
    // folder back should return the cover, rating and grid position with it.
    db.rememberRemoved(game)
    db.removeGame(id)
    return { ok: true, name: game.name }
  })

  ipcMain.handle('library:unignore', (_e, dir: string) => {
    const settings = db.getSettings()
    db.setSettings({
      ignoredDirs: settings.ignoredDirs.filter((d) => d.toLowerCase() !== dir.toLowerCase())
    })
    // Restoring one path is exactly the case where the scan is meant to add something.
    rescan({ discoverIn: [dir] })
    void refreshSizes()
    return db.getSettings()
  })

  /**
   * Forget removal records without acting on them.
   *
   * Distinct from restoring: the path simply stops being skipped, so it is offered
   * again the next time the user rescans that folder. The record of what they had
   * marked on it is deliberately kept — clearing a list is about tidying the list, and
   * a custom cover is not something a rescan could ever bring back on its own.
   */
  ipcMain.handle('library:clearIgnored', (_e, dirs?: string[]) => {
    const settings = db.getSettings()
    if (!dirs || dirs.length === 0) {
      db.setSettings({ ignoredDirs: [] })
    } else {
      const gone = new Set(dirs.map((d) => d.toLowerCase()))
      db.setSettings({
        ignoredDirs: settings.ignoredDirs.filter((d) => !gone.has(d.toLowerCase()))
      })
    }
    db.saveNow()
    return db.getSettings()
  })

  /**
   * Drop a scan folder and everything that came from it.
   *
   * Leaving the games behind was the old behaviour and it read as a bug: the folder is
   * off the list, yet a refresh still shows its contents. What each game recorded is
   * written out to its own sidecar first, so putting the folder back restores the
   * ratings and play history rather than starting over.
   */
  ipcMain.handle('library:removeRoot', (_e, folder: string) => {
    const settings = db.getSettings()
    const doomed = db.getGames().filter((g) => isUnder(g.dir, folder))
    for (const game of doomed) writeGameSidecar(game)

    db.setGames(db.getGames().filter((g) => !isUnder(g.dir, folder)))
    db.setRemoved(db.getRemoved().filter((g) => !isUnder(g.dir, folder)))
    db.setSettings({
      roots: settings.roots.filter((r) => !isUnder(r, folder)),
      ignoredDirs: settings.ignoredDirs.filter((d) => !isUnder(d, folder)),
      groupingPrompted: settings.groupingPrompted.filter((d) => !isUnder(d, folder))
    })

    // Groups left with nothing in them would sit on the desktop as empty folders.
    const live = new Set(db.getGames().map((g) => g.groupId))
    db.setGroups(db.getGroups().filter((g) => g.builtin || live.has(g.id)))

    db.saveNow()
    return { removed: doomed.length, games: db.getGames(), settings: db.getSettings() }
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

  /**
   * Every executable in a game folder, named and explained.
   *
   * A folder with a dozen of them tells the user nothing on its own — which is the
   * whole problem this answers. The scanner's own judgement is shown rather than
   * applied silently, so picking is a decision instead of a guess.
   */
  ipcMain.handle('game:exeCandidates', (_e, id: string): ExeChoices | null => {
    const game = db.findGame(id)
    if (!game || game.kind !== 'installed') return null

    const currentPath = game.exe ? path.resolve(game.exe) : null
    const isCurrent = (full: string): boolean =>
      currentPath !== null && path.resolve(full).toLowerCase() === currentPath.toLowerCase()

    const entries = listDirShallow(game.dir).map((e) => ({
      name: e.name,
      isDir: e.isDir,
      size: e.sizeBytes
    }))

    const choices: ExeChoice[] = classifyExes(game.dir, entries, probeExeMeta).map((v) => ({
      rel: v.name,
      fullPath: v.fullPath,
      sizeBytes: v.size,
      kind: v.kind,
      label: exeKindLabel(v.kind),
      reasons: v.reasons,
      rankable: v.rankable,
      current: isCurrent(v.fullPath)
    }))

    // Ranked ones first, in the order the scanner would have picked them.
    choices.sort((a, b) => Number(b.rankable) - Number(a.rankable))

    for (const sub of collectSubExes(game.dir)) {
      choices.push({
        rel: sub.rel,
        fullPath: sub.fullPath,
        sizeBytes: sub.size,
        kind: 'sub',
        label: exeKindLabel('sub'),
        reasons: [t('exeWhy.inSubfolder', { dir: path.dirname(sub.rel) })],
        rankable: false,
        current: isCurrent(sub.fullPath)
      })
    }

    return {
      dir: game.dir,
      current: currentPath ? path.relative(game.dir, currentPath) : null,
      currentArgs: game.launchArgs ?? [],
      pinned: game.exePinned === true,
      choices
    }
  })

  /** Adopt an executable as the game's main program, optionally with arguments. */
  ipcMain.handle('game:setExe', (_e, id: string, exePath: string, args: string[] = []) => {
    const game = db.findGame(id)
    if (!game) return { ok: false, error: t('err.gameNotFound') }

    const target = path.resolve(exePath)
    // The picker only ever offers paths inside the folder; enforcing it here means a
    // malformed call cannot point a tile at an executable somewhere else on the disk.
    if (!isUnder(target, game.dir)) return { ok: false, error: t('err.mustBeInside') }
    if (!fs.existsSync(target)) return { ok: false, error: t('err.fileGone') }

    const clean = args.map((a) => a.trim()).filter(Boolean)
    const art = resolveArtwork(game.dir, target)
    db.updateGame(id, {
      exe: target,
      exePinned: true,
      launchArgs: clean.length > 0 ? clean : undefined,
      launchCwd: undefined,
      // The tile should look like whatever now starts the game.
      iconPath: art.iconPath ?? game.iconPath
    })
    const updated = db.findGame(id)
    if (updated) writeGameSidecar(updated)
    db.saveNow()
    return { ok: true, game: updated }
  })

  /**
   * Run one candidate without adopting it. Deliberately not a play session: trying four
   * executables in a row should not add four launches to the game's history.
   */
  ipcMain.handle('game:tryExe', async (_e, id: string, exePath: string, args: string[] = []) => {
    const game = db.findGame(id)
    if (!game) return { ok: false, error: t('err.gameNotFound') }
    const target = path.resolve(exePath)
    if (!isUnder(target, game.dir)) return { ok: false, error: t('err.mustBeInsideTry') }
    if (!fs.existsSync(target)) return { ok: false, error: t('err.fileGone') }
    return spawnDetached(target, args, path.dirname(target))
  })

  /** Whether anything is running out of the game folder at this moment. */
  ipcMain.handle('game:probeRunning', async (_e, id: string) => {
    const game = db.findGame(id)
    if (!game) return null
    return runningInDir(game.dir)
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
  ipcMain.handle('fs:runExe', async (_e, exePath: string) => {
    if (!/\.(exe|bat|cmd)$/i.test(exePath) || !fs.existsSync(exePath)) {
      return { ok: false, error: t('err.notExecutable') }
    }
    return spawnDetached(exePath, [], path.dirname(exePath))
  })

  ipcMain.handle('game:setCover', async (_e, id: string) => {
    const game = db.findGame(id)
    if (!game || !mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, {
      title: t('pick.cover'),
      filters: [{ name: t('pick.images'), extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
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

  /* ---------- sharing ---------- */

  /**
   * Work out what a shared copy of each game would contain. Read-only: nothing is
   * written and nothing is decided until the user comes back with `share:start`.
   */
  ipcMain.handle('share:plan', (_e, ids: string[]): SharePlan[] =>
    ids.map((id) => {
      const game = db.findGame(id)
      if (!game) {
        return {
          gameId: id,
          gameName: t('share.goneName'),
          dir: '',
          suggestedName: '',
          suggestedDir: '',
          sizeBytes: 0,
          candidates: [],
          blocked: t('share.blocked.gone')
        }
      }
      const base = {
        gameId: game.id,
        gameName: game.name,
        dir: game.dir,
        suggestedName: sanitizeArchiveName(game.name) || path.basename(game.dir),
        // The parent, never the game folder itself: an archive written inside the folder
        // it is packing is an archive trying to contain itself.
        suggestedDir: path.dirname(game.dir),
        sizeBytes: game.sizeBytes ?? 0,
        candidates: [] as ShareCandidate[]
      }
      if (game.kind === 'archive') {
        return { ...base, blocked: t('share.blocked.isArchive') }
      }
      if (game.missing || !fs.existsSync(game.dir)) {
        return { ...base, blocked: t('share.blocked.noFolder') }
      }
      return { ...base, candidates: scanPersonalData(game.dir) }
    })
  )

  ipcMain.handle(
    'share:start',
    (_e, jobs: ShareJob[], options: ShareOptions): { ok: boolean; error?: string } => {
      if (shareHandle) return { ok: false, error: t('err.shareBusy') }

      const resolved: { job: ShareJob; gameDir: string }[] = []
      for (const job of jobs) {
        const game = db.findGame(job.gameId)
        if (!game || game.kind === 'archive' || !fs.existsSync(game.dir)) continue
        // Anything outside the game folder is not ours to leave out of the archive, and
        // a path that wandered would silently drop files the user never saw listed.
        const exclude = job.exclude.filter((p) => isUnder(p, game.dir))
        // An archive landing inside the folder being packed has to skip itself.
        const out = path.join(job.outDir, job.name)
        if (isUnder(out, game.dir)) exclude.push(out)
        resolved.push({ job: { ...job, exclude }, gameDir: game.dir })
      }
      if (resolved.length === 0) return { ok: false, error: t('err.nothingToShare') }

      shareHandle = startShare(
        resolved,
        options,
        (progress) => mainWindow?.webContents.send('share:progress', progress),
        (results) => {
          shareHandle = null
          mainWindow?.webContents.send('share:done', results)
        }
      )
      return { ok: true }
    }
  )

  ipcMain.handle('share:cancel', () => {
    shareHandle?.cancel()
    return true
  })

  /**
   * Pick something to exclude, from inside one game folder.
   *
   * The result is rejected unless it actually sits under that folder: an exclusion
   * pointing somewhere else would be silently ignored by 7z later, and the user would
   * have no way to tell that the line they added was doing nothing.
   */
  ipcMain.handle(
    'dialog:pickInside',
    async (_e, dir: string, kind: 'file' | 'dir'): Promise<string | null> => {
      if (!mainWindow) return null
      const res = await dialog.showOpenDialog(mainWindow, {
        title: kind === 'dir' ? t('pick.excludeDir') : t('pick.excludeFile'),
        defaultPath: dir,
        properties: [kind === 'dir' ? 'openDirectory' : 'openFile']
      })
      const picked = res.canceled ? null : res.filePaths[0]
      if (!picked) return null
      return isUnder(picked, dir) ? picked : null
    }
  )

  /** Free space on the volume an archive would be written to. */
  ipcMain.handle('share:freeSpace', (_e, dir: string): number | null => {
    const letter = dir.slice(0, 1).toUpperCase()
    const disk = diskInfo().find((d) => d.drive.toUpperCase().startsWith(letter))
    return disk ? disk.freeBytes : null
  })

  ipcMain.handle('archive:has7z', () => find7z() !== null)
  ipcMain.handle('archive:extract', (_e, id: string) => {
    const game = db.findGame(id)
    if (!game || game.kind !== 'archive') return { ok: false, error: t('err.notArchive') }
    const first = (game.archiveVolumes ?? [game.dir])[0]
    const dest = defaultDestFor(first)
    extractArchive(
      first,
      dest,
      (percent) => mainWindow?.webContents.send('archive:progress', { id, percent }),
      (result) => {
        mainWindow?.webContents.send('archive:done', { id, ...result })
        if (result.ok) {
          // The user asked for this install, so what came out of the archive may join
          // the library without a second confirmation.
          rescan({ discoverIn: [dest] })
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
      title: t('pick.libraryFolder'),
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
      title: t('pick.mainExe'),
      filters: [{ name: t('pick.executables'), extensions: ['exe'] }],
      properties: ['openFile']
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return addGameByExe(res.filePaths[0])
  })

  /**
   * Add a game from a path the user dropped onto the window.
   *
   * Shortcuts are resolved first: dragging a game off the desktop or the start menu
   * hands over a .lnk, not the executable, and refusing those would reject the most
   * natural way to do this.
   */
  ipcMain.handle(
    'game:importPath',
    (_e, filePath: string, patch: Partial<Game> = {}): ImportDropResult => {
      let target = filePath
      const extras: AddGameExtras = {}
      if (target.toLowerCase().endsWith('.lnk')) {
        try {
          const link = shell.readShortcutLink(target)
          target = link.target
          // Everything else the shortcut carries matters as much as the target does.
          // A launcher started without its arguments usually does nothing visible.
          const args = splitArgs(link.args ?? '')
          if (args.length > 0) extras.launchArgs = args
          if (link.cwd) extras.launchCwd = link.cwd
          if (link.icon && /\.(ico|png)$/i.test(link.icon) && fs.existsSync(link.icon)) {
            extras.iconPath = link.icon
          }
        } catch {
          return { ok: false, error: t('err.badShortcut') }
        }
      }

      if (!target.toLowerCase().endsWith('.exe')) {
        return { ok: false, error: t('err.notExecutableNamed', { name: path.basename(filePath) }) }
      }
      if (!fs.existsSync(target)) {
        return { ok: false, error: t('err.targetMissing', { name: path.basename(target) }) }
      }

      // Already in the library: report it and change nothing. Silently re-marking an
      // existing game would hide the far more likely reading — that the wrong thing was
      // dragged, or that it was dragged twice by accident.
      const existing = db
        .getGames()
        .find((g) => g.dir.toLowerCase() === path.dirname(target).toLowerCase())
      if (existing) {
        return { ok: false, alreadyKnown: true, game: existing, error: t('err.alreadyInLibrary', { name: existing.name }) }
      }

      const game = addGameByExe(target, extras)
      if (!game) return { ok: false, error: t('err.cantReadFolder') }

      const applied = normalizeStatus(game, patch)
      if (Object.keys(applied).length > 0) db.updateGame(game.id, applied)
      db.saveNow()
      void refreshSizes()
      return { ok: true, game: db.findGame(game.id) ?? game }
    }
  )

  /** Pick an executable path without registering it as a game (used for external tools). */
  ipcMain.handle('dialog:pickExePath', async () => {
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, {
      title: t('pick.anyExe'),
      filters: [{ name: t('pick.executables'), extensions: ['exe'] }],
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

  ipcMain.handle('download:start', (_e, url: string, dir?: string) => startDownload(url, dir))
  ipcMain.handle('download:list', () => db.getDownloads())
  ipcMain.handle('download:cancel', (_e, id: string) => {
    cancelDownload(id)
    return true
  })
  ipcMain.handle('download:clearFinished', () => {
    clearFinishedDownloads()
    return true
  })
  ipcMain.handle('download:detect', (_e, key: DownloaderKey) => detectDownloader(key))

  ipcMain.handle('dialog:pickDownloadDir', async () => {
    if (!mainWindow) return null
    const res = await dialog.showOpenDialog(mainWindow, {
      title: t('pick.downloadDir'),
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })

  // The renderer has rendered the library. Nothing depends on the payload — the message
  // arriving is the whole signal, and it is what retires the splash.
  ipcMain.on('app:ready', markLibraryReady)
}

app.whenReady().then(() => {
  // First, before any of the work below: everything that runs ahead of this is time the
  // user spends wondering whether the double-click registered at all.
  // The splash has words on it, so the language has to be settled before it is drawn.
  // One small read, and the file is in the OS cache by the time the database opens it.
  setMainLang(db.peekLanguage())
  showSplash()

  db.initPaths()
  registerAssetProtocol()
  registerIpc()
  splashStage(t('splash.loading'))
  onPlaytimeChange((payload) => mainWindow?.webContents.send('playtime:changed', payload))
  // Only the fact that something went wrong is pushed. Running the diagnosis costs a PE
  // parse and a registry read, and it belongs behind the user deciding they want it.
  onLaunchTrouble(({ game, trouble, startedAt }) =>
    mainWindow?.webContents.send('launch:trouble', {
      id: game.id,
      name: game.name,
      trouble,
      startedAt
    })
  )
  // The list is short enough that pushing it whole beats tracking what changed.
  onDownloadsChanged(() => mainWindow?.webContents.send('download:changed', db.getDownloads()))
  createWindow()
  splashStage(t('splash.arranging'))
  // Downloads outlive the app: one still running belongs to another process, so pick
  // the watch back up rather than starting the job over.
  resumeDownloads()

  // Ensure the built-in bucket for not-yet-installed archives always exists.
  const groups = db.getGroups()
  if (!groups.some((g) => g.id === ARCHIVE_GROUP_ID)) {
    db.setGroups([
      ...groups,
      { id: ARCHIVE_GROUP_ID, name: t('group.archives'), order: 9999, builtin: true }
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
  // Stops the watch timers. Downloads themselves keep running in their own process and
  // are picked back up next launch; an extract in flight is cancelled rather than left
  // to write into a folder nothing is tracking any more.
  shutdownDownloads()
  db.saveNow()
  shutdownWorkers()
})
