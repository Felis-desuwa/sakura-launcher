// Extension spelled out: `scripts/magpie-test.mts` loads this file straight into node.
import { MAGPIE_MODES, normalizeUpscaleMode, type UpscaleMode } from '../shared/types.ts'
import type { UpscaleTarget } from './upscale-rules.ts'

/**
 * Writing Magpie's `config.json` without taking anything away from it.
 *
 * This is a **merge**, never a fresh write, and the distinction is the whole reason this
 * file exists as a pure module:
 *
 *  - Magpie rewrites this file from memory whenever any of its own settings changes —
 *    window position, its own normalisation of the scaling-mode list, whatever fields a
 *    future version adds. A wholesale overwrite would silently undo all of it, including
 *    anything the user changed in Magpie's own interface, on every launch.
 *  - A profile's `scalingMode` is an **index** into a list the user can reorder, so the
 *    meaning of the number has to be read back out of the file rather than assumed.
 *  - Whether the file needs rewriting at all decides whether Magpie has to be stopped and
 *    restarted, which is the one genuinely disruptive thing this feature does. That
 *    verdict is a single boolean and it deserves to be testable under bare node.
 *
 * The rule that governs every decision below: **anything we did not put there stays**.
 */

/**
 * `ScalingType` from Magpie's `ScalingOptions.h`. `Fit` means "the largest whole-ratio
 * scale the screen can hold", which is what an upscaler wants; `Normal` treats `scale` as
 * a plain multiplier. An `EffectOption` defaults to `Normal` with a scale of 1×1, so the
 * seed below only spells out what differs from that.
 */
const FIT = 1
const NORMAL = 0

/**
 * The seven modes Magpie creates for itself, reproduced field for field from its
 * `_SetDefaultScalingModes()`.
 *
 * This has to be written out rather than left to Magpie, and that is not obvious:
 * `ScalingModesService::Import()` returns early when the key is missing *or* empty
 * without filling anything in, and `_SetDefaultScalingModes()` only runs when there is no
 * config file at all. So a config file that omits this key leaves Magpie with an **empty
 * mode list** — every profile's index out of range, nothing scaled, no error shown. The
 * effect names are the paths under `effects\`, verified against the shipped archive.
 */
const SEED_SCALING_MODES: unknown[] = [
  { name: 'Lanczos', effects: [{ name: 'Lanczos', scalingType: FIT }] },
  {
    name: 'FSR',
    effects: [
      { name: 'FSR\\FSR_EASU', scalingType: FIT },
      { name: 'FSR\\FSR_RCAS', parameters: { sharpness: 0.87 } }
    ]
  },
  { name: 'FSRCNNX', effects: [{ name: 'FSRCNNX\\FSRCNNX' }] },
  { name: 'CuNNy', effects: [{ name: 'CuNNy2\\CuNNy-4x12-NVL' }] },
  { name: 'Anime4K', effects: [{ name: 'Anime4K\\Anime4K_Upscale_Denoise_L' }] },
  {
    name: 'CRT-Geom',
    effects: [
      {
        name: 'CRT\\CRT_Geom',
        scalingType: FIT,
        parameters: {
          curvature: 0,
          cornerSize: 0.001,
          CRTGamma: 1.5,
          monitorGamma: 2.2,
          interlace: 0
        }
      }
    ]
  },
  {
    name: 'Integer Scale 2x',
    effects: [{ name: 'Nearest', scalingType: NORMAL, scale: { x: 2, y: 2 } }]
  }
]

/** Modifier bits Magpie packs a hotkey into, from its `_SetDefaultShortcuts()`. */
const WIN = 0x100
const CTRL = 0x200
const ALT = 0x400
const SHIFT = 0x800

/**
 * Pack a hotkey the way Magpie stores it: the virtual-key code with modifier bits above
 * it. Exported so the harness can pin the encoding rather than trust it.
 */
export function shortcutCode(k: {
  key: number
  win?: boolean
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
}): number {
  return (
    k.key | (k.win ? WIN : 0) | (k.ctrl ? CTRL : 0) | (k.alt ? ALT : 0) | (k.shift ? SHIFT : 0)
  )
}

/**
 * Magpie's own defaults: Alt+Shift+A, Q and D.
 *
 * Only ever written into a file that has no `shortcuts` of its own. A hotkey the user
 * rebound is theirs, and the manual one matters here beyond tidiness: when a game hands
 * off to a second executable, the profile never matches and pressing the scale hotkey is
 * the user's only way to scale that window at all.
 */
const SEED_SHORTCUTS = {
  scale: shortcutCode({ key: 65, alt: true, shift: true }),
  windowedModeScale: shortcutCode({ key: 81, alt: true, shift: true }),
  toolbar: shortcutCode({ key: 68, alt: true, shift: true })
}

/** A plain JSON object, which is all this module ever deals in. */
type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Read Magpie's config file.
 *
 * Tolerates a BOM and returns null for anything that is not a JSON object — a truncated
 * or hand-mangled file is treated as "no config", which `buildConfig` then rebuilds from
 * scratch. Throwing instead would leave the feature permanently broken on a file the user
 * cannot be expected to repair.
 */
export function parseConfig(text: string): Obj | null {
  try {
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
    return isObj(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Whether the file already asks for the language we would ask for.
 *
 * `zh` and `zh-Hans` are the same request; so are `en` and `en-US`. Compared by prefix
 * because what matters is not writing the field again, and the exact tag Magpie settles on
 * is its business.
 */
function sameLanguage(current: unknown, want: 'zh' | 'en'): boolean {
  if (typeof current !== 'string') return false
  const got = current.trim().toLowerCase()
  return got === want || got.startsWith(`${want}-`)
}

/** The scaling-mode list actually in force for a given file. */
function scalingModesOf(existing: Obj | null): unknown[] {
  const list = existing?.scalingModes
  return Array.isArray(list) && list.length > 0 ? list : SEED_SCALING_MODES
}

/**
 * Every mode name the file offers, in the order Magpie lists them.
 *
 * This is what the settings page and the right-click menu are filled from, and the reason
 * they are filled from a file rather than a constant: Magpie's interface can build new
 * modes out of the shaders under `effects\`, and one built there is precisely the mode
 * somebody went looking for. Offering only the seven built-ins would leave it unselectable
 * in the program that offers the setting.
 *
 * Falls back to the built-in names when there is no file yet, so the list is never empty —
 * a mode has to be choosable before Magpie has ever run.
 */
export function listModes(existing: Obj | null): UpscaleMode[] {
  const out: UpscaleMode[] = []
  for (const entry of scalingModesOf(existing)) {
    if (!isObj(entry) || typeof entry.name !== 'string') continue
    const name = entry.name.trim()
    // Magpie allows two modes the same name; this list is offered as a choice, and the
    // second one could never be told from the first.
    if (name !== '' && !out.includes(name)) out.push(name)
  }
  return out.length > 0 ? out : [...MAGPIE_MODES]
}

/**
 * Turn a mode into the index Magpie's config wants.
 *
 * Looked up **by name** against whatever list the file holds, because the index is a
 * position the user can rearrange from Magpie's interface — a hard-coded number would
 * quietly select a different shader the moment they did. `-1` is Magpie's own "use the
 * default", and is the right answer for a mode the file's list does not contain: it is
 * the one value guaranteed to be in range. That is the graceful end of a mode the user
 * deleted after choosing it here, and of one carried in on a sidecar from a machine whose
 * Magpie had it.
 */
export function modeIndexIn(existing: Obj | null, mode: UpscaleMode): number {
  const list = scalingModesOf(existing)
  const want = normalizeUpscaleMode(mode)
  const found = list.findIndex((m) => isObj(m) && m.name === want)
  if (found >= 0) return found
  // Second pass ignoring case, for a name typed into a sidecar by hand. Exact first, so
  // two modes differing only in case still resolve to the one that was actually meant.
  const loose = want.toLowerCase()
  return list.findIndex((m) => isObj(m) && typeof m.name === 'string' && m.name.toLowerCase() === loose)
}

/** What the caller wants the file to say. */
export interface DesiredMagpie {
  profiles: UpscaleTarget[]
  defaultMode: UpscaleMode
  language: 'zh' | 'en'
}

export interface MagpieConfigResult {
  config: Obj
  /**
   * The parts we care about differ from what was on disk, so Magpie has to be stopped and
   * the file rewritten. False in the steady state, which is what keeps that from happening
   * on every launch.
   */
  changed: boolean
  /** Lower-cased `pathRule` of every profile this program wrote, for the next merge. */
  owned: string[]
}

/**
 * Everything that is ours to decide, compared for equality.
 *
 * `windowPos` is excluded deliberately: Magpie moves its own window and records it here,
 * and counting that as a change would restart Magpie every time the user dragged it.
 */
function signature(config: Obj): string {
  const rest: Obj = { ...config }
  delete rest.windowPos
  return JSON.stringify(rest)
}

/**
 * Merge what we want into what is already there.
 *
 * Profiles are the delicate part. `profiles[0]` is Magpie's global default and is kept,
 * not replaced — only its scaling mode is set, so that the manual hotkey scales with the
 * shader the user picked. Beyond that, a profile is only ever removed if we are the ones
 * who wrote it (`previouslyOwned`); one the user added in Magpie's own interface survives
 * untouched, including when it claims an executable we would otherwise have written —
 * their explicit choice outranks our derived one, and two profiles for one path would
 * just be a duplicate they have to look at.
 */
export function buildConfig(
  existing: Obj | null,
  desired: DesiredMagpie,
  previouslyOwned: string[]
): MagpieConfigResult {
  const config: Obj = existing ? { ...existing } : {}
  const mine = new Set(previouslyOwned.map((p) => p.trim().toLowerCase()))

  // Ours to dictate. Update checks are off because this program does not go to the
  // network and a copy it ships may not either; the tray icon stays because it is the
  // only handle the user has on a Magpie that has outlived its game.
  config.autoCheckForUpdates = false
  config.showNotifyIcon = true
  config.alwaysRunAsAdmin = false
  config.developerMode = false
  config.debugMode = false
  config.benchmarkMode = false
  // Follows the launcher's language, but only when Magpie is not already saying the same
  // thing in its own spelling. Magpie normalises this field when it rewrites the file, and
  // a plain assignment that disagreed with the normalised form would differ from the file
  // on every comparison — making `changed` permanently true, and restarting Magpie on
  // every launch over one word.
  if (!sameLanguage(config.language, desired.language)) config.language = desired.language

  // Theirs if they have any.
  if (!isObj(config.shortcuts)) config.shortcuts = { ...SEED_SHORTCUTS }

  // Written whole when absent or empty — see SEED_SCALING_MODES for why an omitted list
  // is not a harmless default.
  const modes = scalingModesOf(existing)
  config.scalingModes = modes

  const indexFor = (mode: UpscaleMode): number => modeIndexIn({ scalingModes: modes }, mode)

  const oldProfiles: unknown[] = Array.isArray(existing?.profiles) ? existing.profiles : []

  // profiles[0] is the global default profile, and it is a different thing from the rest.
  const defaultProfile: Obj = isObj(oldProfiles[0]) ? { ...oldProfiles[0] } : {}
  defaultProfile.scalingMode = indexFor(desired.defaultMode)

  // Everything the user put there stays, in its original order. Ones this program wrote
  // are set aside rather than dropped: they are rebuilt below, but *onto* whatever Magpie
  // last serialised for them.
  const kept: Obj[] = []
  const claimed = new Set<string>()
  const previous = new Map<string, Obj>()
  for (const raw of oldProfiles.slice(1)) {
    if (!isObj(raw)) continue
    const rule = typeof raw.pathRule === 'string' ? raw.pathRule.trim().toLowerCase() : ''
    if (rule !== '' && mine.has(rule)) {
      previous.set(rule, raw)
      continue
    }
    kept.push(raw)
    if (rule !== '') claimed.add(rule)
  }

  const ours: Obj[] = []
  const owned: string[] = []
  for (const profile of desired.profiles) {
    const rule = profile.exe.trim().toLowerCase()
    if (rule === '' || claimed.has(rule)) continue
    claimed.add(rule)
    owned.push(rule)
    // Merged onto the profile that was there, not written fresh over it. A profile is
    // Magpie's own record too: open its interface and set a capture method, a frame-rate
    // limit or a cursor rule on this game and Magpie saves those fields here. Emitting
    // only the six this program cares about would throw all of that away — and, because
    // the result would then differ from the file on every comparison, would make `changed`
    // permanently true and stop-write-start Magpie on every single launch, which is the
    // one thing the whole design is arranged to avoid.
    ours.push({
      ...(previous.get(rule) ?? {}),
      name: profile.name,
      packaged: false,
      pathRule: profile.exe,
      classNameRule: '',
      autoScale: true,
      scalingMode: indexFor(profile.mode)
    })
  }

  config.profiles = [defaultProfile, ...kept, ...ours]

  return {
    config,
    changed: existing === null || signature(config) !== signature(existing),
    owned
  }
}
