import {
  advanceVirtual,
  fitModeOf,
  isDragStep,
  mapPointer,
  MIN_SOURCE,
  pictureRect
} from '../src/main/pointer-map-rules.ts'
import type { FitMode, Rect } from '../src/main/pointer-map-rules.ts'

/**
 * Putting a tapped screen point back on the game window.
 *
 * This is the arithmetic behind the pointer mapping, and it is tested on its own because
 * the code that uses it runs inside a low-level mouse hook: it cannot be stepped through,
 * it cannot print, and getting it wrong does not look like a crash — it looks like a click
 * landing an inch from the button, which reads as the streaming client's fault.
 *
 * Three things are easy to get wrong and each has cases below:
 *
 *  - **The letterbox is not the picture.** A 4:3 game on a 16:9 screen leaves two black
 *    columns, and a mapping that ignores them stretches every coordinate.
 *  - **`SharpBilinear` is not whole-multiple scaling.** It takes the picture up by a whole
 *    multiple and then covers the remainder, so what reaches the screen fills the same
 *    rectangle the plain proportional fit does. Reading it as `integer` would leave the
 *    mapping short by a border that is not there.
 *  - **A point on the letterbox must still map.** Refusing it deadlocks the pointer there:
 *    a streaming client injects every move as well as every click, so the events that
 *    would carry the pointer off the letterbox are exactly the ones being refused. That
 *    shipped, and the mouse stopped dead. Only a point on *another monitor* is passed
 *    through, because that is somebody's actual desktop.
 *
 * Nothing here needs a screen, a window or an upscaler.
 */

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function eq<T>(name: string, got: T, want: T): void {
  check(name, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

function rectEq(name: string, got: Rect, want: Rect): void {
  check(
    name,
    got.x === want.x && got.y === want.y && got.w === want.w && got.h === want.h,
    `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`
  )
}

function mapped(name: string, got: ReturnType<typeof mapPointer>, x: number, y: number): void {
  check(
    name,
    got.kind === 'map' && got.x === x && got.y === y,
    `got ${JSON.stringify(got)}, want map ${x},${y}`
  )
}

/* -------------------------------------------------------------------------- */
console.log('\nReading a profile as a fit mode\n')

eq('the presets keep proportions', fitModeOf('Anime4K', 'AspectRatio'), 'aspect')
eq('so does the cheap one', fitModeOf('BicubicCAS', 'AspectRatio'), 'aspect')
eq('whole multiples are their own case', fitModeOf('Integer', 'AspectRatio'), 'integer')
eq('stretching is what Fullscreen means', fitModeOf('Anime4K', 'Fullscreen'), 'stretch')
// The one combination where the algorithm and the fit disagree. The fit wins: it is the
// field that says where the picture goes, and Integer is the field that says how it is
// drawn. Pinned so the precedence cannot be reversed by accident.
eq('an explicit Fullscreen outranks Integer', fitModeOf('Integer', 'Fullscreen'), 'stretch')
// SharpBilinear scales by a whole multiple internally and then covers the remainder. What
// lands on screen is the proportional fit, not a whole multiple of the source.
eq('SharpBilinear is not whole-multiple scaling', fitModeOf('SharpBilinear', 'AspectRatio'), 'aspect')
eq('an absent fit mode is the upscaler default', fitModeOf('FSR', null), 'aspect')
eq('and an absent everything still answers', fitModeOf(null, null), 'aspect')
eq('spelling is not case', fitModeOf('integer', 'aspectratio'), 'integer')

/* -------------------------------------------------------------------------- */
console.log('\nWhere the picture lands\n')

// The case this library actually runs into: a 4:3 game on a 16:9 screen.
const src800: Rect = { x: 560, y: 240, w: 800, h: 600 }
const screen: Rect = { x: 0, y: 0, w: 2560, h: 1440 }

rectEq('a 4:3 game on a 16:9 screen is letterboxed', pictureRect(src800, screen, 'aspect'), {
  x: 320,
  y: 0,
  w: 1920,
  h: 1440
})
// 1440/600 = 2.4, so whole multiples give 2× and leave a border on all four sides.
rectEq('whole multiples leave a border', pictureRect(src800, screen, 'integer'), {
  x: 480,
  y: 120,
  w: 1600,
  h: 1200
})
rectEq('stretching fills the screen', pictureRect(src800, screen, 'stretch'), screen)

// A window larger than the screen. Whole-multiple scaling has no multiple to offer and
// presents the picture at its original size rather than at zero.
const huge: Rect = { x: 0, y: 0, w: 3000, h: 2000 }
rectEq('a window bigger than the screen still has a picture', pictureRect(huge, screen, 'integer'), {
  x: -220,
  y: -280,
  w: 3000,
  h: 2000
})

// A source with no area is "we have not measured it yet", not a division by zero.
rectEq('an unmeasured source yields the output window', pictureRect({ x: 0, y: 0, w: 0, h: 0 }, screen, 'aspect'), screen)

/*
 * A profile naming its own multiple. The other three modes all take the picture as large
 * as the screen allows; this one does not, and the difference is not subtle: 2.1× of an
 * 800×600 game is 1680×1260 at (440,90), where the proportional fit would have given
 * 1920×1440 at (320,0). Read the second for the first and every coordinate is wrong by a
 * factor and an offset at once.
 */
eq('a custom scaling mode names its own factor', fitModeOf('BicubicCAS', 'AspectRatio', 'Custom'), 'fixed')
eq('and Auto is the ordinary derived fit', fitModeOf('BicubicCAS', 'AspectRatio', 'Auto'), 'aspect')
eq('an absent scaling mode changes nothing', fitModeOf('Integer', 'AspectRatio', null), 'integer')
eq('a custom factor outranks the algorithm', fitModeOf('Integer', 'AspectRatio', 'Custom'), 'fixed')
eq('but not an explicit Fullscreen', fitModeOf('Integer', 'Fullscreen', 'Custom'), 'stretch')
rectEq('a fixed factor owes the screen nothing', pictureRect(src800, screen, 'fixed', 2.1), {
  x: 440,
  y: 90,
  w: 1680,
  h: 1260
})
// A factor we could not read must not be guessed at. Falling back to the proportional fit
// is wrong in one profile; inventing a multiple is wrong in every one.
rectEq(
  'a fixed mode with no factor falls back rather than inventing one',
  pictureRect(src800, screen, 'fixed'),
  pictureRect(src800, screen, 'aspect')
)
// Asked for more than fits, the upscaler draws it anyway and the edges fall off screen.
rectEq('a factor larger than the screen is not clamped', pictureRect(src800, screen, 'fixed', 4), {
  x: -320,
  y: -480,
  w: 3200,
  h: 2400
})

/*
 * Too small to be the game. This refusal lived only in the hook for a while, which made it
 * deletable without a single test failing — in the one file whose stated rule is that this
 * one is the specification.
 */
eq(
  'a source too narrow to be a game window is passed through',
  mapPointer(1200, 700, { x: 100, y: 100, w: MIN_SOURCE - 1, h: 400 }, screen, 'aspect').kind,
  'pass'
)
eq(
  'and so is one too short',
  mapPointer(1200, 700, { x: 100, y: 100, w: 400, h: MIN_SOURCE - 1 }, screen, 'aspect').kind,
  'pass'
)
eq(
  'the threshold itself is inside the door',
  mapPointer(1200, 700, { x: 100, y: 100, w: MIN_SOURCE, h: MIN_SOURCE }, screen, 'aspect').kind,
  'map'
)

/* -------------------------------------------------------------------------- */
console.log('\nMapping a tapped point back onto the game\n')

// Picture occupies x 320..2239, y 0..1439. Its centre must land on the game's centre.
mapped(
  'the centre of the picture is the centre of the game',
  mapPointer(1280, 720, src800, screen, 'aspect'),
  560 + 400,
  240 + 300
)
mapped(
  'the top-left of the picture is the top-left of the game',
  mapPointer(320, 0, src800, screen, 'aspect'),
  560,
  240
)
// The far edge is the case rounding gets wrong: 2.4× puts the last column one pixel past
// the window, and a click one pixel outside a window is not a click on it.
mapped(
  'the far corner stays on the last pixel of the game',
  mapPointer(2239, 1439, src800, screen, 'aspect'),
  560 + 799,
  240 + 599
)

// A quarter of the way across the picture is a quarter of the way across the game — which
// is the whole promise, and the thing that is false without the letterbox offset.
mapped(
  'a quarter across the picture is a quarter across the game',
  mapPointer(320 + 480, 360, src800, screen, 'aspect'),
  560 + 200,
  240 + 150
)

// Without the offset, x=320 would map to 100 rather than 0. Pinned as its own case
// because it is the failure that looks almost right.
check(
  'the letterbox offset is not ignored',
  (() => {
    const v = mapPointer(320, 720, src800, screen, 'aspect')
    return v.kind === 'map' && v.x === 560
  })()
)

/* -------------------------------------------------------------------------- */
console.log('\nThe letterbox, which is where this went wrong the first time\n')

/*
 * The first version answered a point on the letterbox with "drop it": inside the output
 * window, off the picture, nothing there but black, so dropping it could not cause a wrong
 * click. That deadlocks. A streaming client's every event is injected — including every
 * *move* — so a pointer sitting on the letterbox could never leave it, because the moves
 * that would carry it off were the very events being dropped. The mouse stopped dead.
 *
 * These cases exist so that answer cannot come back. Every point inside the output window
 * maps to somewhere on the game; none of them are refused.
 */
mapped(
  'a point on the left letterbox maps to the left edge of the game',
  mapPointer(100, 720, src800, screen, 'aspect'),
  560,
  240 + 300
)
mapped(
  '...and one on the right to the right edge',
  mapPointer(2400, 720, src800, screen, 'aspect'),
  560 + 799,
  240 + 300
)
mapped(
  'the top border of a whole-multiple fit maps to the top of the game',
  mapPointer(1280, 60, src800, screen, 'integer'),
  560 + 400,
  240
)
check(
  'no point inside the output window is ever refused',
  ([[0, 0], [0, 1439], [2559, 0], [2559, 1439], [100, 720], [1280, 720], [2400, 20]] as const).every(
    ([x, y]) => mapPointer(x, y, src800, screen, 'aspect').kind === 'map'
  )
)
check(
  '...in whole-multiple scaling too, where the border is on all four sides',
  ([[0, 0], [1280, 60], [2559, 1439], [479, 720]] as const).every(
    ([x, y]) => mapPointer(x, y, src800, screen, 'integer').kind === 'map'
  )
)

/* -------------------------------------------------------------------------- */
console.log('\nWhen it must not act at all\n')

// A second monitor is somebody's actual desktop. Nothing here gets to touch it.
eq('another monitor is passed through', mapPointer(3000, 720, src800, screen, 'aspect').kind, 'pass')
eq('...including above the screen', mapPointer(1280, -40, src800, screen, 'aspect').kind, 'pass')

// An output window on the second monitor: the mapping has to work in its coordinates and
// leave the primary alone, not assume the screen starts at the origin.
const right: Rect = { x: 2560, y: 0, w: 1920, h: 1080 }
const srcRight: Rect = { x: 3000, y: 200, w: 640, h: 480 }
mapped(
  'an output window on the second monitor maps in its own coordinates',
  mapPointer(2560 + 960, 540, srcRight, right, 'aspect'),
  3000 + 320,
  200 + 240
)
eq(
  'and the primary is left alone from there',
  mapPointer(1280, 540, srcRight, right, 'aspect').kind,
  'pass'
)

// Until the source has been measured, nothing is mapped at all. This is the state the
// hook is in between the upscaler starting and the game putting a window on screen, and
// it lasts long enough to matter.
eq(
  'an unmeasured source maps nothing',
  mapPointer(1280, 720, { x: 0, y: 0, w: 0, h: 0 }, screen, 'aspect').kind,
  'pass'
)

// Nothing is being enlarged, so there is nothing to undo — and this is also the shape a
// misidentified window takes, where doing nothing is the only safe answer.
eq(
  'a game already filling the screen is left alone',
  mapPointer(1280, 720, { x: 0, y: 0, w: 2560, h: 1440 }, screen, 'stretch').kind,
  'pass'
)
eq(
  '...and so is one the picture happens to match exactly',
  mapPointer(1280, 720, { x: 0, y: 0, w: 2560, h: 1440 }, screen, 'aspect').kind,
  'pass'
)

/* -------------------------------------------------------------------------- */
console.log('\nStretching, for a profile that asked for it\n')

mapped(
  'a stretched picture has no letterbox to offset',
  mapPointer(0, 0, src800, screen, 'stretch'),
  560,
  240
)
mapped(
  'and its centre is still the centre',
  mapPointer(1280, 720, src800, screen, 'stretch'),
  560 + 400,
  240 + 300
)
check(
  'every point inside a stretched output maps',
  [0, 1, 640, 1280, 2559].every(
    (x) => mapPointer(x, 720, src800, screen, 'stretch').kind === 'map'
  )
)

/* -------------------------------------------------------------------------- */
console.log('\nTelling a tap from a drag, which is the whole of the second bug\n')

/*
 * The remote client that prompted all this is combined: a tap names a position, a
 * press-and-drag behaves like a trackpad. Both arrive as a bare screen coordinate.
 *
 * Mapping is required for the first and fatal for the second — it is a compression, so
 * relative steps run through it converge on its fixed point and the pointer stops dead. For
 * the real case measured here (1284x724 game, 2560x1440 screen) that point is (55, 105), and
 * that is precisely where the pointer was found parked.
 *
 * The separator is that we know where we last placed the pointer. Measured against a real
 * session, the two populations do not overlap: drag steps reached 96px, the smallest tap
 * jump was 129px.
 */
const placed = { x: 592, y: 717 }

check('a step landing where we left the pointer is a drag', isDragStep(597, 720, placed))
check('...and so is one of 96px, the largest drag actually seen', isDragStep(592 + 96, 717, placed))
check('a 129px jump - the smallest tap seen - is not', !isDragStep(592 + 129, 717, placed))
check('nor is a jump across the screen', !isDragStep(2100, 300, placed))
// Before anything has been placed there is no motion to continue, so everything is a tap.
check('with nothing placed yet, every event is a tap', !isDragStep(597, 720, null))

/* -------------------------------------------------------------------------- */
console.log('\nThe virtual pointer, which is what keeps a drag feeling right\n')

// A tap replaces the virtual pointer outright.
const afterTap = advanceVirtual(null, 1123, 1323, null, screen)
check('a tap puts the virtual pointer where it was tapped', afterTap.x === 1123 && afterTap.y === 1323)

// A drag adds the client's step at full size, in screen space. Mapping then divides it by
// the scale, and the upscaler magnifies it back - so the pointer moves exactly as far as
// the finger did. Accumulating in game space instead would halve every drag.
const dragged = advanceVirtual({ x: 1123, y: 1323 }, 602, 722, placed, screen)
check(
  'a drag adds the step at full size',
  dragged.x === 1123 + 10 && dragged.y === 1323 + 5,
  JSON.stringify(dragged)
)

// A drag running off the edge stops at the edge. Left unclamped the virtual pointer walks
// off into coordinates no mapping can bring it back from.
const offEdge = advanceVirtual({ x: 2555, y: 10 }, 592 + 40, 717, placed, screen)
check('a drag off the right edge stops at the edge', offEdge.x === 2559, JSON.stringify(offEdge))

/*
 * The regression that matters: run a drag through the whole loop and check the pointer does
 * NOT converge. Without the virtual pointer this walks to (55, 105) and stays there; with it
 * the pointer keeps up with the finger.
 */
const src1284: Rect = { x: 29, y: 52, w: 1284, h: 724 }
let virt: { x: number; y: number } | null = null
let last: { x: number; y: number } | null = null
// Start with a tap, then twenty identical drag steps of +10,+5.
for (let i = 0; i <= 20; i++) {
  const evx = i === 0 ? 1123 : last!.x + 10
  const evy = i === 0 ? 1323 : last!.y + 5
  virt = advanceVirtual(virt, evx, evy, last, screen)
  const v = mapPointer(virt.x, virt.y, src1284, screen, 'aspect')
  if (v.kind !== 'map') throw new Error('expected a mapping')
  last = { x: v.x, y: v.y }
}
check(
  'twenty drag steps do not converge on the fixed point',
  last!.x > 640 && last!.y > 740,
  `ended at ${JSON.stringify(last)} - the fixed point is 55,105`
)
check(
  'and the pointer tracked the finger across the picture',
  virt!.x === 1123 + 200 && virt!.y === 1323 + 100,
  JSON.stringify(virt)
)

/* -------------------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) process.exit(1)
