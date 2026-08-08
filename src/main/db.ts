import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Database, Game, Group, PendingDownload, Settings } from '../shared/types'
import { DEFAULT_SETTINGS, GAME_DEFAULTS, MAX_REMOVED } from '../shared/types'

const DB_VERSION = 2

let dataDir = ''
let dbPath = ''
let cache: Database | null = null
let writeTimer: NodeJS.Timeout | null = null

export function initPaths(): void {
  dataDir = app.getPath('userData')
  dbPath = path.join(dataDir, 'db.json')
  fs.mkdirSync(iconCacheDir(), { recursive: true })
  fs.mkdirSync(breakdownCacheDir(), { recursive: true })
  fs.mkdirSync(coverDir(), { recursive: true })
}

export function iconCacheDir(): string {
  return path.join(dataDir, 'cache', 'icons')
}

export function breakdownCacheDir(): string {
  return path.join(dataDir, 'cache', 'breakdown')
}

/** User-supplied cover images are copied here so the library keeps working if the source moves. */
export function coverDir(): string {
  return path.join(dataDir, 'covers')
}

function empty(): Database {
  return {
    version: DB_VERSION,
    games: [],
    groups: [],
    settings: { ...DEFAULT_SETTINGS },
    downloads: [],
    removed: []
  }
}

/**
 * Fill in fields a database written by an older version does not have.
 * Settings have always been merged against their defaults; games were not, so a
 * field added later arrived as `undefined` and quietly poisoned anything that did
 * arithmetic on it — `a.tierOrder - b.tierOrder` sorting to NaN, for one.
 */
function normalizeGame(raw: Game): Game {
  const game = { ...GAME_DEFAULTS, ...raw } as Game
  if (!Array.isArray(game.tags)) game.tags = []
  if (!Array.isArray(game.sessions)) game.sessions = []
  if (typeof game.playtimeMs !== 'number' || !isFinite(game.playtimeMs)) game.playtimeMs = 0
  if (typeof game.tierOrder !== 'number' || !isFinite(game.tierOrder)) game.tierOrder = 0
  if (typeof game.order !== 'number' || !isFinite(game.order)) game.order = 0
  if (typeof game.rating !== 'number') game.rating = null
  return game
}

export function load(): Database {
  if (cache) return cache
  try {
    // Strip a UTF-8 BOM: JSON.parse rejects it, and editors on Windows add one freely.
    const raw = fs.readFileSync(dbPath, 'utf-8').replace(/^﻿/, '')
    const parsed = JSON.parse(raw) as Database
    cache = {
      version: DB_VERSION,
      games: Array.isArray(parsed.games) ? parsed.games.map(normalizeGame) : [],
      groups: Array.isArray(parsed.groups) ? parsed.groups : [],
      // Merge so settings added in later versions get their defaults.
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
      downloads: Array.isArray(parsed.downloads) ? parsed.downloads : [],
      removed: Array.isArray(parsed.removed) ? parsed.removed.map(normalizeGame) : []
    }
  } catch {
    cache = empty()
  }
  return cache
}

function writeNow(): void {
  if (!cache) return
  const tmp = dbPath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf-8')
  fs.renameSync(tmp, dbPath)
}

/** Debounced so drag-reorder and toggle spam don't thrash the disk. */
export function save(): void {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    writeTimer = null
    try {
      writeNow()
    } catch {
      /* keep the in-memory state; next save retries */
    }
  }, 300)
}

/**
 * Write immediately, cancelling any pending debounce. Used for changes worth
 * losing nothing over — a finished play session, a completed scan — and on quit.
 */
export function saveNow(): void {
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  try {
    writeNow()
  } catch {
    /* nothing useful to do while quitting */
  }
}

export const flush = saveNow

export function getSettings(): Settings {
  return load().settings
}

export function setSettings(patch: Partial<Settings>): Settings {
  const db = load()
  db.settings = { ...db.settings, ...patch }
  save()
  return db.settings
}

export function getGames(): Game[] {
  return load().games
}

export function setGames(games: Game[]): void {
  load().games = games
  save()
}

export function getGroups(): Group[] {
  return load().groups
}

export function setGroups(groups: Group[]): void {
  load().groups = groups
  save()
}

export function findGame(id: string): Game | undefined {
  return load().games.find((g) => g.id === id)
}

export function updateGame(id: string, patch: Partial<Game>): Game | undefined {
  const game = findGame(id)
  if (!game) return undefined
  Object.assign(game, patch)
  save()
  return game
}

export function removeGame(id: string): void {
  const db = load()
  db.games = db.games.filter((g) => g.id !== id)
  save()
}

/**
 * Set a removed tile aside so adding the same folder back can restore it.
 *
 * Keyed by directory, since that is the one thing that survives the entry being
 * rebuilt from a fresh scan or from a dropped executable.
 */
export function rememberRemoved(game: Game): void {
  const store = load()
  const key = game.dir.toLowerCase()
  store.removed = [game, ...store.removed.filter((g) => g.dir.toLowerCase() !== key)].slice(
    0,
    MAX_REMOVED
  )
  save()
}

/** The record kept for a folder, if there is one. Does not consume it. */
export function peekRemoved(dir: string): Game | undefined {
  const key = dir.toLowerCase()
  return load().removed.find((g) => g.dir.toLowerCase() === key)
}

export function forgetRemoved(dirs: string[]): void {
  if (dirs.length === 0) return
  const keys = new Set(dirs.map((d) => d.toLowerCase()))
  const store = load()
  const before = store.removed.length
  store.removed = store.removed.filter((g) => !keys.has(g.dir.toLowerCase()))
  if (store.removed.length !== before) save()
}

export function getRemoved(): Game[] {
  return load().removed
}

export function setRemoved(list: Game[]): void {
  load().removed = list
  save()
}

export function getDownloads(): PendingDownload[] {
  return load().downloads
}

export function setDownloads(downloads: PendingDownload[]): void {
  load().downloads = downloads
  save()
}

/**
 * Written straight through rather than debounced: a download's state is the only record
 * that the extract-and-import half still has to happen, and it has to survive the app
 * being closed at any moment during a job that runs for hours.
 */
export function upsertDownload(entry: PendingDownload): void {
  const db = load()
  const at = db.downloads.findIndex((d) => d.id === entry.id)
  if (at >= 0) db.downloads[at] = entry
  else db.downloads.push(entry)
  saveNow()
}

export function removeDownload(id: string): void {
  const db = load()
  db.downloads = db.downloads.filter((d) => d.id !== id)
  saveNow()
}
