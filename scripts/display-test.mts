import { aspectFit, hdrActive, mainGpu, primaryDisplay, wholeMultiple } from '../src/main/display-rules.ts'
import { isIntegratedGpu, presetIsHeavy } from '../src/shared/types.ts'
import type { DisplayFacts, GpuFacts, MachineFacts } from '../src/shared/types.ts'

/**
 * What follows from the machine's display hardware.
 *
 * Written after a scaling backend spent an evening producing wrong colour that nothing in
 * this program could explain: the picture was being captured off a display running HDR and
 * the profile driving it said the display was not. Every case below is a way that reading
 * the machine could go wrong without anybody noticing:
 *
 *  - **"Could not measure" is not "no".** An unanswered query has to stay null the whole
 *    way through. Turning it into `false` somewhere in the middle would write HDR support
 *    *off* in a profile that had it on, which is the same bug pointing the other way.
 *  - **Whole-multiple scaling refuses in silence.** When no whole multiple fits it does not
 *    fall back and does not report anything, it just presents the picture at its original
 *    size. The arithmetic has to be available to say so out loud, and the four pixels a
 *    window border adds are enough to decide it.
 *  - **A graphics card is not identified by its name.** Only the discouraging half of that
 *    judgement is ever made, because a model string is marketing and not a frame time.
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

/** One display, spelled out only where a case cares. */
function screen(over: Partial<DisplayFacts> = {}): DisplayFacts {
  return {
    name: '示例显示器',
    width: 2560,
    height: 1440,
    refreshHz: 240,
    primary: true,
    hdrSupported: true,
    hdrEnabled: false,
    bitsPerChannel: 10,
    ...over
  }
}

function machine(displays: DisplayFacts[], gpus: GpuFacts[] = []): MachineFacts {
  return { displays, gpus }
}

/* -------------------------------------------------------------------------- */
console.log('\n== which screen answers ==')

eq('nothing measured is nothing claimed', primaryDisplay(null), null)
eq('an empty list is not a display', primaryDisplay(machine([])), null)
eq(
  'the desktop origin decides',
  primaryDisplay(machine([screen({ name: '副屏', primary: false }), screen({ name: '主屏' })]))?.name,
  '主屏'
)
eq(
  'and with nobody claiming it, the first',
  primaryDisplay(machine([screen({ name: '甲', primary: false }), screen({ name: '乙', primary: false })]))
    ?.name,
  '甲'
)

/* -------------------------------------------------------------------------- */
console.log('\n== whether HDR is on ==')

eq('on', hdrActive(machine([screen({ hdrEnabled: true })])), true)
eq('off', hdrActive(machine([screen({ hdrEnabled: false })])), false)
// The distinction the whole feature rests on. Null must survive as null: `false` here is
// written into somebody else's configuration as though it had been measured.
eq('unmeasured is neither', hdrActive(null), null)
eq('and so is a machine with no readable display', hdrActive(machine([])), null)
eq(
  'a display that cannot do HDR at all is simply off',
  hdrActive(machine([screen({ hdrSupported: false, hdrEnabled: false })])),
  false
)
// A second screen with a different answer does not get a vote: these games open on the
// primary, which is also where Lossless Scaling's own display selection of 0 sends the
// result. The full list is shown in the settings page for anybody it does not suit.
eq(
  'the primary answers for the machine',
  hdrActive(
    machine([screen({ primary: false, hdrEnabled: false }), screen({ primary: true, hdrEnabled: true })])
  ),
  true
)

/* -------------------------------------------------------------------------- */
console.log('\n== whole multiples, and the silence when none fits ==')

const QHD = { width: 2560, height: 1440 }

eq('720p doubles into 1440p exactly', wholeMultiple({ width: 1280, height: 720 }, QHD), 2)
eq('480p goes up three times', wholeMultiple({ width: 800, height: 480 }, QHD), 3)
eq('a quarter of the height still only doubles', wholeMultiple({ width: 1280, height: 360 }, QHD), 2)
// The case that cost a debugging session. A 1280×720 game in a window with a border has a
// client area of 1284×724; twice that is 2568×1448, eight pixels past the screen in each
// direction, and whole-multiple scaling answers by not scaling — with no error at all.
eq('four pixels of window border undo it entirely', wholeMultiple({ width: 1284, height: 724 }, QHD), 1)
eq('a window already larger than the screen scales by nothing', wholeMultiple({ width: 3840, height: 2160 }, QHD), 1)
eq('and a window of no size is not a division', wholeMultiple({ width: 0, height: 0 }, QHD), 1)

/* -------------------------------------------------------------------------- */
console.log('\n== filling the screen instead ==')

// What the preset offered first actually does with the window that whole multiples refuse:
// 2560/1284 is 1.994 and 1440/724 is 1.989, so the height decides, and three pixels of bar
// are left at each side. Effectively fullscreen, and it always scales.
const fit = aspectFit({ width: 1284, height: 724 }, QHD)
eq('the tighter side decides the factor', fit.height, 1440)
eq('the other side comes out just short', fit.width, 2554)
eq('leaving a hairline at each edge', fit.barX, 3)
eq('and nothing above or below', fit.barY, 0)
check('the factor is fractional, which is the whole difference', fit.scale > 1.98 && fit.scale < 1.99)

const exact = aspectFit({ width: 1280, height: 720 }, QHD)
eq('a window that does divide fills it with no bars at all', exact.barX, 0)
eq('...on either axis', exact.barY, 0)
eq('...at a whole factor', exact.scale, 2)

// 4:3 on a 16:9 screen is the case the preset's aspect-ratio setting exists for: bars at
// the sides rather than every face stretched wide.
const fourThree = aspectFit({ width: 800, height: 600 }, QHD)
eq('4:3 keeps its proportions', fourThree.height, 1440)
eq('...and pays in side bars', fourThree.width, 1920)
eq('...320 pixels of them each side', fourThree.barX, 320)

/* -------------------------------------------------------------------------- */
console.log('\n== which of these is the graphics card ==')

const REAL = { name: 'NVIDIA GeForce RTX 5070 Ti', memoryMb: 4095 }
const IGPU = { name: 'Intel(R) Graphics', memoryMb: 2048 }
// Remote-desktop tools and headset software each install one of these, and a machine
// carrying three is ordinary. They report no memory, which sorts them out without this
// program having to keep a list of their names.
const VIRTUAL = [
  { name: 'Virtual Desktop Monitor', memoryMb: 0 },
  { name: 'GameViewer Virtual Display Adapter', memoryMb: 0 },
  { name: 'Meta Virtual Monitor', memoryMb: 0 }
]

eq('nothing measured names nothing', mainGpu(null), null)
eq('nor does a machine of virtual adapters only', mainGpu(machine([], VIRTUAL)), null)
eq('the card with memory wins', mainGpu(machine([], [...VIRTUAL, REAL, IGPU]))?.name, REAL.name)
eq('...whatever order they arrived in', mainGpu(machine([], [IGPU, REAL, ...VIRTUAL]))?.name, REAL.name)
eq('an integrated part alone is still the answer', mainGpu(machine([], [...VIRTUAL, IGPU]))?.name, IGPU.name)

/* -------------------------------------------------------------------------- */
console.log('\n== the one thing said about it ==')

check('a bare Intel graphics is integrated', isIntegratedGpu('Intel(R) Graphics'))
check('...as is UHD', isIntegratedGpu('Intel(R) UHD Graphics 770'))
check('...and Iris Xe', isIntegratedGpu('Intel(R) Iris(R) Xe Graphics'))
check('...and the old HD parts', isIntegratedGpu('Intel(R) HD Graphics 630'))
// Arc is the trap: the same name covers a discrete card and an integrated part, so the
// model number is what separates them.
check('an Arc with a model number is a card', !isIntegratedGpu('Intel(R) Arc(TM) A770 Graphics'))
check('...and an Arc without one is not', isIntegratedGpu('Intel(R) Arc(TM) Graphics'))
check("AMD's integrated graphics are recognised", isIntegratedGpu('AMD Radeon(TM) Graphics'))
check('...including the Vega parts', isIntegratedGpu('AMD Radeon(TM) Vega 8 Graphics'))
check('but a Vega card is a card', !isIntegratedGpu('Radeon RX Vega 64'))
check('a GeForce is not integrated', !isIntegratedGpu('NVIDIA GeForce RTX 5070 Ti'))
check('nor is a Radeon RX', !isIntegratedGpu('AMD Radeon RX 7900 XTX'))
// Everything unrecognised is left alone rather than guessed at. Nothing is annotated on a
// false negative; something wrong is said on a false positive.
check('an unknown adapter is not accused', !isIntegratedGpu('Some Future Accelerator 9000'))
check('nor is an empty name', !isIntegratedGpu(''))

check('the neural presets are the heavy ones', presetIsHeavy('Sakura:Ultra'))
check('...both of them', presetIsHeavy('Sakura:Quality'))
check('the cheap one is not', !presetIsHeavy('Sakura:Performance'))
check('nor is the one offered first', !presetIsHeavy('Sakura:Sharp'))
check('nor whole multiples', !presetIsHeavy('Sakura:Integer'))
check("and a profile of the user's is not a preset at all", !presetIsHeavy('默认'))

/* -------------------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) process.exit(1)
