import { BrowserWindow } from 'electron'
import { t } from './i18n'
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

/**
 * Once on screen, the splash stays at least this long.
 *
 * A library that loads in 200 ms used to produce a blink — and worse, the fade could begin
 * before the window had painted, so what actually reached the screen was a half-transparent
 * ghost of a window. A flash of something half-drawn reads as a glitch, which is precisely
 * the opposite of the reassurance this window exists to give.
 */
const MIN_VISIBLE_MS = 600

let splash: BrowserWindow | null = null
/** Stage text that arrived before the page could receive it. */
let pendingStage: string | null = null
let loaded = false
/** When the window actually reached the screen. Null until then. */
let shownAt: number | null = null
/** Close was asked for. Kept separate from `splash` so a late paint cannot revive it. */
let closing = false

/**
 * Put the splash on screen. Call this before anything else at startup — every line that
 * runs first is a line the user spends staring at an empty desktop.
 */
export function showSplash(): void {
  if (splash) return
  loaded = false
  pendingStage = null
  shownAt = null
  closing = false

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
    // If the library was already in hand before the splash finished painting, showing it
    // now would put a window on screen for one frame purely to take it away again.
    if (closing || win.isDestroyed()) return
    shownAt = Date.now()
    win.show()
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

  void win.loadURL(
    'data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml(t('splash.preparing')))
  )
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
  closing = true
  if (!win || win.isDestroyed()) return

  // Never shown: the app got there first. Take it away without ever putting it up —
  // the `ready-to-show` handler checks `closing` and will not raise it either.
  if (shownAt === null) {
    win.destroy()
    return
  }

  // Shown, but only just. Let it finish being a window before it starts being a fade.
  const owed = MIN_VISIBLE_MS - (Date.now() - shownAt)
  if (owed > 0) {
    setTimeout(() => fadeOut(win), owed)
    return
  }
  fadeOut(win)
}

function fadeOut(win: BrowserWindow): void {
  if (win.isDestroyed()) return

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
