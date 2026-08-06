import { shell } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import * as db from './db'
import { dirSize } from './scan-core'

const UNINSTALLER_RE = /^(unins.*|uninstall.*|卸载.*)\.exe$/i

const GEEK_CANDIDATES = [
  'C:\\Program Files\\Geek\\geek.exe',
  'C:\\Program Files (x86)\\Geek\\geek.exe',
  'C:\\Program Files\\Geek Uninstaller\\geek.exe',
  'C:\\Program Files (x86)\\Geek Uninstaller\\geek.exe'
]

export type UninstallMethod = 'uninstaller' | 'geek' | 'trash'

export interface UninstallPlan {
  method: UninstallMethod
  /** The uninstaller or Geek executable that will be run, when applicable. */
  tool?: string
  sizeBytes: number
}

/** Search shallowly — a deep search would find bundled tool uninstallers, not the game's. */
function findUninstaller(dir: string, depth = 0): string | null {
  if (depth > 2) return null
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    if (e.isFile() && UNINSTALLER_RE.test(e.name)) return path.join(dir, e.name)
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const found = findUninstaller(path.join(dir, e.name), depth + 1)
    if (found) return found
  }
  return null
}

export function findGeek(): string | null {
  const configured = db.getSettings().geekPath
  if (configured && fs.existsSync(configured)) return configured
  for (const c of GEEK_CANDIDATES) {
    if (fs.existsSync(c)) return c
  }
  return null
}

/**
 * Work out how a game would be removed, without doing anything yet.
 * Priority: the game's own uninstaller, then Geek, then the recycle bin.
 */
export function planUninstall(id: string): UninstallPlan | null {
  const game = db.findGame(id)
  if (!game) return null

  const sizeBytes = game.sizeBytes ?? (fs.existsSync(game.dir) ? dirSize(game.dir) : 0)

  if (game.kind === 'installed') {
    const tool = findUninstaller(game.dir)
    if (tool) return { method: 'uninstaller', tool, sizeBytes }
    const geek = findGeek()
    if (geek) return { method: 'geek', tool: geek, sizeBytes }
  }
  return { method: 'trash', sizeBytes }
}

export interface UninstallResult {
  ok: boolean
  method: UninstallMethod
  /** Bytes still on disk after an external uninstaller ran. */
  leftoverBytes?: number
  error?: string
}

async function trash(target: string): Promise<void> {
  await shell.trashItem(target)
}

export async function performUninstall(id: string): Promise<UninstallResult> {
  const game = db.findGame(id)
  if (!game) return { ok: false, method: 'trash', error: '找不到该游戏' }

  const plan = planUninstall(id)
  if (!plan) return { ok: false, method: 'trash', error: '无法确定卸载方式' }

  // Archive entries are just files on disk — always the recycle bin.
  if (game.kind === 'archive') {
    try {
      for (const vol of game.archiveVolumes ?? [game.dir]) {
        if (fs.existsSync(vol)) await trash(vol)
      }
      db.removeGame(id)
      return { ok: true, method: 'trash' }
    } catch (err) {
      return {
        ok: false,
        method: 'trash',
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  if (plan.method === 'uninstaller' || plan.method === 'geek') {
    const tool = plan.tool!
    const args = plan.method === 'geek' ? [game.dir] : []
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(tool, args, { cwd: path.dirname(tool) }, (err) => {
          // A non-zero exit usually means the user cancelled the uninstaller;
          // that is not an error we should surface as a failure.
          if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') reject(err)
          else resolve()
        })
      })
    } catch (err) {
      return {
        ok: false,
        method: plan.method,
        error: err instanceof Error ? err.message : String(err)
      }
    }

    const leftoverBytes = fs.existsSync(game.dir) ? dirSize(game.dir) : 0
    if (leftoverBytes === 0) db.removeGame(id)
    return { ok: true, method: plan.method, leftoverBytes }
  }

  try {
    if (fs.existsSync(game.dir)) await trash(game.dir)
    db.removeGame(id)
    return { ok: true, method: 'trash' }
  } catch (err) {
    return {
      ok: false,
      method: 'trash',
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/** Clean up what an external uninstaller left behind, once the user confirms. */
export async function trashLeftovers(id: string): Promise<UninstallResult> {
  const game = db.findGame(id)
  if (!game) return { ok: false, method: 'trash', error: '找不到该游戏' }
  try {
    if (fs.existsSync(game.dir)) await trash(game.dir)
    db.removeGame(id)
    return { ok: true, method: 'trash' }
  } catch (err) {
    return { ok: false, method: 'trash', error: err instanceof Error ? err.message : String(err) }
  }
}
