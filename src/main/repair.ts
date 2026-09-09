import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import * as db from './db'
import { t } from './i18n'
import { listDirShallow } from './scan-core'
import {
  layerTokens,
  layerWith,
  LOCALE_TOOL_ORDER,
  LOCALE_TOOLS,
  pinnedToolOk,
  repairsFor,
  type RepairFacts
} from './repair-rules.ts'
import type {
  Diagnosis,
  Game,
  LaunchTrouble,
  LocaleToolFound,
  RepairId,
  RepairOffer,
  RepairRecord,
  RepairResult
} from '../shared/types'

/**
 * Measuring what a repair would need to know, and then doing it.
 *
 * The rules next door decide what may be offered; this half gathers the facts they decide
 * on and carries out whichever one the user pressed. Two things run through it:
 *
 * **Every action records how to undo itself before it does anything.** Not after — the
 * previous registry value has to be read before it is overwritten, and the list of files
 * whose attribute is being cleared has to be built while the attribute is still on them.
 * A journal written afterwards is a journal of what we intended.
 *
 * **Nothing here runs unasked.** There is no timer, no startup pass and no "while we are
 * here". A repair happens because somebody read what it would change and pressed the
 * button, which is the only footing a program has for editing a machine it does not own.
 */

/** How deep to walk a game folder when counting. Deeper costs more than it tells. */
const WALK_DEPTH = 3

/** Enough files to judge a pattern by, without walking a hundred-thousand-file install. */
const WALK_LIMIT = 4000

/* -------------------------------------------------------------------------- */
/*  probes                                                                    */
/* -------------------------------------------------------------------------- */

interface WalkResult {
  files: string[]
  readOnly: string[]
}

function walk(dir: string, depth = 0, acc: WalkResult = { files: [], readOnly: [] }): WalkResult {
  if (depth > WALK_DEPTH || acc.files.length >= WALK_LIMIT) return acc
  let entries: ReturnType<typeof listDirShallow>
  try {
    entries = listDirShallow(dir)
  } catch {
    return acc
  }
  for (const entry of entries) {
    if (acc.files.length >= WALK_LIMIT) break
    const full = path.join(dir, entry.name)
    if (entry.isDir) {
      walk(full, depth + 1, acc)
      continue
    }
    acc.files.push(full)
    try {
      // The read-only bit is the low bit of the Windows attribute word, which Node
      // surfaces in `mode` as the absence of the owner-write bit.
      if ((fs.statSync(full).mode & 0o200) === 0) acc.readOnly.push(full)
    } catch {
      /* it was there a moment ago */
    }
  }
  return acc
}

/**
 * Which executables still carry a mark of the web.
 *
 * Read through the Win32 stream syntax, which `CreateFile` understands and Node passes
 * through unchanged. A missing stream throws, and a throw is the clean answer — so the
 * catch is the common path here rather than the exceptional one.
 *
 * Scoped to things that get loaded. Every asset in the folder carries the same mark and
 * none of them matters; reporting "four thousand files are blocked" would bury the four
 * that are.
 */
function markedFiles(files: string[]): string[] {
  const marked: string[] = []
  for (const file of files) {
    if (!/\.(exe|dll)$/i.test(file)) continue
    try {
      const text = fs.readFileSync(`${file}:Zone.Identifier`, 'utf-8')
      if (/ZoneId\s*=\s*[34]/i.test(text)) marked.push(file)
    } catch {
      /* no stream: the file is clean */
    }
  }
  return marked
}

/** Whether anything at all can be written here. Its own file, and cleaned up after. */
function folderWritable(dir: string): boolean {
  const probe = path.join(dir, `.sakura-write-probe-${process.pid}`)
  try {
    fs.writeFileSync(probe, '')
    fs.unlinkSync(probe)
    return true
  } catch {
    try {
      fs.unlinkSync(probe)
    } catch {
      /* it was never made */
    }
    return false
  }
}

/** Read one registry value, or null. `reg.exe` because it needs no dependency. */
function regRead(key: string, value: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', key, '/v', value],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(null)
        // `    <name>    REG_SZ    <data>` — the data may contain spaces, so take the tail.
        const line = stdout.split(/\r?\n/).find((l) => l.includes('REG_'))
        if (!line) return resolve(null)
        const match = /REG_[A-Z_]+\s+(.*)$/.exec(line.trim())
        resolve(match ? match[1].trim() : null)
      }
    )
  })
}

function regWrite(key: string, value: string, data: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['add', key, '/v', value, '/t', 'REG_SZ', '/d', data, '/f'],
      { windowsHide: true, timeout: 5000 },
      (err) => resolve(!err)
    )
  })
}

function regDelete(key: string, value: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['delete', key, '/v', value, '/f'],
      { windowsHide: true, timeout: 5000 },
      (err) => resolve(!err)
    )
  })
}

const LAYERS_KEY = 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers'

/**
 * Find the locale emulators installed on this machine.
 *
 * Two of the three register a shell context-menu handler, and its `CodeBase` is the only
 * reliable record either installer leaves — so that is what is read, rather than guessing
 * at install directories. `ntleas` registers nothing, which is why a pinned path is a
 * standing control here and not a fallback for when the search fails.
 *
 * Both hives, HKCU first: a per-user install writes only there.
 */
async function findLocaleTools(): Promise<LocaleToolFound[]> {
  const found: LocaleToolFound[] = []

  for (const tool of LOCALE_TOOL_ORDER) {
    const spec = LOCALE_TOOLS[tool]

    // A path the user pinned outranks the search, and is refused unless it really names
    // that tool — a bad pin would outrank the search from then on and aim the feature at
    // nothing while showing a path as though it worked.
    const pinned = db.getSettings().localeTools?.[tool]
    if (pinned && pinnedToolOk(tool, pinned) && fs.existsSync(pinned)) {
      found.push({ tool, exe: pinned, fits: spec.fits })
      continue
    }

    if (!spec.clsid) continue
    for (const hive of ['HKCU', 'HKLM']) {
      const key = `${hive}\\Software\\Classes\\CLSID\\${spec.clsid}\\InprocServer32`
      const codeBase = await regRead(key, 'CodeBase')
      if (!codeBase) continue
      const local = codeBase.replace(/^file:\/+/i, '').replace(/\//g, '\\')
      const dir = path.dirname(local)
      const proc = path.join(dir, spec.proc)
      // Both, not either. A leftover registry key from an uninstall points at a directory
      // that is no longer there, and offering that is worse than finding nothing.
      if (fs.existsSync(proc) && fs.existsSync(path.join(dir, spec.marker))) {
        found.push({ tool, exe: proc, fits: spec.fits })
        break
      }
    }
  }
  return found
}

/**
 * The UAC VirtualStore copy of a game folder, if it exists and has anything in it.
 *
 * Virtualisation only applies under the protected locations, and only on the system drive,
 * so anything else answers null without touching the disk. The path is the game folder with
 * its drive specification removed, hung under `%LOCALAPPDATA%\VirtualStore`.
 *
 * **Emptiness is the whole question.** The directory can exist from a single failed write
 * years ago and mean nothing; a tree with files in it means the game has been saving there
 * and is doing so successfully right now.
 */
function virtualStoreFor(dir: string): string | null {
  const local = process.env.LOCALAPPDATA
  if (!local || !dir) return null

  const protectedRoots = [
    process.env['ProgramFiles(x86)'],
    process.env.ProgramFiles,
    process.env.ProgramData,
    process.env.SystemRoot
  ].filter((r): r is string => typeof r === 'string' && r !== '')

  const lower = dir.toLowerCase()
  if (!protectedRoots.some((root) => lower.startsWith(root.toLowerCase() + path.sep))) return null

  // `C:\Program Files (x86)\X` -> `Program Files (x86)\X`
  const parsed = path.parse(dir)
  const relative = dir.slice(parsed.root.length)
  const candidate = path.join(local, 'VirtualStore', relative)
  try {
    if (!fs.existsSync(candidate)) return null
    return walk(candidate).files.length > 0 ? candidate : null
  } catch {
    return null
  }
}

/** Fonts Windows does not ship, which is how the optional feature is detected. */
const JP_FONTS = ['msgothic.ttc', 'msmincho.ttc']

function missingJapaneseFonts(): string[] {
  const dir = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts')
  return JP_FONTS.filter((f) => {
    try {
      return !fs.existsSync(path.join(dir, f))
    } catch {
      return false
    }
  })
}

/**
 * Everything the rules need, measured.
 *
 * Read-only throughout, apart from the one throwaway file the writability probe makes and
 * removes. Running this changes nothing, which is what lets the dialog run it on open.
 */
export async function repairFacts(
  game: Game,
  diagnosis: Diagnosis,
  trouble: LaunchTrouble | null
): Promise<RepairFacts> {
  const walked = game.dir ? walk(game.dir) : { files: [], readOnly: [] }
  const layers = game.exe ? layerTokens(await regRead(LAYERS_KEY, game.exe)) : []
  return {
    codes: diagnosis.checks.map((c) => c.code),
    trouble,
    arch: diagnosis.arch,
    gameExe: game.exe || null,
    blocked: markedFiles(walked.files),
    readOnly: walked.readOnly.length,
    fileCount: walked.files.length,
    folderWritable: game.dir ? folderWritable(game.dir) : true,
    virtualStore: game.dir ? virtualStoreFor(game.dir) : null,
    localeTools: await findLocaleTools(),
    missingFonts: missingJapaneseFonts(),
    layers
  }
}

/** What can be done about this game, with the evidence for each. */
export async function repairOffers(
  game: Game,
  diagnosis: Diagnosis,
  trouble: LaunchTrouble | null
): Promise<RepairOffer[]> {
  return repairsFor(await repairFacts(game, diagnosis, trouble))
}

/* -------------------------------------------------------------------------- */
/*  doing it                                                                  */
/* -------------------------------------------------------------------------- */

function remember(record: RepairRecord): void {
  db.pushRepair(record)
}

/**
 * Carry out one repair.
 *
 * Every branch reads what it is about to overwrite *first*, and only then writes. A
 * journal built after the fact records what was intended rather than what was replaced,
 * and the difference shows up exactly when somebody needs the undo to work.
 */
export async function applyRepair(
  id: RepairId,
  game: Game,
  arch: string | null
): Promise<RepairResult> {
  switch (id) {
    case 'unblock': {
      const walked = walk(game.dir)
      const marked = markedFiles(walked.files)
      let cleared = 0
      for (const file of marked) {
        try {
          fs.unlinkSync(`${file}:Zone.Identifier`)
          cleared++
        } catch {
          /* another process has it, or it went away */
        }
      }
      // Verified rather than assumed: re-probe, and report what is actually left.
      const left = markedFiles(marked)
      return {
        ok: left.length === 0,
        message:
          left.length === 0
            ? t('repair.done.unblock', { n: String(cleared) })
            : t('repair.left.unblock', { n: String(left.length) }),
        record: {
          id,
          gameId: game.id,
          at: Date.now(),
          summary: t('repair.done.unblock', { n: String(cleared) }),
          undo: { kind: 'none' }
        }
      }
    }

    case 'clear-readonly': {
      const walked = walk(game.dir)
      const changed: string[] = []
      for (const file of walked.readOnly) {
        try {
          const mode = fs.statSync(file).mode
          fs.chmodSync(file, mode | 0o200)
          changed.push(file)
        } catch {
          /* skip it; the list only carries what really changed */
        }
      }
      const record: RepairRecord = {
        id,
        gameId: game.id,
        at: Date.now(),
        summary: t('repair.done.readonly', { n: String(changed.length) }),
        undo: { kind: 'readonly', files: changed }
      }
      remember(record)
      return { ok: changed.length > 0, message: record.summary, record }
    }

    case 'not-writable': {
      if (!game.exe) return { ok: false, message: t('launch.noExe') }
      const previous = await regRead(LAYERS_KEY, game.exe)
      const next = layerWith(previous, 'RUNASADMIN')
      if (next === null) {
        return { ok: false, message: t('repair.already.layer') }
      }
      const wrote = await regWrite(LAYERS_KEY, game.exe, next)
      if (!wrote) return { ok: false, message: t('repair.failed', { why: t('repair.regFailed') }) }
      const record: RepairRecord = {
        id,
        gameId: game.id,
        at: Date.now(),
        summary: t('repair.done.runAsAdmin'),
        undo: { kind: 'compat-layer', exe: game.exe, previous }
      }
      remember(record)
      return { ok: true, message: record.summary, record }
    }

    case 'compat-layer': {
      if (!game.exe) return { ok: false, message: t('launch.noExe') }
      const previous = await regRead(LAYERS_KEY, game.exe)
      if (previous === null) return { ok: false, message: t('repair.already.noLayer') }
      const gone = await regDelete(LAYERS_KEY, game.exe)
      if (!gone) return { ok: false, message: t('repair.failed', { why: t('repair.regFailed') }) }
      const record: RepairRecord = {
        id,
        gameId: game.id,
        at: Date.now(),
        summary: t('repair.done.layersCleared', { tokens: previous }),
        undo: { kind: 'compat-layer', exe: game.exe, previous }
      }
      remember(record)
      return { ok: true, message: record.summary, record }
    }

    /*
     * Both guides, and `locale-chain` is one deliberately.
     *
     * It used to rewrite `game.exe` to the emulator with the game as an argument, which
     * looked like one small action and was four. `game.exe` is the identity everything
     * else hangs on: `sidecar-sync.ts` writes it into the travelling `sakura-launcher.md`
     * relative to the game folder with no `isUnder` guard, so an emulator outside that
     * folder put a machine-specific path into a file meant to survive being moved to
     * another computer; a rescan reverted it whenever `exePinned` was not set, silently,
     * while the journal still offered to undo it; the compatibility-layer repairs key on
     * `game.exe`, so a later `RUNASADMIN` landed on `LEProc.exe` and made every program
     * launched through Locale Emulator demand UAC; and pressing it twice aimed the
     * emulator at itself.
     *
     * Doing it properly means a launch chain the launcher honours *without* touching
     * `game.exe` — a change to the scanner, the sidecar and the fix-pack hashing. Worth
     * doing; not worth doing blind, on a machine with no emulator installed to test it
     * against. Until then the offer hands over the exact command line.
     */
    case 'locale-chain':
    case 'install-fonts':
      return { ok: false, message: t('repair.guideOnly') }
  }
}

/** Put a repair back exactly. */
export async function undoRepair(record: RepairRecord): Promise<RepairResult> {
  switch (record.undo.kind) {
    case 'none':
      return { ok: false, message: t('repair.notUndoable') }

    case 'readonly': {
      let back = 0
      for (const file of record.undo.files) {
        try {
          const mode = fs.statSync(file).mode
          fs.chmodSync(file, mode & ~0o200)
          back++
        } catch {
          /* gone; nothing to put back */
        }
      }
      db.dropRepair(record)
      return { ok: true, message: t('repair.undone.readonly', { n: String(back) }) }
    }

    case 'compat-layer': {
      const ok =
        record.undo.previous === null
          ? await regDelete(LAYERS_KEY, record.undo.exe)
          : await regWrite(LAYERS_KEY, record.undo.exe, record.undo.previous)
      if (ok) db.dropRepair(record)
      return {
        ok,
        message: ok ? t('repair.undone') : t('repair.failed', { why: t('repair.regFailed') })
      }
    }

  }
}

/** Repairs made to this game that can still be put back. */
export function repairsMade(gameId: string): RepairRecord[] {
  return db.getRepairs().filter((r) => r.gameId === gameId && r.undo.kind !== 'none')
}

/** The emulators found on this machine, for the settings page. */
export function installedLocaleTools(): Promise<LocaleToolFound[]> {
  return findLocaleTools()
}
