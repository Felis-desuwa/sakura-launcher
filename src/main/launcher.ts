import { shell } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import * as db from './db'
import { beginSession } from './playtime'

/**
 * Launch a game detached, with the working directory set to the game folder.
 * Many doujin engines resolve their assets relative to cwd, so launching from
 * anywhere else silently breaks them.
 *
 * Arguments recorded from a dropped shortcut are passed through. Without them a
 * launcher-based entry starts the launcher and stops there — `steam.exe` with no
 * `-applaunch` just brings Steam to the front, which reads as "it said it started
 * and nothing happened".
 */
export function launchGame(id: string): { ok: boolean; error?: string } {
  const game = db.findGame(id)
  if (!game) return { ok: false, error: '找不到该游戏' }
  if (!game.exe) return { ok: false, error: '该条目没有可执行文件' }
  if (!fs.existsSync(game.exe)) return { ok: false, error: `主程序不存在：${game.exe}` }

  const cwd =
    game.launchCwd && fs.existsSync(game.launchCwd) ? game.launchCwd : path.dirname(game.exe)

  try {
    const child = spawn(game.exe, game.launchArgs ?? [], {
      cwd,
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  // Opens the play session, which is what bumps lastLaunchedAt and launchCount —
  // and closes it again once the game is gone, recording how long it ran.
  beginSession(game)
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
