import { shell } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import * as db from './db'

/**
 * Launch a game detached, with the working directory set to the game folder.
 * Many doujin engines resolve their assets relative to cwd, so launching from
 * anywhere else silently breaks them.
 */
export function launchGame(id: string): { ok: boolean; error?: string } {
  const game = db.findGame(id)
  if (!game) return { ok: false, error: '找不到该游戏' }
  if (!game.exe) return { ok: false, error: '该条目没有可执行文件' }
  if (!fs.existsSync(game.exe)) return { ok: false, error: `主程序不存在：${game.exe}` }

  try {
    const child = spawn(game.exe, [], {
      cwd: path.dirname(game.exe),
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  db.updateGame(id, {
    lastLaunchedAt: Date.now(),
    launchCount: game.launchCount + 1
  })
  return { ok: true }
}

export function revealInExplorer(target: string): void {
  if (!fs.existsSync(target)) return
  if (fs.statSync(target).isDirectory()) {
    shell.openPath(target)
  } else {
    shell.showItemInFolder(target)
  }
}
