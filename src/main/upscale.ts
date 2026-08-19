import type { Game, UpscaleNotice, UpscaleStatus } from '../shared/types'
import { MAGPIE_MODES } from '../shared/types'
import * as db from './db'
import {
  magpieBeforeLaunch,
  magpieModes,
  magpieSessionsChanged,
  magpieStatus,
  onMagpieNotice,
  openMagpieFolder,
  openMagpieSettings,
  shutdownMagpie,
  warmMagpie
} from './magpie'
import {
  clearLosslessProfiles,
  losslessBeforeLaunch,
  losslessModes,
  losslessSessionsChanged,
  losslessStatus,
  onLosslessNotice,
  openLosslessSettings,
  revealLossless,
  shutdownLossless,
  warmLossless
} from './lossless'

/**
 * Which program does the scaling.
 *
 * Everything outside this file — `launcher.ts`, the IPC handlers, the renderer — asks for
 * "upscaling" and never names a backend. That is the whole job here: one switch statement
 * in one place, so that adding the second upscaler did not mean teaching every caller
 * about both.
 *
 * The two are exclusive, and the transition between them is the part worth reading. Both
 * leave things behind — a running process, profiles in a configuration file — and a switch
 * that only started the new one would leave the old one's leavings in place with nothing
 * left in the interface to explain them.
 */

function backend(): 'magpie' | 'lossless' {
  return db.getSettings().upscaler
}

export function upscaleBeforeLaunch(game: Game, opts: { elevated: boolean }): Promise<void> {
  return backend() === 'lossless'
    ? losslessBeforeLaunch(game, opts)
    : magpieBeforeLaunch(game, opts)
}

/**
 * Both are told, whichever is in force.
 *
 * Deliberately not routed. This is the signal that a game has stopped being played, and
 * the thing it triggers is "stop the upscaler if nothing needs it" — which the backend the
 * user has just switched *away* from needs to hear more than the current one does. Each
 * already answers for itself whether anything of its own is running, so telling both costs
 * nothing and closes the gap.
 */
export function upscaleSessionsChanged(playing: string[]): void {
  magpieSessionsChanged(playing)
  losslessSessionsChanged(playing)
}

export function warmUpscale(): void {
  if (backend() === 'lossless') warmLossless()
  else warmMagpie()
}

export function shutdownUpscale(): void {
  shutdownMagpie()
  shutdownLossless()
}

export function upscaleStatus(): Promise<UpscaleStatus> {
  return backend() === 'lossless' ? losslessStatus() : magpieStatus()
}

/**
 * The mode names to offer, read from whichever backend's own configuration.
 *
 * Magpie falls back to its seven built-ins, because they are what its config file will
 * hold once it has been written and choosing one before that is meaningful. Lossless
 * Scaling has no equivalent and must not be given one: its profiles are the user's own
 * creations, so an empty list means "there is nothing there to choose yet" — and offering
 * an invented name would let the user pick something that silently scales nothing.
 */
export async function upscaleModes(): Promise<string[]> {
  if (backend() === 'lossless') return losslessModes()
  const modes = await magpieModes()
  return modes.length > 0 ? modes : [...MAGPIE_MODES]
}

export function openUpscalerSettings(): void {
  if (backend() === 'lossless') openLosslessSettings()
  else openMagpieSettings()
}

export function revealUpscaler(): void {
  if (backend() === 'lossless') void revealLossless()
  else openMagpieFolder()
}

/** Both, so a toast is not lost the moment the backend changes under it. */
export function onUpscaleNotice(fn: (notice: UpscaleNotice) => void): () => void {
  const offMagpie = onMagpieNotice(fn)
  const offLossless = onLosslessNotice(fn)
  return () => {
    offMagpie()
    offLossless()
  }
}

/**
 * Tidy up after a setting that has just changed.
 *
 * Called with what the settings page sent, so that "which of these mattered" is decided
 * once here rather than at the call site. Two changes matter:
 *
 *  - **Switching away from Lossless Scaling, or off altogether**, has to take our profiles
 *    out of their `Settings.xml`. Leaving them would be litter in software the user paid
 *    for, under a name they never chose, in a program this one may never open again.
 *  - **Switching on** warms whichever backend is now in force — for Magpie that means
 *    laying the copy down before it is first needed; for Lossless Scaling it means taking
 *    the copy of their file while it is certainly still untouched.
 *
 * Magpie needs no equivalent of the clearing: its config file is a private copy under
 * `%APPDATA%`, and deleting the folder is already offered as one button.
 */
export function upscaleSettingsChanged(patch: { upscale?: boolean; upscaler?: string }): void {
  const settings = db.getSettings()
  const leftLossless =
    (patch.upscaler !== undefined && settings.upscaler !== 'lossless') || patch.upscale === false
  if (leftLossless) void clearLosslessProfiles()
  if (patch.upscale === true || (patch.upscaler !== undefined && settings.upscale)) warmUpscale()
}
