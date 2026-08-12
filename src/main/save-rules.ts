import path from 'node:path'
// Extension spelled out: `scripts/save-test.mts` loads this file straight into node,
// where nothing fills the extension in.
import type { EngineId, SaveConfidence, SaveRoot } from '../shared/types.ts'
import { SAVE_DIRS } from './share-rules.ts'

/**
 * Working out where a game keeps its saves.
 *
 * This exists because the honest answer to "where are the saves" is *not* "in the game
 * folder". Half the engines this launcher recognises write somewhere else entirely —
 * Ren'Py keeps the authoritative copy under `%APPDATA%\RenPy`, Unity uses `LocalLow`,
 * anything built on NW.js hides a leveldb under `%LOCALAPPDATA%`, and a game that
 * resolves a relative path against the wrong working directory can land its saves at the
 * root of C:. A feature that only looked inside the folder would quietly back up nothing
 * for those and report success.
 *
 * So detection here is a *search*, and it is stated as one. Nothing found outside the
 * game folder is proof; it is a folder whose name matches the game, sitting somewhere
 * this engine is known to write. That earns `strong` and a ticked box. Everything weaker
 * is still shown, with the reason, unticked — because the alternative to showing a
 * doubtful hit is not showing it, and a save nobody was told about is the one that gets
 * lost.
 *
 * The other half of the problem is that a save file inside a game folder is very often
 * **not the user's**: these downloads routinely ship with a completed save. Nothing about
 * the file says so — same name, same extension, same folder. The only thing that
 * separates them is *time*, which is why `Game.addedAt` exists and why a game added
 * before it existed is reported as having no baseline rather than guessed at.
 *
 * No electron import: the harness loads this directly under node's type stripping, the
 * same arrangement `share-rules.ts` and `scan-core.ts` have.
 */

/**
 * How far below a root a game's own folder can sit.
 *
 * Two for the AppData family because the convention there is `<brand>\<title>` as often
 * as it is `<title>` — the publisher's name is the folder people forget about. One for
 * `Saved Games` and the drive root, which have no such convention and where descending
 * further would mean walking a third of the disk.
 */
export const ROOT_DEPTH: Record<Exclude<SaveRoot, 'game'>, number> = {
  appdata: 2,
  localappdata: 2,
  locallow: 2,
  documents: 2,
  savedgames: 1,
  systemdrive: 1
}

/**
 * Where each engine is *known* to write.
 *
 * Only used to decide confidence, never to decide where to look — every root is searched
 * for every game, because a game is free to ignore its engine's habits and plenty do.
 * An empty list means the engine keeps its saves in the game folder, which the in-folder
 * pass already covers.
 */
const ENGINE_ROOTS: Record<EngineId, Exclude<SaveRoot, 'game'>[]> = {
  // Old Japanese VN engines: mostly in-folder, but the later builds moved to Roaming,
  // usually under the brand's name rather than the game's.
  kirikiri: ['appdata'],
  bgi: ['appdata'],
  siglus: ['appdata'],
  majiro: ['appdata'],
  nscripter: ['appdata'],
  artemis: ['appdata', 'documents'],
  // `%APPDATA%\RenPy\<name>` is the authoritative copy; `game\saves` is a mirror.
  renpy: ['appdata'],
  // XP/VX/VXAce write beside the game; MV and MZ are NW.js and do not.
  rpgmaker: ['localappdata'],
  wolf: [],
  // `LocalLow\<company>\<product>`. PlayerPrefs lives in the registry and is out of reach.
  unity: ['locallow'],
  unreal: ['localappdata'],
  tyrano: ['localappdata'],
  nwjs: ['localappdata']
}

/** Every root worth enumerating. Cheap: this is a readdir, done once per backup run. */
export function rootsToSearch(): Exclude<SaveRoot, 'game'>[] {
  return ['appdata', 'localappdata', 'locallow', 'documents', 'savedgames', 'systemdrive']
}

/** Whether this engine is known to keep saves under that root. */
export function engineWrites(engine: EngineId | null, root: Exclude<SaveRoot, 'game'>): boolean {
  if (!engine) return false
  return ENGINE_ROOTS[engine].includes(root)
}

/**
 * Folders at the root of C: that belong to Windows.
 *
 * Only consulted for the drive root, and only because that is the one place where a
 * generic name like `Save` is worth reporting at all — everywhere else it would be noise.
 */
const SYSTEM_DIRS = new Set([
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'users',
  'perflogs',
  '$recycle.bin',
  'system volume information',
  'recovery',
  'documents and settings',
  'msocache',
  'intel',
  'amd',
  'nvidia',
  'drivers',
  'temp',
  'windows.old'
])

/** Our own data directory, which is not a game's save folder however it is matched. */
const OURS = 'sakura-launcher'

/**
 * Words too common to identify anything.
 *
 * A game whose folder is called `Game` would otherwise match `%APPDATA%\Game`, which
 * belongs to something else entirely — and the user would have no way to know that the
 * row in front of them came from a one-word coincidence.
 */
const GENERIC_ALIASES = new Set([
  'game',
  'games',
  'data',
  'save',
  'saves',
  'savedata',
  'app',
  'apps',
  'new',
  'temp',
  'test',
  'common',
  'default',
  'main',
  'setup',
  'install',
  'program',
  'software'
])

/** The shortest folded alias worth matching on. Below this, everything matches. */
export const MIN_ALIAS = 3

/**
 * Reduce a name to the part that survives being written by different people.
 *
 * Case, spaces, brackets, punctuation and full-width forms all vary between the folder
 * on disk, the title in a catalogue and whatever the publisher called their AppData
 * directory. What is left is letters, digits and CJK.
 */
export function foldName(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]/gu, '')
}

/**
 * The names this game might be known by outside its own folder.
 *
 * The display name, the folder, the executable and whatever a catalogue matched — a
 * publisher naming an AppData folder picks one of those, and which one is not
 * predictable. Folded, deduplicated, and stripped of anything too generic to mean
 * something.
 */
export function aliasesFor(input: {
  name?: string
  dir?: string
  exe?: string
  workTitle?: string
  workAlt?: string
}): string[] {
  const raw = [
    input.name,
    input.dir ? path.basename(input.dir) : undefined,
    input.exe ? path.basename(input.exe).replace(/\.exe$/i, '') : undefined,
    input.workTitle,
    input.workAlt
  ]
  const out: string[] = []
  for (const candidate of raw) {
    if (!candidate) continue
    const folded = foldName(candidate)
    if (folded.length < MIN_ALIAS) continue
    if (GENERIC_ALIASES.has(folded)) continue
    if (!out.includes(folded)) out.push(folded)
  }
  return out
}

/**
 * Whether a directory sitting under one of the roots is named after this game.
 *
 * Containment either way, because a publisher's folder is as likely to be longer than
 * the title (`SampleGameTrial`) as shorter (`Sample`). The four-character floor on the
 * containment cases is what stops a three-letter abbreviation from matching half of
 * AppData; an exact match needs no such floor because it is already the whole name.
 */
export function nameMatches(dirName: string, aliases: string[]): boolean {
  const folded = foldName(dirName)
  if (folded.length === 0) return false
  if (folded === foldName(OURS)) return false
  for (const alias of aliases) {
    if (alias === folded) return true
    if (alias.length >= 4 && folded.includes(alias)) return true
    if (folded.length >= 4 && alias.includes(folded)) return true
  }
  return false
}

/** Whether a directory name is one of the ones that means "saves live here". */
export function isSaveDirName(name: string): boolean {
  return SAVE_DIRS.includes(name.toLowerCase())
}

/** Whether a folder at the root of C: is Windows' rather than a game's. */
export function isSystemDir(name: string): boolean {
  return SYSTEM_DIRS.has(name.toLowerCase())
}

export type SaveVia = 'alias' | 'generic'

export interface OutsideHit {
  path: string
  name: string
  root: Exclude<SaveRoot, 'game'>
  via: SaveVia
  confidence: SaveConfidence
}

/**
 * Pick this game's saves out of everything found under the roots.
 *
 * `entries` is enumerated once per run and reused for every game, which is what keeps a
 * twenty-game selection from walking AppData twenty times.
 *
 * A name match under a root the engine actually uses is the only thing that gets
 * `strong`. A name match anywhere else is real evidence but not conclusive, and a folder
 * merely *called* `Save` at the root of C: identifies no game at all — it is reported
 * because the user asked about exactly that case, and left unticked because nothing here
 * can tell whose it is.
 */
export function pickOutside(
  entries: { path: string; name: string; root: Exclude<SaveRoot, 'game'>; depth: number }[],
  aliases: string[],
  engine: EngineId | null
): OutsideHit[] {
  const hits: OutsideHit[] = []
  for (const entry of entries) {
    if (foldName(entry.name) === foldName(OURS)) continue
    if (entry.root === 'systemdrive' && isSystemDir(entry.name)) continue

    if (nameMatches(entry.name, aliases)) {
      hits.push({
        path: entry.path,
        name: entry.name,
        root: entry.root,
        via: 'alias',
        confidence: engineWrites(engine, entry.root) ? 'strong' : 'weak'
      })
      continue
    }
    // A folder literally called `save` is only worth raising at the root of the drive,
    // which is the one place a game puts one without any name to identify it by.
    if (entry.root === 'systemdrive' && entry.depth === 1 && isSaveDirName(entry.name)) {
      hits.push({
        path: entry.path,
        name: entry.name,
        root: entry.root,
        via: 'generic',
        confidence: 'weak'
      })
    }
  }
  return hits
}

/**
 * Whether everything in a candidate predates the game joining the library.
 *
 * The one discriminator that does not need to understand an engine: the user cannot have
 * written a save before they owned the folder, so anything untouched since before that
 * moment came inside the download. `null` baseline means the entry predates the field,
 * and the honest answer is "cannot tell" — never "it is the user's" and never "it is
 * not". A one-minute allowance covers a scan that stamped the entry a moment after
 * copying the files off a disk.
 */
export const BASELINE_SLACK_MS = 60_000

export function isPrepacked(newestMs: number, baselineMs: number | null): boolean {
  if (baselineMs === null || newestMs <= 0) return false
  return newestMs < baselineMs - BASELINE_SLACK_MS
}

/**
 * A candidate this large is far more likely to be the game than the saves.
 *
 * The same reasoning as the share scan, and the same number: a rule that has caught the
 * asset archive should still be shown, because the user may know something the rule does
 * not, but it must not be ticked by default.
 */
export const OVERSIZE_RATIO = 0.3

export function isOversized(candidateBytes: number, gameBytes: number): boolean {
  if (gameBytes <= 0 || candidateBytes <= 0) return false
  return candidateBytes / gameBytes > OVERSIZE_RATIO
}

/** Strip what Windows will not accept in a folder name. */
export function sanitizeFolderName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'game'
}

/**
 * The folder one run writes into, as `2026-08-12_1530`.
 *
 * A timestamp rather than a fixed name because a backup that overwrites the previous one
 * is a backup that can destroy a good copy with a bad one — the failure this whole
 * feature exists to avoid. Built from parts rather than `toISOString()` so it reads in
 * the user's own clock, which is the one they will be comparing it against.
 */
export function stampFor(when: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    `_${pad(when.getHours())}${pad(when.getMinutes())}`
  )
}

/**
 * What one copied item is called inside the backup folder.
 *
 * In-folder items keep their path relative to the game, so the layout of the backup is
 * the layout of the folder. Anything from outside is prefixed with the root it came from,
 * because `Save` on its own says nothing about where it has to go back to — and going
 * back is a manual job, done by a person reading these names.
 */
export function destNameFor(
  candidate: { path: string; root: SaveRoot },
  gameDir: string
): string {
  if (candidate.root === 'game') {
    const rel = path.relative(gameDir, candidate.path)
    if (rel && !rel.startsWith('..')) return path.join('game', rel)
    return path.join('game', path.basename(candidate.path))
  }
  return path.join(candidate.root, path.basename(candidate.path))
}

/** Make a destination unique without ever overwriting what is already there. */
export function uniqueName(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base
  for (let i = 2; i < 1000; i++) {
    const next = `${base}-${i}`
    if (!taken(next)) return next
  }
  return `${base}-${Date.now()}`
}
