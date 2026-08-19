// Extension spelled out: `scripts/display-test.mts` loads this file straight into node.
import type { DisplayFacts, GpuFacts, MachineFacts } from '../shared/types.ts'

/**
 * What follows from the machine's display hardware.
 *
 * Split from `display-info.ts` for the reason every pure module here is split: the reading
 * needs a Windows API and a PowerShell to reach it, and the judgement does not. Everything
 * below is arithmetic over facts somebody else measured, so it can be tested without a
 * screen, a window or an upscaler.
 *
 * The line this module is careful about is the one between a **fact** and a **preference**.
 * Whether HDR is on is a fact, and getting it wrong makes the picture visibly wrong; which
 * scaling algorithm looks best is a preference, and this program has no business holding
 * one inside somebody else's software. So there are functions here that answer the first
 * kind and deliberately none that answer the second.
 *
 * Nothing here imports electron.
 */

/** The display the desktop's origin sits on, or the first one, or null for no facts at all. */
export function primaryDisplay(facts: MachineFacts | null): DisplayFacts | null {
  if (!facts || facts.displays.length === 0) return null
  return facts.displays.find((d) => d.primary) ?? facts.displays[0]
}

/**
 * Whether the screen a game will be scaled onto has HDR switched on.
 *
 * **Null means "could not tell", and is not false.** Every caller has to keep them apart:
 * writing `false` on an unknown would turn HDR support off in a profile that had it on,
 * which is the mirror image of the bug this exists to fix.
 *
 * The primary display is the answer because that is where these games open and where
 * Lossless Scaling's own `OutputDisplayId` of 0 sends the result. A machine whose
 * displays disagree gets the primary's answer and the full list on screen to argue with.
 */
export function hdrActive(facts: MachineFacts | null): boolean | null {
  const display = primaryDisplay(facts)
  return display === null ? null : display.hdrEnabled
}

/** A window's client area, which is what an upscaler actually sees. */
export interface Size {
  width: number
  height: number
}

/**
 * The largest whole multiple of `client` that fits inside `display`, and 1 when none does.
 *
 * One is not a scale factor here, it is a **refusal**: whole-multiple scaling that cannot
 * find a multiple does not fall back to something else and does not report a problem, it
 * simply presents the picture at its original size. That silence cost a whole debugging
 * session — a 1284×724 window on a 2560×1440 screen needs 2568×1448 to double, overshoots
 * by eight pixels in each direction, and comes out looking as though scaling was never
 * switched on. The four pixels that did it were the window's own border.
 */
export function wholeMultiple(client: Size, display: Size): number {
  if (client.width <= 0 || client.height <= 0) return 1
  const fit = Math.min(
    Math.floor(display.width / client.width),
    Math.floor(display.height / client.height)
  )
  return Math.max(1, fit)
}

/** What aspect-preserving fullscreen scaling produces: the picture, and the bars beside it. */
export interface FitResult {
  width: number
  height: number
  scale: number
  /** Black bar width on **each** side, left and right. */
  barX: number
  /** Black bar height on **each** side, top and bottom. */
  barY: number
}

/**
 * The output of Lossless Scaling's automatic scale factor with aspect ratio preserved.
 *
 * The counterpart to `wholeMultiple`: it takes whatever fraction fills the screen, so it
 * always scales, and pays for it with weights that are not perfectly even. For the library
 * this program is built for that is the better trade nearly every time, which is why the
 * preset built on it is offered first.
 */
export function aspectFit(client: Size, display: Size): FitResult {
  if (client.width <= 0 || client.height <= 0) {
    return { width: 0, height: 0, scale: 1, barX: 0, barY: 0 }
  }
  const scale = Math.min(display.width / client.width, display.height / client.height)
  const width = Math.round(client.width * scale)
  const height = Math.round(client.height * scale)
  return {
    width,
    height,
    scale,
    barX: Math.max(0, Math.round((display.width - width) / 2)),
    barY: Math.max(0, Math.round((display.height - height) / 2))
  }
}

/**
 * The adapter worth naming, by reported memory.
 *
 * Machines in this library's world routinely carry three or four adapters that are not
 * graphics cards: remote-desktop tools and headset software each install a virtual display
 * adapter, and they report no memory at all. Ordering by memory drops them without needing
 * a list of their names, which would go stale.
 */
export function mainGpu(facts: MachineFacts | null): GpuFacts | null {
  if (!facts) return null
  const real = facts.gpus.filter((g) => g.memoryMb > 0)
  if (real.length === 0) return null
  return real.reduce((best, g) => (g.memoryMb > best.memoryMb ? g : best))
}
