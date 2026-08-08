import fs from 'node:fs'
import path from 'node:path'
// Extensions spelled out: the harness in scripts/ imports this file straight into node,
// where nothing fills them in — the same reason scan-core.ts does it.
import type { DownloaderKey } from '../shared/types.ts'
import { ALLOWED_URL_PROTOCOLS } from '../shared/types.ts'
import { archiveBaseName, isArchiveFile } from './scan-core.ts'

/**
 * The parts of downloading that are pure Node, so they can be exercised from a CLI
 * harness without an Electron window: which links we accept, what command line each
 * downloader gets, and when a folder has stopped receiving a download.
 */

export interface UrlCheck {
  ok: boolean
  /** Present when ok — the parsed URL, normalised. */
  url?: string
  /** A filename to suggest to the downloader, when one can be read off the path. */
  name?: string
  error?: string
}

/**
 * Accept only links we are willing to hand to another program.
 *
 * This is a feature limit — IDM does not do magnet links — but it is also the security
 * boundary. Everything downstream passes this string to an external executable, and the
 * narrow protocol list means a crafted `file:` or `javascript:` URL never gets there.
 */
export function checkUrl(raw: string): UrlCheck {
  const text = raw.trim()
  if (!text) return { ok: false, error: '链接为空' }

  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return { ok: false, error: '不是有效的链接' }
  }

  if (!ALLOWED_URL_PROTOCOLS.includes(parsed.protocol)) {
    return {
      ok: false,
      error: `不支持 ${parsed.protocol} 链接，只接受 http / https / ftp 直链`
    }
  }

  // A name is a nicety, not a requirement: plenty of links end in a script path and
  // let the server name the file in a header.
  let name: string | undefined
  try {
    const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '')
    if (last && /\.[a-z0-9]{1,8}$/i.test(last) && !/[\\/:*?"<>|]/.test(last)) name = last
  } catch {
    /* percent-decoding failed; no name, which is fine */
  }

  return { ok: true, url: parsed.toString(), name }
}

export interface Command {
  exe: string
  args: string[]
}

const PLACEHOLDER = /\{(url|dir|name)\}/g

/**
 * Fill `{url}` / `{dir}` / `{name}` in a custom argument template.
 *
 * The template is split into arguments *first* and substituted *after*, so a value can
 * never introduce an argument boundary. Combined with never passing `shell: true`, that
 * is what stops a link like `http://x/?a=b" --evil` from turning into a second flag.
 */
export function buildCustomArgs(
  template: string,
  values: { url: string; dir: string; name: string }
): string[] {
  return template
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(PLACEHOLDER, (_, key: 'url' | 'dir' | 'name') => values[key]))
}

/** The command line for one downloader, or null when it cannot be run as a process. */
export function buildCommand(
  downloader: DownloaderKey,
  exePath: string | null,
  argsTemplate: string,
  job: { url: string; dir: string; name: string }
): Command | null {
  switch (downloader) {
    case 'idm':
      if (!exePath) return null
      // /n suppresses IDM's own dialogs; /p sets the folder, /f the file name.
      return {
        exe: exePath,
        args: ['/d', job.url, '/p', job.dir, ...(job.name ? ['/f', job.name] : []), '/n']
      }
    case 'aria2':
      if (!exePath) return null
      return {
        exe: exePath,
        args: [
          '-d',
          job.dir,
          ...(job.name ? ['-o', job.name] : []),
          '--summary-interval=1',
          '--console-log-level=warn',
          '--auto-file-renaming=true',
          job.url
        ]
      }
    case 'custom':
      if (!exePath) return null
      return { exe: exePath, args: buildCustomArgs(argsTemplate, job) }
    case 'system':
      // Handed to the shell instead; there is no command of our own.
      return null
  }
}

/** aria2 prints `[#1a2b3c 4.5MiB/90MiB(5%) CN:1 DL:1.2MiB]`; take the last percentage. */
export function parseAria2Percent(chunk: string): number | null {
  const matches = chunk.match(/\((\d{1,3})%\)/g)
  if (!matches || matches.length === 0) return null
  const last = /(\d{1,3})/.exec(matches[matches.length - 1])
  if (!last) return null
  const pct = Number(last[1])
  return Number.isFinite(pct) ? Math.min(100, pct) : null
}

/** Suffixes downloaders use while a file is still being written. */
const IN_PROGRESS = /\.(tmp|part|partial|crdownload|aria2|td|!ut|downloading|bc!|dl)$/i

export function isInProgressFile(name: string): boolean {
  return IN_PROGRESS.test(name)
}

export interface FolderEntry {
  name: string
  size: number
  mtimeMs: number
}

export function listFiles(dir: string): FolderEntry[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const stat = fs.statSync(path.join(dir, e.name))
        return { name: e.name, size: stat.size, mtimeMs: stat.mtimeMs }
      })
  } catch {
    return []
  }
}

export interface WatchState {
  /** Names present before the download started; never ours. */
  baseline: Set<string>
  /** How many consecutive polls each candidate has looked identical. */
  stable: Map<string, { size: number; mtimeMs: number; ticks: number }>
}

export interface WatchVerdict {
  /** Files that have arrived and stopped changing. Empty until the set is complete. */
  done: string[]
  /** Something is being written right now. */
  active: boolean
}

/** Consecutive identical polls before a file counts as finished. */
export const STABLE_TICKS = 3

/**
 * Decide whether a download has landed, from one poll of the destination folder.
 *
 * Polling rather than `fs.watch`: IDM downloads into its own temp directory and *moves*
 * the finished file into place, and `fs.watch` misses moves on some Windows volumes. It
 * also reports no size, which is the only way to tell "arrived" from "still arriving".
 *
 * A multi-volume set has to arrive whole. Volumes are grouped by the same base-name rule
 * the scanner uses, and a group only counts as done when every one of its members has
 * been stable for a full window — so a set still gaining `.002` never fires early.
 */
export function pollFolder(state: WatchState, entries: FolderEntry[]): WatchVerdict {
  const fresh = entries.filter((e) => !state.baseline.has(e.name))
  const pending = fresh.filter((e) => isInProgressFile(e.name))

  for (const entry of fresh) {
    if (isInProgressFile(entry.name)) continue
    const seen = state.stable.get(entry.name)
    if (seen && seen.size === entry.size && seen.mtimeMs === entry.mtimeMs) seen.ticks += 1
    else state.stable.set(entry.name, { size: entry.size, mtimeMs: entry.mtimeMs, ticks: 1 })
  }

  // Anything that vanished (a temp file renamed into place) should not linger.
  const present = new Set(fresh.map((e) => e.name))
  for (const name of [...state.stable.keys()]) {
    if (!present.has(name)) state.stable.delete(name)
  }

  const settled = [...state.stable.entries()]
    .filter(([, v]) => v.ticks >= STABLE_TICKS)
    .map(([name]) => name)

  const active = pending.length > 0 || settled.length < state.stable.size
  if (settled.length === 0 || active) return { done: [], active: true }

  // Every settled archive volume must belong to a group that is entirely settled.
  const archives = settled.filter(isArchiveFile)
  if (archives.length === 0) return { done: settled.sort(), active: false }

  const groups = new Map<string, string[]>()
  for (const name of archives) {
    const key = archiveBaseName(name) as string
    groups.set(key, [...(groups.get(key) ?? []), name])
  }
  // The largest group wins: a download is one logical archive, and anything else that
  // happened to land in a shared folder meanwhile is not ours to extract.
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0]
  return { done: best.sort(), active: false }
}

export function newWatchState(baseline: string[]): WatchState {
  return { baseline: new Set(baseline), stable: new Map() }
}

/** The volume 7-Zip should be pointed at: the first part of a split set. */
export function firstVolumeOf(names: string[]): string | null {
  const archives = names.filter(isArchiveFile).sort()
  return archives[0] ?? null
}
