import { shell } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { DownloaderKey, MultiArchiveNotice, PendingDownload } from '../shared/types'
import { downloadDirFor } from '../shared/types'
import { defaultDestFor, extractArchive } from './archive'
import * as db from './db'
import { t } from './i18n'
import {
  archiveSets,
  buildCommand,
  checkUrl,
  disownFiles,
  firstVolumeOf,
  listFiles,
  newWatchState,
  parseAria2Percent,
  pollFolder,
  type WatchState
} from './download-core'
import { importFolder, rescan } from './scanner'

/**
 * Seeing a download through from a pasted link to a tile in the library.
 *
 * The awkward part is knowing when the download ended. Only aria2 is a child of ours;
 * IDM, the system handler and any custom command hand the work to a program that
 * outlives the call and reports nothing back. For those the destination folder is
 * watched until a file arrives and stops changing — see `pollFolder`.
 */

const POLL_MS = 2000

/** Give up watching after this long, rather than leaving a timer running forever. */
const WATCH_TIMEOUT_MS = 12 * 60 * 60 * 1000

const IDM_FALLBACKS = [
  'C:\\Program Files (x86)\\Internet Download Manager\\IDMan.exe',
  'C:\\Program Files\\Internet Download Manager\\IDMan.exe'
]

interface Live {
  state: WatchState
  /** The folder being watched. Kept here so a settling job can find its neighbours. */
  dir: string
  child?: ChildProcess
  cancelExtract?: () => void
}

const live = new Map<string, Live>()
let timer: NodeJS.Timeout | null = null
let notify: (() => void) | null = null

let notifyMultiArchive: ((notice: MultiArchiveNotice) => void) | null = null

export function onDownloadsChanged(fn: () => void): void {
  notify = fn
}

/** Told when a download turns out to be several archives — see `MultiArchiveNotice`. */
export function onMultiArchive(fn: (notice: MultiArchiveNotice) => void): void {
  notifyMultiArchive = fn
}

function emit(): void {
  notify?.()
}

function update(id: string, patch: Partial<PendingDownload>): PendingDownload | null {
  const current = db.getDownloads().find((d) => d.id === id)
  if (!current) return null
  const next = { ...current, ...patch }
  db.upsertDownload(next)
  emit()
  return next
}

/* ---------- locating the downloader ---------- */

function registryValue(key: string, name: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', key, '/v', name],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null)
        // `    ExePath    REG_SZ    C:\...\IDMan.exe`
        const m = new RegExp(`${name}\\s+REG_[A-Z_]+\\s+(.+)`, 'i').exec(stdout)
        const value = m?.[1]?.trim()
        resolve(value ? value : null)
      }
    )
  })
}

/** Where IDM lives, or null if it is not installed. Never throws. */
export async function detectDownloader(key: DownloaderKey): Promise<string | null> {
  if (key !== 'idm') return null
  const fromRegistry = await registryValue('HKCU\\Software\\DownloadManager', 'ExePath')
  if (fromRegistry && fs.existsSync(fromRegistry)) return fromRegistry
  return IDM_FALLBACKS.find((p) => fs.existsSync(p)) ?? null
}

/* ---------- starting ---------- */

export interface StartResult {
  ok: boolean
  id?: string
  error?: string
}

/**
 * @param intoDir overrides the configured folder for this one download — the dialog
 *   lets the destination be changed per job without rewriting the default.
 */
export async function startDownload(rawUrl: string, intoDir?: string): Promise<StartResult> {
  const check = checkUrl(rawUrl)
  if (!check.ok || !check.url) return { ok: false, error: check.error }

  const settings = db.getSettings()
  const dir = intoDir?.trim() || downloadDirFor(settings)
  if (!dir) return { ok: false, error: t('dlerr.noDir') }
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    return {
      ok: false,
      error: t('dlerr.cantCreateDir', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  const key = settings.downloader
  let exePath = settings.downloaderPath
  // IDM can find itself, so a fresh install works without visiting settings first.
  if (!exePath && key === 'idm') exePath = await detectDownloader('idm')

  const job = { url: check.url, dir, name: check.name ?? '' }
  const command = buildCommand(key, exePath, settings.downloaderArgs, job)
  if (!command && key !== 'system') {
    return {
      ok: false,
      error: key === 'idm' ? t('dlerr.noIdm') : t('dlerr.noDownloader')
    }
  }

  const entry: PendingDownload = {
    id: `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    url: check.url,
    dir,
    downloader: key,
    baseline: listFiles(dir).map((f) => f.name),
    startedAt: Date.now(),
    status: 'downloading',
    percent: null
  }
  db.upsertDownload(entry)
  emit()

  try {
    launch(entry, command)
  } catch (err) {
    update(entry.id, {
      status: 'failed',
      message: err instanceof Error ? err.message : String(err)
    })
    return { ok: false, error: t('dlerr.cantStart') }
  }
  return { ok: true, id: entry.id }
}

function launch(entry: PendingDownload, command: { exe: string; args: string[] } | null): void {
  const handle: Live = { state: newWatchState(entry.baseline), dir: entry.dir }
  live.set(entry.id, handle)

  if (!command) {
    // System handler: no process of ours, and no say in where it saves.
    void shell.openExternal(entry.url)
    startTimer()
    return
  }

  // No `shell: true` anywhere: arguments stay separate values, so nothing inside a URL
  // can be read as another flag.
  const child = spawn(command.exe, command.args, { windowsHide: true, detached: false })
  handle.child = child

  if (entry.downloader === 'aria2') {
    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => {
      const pct = parseAria2Percent(chunk)
      if (pct !== null) update(entry.id, { percent: pct })
    })
    let stderr = ''
    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (err) => update(entry.id, { status: 'failed', message: err.message }))
    child.on('close', (code) => {
      handle.child = undefined
      if (code === 0) {
        // aria2 told us it is done, so take the folder's word for what it produced
        // rather than waiting out the stability window.
        settle(entry.id, true)
      } else {
        update(entry.id, { status: 'failed', message: stderr.trim() || t('dlerr.aria2Exit', { code: String(code) }) })
        live.delete(entry.id)
      }
    })
    return
  }

  // IDM and custom commands hand off and exit; only the folder can tell us anything.
  child.on('error', (err) => update(entry.id, { status: 'failed', message: err.message }))
  child.on('close', (code) => {
    handle.child = undefined
    // IDM's launcher exits the moment it has passed the job to the resident process, so
    // its exit code says nothing about the download. A custom command is the download,
    // so a failure there is worth reporting instead of watching a folder for 12 hours.
    if (code !== 0 && entry.downloader === 'custom') {
      const still = db.getDownloads().find((d) => d.id === entry.id)
      if (still?.status === 'downloading') {
        update(entry.id, { status: 'failed', message: t('dlerr.exit', { code: String(code) }) })
        live.delete(entry.id)
      }
    }
  })
  startTimer()
}

/* ---------- watching ---------- */

function startTimer(): void {
  if (timer) return
  timer = setInterval(tick, POLL_MS)
}

/**
 * The timer runs while any job is still being followed.
 *
 * Deliberately not keyed on whether a child process is alive: IDM and a custom command
 * are both spawned by us and both exit almost immediately — IDM because it hands the
 * job to its resident process, curl and friends because they are simply done — and the
 * folder still has to be watched afterwards either way.
 */
function stopTimerIfIdle(): void {
  const watching = db.getDownloads().some((d) => d.status === 'downloading' && live.has(d.id))
  if (watching || !timer) return
  clearInterval(timer)
  timer = null
}

function tick(): void {
  for (const entry of db.getDownloads()) {
    if (entry.status !== 'downloading') continue
    const handle = live.get(entry.id)
    if (!handle) continue
    // aria2 reports for itself; its exit is the signal, not the folder.
    if (handle.child && entry.downloader === 'aria2') continue

    if (Date.now() - entry.startedAt > WATCH_TIMEOUT_MS) {
      update(entry.id, { status: 'failed', message: t('dlerr.timeout') })
      live.delete(entry.id)
      continue
    }

    const verdict = pollFolder(handle.state, listFiles(entry.dir))
    if (verdict.done.length > 0) settle(entry.id, false)
  }
  stopTimerIfIdle()
}

/* ---------- keeping concurrent jobs out of each other's way ---------- */

function sameFolder(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
}

/** Tell every other watcher on this folder that these files are already spoken for. */
function claimFiles(owner: string, dir: string, names: string[]): void {
  for (const [otherId, other] of live) {
    if (otherId === owner || !sameFolder(other.dir, dir)) continue
    disownFiles(other.state, names)
  }
}

/** Destination folders one of our 7-Zips is writing into right now. */
const extractingInto = new Set<string>()

function destKey(dir: string): string {
  return path.resolve(dir).toLowerCase()
}

/**
 * A destination no extraction of ours is already writing into.
 *
 * Two archives in one folder can name the same default target — `game.zip` and
 * `game.7z` both reduce to `game` — and two 7-Zips over one tree is not a race that
 * ends well: each deletes files the other has open and both report every entry failed.
 * Different archives get different folders instead. This says nothing about a folder
 * that merely already exists on disk; extracting into one of those is the normal case.
 */
function freeDestFor(firstVolume: string): string {
  const base = defaultDestFor(firstVolume)
  // Terminates: the set is finite, so one of the first `size + 1` suffixes is free.
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base} (${n})`
    if (!extractingInto.has(destKey(candidate))) return candidate
  }
}

/** A download has produced its files; take it the rest of the way. */
function settle(id: string, trustProcess: boolean): void {
  const entry = db.getDownloads().find((d) => d.id === id)
  const handle = live.get(id)
  if (!entry || !handle) return

  const verdict = pollFolder(handle.state, listFiles(entry.dir))
  let files = verdict.done
  // Every archive set that landed, not just the one `done` narrowed to — deciding
  // whether narrowing was defensible needs the ones it dropped.
  let sets = verdict.sets ?? []
  if (files.length === 0 && trustProcess) {
    // The process said it finished, so whatever is new in the folder is the result —
    // the stability counter has not had time to run yet. The watcher's baseline, not
    // the entry's: that is the one carrying what a neighbouring job has claimed.
    files = listFiles(entry.dir)
      .map((f) => f.name)
      .filter((n) => !handle.state.baseline.has(n))
      .sort()
    sets = archiveSets(files)
  }
  if (files.length === 0) return

  // Several unrelated archives, not one split set. Which of them is the game — and
  // whether the rest are patches, appendices or a second release entirely — is a
  // question about the contents, and nothing here has read them. Extracting the
  // largest and calling the job done was a guess, and a silent one.
  if (sets.length > 1) {
    const all = sets.flat()
    claimFiles(id, entry.dir, all)
    update(id, {
      status: 'done',
      percent: 100,
      volumes: all.map((f) => path.join(entry.dir, f)),
      message: t('dl.multiSetNote', { n: String(sets.length) })
    })
    notifyMultiArchive?.({
      dir: entry.dir,
      sets: sets.map((set) => ({ name: set[0], volumes: set.length }))
    })
    live.delete(id)
    return
  }

  // Claim them before anything else can: `tick` walks the jobs in one pass, so a
  // neighbour polled later in this same pass must already see these as not its own.
  claimFiles(id, entry.dir, files)

  const first = firstVolumeOf(files)
  if (!first) {
    // Not an archive — a bare installer, say. Nothing to extract, and guessing would
    // do more harm than leaving it where the user can see it.
    update(id, {
      status: 'done',
      percent: 100,
      volumes: files,
      message: t('dlerr.notArchive', { name: files[0] })
    })
    live.delete(id)
    return
  }

  const volumes = files.map((f) => path.join(entry.dir, f))
  const firstPath = path.join(entry.dir, first)
  update(id, { status: 'extracting', percent: 0, volumes })

  const destDir = freeDestFor(firstPath)
  const held = destKey(destDir)
  extractingInto.add(held)

  const extract = extractArchive(
    firstPath,
    destDir,
    (percent) => update(id, { percent }),
    (result) => {
      extractingInto.delete(held)
      handle.cancelExtract = undefined
      if (!result.ok) {
        update(id, { status: 'failed', message: result.error ?? t('dlerr.extractFailed') })
        live.delete(id)
        return
      }
      void finishImport(id, entry, result.destDir, volumes)
    }
  )
  handle.cancelExtract = extract?.cancel
}

async function finishImport(
  id: string,
  entry: PendingDownload,
  destDir: string,
  volumes: string[]
): Promise<void> {
  update(id, { status: 'importing', percent: null })

  const settings = db.getSettings()
  const inLibrary = settings.roots.some(
    (root) => entry.dir === root || entry.dir.toLowerCase().startsWith(root.toLowerCase() + path.sep)
  )

  let added = 0
  try {
    if (inLibrary) {
      // Already inside a scan root — a scan of what we just extracted sees it, keeps
      // every user field, and needs no decision from us about what counts as a game.
      const before = db.getGames().length
      rescan({ discoverIn: [destDir] })
      added = db.getGames().length - before
    } else {
      // importFolder also adds the folder to the scan roots, which is what we want:
      // a folder chosen to download into is a folder new games will keep arriving in.
      const outcome = importFolder(entry.dir, [destDir], [])
      added = outcome.added
    }
  } catch (err) {
    update(id, { status: 'failed', message: err instanceof Error ? err.message : String(err) })
    live.delete(id)
    return
  }

  let note = added > 0 ? t('dl.importedN', { n: added }) : t('dl.noneRecognised')
  if (settings.trashArchiveAfterExtract) {
    try {
      for (const volume of volumes) await shell.trashItem(volume)
      note += t('dl.archiveTrashed')
    } catch {
      note += t('dl.archiveNotTrashed')
    }
  }
  if (!inLibrary) note += t('dl.dirAdded')

  update(id, { status: 'done', percent: 100, message: note })
  live.delete(id)
}

/* ---------- lifecycle ---------- */

export function cancelDownload(id: string): void {
  const handle = live.get(id)
  handle?.child?.kill()
  handle?.cancelExtract?.()
  live.delete(id)
  db.removeDownload(id)
  emit()
}

/** Drop finished and failed entries; the active ones stay. */
export function clearFinishedDownloads(): void {
  db.setDownloads(db.getDownloads().filter((d) => d.status !== 'done' && d.status !== 'failed'))
  emit()
}

/**
 * Pick up where a previous run left off.
 *
 * A download that was still running when the app closed kept going — it belongs to
 * another process — so the folder is watched again rather than the job restarted. An
 * extract that was interrupted has no such luck and is marked failed, since half an
 * archive on disk is worse than an honest error.
 *
 * A resumed watcher also inherits the claims: a job that settled during the last run
 * left its archive sitting in the folder, and it is not in the baseline of a job that
 * started before it landed.
 */
export function resumeDownloads(): void {
  let touched = false
  const all = db.getDownloads()
  for (const entry of all) {
    if (entry.status === 'downloading') {
      const state = newWatchState(entry.baseline)
      for (const other of all) {
        if (other.id === entry.id || !other.volumes || !sameFolder(other.dir, entry.dir)) continue
        disownFiles(state, other.volumes.map((v) => path.basename(v)))
      }
      live.set(entry.id, { state, dir: entry.dir })
      touched = true
    } else if (entry.status === 'extracting' || entry.status === 'importing') {
      db.upsertDownload({ ...entry, status: 'failed', message: t('dlerr.interrupted') })
      touched = true
    }
  }
  if (live.size > 0) startTimer()
  if (touched) emit()
}

export function shutdownDownloads(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  for (const handle of live.values()) handle.cancelExtract?.()
}
