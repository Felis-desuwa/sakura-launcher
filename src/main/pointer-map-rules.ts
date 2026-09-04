// Extension spelled out: `scripts/pointer-map-test.mts` loads this file straight into node.

/**
 * Putting a click back where the picture says it should go.
 *
 * An upscaler of this kind does not make the game's window bigger. It captures that
 * window, draws the enlarged picture on a second window covering the whole screen, and
 * leaves the game exactly where it was — a small rectangle somewhere in the middle. Input
 * never passes through it at all.
 *
 * With an ordinary mouse nobody notices, and the reason is worth stating because the whole
 * feature turns on it: the capture includes the cursor (this is why the presets pin
 * `CaptureApi: WGC` — see `LOSSLESS_PRESETS`), so the pointer you see on the enlarged
 * picture *is* the real pointer, magnified. It is over the button it looks like it is over,
 * and a click lands.
 *
 * A streaming client that sends **absolute** coordinates breaks that. Tapping the screen
 * teleports the real pointer to the screen coordinate under your finger, which is a point
 * on the enlarged picture and almost never inside the game's small rectangle. The click
 * lands on whatever else is there.
 *
 * What this module holds is the arithmetic that undoes it: given where the game window is,
 * where the upscaler's output window is, and how the picture was fitted into it, turn a
 * screen point into the point on the game window it appears to be over. It is a pure module
 * so the geometry can be pinned by a harness — the code that *acts* on it runs inside a
 * mouse hook, where a mistake is expensive and stepping through it is not an option.
 */

/** A rectangle in physical screen coordinates: top-left plus a size. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * How the source picture is fitted into the output window.
 *
 * Named after what it does to the geometry rather than after any one upscaler's spelling,
 * because the arithmetic is the same wherever it comes from — `fitModeOf` is the only part
 * that knows Lossless Scaling's vocabulary.
 */
export type FitMode =
  /** Largest rectangle of the source's own proportions that fits. Letterboxed. */
  | 'aspect'
  /** As above but whole multiples only, so the remainder stays black. */
  | 'integer'
  /** Fills the output window, proportions be damned. */
  | 'stretch'
  /**
   * A multiple the profile names outright, which owes the screen nothing.
   *
   * The other three modes all derive the scale from how big the screen is, so the picture
   * is as large as it can be. This one does not: the profile says 2.1× and the picture is
   * 2.1×, leaving a border on every side that none of the others would. Missing it is not
   * a small error — the mapping comes out wrong by the factor *and* by the offset, at
   * every point on the screen.
   */
  | 'fixed'

/**
 * How small a source rectangle stops being credible as a game window.
 *
 * A tooltip, a splash, an off-screen helper — measure one of those as the source and the
 * whole screen compresses into a few pixels. That does not look like a bad mapping from
 * the sofa; it looks like the pointer has stopped moving at all. Refusing is the only safe
 * answer and 200px is well under any window worth enlarging.
 */
export const MIN_SOURCE = 200

/**
 * Read a Lossless Scaling profile's two scaling elements as a fit mode.
 *
 * `ScalingFitMode` is the one that actually decides, and it is read first for that reason:
 * it is what the user (or a preset) wrote down about *where the picture goes*, while
 * `ScalingType` names the algorithm that fills it. The one algorithm that also constrains
 * the geometry is `Integer`, which refuses a fractional multiple outright — so it only
 * gets a say once `ScalingFitMode` has said "keep the proportions".
 *
 * `SharpBilinear` deliberately does **not** land here: it takes the picture up by a whole
 * multiple internally and then covers the remainder, so what reaches the screen fills the
 * same rectangle `aspect` describes. Treating it as `integer` would put the mapping off by
 * the size of the border it does not leave.
 *
 * A missing `ScalingFitMode` is `aspect`, which is Lossless Scaling's own default and the
 * value every preset in this program writes.
 *
 * `ScalingMode` is the third element and it outranks the algorithm, because it decides
 * whether the scale is derived at all. `Custom` means the profile names the factor itself
 * (`ScaleFactor`) and the picture is that size whatever the screen measures — the presets
 * here all write `Auto`, but a mode naming one of the user's own profiles is cloned
 * verbatim, and a fixed factor is an ordinary thing to find in one.
 */
export function fitModeOf(
  scalingType: string | null,
  scalingFitMode: string | null,
  scalingMode: string | null = null
): FitMode {
  const fit = (scalingFitMode ?? '').trim().toLowerCase()
  if (fit === 'fullscreen') return 'stretch'
  if ((scalingMode ?? '').trim().toLowerCase() === 'custom') return 'fixed'
  if ((scalingType ?? '').trim().toLowerCase() === 'integer') return 'integer'
  return 'aspect'
}

/**
 * Where the enlarged picture actually lands inside the output window.
 *
 * Centred, because that is what every fit mode here does with the remainder. A source with
 * no area at all returns the output window unchanged rather than dividing by zero — the
 * caller treats that as "we do not know yet" and stays out of the way.
 */
export function pictureRect(src: Rect, out: Rect, fit: FitMode, factor = 0): Rect {
  if (src.w <= 0 || src.h <= 0 || out.w <= 0 || out.h <= 0) return { ...out }
  if (fit === 'stretch') return { ...out }
  /*
   * `factor` is read only by `fixed`, and a `fixed` with no usable factor falls through to
   * the proportional fit rather than inventing one. That is the honest answer to "the
   * profile says Custom and we could not read the number" — it is also what the picture
   * looks like most of the time, where a guessed multiple would be wrong everywhere.
   *
   * Not clamped to the screen: an upscaler asked for more than fits draws what it was
   * asked for and lets the edges fall off, and a mapping that pretended otherwise would
   * disagree with the picture over the whole of it.
   */
  if (fit === 'fixed' && factor > 0) {
    const fw = Math.round(src.w * factor)
    const fh = Math.round(src.h * factor)
    return {
      x: out.x + Math.round((out.w - fw) / 2),
      y: out.y + Math.round((out.h - fh) / 2),
      w: fw,
      h: fh
    }
  }

  let scale = Math.min(out.w / src.w, out.h / src.h)
  if (fit === 'integer') {
    // A whole multiple, and never zero: an upscaler asked to scale a window larger than
    // the screen presents it at its original size rather than vanishing it.
    scale = Math.max(1, Math.floor(scale))
  }

  const w = Math.round(src.w * scale)
  const h = Math.round(src.h * scale)
  return {
    x: out.x + Math.round((out.w - w) / 2),
    y: out.y + Math.round((out.h - h) / 2),
    w,
    h
  }
}

/**
 * What the hook should do with one pointer event.
 *
 * Two outcomes, and the absence of a third is the whole lesson of this file.
 *
 * The first version had a `swallow` for a point on the letterbox — inside the output
 * window, off the picture, nothing there but black — on the reasoning that dropping it
 * could not cause a wrong click. That reasoning **deadlocks**, and it does so in the
 * only situation this feature exists for. A streaming client's every event is injected,
 * including every *move*; swallow them and a pointer that is on the letterbox can never
 * leave it, because the events that would move it off are exactly the ones being dropped.
 * The mouse stops dead and the clicks go nowhere. It was reported within minutes.
 *
 * So a point inside the output window is **clamped onto the picture and mapped**, never
 * dropped. The pointer is then always somewhere on the game window, which is both always
 * escapable and — as a free consequence — the thing `ClipCursor` was there to do.
 *
 * `pass` is left for the two cases where this has no business acting: a point on another
 * monitor, which is somebody's actual desktop, and a source we have not measured.
 */
export type PointerVerdict = { kind: 'map'; x: number; y: number } | { kind: 'pass' }

/** Whether a point falls inside a rectangle, right and bottom edges excluded. */
function inside(px: number, py: number, r: Rect): boolean {
  return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Two gestures arrive down one wire, and mapping is right for one and fatal for the other.
 *
 * A remote client of the kind this exists for is usually *combined*: a tap names a position
 * outright (absolute), and a press-and-drag works like a trackpad (relative). Both reach a
 * mouse hook as the same thing — a screen coordinate — and nothing in the event says which
 * it was.
 *
 * The distinction is not cosmetic. Mapping compresses the screen onto the smaller game
 * window, and **a compression has a fixed point**. Feed relative motion through it and every
 * step is compressed again, so the pointer converges on that point and stops. With a 1284×724
 * game filling a 2560×1440 screen the fixed point is (55, 105) — the top-left of the picture,
 * which is exactly where the pointer was found stuck.
 *
 * What tells them apart is that we know where we last put the pointer. A relative step is
 * measured from there, so it lands near it; a tap names somewhere else entirely. In a real
 * session the two populations do not overlap: drags topped out at 96px, and the smallest tap
 * jump was 129px.
 */
export const TAP_DISTANCE = 110

/**
 * Whether this event continues from where we last placed the pointer, or names a new place.
 *
 * `lastPlaced` is null before we have placed it at all, and then every event is a tap — which
 * is the right answer, because there is no motion to continue.
 */
export function isDragStep(
  px: number,
  py: number,
  lastPlaced: { x: number; y: number } | null
): boolean {
  if (lastPlaced === null) return false
  const dx = px - lastPlaced.x
  const dy = py - lastPlaced.y
  return dx * dx + dy * dy < TAP_DISTANCE * TAP_DISTANCE
}

/**
 * Where the pointer should appear to be, in the coordinates of the enlarged picture.
 *
 * This is the piece that keeps a drag feeling right. The virtual pointer lives in *screen*
 * space and takes the client's step at full size; mapping then divides it by the scale, so
 * the pointer moves half as far inside a game enlarged 2×  — and the upscaler magnifies that
 * back to exactly the step the user made. Accumulating in game space instead would halve the
 * drag and make the pointer feel heavy.
 *
 * Clamped to the output window, so a drag that runs off the edge stops at the edge instead of
 * wandering somewhere no mapping can bring it back from.
 */
export function advanceVirtual(
  virtual: { x: number; y: number } | null,
  px: number,
  py: number,
  lastPlaced: { x: number; y: number } | null,
  out: Rect
): { x: number; y: number } {
  if (virtual === null || lastPlaced === null || !isDragStep(px, py, lastPlaced)) {
    return { x: clamp(px, out.x, out.x + out.w - 1), y: clamp(py, out.y, out.y + out.h - 1) }
  }
  return {
    x: clamp(virtual.x + (px - lastPlaced.x), out.x, out.x + out.w - 1),
    y: clamp(virtual.y + (py - lastPlaced.y), out.y, out.y + out.h - 1)
  }
}

/**
 * Turn a screen point into the point on the source window it appears to be over.
 *
 * The source rectangle is the game's **client area** in screen coordinates, not its window
 * rectangle. That is the same measurement `checkWholeMultipleFit` works from, and it is
 * the one the upscaler is enlarging — mapping against the window rectangle instead would
 * put every click out by the width of the border.
 *
 * The result is clamped to the last row and column of the source. Rounding at the far edge
 * of a picture scaled by 2.4 can land one pixel past it, and a click one pixel outside the
 * window is not a click on the window at all.
 */
export function mapPointer(
  px: number,
  py: number,
  src: Rect,
  out: Rect,
  fit: FitMode,
  factor = 0
): PointerVerdict {
  if (src.w <= 0 || src.h <= 0 || out.w <= 0 || out.h <= 0) return { kind: 'pass' }
  // See MIN_SOURCE. A window this small is one we misidentified, and mapping into it is
  // indistinguishable from the pointer having died.
  if (src.w < MIN_SOURCE || src.h < MIN_SOURCE) return { kind: 'pass' }
  if (!inside(px, py, out)) return { kind: 'pass' }

  const pic = pictureRect(src, out, fit, factor)
  // Nothing is being enlarged, so there is nothing to undo. Reached when the game already
  // fills the screen, and worth short-circuiting rather than mapping by a factor of one:
  // it is also the shape a misidentified window takes, and doing nothing is the right
  // answer to both.
  if (pic.w === src.w && pic.h === src.h) return { kind: 'pass' }

  // Clamped, not rejected — see PointerVerdict. A point on the letterbox is answered with
  // the nearest point on the picture, which keeps the pointer somewhere it can move from.
  const cx = clamp(px, pic.x, pic.x + pic.w - 1)
  const cy = clamp(py, pic.y, pic.y + pic.h - 1)

  const u = (cx - pic.x) / pic.w
  const v = (cy - pic.y) / pic.h
  return {
    kind: 'map',
    x: src.x + Math.min(src.w - 1, Math.floor(u * src.w)),
    y: src.y + Math.min(src.h - 1, Math.floor(v * src.h))
  }
}
