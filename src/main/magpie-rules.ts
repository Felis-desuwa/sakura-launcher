// Extension spelled out: `scripts/magpie-test.mts` loads this file straight into node,
// where nothing fills the extension in.
import {
  MAGPIE_MODES,
  MAX_MAGPIE_MODE,
  normalizeMagpieMode,
  type Game,
  type MagpieMode,
  type Settings
} from '../shared/types.ts'

/**
 * Deciding what Magpie should be told, without touching a disk or a process.
 *
 * Magpie is a separate program — GPLv3, shipped alongside this one — that scales a
 * window up with a shader while it runs. It is here because the games in this library
 * are the ones it helps most: an engine that hard-codes 800×600 is a postage stamp on a
 * modern display, and the alternative Windows offers is an integer stretch that turns
 * line art to mush.
 *
 * The whole integration rests on one Magpie feature: a *profile* that names an
 * executable path and sets `autoScale` makes Magpie scale that window by itself, the
 * moment it appears, with no further prompting. So this program never has to hold a
 * window handle, poll for one, or synthesise a hotkey — it writes a JSON file and starts
 * a process. That is the reason a launcher with no native dependencies can carry this
 * feature at all.
 *
 * Nothing here imports electron; the harness loads it directly under node, the same
 * arrangement `save-rules.ts` and `scan-core.ts` have.
 */

/**
 * The Magpie release this program ships.
 *
 * Also the reinstall trigger: the copy under `%APPDATA%` records the version it was
 * written from, and a mismatch means the launcher was updated and the copy is stale.
 * Keep it in step with `scripts/fetch-magpie.mts`, which verifies the download's hash.
 */
export const MAGPIE_VERSION = '0.12.1'

/**
 * How many games get a profile written for them.
 *
 * Profiles are written for *every* enabled game at once rather than for the one being
 * launched, because rewriting the file is the dangerous half of this feature: Magpie must
 * be stopped first, or its next save overwrites the file from memory. Covering the
 * whole library means the desired config is nearly always the config already on disk, so
 * the stop-write-start dance happens a handful of times in a library's life instead of
 * on every launch. The cap keeps a two-thousand-game library from producing a config file
 * to match; the least recently played fall off first, since they are the ones least
 * likely to be started next.
 */
export const MAGPIE_MAX_PROFILES = 200

/** Longest profile name written into Magpie's config. Its own UI has to display these. */
const MAX_PROFILE_NAME = 80

/**
 * The seven built-in mode names live in `shared/types.ts`, because the settings page and
 * the right-click menu offer them too and the renderer cannot reach into `src/main`.
 *
 * Re-exported under the name this side of the program uses. The order is only ever a
 * *seed*: once Magpie has run it writes the list back itself, and the user can reorder it —
 * or add to it — from Magpie's interface, so the real index is looked up by name against
 * the file. `modeIndexIn()` in `magpie-config.ts` does that.
 */
export const DEFAULT_MODE_ORDER = MAGPIE_MODES

/**
 * Read a mode back out of a hand-edited sidecar.
 *
 * Any name is admissible, because a mode assembled in Magpie's own interface is called
 * whatever its author called it and this line has to be able to say so. The seven
 * built-ins are still recognised loosely — case, spaces and dashes all forgiven, and the
 * keys this field used to hold translated — but anything else is passed through as typed,
 * since only Magpie's config file knows whether that mode exists, and it is read far from
 * here.
 *
 * Empty is nothing, and so is a name too long to be one: the whole line is then treated as
 * absent, which reads back as "follow the setting". The cost of a typo has to be "it did
 * not take effect", never "it cleared something".
 */
export function modeFromLabel(text: string): MagpieMode | null {
  const raw = text.trim()
  if (raw === '' || raw.length > MAX_MAGPIE_MODE) return null

  const loose = raw.toLowerCase().replace(/[\s_-]+/g, '')
  for (const mode of DEFAULT_MODE_ORDER) {
    if (mode.toLowerCase().replace(/[\s_-]+/g, '') === loose) return mode
  }
  return normalizeMagpieMode(raw)
}

/**
 * Whether this entry is the kind of thing Magpie could scale at all.
 *
 * An archive has no window, and a folder that went missing has no executable to match a
 * profile against. Both would produce a profile that can never fire, so neither gets one.
 */
export function magpieApplies(game: Game): boolean {
  return game.kind === 'installed' && !game.missing && game.exe.trim() !== ''
}

/**
 * What actually happens for one game: the setting and the per-game override, resolved.
 *
 * The master switch wins outright when it is off. A game individually switched on does
 * **not** bring the feature back to life — see `Settings.magpie` for why that matters.
 */
export function effectiveMagpie(
  settings: Settings,
  game: Game
): { on: boolean; mode: MagpieMode } {
  // The one place either stored value is read, and so the one place old keys have to be
  // turned back into names.
  const mode = normalizeMagpieMode(game.magpieMode ?? settings.magpieMode)
  if (!settings.magpie || !magpieApplies(game) || game.magpie === false) {
    return { on: false, mode }
  }
  return { on: true, mode }
}

/** One line of Magpie's config: an executable to watch for, and how to scale it. */
export interface MagpieProfile {
  /** Absolute path to the executable — Magpie matches windows against this. */
  exe: string
  /** What to call it in Magpie's own interface. */
  name: string
  mode: MagpieMode
}

/**
 * Trim a game's title down to something Magpie's interface can show.
 *
 * Control characters go because they would survive `JSON.stringify` as escapes and make
 * the file unreadable to a person; the length cap is so one absurdly named folder cannot
 * dominate a list the user has to scroll.
 */
function profileName(name: string, exe: string): string {
  const clean = name
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PROFILE_NAME)
  // A game whose name is nothing but control characters still needs to be identifiable.
  return clean === '' ? exe.slice(-MAX_PROFILE_NAME) : clean
}

/**
 * Every profile that should be in Magpie's config right now.
 *
 * Ordering is by most recently played, so that the cap drops the games least likely to be
 * started next — but it also has to be **stable**, because the caller compares the result
 * against what is already on disk to decide whether Magpie must be stopped and the file
 * rewritten. Two calls on the same library that differ only in order would make that
 * comparison report a change that is not one, and the stop-write-start would then happen
 * on every single launch. Hence the explicit tiebreak on id.
 *
 * Duplicate executables collapse: two entries pointing at the same binary are one window
 * as far as Magpie is concerned, and a second profile for the same path would be dead
 * weight the user has to look at.
 */
export function magpieGames(settings: Settings, games: Game[]): MagpieProfile[] {
  const enabled = games.filter((g) => effectiveMagpie(settings, g).on)

  const ranked = [...enabled].sort((a, b) => {
    const at = a.lastLaunchedAt ?? 0
    const bt = b.lastLaunchedAt ?? 0
    if (at !== bt) return bt - at
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  const seen = new Set<string>()
  const out: MagpieProfile[] = []
  for (const game of ranked) {
    const exe = game.exe.trim()
    const key = exe.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ exe, name: profileName(game.name, exe), mode: effectiveMagpie(settings, game).mode })
    if (out.length >= MAGPIE_MAX_PROFILES) break
  }
  return out
}

/**
 * The Windows build Magpie needs: 10 v1903, the first with the capture API it uses.
 * Windows 11 reports 10.0 too, with a higher build, so only the build number is read.
 */
const MIN_BUILD = 18362

/**
 * Whether this machine is new enough, from `os.release()`.
 *
 * Anything unparseable is a no. Being wrong in that direction costs the user a feature
 * they can switch on again after being told why; being wrong in the other direction
 * starts a process that exits immediately and explains nothing.
 */
export function supportsMagpie(osRelease: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(osRelease.trim())
  if (!m) return false
  const major = Number(m[1])
  if (major > 10) return true
  if (major < 10) return false
  return Number(m[3]) >= MIN_BUILD
}

/**
 * What the Magpie processes currently running mean for us.
 *
 * `foreign` is the case worth all this trouble. Magpie allows one instance, so when the
 * user has their own copy open, the copy this program starts exits immediately and its
 * profiles never apply — and from here that is indistinguishable from success. Detecting
 * it is the only way the user ever finds out.
 */
export type InstanceVerdict =
  | { kind: 'none' }
  | { kind: 'ours' }
  | { kind: 'foreign'; path: string }

/**
 * Judge the running Magpie processes against the copy we manage.
 *
 * A foreign instance outranks ours: if both are somehow running, ours is the one that
 * lost the single-instance race and is doing nothing.
 */
export function instanceVerdict(runningExePaths: string[], ourExe: string): InstanceVerdict {
  const ours = ourExe.trim().toLowerCase()
  let mine = false
  for (const raw of runningExePaths) {
    const p = raw.trim()
    if (p === '') continue
    if (p.toLowerCase() === ours) mine = true
    else return { kind: 'foreign', path: p }
  }
  return mine ? { kind: 'ours' } : { kind: 'none' }
}

/**
 * Whether this program may stop the Magpie it found.
 *
 * Only ever the copy it owns, compared as a whole path. This is the guard on the one
 * genuinely destructive thing here — killing a process — and it exists because the
 * obvious implementation (match on the name `Magpie.exe`) would terminate the user's own
 * running copy, which this program has no business touching.
 */
export function mayStop(verdict: InstanceVerdict): boolean {
  return verdict.kind === 'ours'
}

/** What the copy under `%APPDATA%` records about where it came from. */
export interface MagpieStamp {
  magpieVersion: string
  appVersion: string
  copiedAt: number
}

/**
 * Whether the copy on disk has to be laid down again.
 *
 * Anything unrecognisable counts as stale: a stamp that cannot be read is a copy whose
 * provenance is unknown, and re-copying costs one file operation while trusting it could
 * leave a new launcher driving an old Magpie's effect files.
 */
export function needsReinstall(stamp: unknown, version: string): boolean {
  if (typeof stamp !== 'object' || stamp === null) return true
  const got = (stamp as { magpieVersion?: unknown }).magpieVersion
  return typeof got !== 'string' || got !== version
}
