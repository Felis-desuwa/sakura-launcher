import { BrowserWindow } from 'electron'
import { splashHtml } from './splash-html'

/**
 * The little window that says "yes, it heard you".
 *
 * Electron takes a second or two to get from a double-click to a painted library, and
 * during that time Windows shows nothing at all — no window, no hint, so the natural
 * response is to double-click again. This window exists to fill exactly that gap, which
 * is why it carries no bundle, no preload and no assets: its markup is a data URL built
 * here, so it can go up the moment the app is ready and never waits on a disk read.
 *
 * It is deliberately dumb. Progress text arrives through `executeJavaScript` rather than
 * IPC, because wiring a preload into a window that lives for two seconds costs more than
 * it saves.
 */

/** How long the fade-out takes, in one frame per step. */
const FADE_STEP = 0.12
const FADE_INTERVAL_MS = 16

let splash: BrowserWindow | null = null
/** Stage text that arrived before the page could receive it. */
let pendingStage: string | null = null
let loaded = false

/**
 * Put the splash on screen. Call this before anything else at startup — every line that
 * runs first is a line the user spends staring at an empty desktop.
 */
export function showSplash(): void {
  if (splash) return
  loaded = false
  pendingStage = null

  splash = new BrowserWindow({
    width: 380,
    height: 230,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    center: true,
    alwaysOnTop: true,
    // Kept in the taskbar on purpose: a taskbar entry appearing is itself the answer to
    // "did that do anything?", even before the window has drawn.
    skipTaskbar: false,
    show: false,
    title: 'Sakura Launcher',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })

  const win = splash
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })
  win.webContents.once('did-finish-load', () => {
    loaded = true
    if (pendingStage !== null) {
      splashStage(pendingStage)
      pendingStage = null
    }
  })
  win.on('closed', () => {
    if (splash === win) splash = null
  })

  void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml()))
}

/** Say what the app is busy with, if the splash is still up. */
export function splashStage(text: string): void {
  if (!splash || splash.isDestroyed()) return
  if (!loaded) {
    pendingStage = text
    return
  }
  splash.webContents
    .executeJavaScript(`{ const el = document.getElementById('stage'); if (el) el.textContent = ${JSON.stringify(text)}; }`)
    .catch(() => {
      /* the window went away mid-startup; nothing to update */
    })
}

/**
 * Fade the splash out and dispose of it.
 *
 * The fade runs on the window's opacity rather than in CSS so that it works even if the
 * page never finished loading — a splash stuck at full opacity over the real window
 * would be worse than no splash at all.
 */
export function closeSplash(): void {
  const win = splash
  splash = null
  if (!win || win.isDestroyed()) return

  let opacity = 1
  const timer = setInterval(() => {
    if (win.isDestroyed()) {
      clearInterval(timer)
      return
    }
    opacity -= FADE_STEP
    if (opacity <= 0) {
      clearInterval(timer)
      win.destroy()
      return
    }
    win.setOpacity(opacity)
  }, FADE_INTERVAL_MS)
}
