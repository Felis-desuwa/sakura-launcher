// Extension spelled out: the harnesses in `scripts/` load this file straight into node,
// where nothing fills the extension in.
import {
  MAGPIE_MODES,
  MAX_UPSCALE_MODE,
  normalizeUpscaleMode,
  type Game,
  type Settings,
  type UpscaleMode
} from '../shared/types.ts'

/**
 * Deciding *what* is to be scaled and *how*, without knowing which program will do it.
 *
 * Both backends this launcher can drive — Magpie and Lossless Scaling — turn out to want
 * the same thing said to them: a list of executables, each with a name to display and the
 * name of a mode in their own configuration. Magpie calls the result a profile with a
 * `pathRule`; Lossless Scaling calls it a game profile with a `<Path>` filter. The
 * arithmetic that produces that list — which games qualify, whose setting wins, how many
 * fit, in what order — is identical, so it lives here once instead of twice.
 *
 * What is *not* here is anything either program does with the answer. `magpie-config.ts`
 * and `lossless-config.ts` are where the two diverge, and they diverge completely.
 *
 * Nothing here imports electron; the harnesses load it directly under node, the same
 * arrangement `save-rules.ts` and `scan-core.ts` have.
 */

/**
 * How many games get a profile written for them.
 *
 * Profiles are written for *every* enabled game at once rather than for the one being
 * launched, because rewriting the file is the dangerous half of this feature: the upscaler
 * must be stopped first, or its next save overwrites the file from memory. Covering the
 * whole library means the desired config is nearly always the config already on disk, so
 * the stop-write-start dance happens a handful of times in a library's life instead of
 * on every launch. The cap keeps a two-thousand-game library from producing a config file
 * to match; the least recently played fall off first, since they are the ones least
 * likely to be started next.
 */
export const MAX_UPSCALE_TARGETS = 200

/** Longest profile name written into an upscaler's config. Their UIs display these. */
const MAX_PROFILE_NAME = 80

/**
 * The seven built-in Magpie mode names live in `shared/types.ts`, because the settings
 * page and the right-click menu offer them too and the renderer cannot reach into
 * `src/main`.
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
 * Any name is admissible, because a mode assembled in Magpie's own interface — or a
 * profile made in Lossless Scaling's — is called whatever its author called it and this
 * line has to be able to say so. Magpie's seven built-ins are still recognised loosely —
 * case, spaces and dashes all forgiven, and the keys this field used to hold translated —
 * but anything else is passed through as typed, since only the upscaler's own config file
 * knows whether that mode exists, and it is read far from here.
 *
 * Empty is nothing, and so is a name too long to be one: the whole line is then treated as
 * absent, which reads back as "follow the setting". The cost of a typo has to be "it did
 * not take effect", never "it cleared something".
 */
export function modeFromLabel(text: string): UpscaleMode | null {
  const raw = text.trim()
  if (raw === '' || raw.length > MAX_UPSCALE_MODE) return null

  const loose = raw.toLowerCase().replace(/[\s_-]+/g, '')
  for (const mode of DEFAULT_MODE_ORDER) {
    if (mode.toLowerCase().replace(/[\s_-]+/g, '') === loose) return mode
  }
  return normalizeUpscaleMode(raw)
}

/**
 * Whether this entry is the kind of thing an upscaler could scale at all.
 *
 * An archive has no window, and a folder that went missing has no executable to match a
 * profile against. Both would produce a profile that can never fire, so neither gets one.
 */
export function upscaleApplies(game: Game): boolean {
  return game.kind === 'installed' && !game.missing && game.exe.trim() !== ''
}

/**
 * What actually happens for one game: the setting and the per-game override, resolved.
 *
 * The master switch wins outright when it is off. A game individually switched on does
 * **not** bring the feature back to life — see `Settings.upscale` for why that matters.
 */
export function effectiveUpscale(
  settings: Settings,
  game: Game
): { on: boolean; mode: UpscaleMode } {
  // The one place either stored value is read, and so the one place old keys have to be
  // turned back into names.
  const mode = normalizeUpscaleMode(game.upscaleMode ?? settings.upscaleMode)
  if (!settings.upscale || !upscaleApplies(game) || game.upscale === false) {
    return { on: false, mode }
  }
  return { on: true, mode }
}

/** One thing to scale: an executable to watch for, what to call it, and how to scale it. */
export interface UpscaleTarget {
  /** Absolute path to the executable — the upscaler matches windows against this. */
  exe: string
  /** What to call it in the upscaler's own interface. */
  name: string
  mode: UpscaleMode
}

/**
 * Trim a game's title down to something an upscaler's interface can show.
 *
 * Control characters go because they would survive serialisation as escapes and make the
 * file unreadable to a person; the length cap is so one absurdly named folder cannot
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
 * Everything that should be in the upscaler's config right now.
 *
 * Ordering is by most recently played, so that the cap drops the games least likely to be
 * started next — but it also has to be **stable**, because the caller compares the result
 * against what is already on disk to decide whether the upscaler must be stopped and the
 * file rewritten. Two calls on the same library that differ only in order would make that
 * comparison report a change that is not one, and the stop-write-start would then happen
 * on every single launch. Hence the explicit tiebreak on id.
 *
 * Duplicate executables collapse: two entries pointing at the same binary are one window
 * as far as either upscaler is concerned, and a second profile for the same path would be
 * dead weight the user has to look at.
 */
export function upscaleTargets(settings: Settings, games: Game[]): UpscaleTarget[] {
  const enabled = games.filter((g) => effectiveUpscale(settings, g).on)

  const ranked = [...enabled].sort((a, b) => {
    const at = a.lastLaunchedAt ?? 0
    const bt = b.lastLaunchedAt ?? 0
    if (at !== bt) return bt - at
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  const seen = new Set<string>()
  const out: UpscaleTarget[] = []
  for (const game of ranked) {
    const exe = game.exe.trim()
    const key = exe.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ exe, name: profileName(game.name, exe), mode: effectiveUpscale(settings, game).mode })
    if (out.length >= MAX_UPSCALE_TARGETS) break
  }
  return out
}
