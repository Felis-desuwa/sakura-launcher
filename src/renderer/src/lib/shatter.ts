/**
 * Breaking a square the way a mirror breaks.
 *
 * The pieces are `clip-path` polygons over their own copy of the artwork, so the break
 * costs no canvas and no image processing — the same picture is shown through a couple
 * of dozen different holes and each hole is moved somewhere else.
 *
 * What makes it read as glass is entirely in the geometry, and two things do the work:
 *
 * The lateral cracks are *discontinuous*. Rings that close all the way round the impact
 * are what a spider builds, not what a stone does — real lateral cracks are short chords
 * that run between two neighbouring radial cracks and stop there, and the next sector
 * over is cut at a different distance, or not at all. So every sector is divided along
 * its own radii, independently of its neighbours: some are cut twice, some once, some
 * are a single long sliver running from the impact clean out to the frame.
 *
 * And the radial cracks bow. A crack that travels dead straight from a point is a
 * sunburst; one that bends, even by a few percent, stops looking drawn.
 */

export interface Fragment {
  /** CSS `clip-path` polygon, in percentages of the box. */
  clip: string
  /** Unit direction away from the impact point. */
  dx: number
  dy: number
  /** How far it slides sideways, in px, by the time it is gone. */
  dist: number
  /** How far it drops, in px. Glass mostly falls; it does not fly. */
  fall: number
  /** Degrees it tumbles through on the way. */
  rot: number
  /** Progress at which this piece lets go. Pieces at the impact go first. */
  start: number
}

export interface MirrorBreak {
  fragments: Fragment[]
  /** Crack lines, as SVG `points` strings in a 0–100 box. */
  cracks: string[]
}

type Point = [number, number]

/** Where a ray leaving `(cx, cy)` at `deg` meets the wall of the box. */
function toEdge(cx: number, cy: number, deg: number): Point {
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  let t = Infinity
  if (cos > 1e-9) t = Math.min(t, (100 - cx) / cos)
  if (cos < -1e-9) t = Math.min(t, -cx / cos)
  if (sin > 1e-9) t = Math.min(t, (100 - cy) / sin)
  if (sin < -1e-9) t = Math.min(t, -cy / sin)
  return [cx + cos * t, cy + sin * t]
}

/**
 * The angles the cracks run out at.
 *
 * Not evenly spaced: an impact cracks harder toward one side, so the rays are pulled
 * toward a direction picked at random. Spokes that end up almost on top of each other
 * are dropped — a sector narrower than a degree or two is invisible anyway, and losing
 * one is itself a source of variety.
 */
function anglesFor(rays: number): number[] {
  const bias = Math.random() * 360
  const pull = Math.random() * 0.7 * (180 / rays)
  const jitter = (200 + Math.random() * 160) / rays

  const raw: number[] = []
  for (let i = 0; i < rays; i++) {
    const base = (i * 360) / rays
    raw.push(
      base + pull * Math.sin(((base - bias) * Math.PI) / 180) + (Math.random() - 0.5) * jitter
    )
  }
  raw.sort((a, b) => a - b)

  const kept = raw.filter((deg, i) => i === 0 || deg - raw[i - 1] > 7)
  if (kept.length > 4 && kept[0] + 360 - kept[kept.length - 1] <= 7) kept.pop()
  return kept
}

/**
 * How far out this one sector is cut across, if at all.
 *
 * Sometimes not at all, which leaves the long splinter that every broken mirror has a
 * few of; usually once; occasionally twice. Neighbouring sectors never consult each
 * other, which is the whole point.
 */
function cutsForSector(): number[] {
  const roll = Math.random()
  const count = roll < 0.2 ? 0 : roll < 0.72 ? 1 : 2
  const picks: number[] = []
  for (let tries = 0; picks.length < count && tries < 20; tries++) {
    const r = 0.2 + Math.random() * 0.64
    if (picks.every((p) => Math.abs(p - r) > 0.18)) picks.push(r)
  }
  return picks.sort((a, b) => a - b)
}

const fmt = ([x, y]: Point): string => `${x.toFixed(2)}% ${y.toFixed(2)}%`
const svg = ([x, y]: Point): string => `${x.toFixed(2)},${y.toFixed(2)}`

/**
 * Break a box, differently every time.
 *
 * @param crackPhase progress spent cracking before the first piece may fall
 */
export function buildMirror(crackPhase: number): MirrorBreak {
  // Off-centre on purpose: a mirror struck dead in the middle comes apart symmetrically,
  // and symmetry is exactly what stops it looking broken.
  const cx = 32 + Math.random() * 36
  const cy = 28 + Math.random() * 38

  const angles = anglesFor(7 + Math.floor(Math.random() * 6))
  const count = angles.length
  const edges = angles.map((deg) => toEdge(cx, cy, deg))
  // Each crack bows to one side. Zero at both ends, so a ray still starts at the impact
  // and still lands exactly on the wall of the box.
  const bends = angles.map(() => (Math.random() - 0.5) * 0.24)

  /** A point at fraction `r` along crack `i`, following its bow. */
  const ray = (i: number, r: number): Point => {
    const [ex, ey] = edges[i]
    const rad = (angles[i] * Math.PI) / 180
    const bow = bends[i] * Math.sin(Math.PI * r) * Math.hypot(ex - cx, ey - cy)
    return [cx + (ex - cx) * r - Math.sin(rad) * bow, cy + (ey - cy) * r + Math.cos(rad) * bow]
  }

  /** Points walking along crack `i` between two radii, enough of them to show the bow. */
  const along = (i: number, from: number, to: number): Point[] => {
    const steps = 3
    const out: Point[] = []
    for (let s = 0; s <= steps; s++) out.push(ray(i, from + ((to - from) * s) / steps))
    return out
  }

  const corners: { deg: number; point: Point }[] = (
    [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100]
    ] as Point[]
  ).map((point) => ({
    deg: ((Math.atan2(point[1] - cy, point[0] - cx) * 180) / Math.PI + 360) % 360,
    point
  }))

  /** Corners of the box lying between two crack angles, walking forwards. */
  const cornersBetween = (from: number, to: number): Point[] => {
    const span = (deg: number): number => (deg - from + 360) % 360
    const width = (to - from + 360) % 360
    return corners
      .filter((c) => span(c.deg) > 0.001 && span(c.deg) < width)
      .sort((a, b) => span(a.deg) - span(b.deg))
      .map((c) => c.point)
  }

  const reach = Math.max(...corners.map((c) => Math.hypot(c.point[0] - cx, c.point[1] - cy)))

  const fragments: Fragment[] = []
  const push = (points: Point[]): void => {
    let mx = 0
    let my = 0
    for (const [x, y] of points) {
      mx += x
      my += y
    }
    mx /= points.length
    my /= points.length
    const away = Math.hypot(mx - cx, my - cy) || 1

    fragments.push({
      clip: `polygon(${points.map(fmt).join(', ')})`,
      dx: (mx - cx) / away,
      dy: (my - cy) / away,
      // Enough sideways travel to out-run the fall, or every piece drops the same way
      // and they land in a stack that reads as sheets of paper rather than fragments.
      dist: 26 + Math.random() * 70,
      fall: 80 + Math.random() * 130,
      rot: (Math.random() - 0.5) * 130,
      // The break travels outward from the impact rather than the whole surface letting
      // go at once — measured in distance, not in bands, since the bands are ragged.
      start: crackPhase + Math.min(1, away / reach) * 0.2 + Math.random() * 0.12
    })
  }

  const cracks: string[] = []

  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count
    const cuts = cutsForSector()
    const bounds = [0, ...cuts, 1]

    for (let b = 0; b < bounds.length - 1; b++) {
      const inner = bounds[b]
      const outer = bounds[b + 1]
      const points: Point[] = [...along(i, inner, outer)]
      // The outermost piece of a sector has to go round any corner of the box it spans,
      // or the polygon cuts the corner off and leaves a triangular hole in the picture.
      if (outer === 1) points.push(...cornersBetween(angles[i], angles[next]))
      points.push(...along(next, outer, inner))
      push(points)
    }

    // The chord where this sector was cut across, stopping dead at both radial cracks.
    for (const r of cuts) cracks.push([ray(i, r), ray(next, r)].map(svg).join(' '))
  }

  // The radial cracks themselves, drawn with enough points to show the bow.
  for (let i = 0; i < count; i++) {
    const line: Point[] = []
    for (let s = 0; s <= 8; s++) line.push(ray(i, s / 8))
    cracks.push(line.map(svg).join(' '))
  }

  return { fragments, cracks }
}
