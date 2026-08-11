import fs from 'node:fs'
import path from 'node:path'
// Extension spelled out: the harnesses in scripts/ import this file straight into node,
// where nothing fills the extension in for them.
import type { ShareCandidate, ShareCategory } from '../shared/types.ts'

/**
 * Deciding what not to put in a shared copy of a game.
 *
 * Everything here is a *proposal*. Nothing is excluded without the user having seen it,
 * because the cost of a wrong guess is asymmetric: leaving a save in means sending
 * someone your playthrough, while taking the wrong file out means shipping a game that
 * does not start, and the second one is not discovered until the person on the other end
 * tries to run it.
 *
 * The rule that matters most is that a rule may never be a bare extension. `*.dat` is
 * the trap: it is a save file in one engine and the entire game in another — BGI and
 * Ethornell titles keep their script and assets in `.dat` files right in the game
 * folder. So every rule is bounded by *where* the file sits as well as what it is
 * called, and the extensions that are only ever game data are named as such and can
 * never be matched.
 *
 * No electron import: this module is pure so that `scripts/share-test.mts` can load it
 * directly under node's type stripping, the same arrangement `scan-core.ts` has.
 */

/**
 * Container formats. A file with one of these extensions is game data and is never a
 * candidate, whatever else it might look like.
 */
const GAME_DATA_EXT = new Set([
  '.xp3', // KiriKiri
  '.arc',
  '.pak',
  '.pck',
  '.rpa', // Ren'Py
  '.assets',
  '.bundle',
  '.vpk',
  '.wad',
  '.pac',
  '.afs',
  '.nsa',
  '.sar',
  '.ypf',
  '.pfs',
  '.int',
  '.cpz',
  '.med',
  '.noa',
  '.mrg'
])

/** Directory names that hold saved games, at any depth. */
const SAVE_DIRS = [
  'save',
  'saves',
  'savedata',
  'save_data',
  'savegame',
  'savegames',
  'savefile',
  'savefiles',
  'userdata',
  'user data',
  'profile',
  'profiles',
  'セーブ',
  'セーブデータ',
  'せーぶ',
  '存档',
  '存檔'
]

/** Directory names that are noise — never part of the game itself. */
const NOISE_DIRS = [
  'log',
  'logs',
  'crash',
  'crashes',
  'crashdumps',
  'dump',
  'dumps',
  'capture',
  'captures',
  'screenshot',
  'screenshots',
  'スクリーンショット',
  'キャプチャ',
  '截图',
  '__pycache__'
]

/** Save files, wherever they sit. These extensions are not used for game data. */
const SAVE_EXT = new Set(['.sav', '.save', '.svd', '.rvdata2', '.rvdata', '.rxdata', '.lsd'])

/** Save-ish extensions that only count *inside* a save directory. */
const SAVE_EXT_SCOPED = new Set(['.dat', '.bin', '.json', '.xml'])

/** Noise files, wherever they sit. */
const NOISE_EXT = new Set(['.log', '.dmp', '.tmp', '.temp', '.bak', '.old'])

const NOISE_NAMES = new Set(['thumbs.db', 'desktop.ini', '.ds_store', 'persistent'])

/** Settings that may hold a name or a window position — and may also be required. */
const CONFIG_EXT = new Set(['.ini', '.cfg', '.conf', '.config', '.xml', '.json'])
const CONFIG_NAMES = new Set(['config.dat', 'setup.dat', 'system.dat', 'option.dat'])

/** The launcher's own sidecar: playtime, rating, tags, every session ever recorded. */
const LAUNCHER_FILES = new Set(['sakura-launcher.md', 'sakura-launcher.txt'])

/**
 * A candidate bigger than this share of the folder is presumed to be misidentified game
 * data and is proposed unticked. Nobody's save file is a third of the install.
 */
const OVERSIZE_RATIO = 0.3

/** How deep to look. Saves are never twenty levels down, and neither is anything else. */
const MAX_DEPTH = 6

const lower = (s: string): string => s.toLowerCase()

function isSaveDir(name: string): boolean {
  return SAVE_DIRS.includes(lower(name))
}

function isNoiseDir(name: string): boolean {
  return NOISE_DIRS.includes(lower(name))
}

function dirSizeOf(dir: string): number {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile()) {
        try {
          total += fs.statSync(full).size
        } catch {
          /* unreadable file contributes nothing */
        }
      }
    }
  }
  return total
}

interface Match {
  category: ShareCategory
  reason: string
}

/**
 * Judge one file. `insideSave` says whether an ancestor directory was already a save
 * folder, which is what licenses the scoped extensions.
 */
function judgeFile(name: string, depth: number, insideSave: boolean): Match | null {
  const lowered = lower(name)
  const ext = path.extname(lowered)

  if (LAUNCHER_FILES.has(lowered)) {
    return { category: 'launcher', reason: '启动器写的说明文件，含游玩时长、评分与游玩记录' }
  }

  // Never a candidate, no matter what other rule might reach for it.
  if (GAME_DATA_EXT.has(ext)) return null

  if (SAVE_EXT.has(ext)) return { category: 'save', reason: `存档文件（${ext}）` }
  if (insideSave && SAVE_EXT_SCOPED.has(ext)) {
    return { category: 'save', reason: `存档目录里的 ${ext} 文件` }
  }
  // NScripter and KiriKiri drop save1.dat, save2.dat… straight in the game folder.
  if (depth === 0 && /^save\d*\.(dat|bin)$/.test(lowered)) {
    return { category: 'save', reason: '游戏根目录下的存档文件' }
  }

  if (NOISE_NAMES.has(lowered)) return { category: 'noise', reason: '系统或引擎生成的杂项文件' }
  if (NOISE_EXT.has(ext)) return { category: 'noise', reason: `日志或临时文件（${ext}）` }

  // Config only counts at the top level: deeper down these are far more often data.
  if (depth === 0 && (CONFIG_NAMES.has(lowered) || CONFIG_EXT.has(ext))) {
    return { category: 'config', reason: '设置文件，可能存了你的用户名或窗口位置' }
  }

  return null
}

/**
 * Walk a game folder and propose what should stay out of a shared copy.
 *
 * A matched directory is reported whole and not descended into — excluding the folder
 * takes its subtree with it, and listing forty save slots individually would bury the
 * one line the user actually needs to read.
 */
export function scanPersonalData(gameDir: string): ShareCandidate[] {
  const found: ShareCandidate[] = []

  const walk = (dir: string, depth: number, insideSave: boolean): void => {
    if (depth > MAX_DEPTH) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const rel = path.relative(gameDir, full)

      if (entry.isDirectory()) {
        const save = isSaveDir(entry.name)
        const noise = isNoiseDir(entry.name)
        if (save || noise) {
          found.push({
            path: full,
            rel,
            isDir: true,
            sizeBytes: dirSizeOf(full),
            category: save ? 'save' : 'noise',
            reason: save ? '存档目录' : '日志、崩溃转储或截图目录',
            checked: true
          })
          // Reported whole; no need to look inside.
          continue
        }
        walk(full, depth + 1, insideSave)
        continue
      }

      if (!entry.isFile()) continue
      const match = judgeFile(entry.name, depth, insideSave)
      if (!match) continue
      let size = 0
      try {
        size = fs.statSync(full).size
      } catch {
        /* unreadable file still gets offered */
      }
      found.push({
        path: full,
        rel,
        isDir: false,
        sizeBytes: size,
        category: match.category,
        reason: match.reason,
        checked: match.category !== 'config'
      })
    }
  }

  walk(gameDir, 0, false)

  // A candidate that accounts for a large share of the folder is far more likely to be
  // game data caught by a rule than it is to be personal. Offer it, but not ticked.
  // Measured against the folder as a whole, which already counts the candidates.
  const total = dirSizeOf(gameDir)
  if (total > 0) {
    for (const candidate of found) {
      // Never the launcher's own file: the guard is for rules that may have caught game
      // data by mistake, and this is the one file we know the provenance of exactly.
      if (candidate.category === 'launcher') continue
      if (candidate.sizeBytes / total > OVERSIZE_RATIO) {
        candidate.oversized = true
        candidate.checked = false
      }
    }
  }

  return found.sort((a, b) => a.rel.localeCompare(b.rel, 'zh-CN'))
}

/** Strip what Windows will not accept in a file name. */
export function sanitizeArchiveName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
}
