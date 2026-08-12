import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type {
  Game,
  SaveBackupJob,
  SaveBackupResult,
  SaveCandidate,
  SavePlan,
  SaveRoot
} from '../shared/types'
import { ENGINE_LABEL } from '../shared/types'
import type { MessageKey } from '../shared/i18n'
import * as db from './db'
import { t } from './i18n'
import {
  ROOT_DEPTH,
  aliasesFor,
  destNameFor,
  engineWrites,
  isOversized,
  isPrepacked,
  pickOutside,
  rootsToSearch,
  sanitizeFolderName,
  stampFor,
  uniqueName
} from './save-rules'
import { scanPersonalData } from './share-rules'

/**
 * Copying a game's saves somewhere safe.
 *
 * Two promises hold this together, and they are the reason it is shaped the way it is.
 *
 * **It only reads the game.** Every path under the game folder is opened for reading and
 * nothing else; every write goes to the backup folder. That is the same promise sharing
 * makes, and it is what lets this run without a confirmation ritual.
 *
 * **It does not put anything back.** There is deliberately no restore. Restoring means
 * overwriting a save file in place, which is the only operation in this program that can
 * destroy something the user cannot get again — worse than uninstalling, which at least
 * goes through the recycle bin. Until that has a ritual of its own, the backup writes a
 * `sakura-backup.md` next to the copies recording where each one came from, and putting
 * them back is a person's job.
 *
 * Detection lives in `save-rules.ts`, which imports no electron and is tested on its own.
 */

/** Names the manifest is written under. Fixed, so a second run overwrites nothing else. */
const MANIFEST = 'sakura-backup.md'

/** The default place to put backups when the user has not chosen one. */
export function defaultBackupDir(): string {
  return path.join(app.getPath('documents'), 'Sakura Launcher Saves')
}

export function backupDirFor(): string {
  return db.getSettings().backupDir ?? defaultBackupDir()
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Where each named root actually is on this machine. `null` when Windows has no such place. */
function resolveRoot(root: Exclude<SaveRoot, 'game'>): string | null {
  try {
    switch (root) {
      case 'appdata':
        return app.getPath('appData')
      case 'localappdata':
        return process.env.LOCALAPPDATA ?? null
      case 'locallow':
        // Electron has no name for this one; it is a sibling of Local and Roaming.
        return path.join(app.getPath('home'), 'AppData', 'LocalLow')
      case 'documents':
        // Through Electron rather than %USERPROFILE%\Documents: this folder is very
        // often redirected onto another drive, and the redirect is the whole point.
        return app.getPath('documents')
      case 'savedgames':
        return path.join(app.getPath('home'), 'Saved Games')
      case 'systemdrive':
        return `${process.env.SystemDrive ?? 'C:'}\\`
    }
  } catch {
    return null
  }
}

interface RootEntry {
  path: string
  name: string
  root: Exclude<SaveRoot, 'game'>
  depth: number
}

/**
 * Every directory under every root, to the depth that root allows.
 *
 * Enumerated once and handed to every game in the run. Doing it per game would mean
 * walking AppData once per selected title, which for a bulk backup is the difference
 * between instant and visibly slow — and the answer would be identical every time.
 */
function enumerateRoots(): RootEntry[] {
  const out: RootEntry[] = []
  for (const root of rootsToSearch()) {
    const base = resolveRoot(root)
    if (!base) continue
    const maxDepth = ROOT_DEPTH[root]
    const walk = (dir: string, depth: number): void => {
      if (depth > maxDepth) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const full = path.join(dir, entry.name)
        out.push({ path: full, name: entry.name, root, depth })
        if (depth < maxDepth) walk(full, depth + 1)
      }
    }
    walk(base, 1)
  }
  return out
}

interface Measured {
  bytes: number
  files: number
  newestMs: number
}

/**
 * How big something is, how many files it holds, and when it was last written.
 *
 * One walk for all three: the size decides whether a rule has caught the game itself,
 * and the newest mtime decides whether the user has ever written to it — asking twice
 * would mean walking a save folder twice for no reason.
 */
function measure(target: string): Measured {
  let bytes = 0
  let files = 0
  let newestMs = 0
  let stat: fs.Stats
  try {
    stat = fs.statSync(target)
  } catch {
    return { bytes: 0, files: 0, newestMs: 0 }
  }
  if (stat.isFile()) return { bytes: stat.size, files: 1, newestMs: stat.mtimeMs }

  const stack = [target]
  // A candidate that turns out to hold a hundred thousand files is not a save folder,
  // and finishing the count would only tell us that slowly.
  const LIMIT = 20_000
  while (stack.length > 0 && files < LIMIT) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const st = fs.statSync(full)
        bytes += st.size
        files++
        if (st.mtimeMs > newestMs) newestMs = st.mtimeMs
      } catch {
        /* an unreadable file still exists; it just cannot be measured */
      }
    }
  }
  return { bytes, files, newestMs }
}

/** The label for a root, so a row says where it came from rather than just its name. */
function rootLabel(root: SaveRoot): string {
  return t(`saveRoot.${root}` as MessageKey)
}

/**
 * What would be copied for one game.
 *
 * The in-folder half is the share scan's `save` pile verbatim — the rules for what a save
 * looks like inside a game folder already exist, are already tested, and disagreeing with
 * them here would mean the same file being called a save by one feature and not the
 * other. The out-of-folder half is a name search, and is labelled as one.
 */
function planFor(game: Game, entries: RootEntry[]): SavePlan {
  const base: SavePlan = {
    gameId: game.id,
    gameName: game.name,
    dir: game.dir,
    engine: game.engine ?? null,
    candidates: [],
    baselineMs: game.addedAt ?? null
  }

  if (game.kind === 'archive') return { ...base, blocked: t('saves.blocked.isArchive') }
  if (game.missing || !fs.existsSync(game.dir)) {
    return { ...base, blocked: t('saves.blocked.noFolder') }
  }

  const gameBytes = game.sizeBytes ?? 0
  const candidates: SaveCandidate[] = []
  const seen = new Set<string>()

  const add = (
    target: string,
    root: SaveRoot,
    confidence: SaveCandidate['confidence'],
    reason: string,
    extra: Partial<SaveCandidate> = {}
  ): void => {
    const key = target.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    let isDir = false
    try {
      isDir = fs.statSync(target).isDirectory()
    } catch {
      return
    }
    const m = measure(target)
    const prepacked = isPrepacked(m.newestMs, base.baselineMs)
    const oversized = root === 'game' && isOversized(m.bytes, gameBytes)
    candidates.push({
      path: target,
      label: root === 'game' ? path.relative(game.dir, target) || path.basename(target) : target,
      isDir,
      sizeBytes: m.bytes,
      fileCount: m.files,
      newestMs: m.newestMs,
      root,
      confidence,
      reason,
      // Empty folders are offered but never ticked: copying nothing succeeds, and a
      // success report over an empty backup is the worst outcome this feature has.
      checked: confidence === 'strong' && !prepacked && !oversized && m.files > 0,
      ...(prepacked ? { prepacked: true } : {}),
      ...(oversized ? { oversized: true } : {}),
      ...extra
    })
  }

  // Inside the folder — the pile the share scan already knows how to find.
  for (const found of scanPersonalData(game.dir)) {
    if (found.category !== 'save') continue
    add(found.path, 'game', 'strong', found.reason)
  }

  // Outside it — a name search across the places Windows lets a game write.
  const aliases = aliasesFor({
    name: game.name,
    dir: game.dir,
    exe: game.exe,
    workTitle: game.work?.title
  })
  for (const hit of pickOutside(entries, aliases, game.engine ?? null)) {
    const reason =
      hit.via === 'generic'
        ? t('whySave.genericAtRoot', { name: hit.name })
        : engineWrites(game.engine ?? null, hit.root)
          ? t('whySave.engineRoot', {
              engine: ENGINE_LABEL[game.engine!],
              root: rootLabel(hit.root)
            })
          : t('whySave.nameMatch', { root: rootLabel(hit.root) })
    add(hit.path, hit.root, hit.confidence, reason)
  }

  // Anything the user named themselves outranks every rule above, and is always ticked:
  // they went and pointed at it, which is a stronger statement than any heuristic here.
  for (const chosen of game.saveDirs ?? []) {
    if (!fs.existsSync(chosen)) continue
    const key = chosen.toLowerCase()
    const already = candidates.find((c) => c.path.toLowerCase() === key)
    if (already) {
      already.byHand = true
      already.checked = true
      already.reason = t('whySave.addedByHand')
      continue
    }
    add(chosen, rootOf(chosen, game.dir), 'strong', t('whySave.addedByHand'), {
      byHand: true,
      checked: true
    })
  }

  // Strongest first, then biggest — the row most likely to be the answer is the one the
  // user should not have to scroll to.
  candidates.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === 'strong' ? -1 : 1
    if (a.root !== b.root) return a.root === 'game' ? -1 : 1
    return b.sizeBytes - a.sizeBytes
  })

  return { ...base, candidates }
}

/** Which named place a hand-picked path sits in, so its backup folder is labelled. */
function rootOf(target: string, gameDir: string): SaveRoot {
  if (isUnder(target, gameDir)) return 'game'
  for (const root of rootsToSearch()) {
    const base = resolveRoot(root)
    if (base && isUnder(target, base)) return root
  }
  return 'systemdrive'
}

export function planSaveBackup(ids: string[]): SavePlan[] {
  const entries = enumerateRoots()
  return ids.map((id) => {
    const game = db.findGame(id)
    if (!game) {
      return {
        gameId: id,
        gameName: t('share.goneName'),
        dir: '',
        engine: null,
        candidates: [],
        baselineMs: null,
        blocked: t('share.blocked.gone')
      }
    }
    return planFor(game, entries)
  })
}

/* ---------- writing the copies ---------- */

export interface SaveBackupProgress {
  gameId: string
  /** 0–100 for the game currently being copied. */
  percent: number
  /** 1-based position in the queue. */
  index: number
  total: number
}

export interface SaveBackupHandle {
  cancel: () => void
}

interface CopyTally {
  files: number
  bytes: number
  unreadable: number
}

/**
 * Copy one tree, counting as it goes.
 *
 * File by file rather than `fs.cpSync` so that a single unreadable file — a save the
 * game still has open — costs that one file instead of the whole backup, and so there is
 * something to report progress with.
 */
function copyTree(
  src: string,
  dest: string,
  tally: CopyTally,
  onBytes: (n: number) => void,
  cancelled: () => boolean
): void {
  if (cancelled()) return
  let stat: fs.Stats
  try {
    stat = fs.statSync(src)
  } catch {
    tally.unreadable++
    return
  }

  if (stat.isFile()) {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(src, dest)
      // Carry the timestamps across. Without them every backed-up save looks like it was
      // written today, and the one thing this feature uses to tell saves apart is when
      // they were last touched.
      fs.utimesSync(dest, stat.atime, stat.mtime)
      tally.files++
      tally.bytes += stat.size
      onBytes(stat.size)
    } catch {
      tally.unreadable++
    }
    return
  }

  if (!stat.isDirectory()) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(src, { withFileTypes: true })
  } catch {
    tally.unreadable++
    return
  }
  try {
    fs.mkdirSync(dest, { recursive: true })
  } catch {
    tally.unreadable++
    return
  }
  for (const entry of entries) {
    if (cancelled()) return
    // Reparse points are followed nowhere: a junction pointing back up the tree would
    // copy forever, and a symlink to somewhere else is not this game's save data.
    if (entry.isSymbolicLink()) continue
    copyTree(path.join(src, entry.name), path.join(dest, entry.name), tally, onBytes, cancelled)
  }
}

/**
 * The note left beside the copies.
 *
 * This is load-bearing, not decoration. There is no restore, so the only way anything
 * here goes back is a person opening this file and reading where each folder came from.
 * Absolute paths, written in the user's language, in the same hand-editable Markdown as
 * the sidecar.
 */
function manifestFor(
  game: Game,
  items: { from: string; to: string; bytes: number }[],
  when: Date
): string {
  const lines = [
    `# ${t('saveDoc.title')}`,
    '',
    `- **${t('saveDoc.game')}**: ${game.name}`,
    `- **${t('saveDoc.folder')}**: \`${game.dir}\``,
    `- **${t('saveDoc.when')}**: ${when.toLocaleString()}`,
    '',
    t('saveDoc.intro'),
    '',
    `| ${t('saveDoc.to')} | ${t('saveDoc.from')} |`,
    '| --- | --- |'
  ]
  for (const item of items) {
    lines.push(`| \`${item.to}\` | \`${item.from}\` |`)
  }
  lines.push('', `> ${t('saveDoc.restore')}`, '')
  return lines.join('\r\n')
}

/**
 * Run a queue of backups, one game at a time.
 *
 * Sequential for the same reason sharing is: these are large sequential reads and writes
 * on what is usually one disk, and two at once finishes both later. A game that fails
 * does not stop the queue — finding out that the third folder had a permissions problem
 * is no reason for the other five never to run.
 */
export function startSaveBackup(
  jobs: { job: SaveBackupJob; game: Game; candidates: SaveCandidate[] }[],
  destRoot: string,
  onProgress: (progress: SaveBackupProgress) => void,
  onDone: (results: SaveBackupResult[]) => void
): SaveBackupHandle {
  const results: SaveBackupResult[] = []
  let cancelled = false
  const isCancelled = (): boolean => cancelled

  const run = async (): Promise<void> => {
    for (let index = 0; index < jobs.length; index++) {
      if (cancelled) {
        for (let i = index; i < jobs.length; i++) {
          results.push({ gameId: jobs[i].job.gameId, ok: false, skipped: true })
        }
        break
      }
      const { job, game, candidates } = jobs[index]
      const picked = candidates.filter((c) => job.include.includes(c.path))
      if (picked.length === 0) {
        results.push({ gameId: job.gameId, ok: false, error: t('saves.nothingPicked') })
        continue
      }

      // A backup written inside the folder it is backing up is not a backup — it is a
      // second copy that goes in the bin with the first. This is also the only route by
      // which this feature could ever write into a game folder, so it is refused here.
      if (isUnder(destRoot, game.dir) || destRoot.toLowerCase() === game.dir.toLowerCase()) {
        results.push({ gameId: job.gameId, ok: false, error: t('saves.blocked.insideGame') })
        continue
      }

      const when = new Date()
      const gameFolder = path.join(destRoot, sanitizeFolderName(game.name))
      let dest: string
      try {
        fs.mkdirSync(gameFolder, { recursive: true })
        const stamp = uniqueName(stampFor(when), (name) => fs.existsSync(path.join(gameFolder, name)))
        dest = path.join(gameFolder, stamp)
        fs.mkdirSync(dest, { recursive: true })
      } catch (err) {
        results.push({
          gameId: job.gameId,
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        })
        continue
      }

      const totalBytes = picked.reduce((sum, c) => sum + c.sizeBytes, 0)
      let copiedBytes = 0
      onProgress({ gameId: job.gameId, percent: 0, index: index + 1, total: jobs.length })

      const tally: CopyTally = { files: 0, bytes: 0, unreadable: 0 }
      const written: { from: string; to: string; bytes: number }[] = []
      const usedNames = new Set<string>()

      for (const candidate of picked) {
        if (cancelled) break
        const wanted = destNameFor(candidate, game.dir)
        const rel = uniqueName(wanted, (name) => usedNames.has(name.toLowerCase()))
        usedNames.add(rel.toLowerCase())
        copyTree(
          candidate.path,
          path.join(dest, rel),
          tally,
          (n) => {
            copiedBytes += n
            const percent = totalBytes > 0 ? Math.min(100, (copiedBytes / totalBytes) * 100) : 100
            onProgress({ gameId: job.gameId, percent, index: index + 1, total: jobs.length })
          },
          isCancelled
        )
        written.push({ from: candidate.path, to: rel, bytes: candidate.sizeBytes })
        // Yield between items so a cancel lands and the window keeps painting.
        await new Promise((resolve) => setImmediate(resolve))
      }

      if (cancelled) {
        results.push({ gameId: job.gameId, ok: false, skipped: true })
        continue
      }

      try {
        // With a BOM, for the same reason the sidecar has one: a Windows editor opening
        // this without one falls back to the ANSI codepage and turns every path in it to
        // mojibake. This file is the only route back from a backup, so it has to be
        // readable by the person holding it.
        fs.writeFileSync(
          path.join(dest, MANIFEST),
          '﻿' + manifestFor(game, written, when),
          'utf-8'
        )
      } catch {
        /* the copies are what matter; a missing note is not a failed backup */
      }

      db.updateGame(game.id, { savesBackedUpAt: when.getTime() })
      results.push({
        gameId: job.gameId,
        ok: tally.files > 0,
        dest,
        files: tally.files,
        bytes: tally.bytes,
        unreadable: tally.unreadable,
        error: tally.files === 0 ? t('saves.copiedNothing') : undefined
      })
    }
    db.saveNow()
    onDone(results)
  }

  void run()
  return {
    cancel: () => {
      cancelled = true
    }
  }
}
