import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Database, Game, Group, Settings } from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'

const DB_VERSION = 1

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
  return { version: DB_VERSION, games: [], groups: [], settings: { ...DEFAULT_SETTINGS } }
}

export function load(): Database {
  if (cache) return cache
  try {
    // Strip a UTF-8 BOM: JSON.parse rejects it, and editors on Windows add one freely.
    const raw = fs.readFileSync(dbPath, 'utf-8').replace(/^﻿/, '')
    const parsed = JSON.parse(raw) as Database
    cache = {
      version: DB_VERSION,
      games: Array.isArray(parsed.games) ? parsed.games : [],
      groups: Array.isArray(parsed.groups) ? parsed.groups : [],
      // Merge so settings added in later versions get their defaults.
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) }
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

export function flush(): void {
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
