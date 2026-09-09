import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  layerTokens,
  layerValue,
  layerWith,
  localeCommand,
  localeCommandText,
  localeToolFits,
  LOCALE_TOOLS,
  pinnedToolOk,
  READONLY_MIN_FILES,
  READONLY_SHARE,
  repairsFor,
  type RepairFacts
} from '../src/main/repair-rules.ts'
import * as repairRules from '../src/main/repair-rules.ts'
import * as binfixRules from '../src/main/binfix-rules.ts'
import * as diagnoseRules from '../src/main/diagnose-rules.ts'

/**
 * What may be offered as a repair, and — mostly — what may not.
 *
 * Every `act` in this list edits somebody's machine, so the weighting is the same as the
 * diagnosis it sits on top of: staying quiet is cheap, acting on a wrong reading is not.
 * The cases below are largely about the offer *not* appearing.
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

function deepEq(name: string, got: unknown, want: unknown): void {
  check(
    name,
    JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`
  )
}

/** A machine with nothing wrong on it. Cases vary one thing from here. */
function facts(over: Partial<RepairFacts> = {}): RepairFacts {
  return {
    codes: [],
    // The default is a dialog opened by hand, off a working game's context menu — which is
    // the population every offer here has to stay quiet for.
    trouble: null,
    arch: 'x86',
    gameExe: 'H:\\games\\示例游戏\\game.exe',
    blocked: [],
    readOnly: 0,
    fileCount: 200,
    folderWritable: true,
    virtualStore: null,
    localeTools: [],
    missingFonts: [],
    layers: [],
    ...over
  }
}

const ids = (f: RepairFacts): string[] => repairsFor(f).map((o) => o.id)

/* ------------------------------ nothing wrong ------------------------------ */

console.log('\n-- a clean game gets no offers --')
deepEq('nothing is offered when nothing is wrong', ids(facts()), [])

/* -------------------------------- layers --------------------------------- */

console.log('\n-- compatibility layers --')

eq('a value is space-separated and starts with a tilde', layerValue(['RUNASADMIN']), '~ RUNASADMIN')
eq('two tokens keep their space', layerValue(['RUNASADMIN', 'HIGHDPIAWARE']), '~ RUNASADMIN HIGHDPIAWARE')
// Running tokens together is the trap: Windows reads the value and silently does nothing.
check('tokens never run together', !layerValue(['A', 'B']).includes('AB'))
eq('an empty list is an empty value, not a bare tilde', layerValue([]), '')
eq('a lone tilde contributes nothing', layerValue(['~']), '')
eq('duplicates collapse', layerValue(['RUNASADMIN', 'runasadmin']), '~ RUNASADMIN')

deepEq('tokens read back without the tilde', layerTokens('~ RUNASADMIN HIGHDPIAWARE'), [
  'RUNASADMIN',
  'HIGHDPIAWARE'
])
deepEq('a missing value reads as no tokens', layerTokens(null), [])
deepEq('a value with no tilde still reads', layerTokens('RUNASADMIN'), ['RUNASADMIN'])

eq('adding a token that is already there changes nothing', layerWith('~ RUNASADMIN', 'RUNASADMIN'), null)
eq('...case-insensitively', layerWith('~ runasadmin', 'RUNASADMIN'), null)
eq('adding to nothing makes a value', layerWith(null, 'RUNASADMIN'), '~ RUNASADMIN')
eq(
  'adding keeps what was already there',
  layerWith('~ WIN7RTM', 'RUNASADMIN'),
  '~ WIN7RTM RUNASADMIN'
)

/* ------------------------------ locale tools ------------------------------ */

console.log('\n-- which emulator can drive which game --')

// Locale Emulator is 32-bit only. Offering it for a 64-bit game is a silent no-op — no
// error, no locale — and a user who concludes locale emulation does not work for them.
eq('Locale Emulator drives a 32-bit game', localeToolFits('le', 'x86'), true)
eq('...and not a 64-bit one', localeToolFits('le', 'x64'), false)
eq('Locale Remulator drives both', localeToolFits('lr', 'x64'), true)
eq('ntleas drives both', localeToolFits('ntleas', 'x64'), true)
// An unknown architecture is treated as unfitting: a wrong guess produces exactly the
// silence this is meant to prevent.
eq('an unknown architecture fits nothing', localeToolFits('lr', null), false)
eq('...and neither does a made-up one', localeToolFits('lr', 'arm64'), false)

// Both of these were wrong first time round in the same way — the switch that reads most
// like what we want does something else — so each is pinned to the upstream source.
// `-run` is `RunWithIndependentProfile` in LEProc/Program.cs: no `<path>.le.config` beside
// the target and it launches LEGUI.exe to have one authored. The bare path is
// `RunWithDefaultProfile`, which falls back to a built-in ja-JP profile and writes nothing.
deepEq('Locale Emulator takes a bare path', localeCommand('le', 'C:\\LE\\LEProc.exe', 'G:\\g\\a.exe'), {
  exe: 'C:\\LE\\LEProc.exe',
  args: ['G:\\g\\a.exe']
})
check(
  '...and is never given -run, which opens the config GUI',
  !(localeCommand('le', 'x', 'y')?.args ?? []).includes('-run')
)
// LRProc.cpp opens with `if (__argc < 3)` and a usage box; the form is `GUID Path Args`
// and there is no default GUID to invent. Sending the path alone is argc 2 — the usage box.
eq('Locale Remulator cannot be driven without a profile GUID', localeCommand('lr', 'C:\\LR\\LRProc.exe', 'G:\\g\\a.exe'), null)
// `Q1` is quiet. Without it a failure is a modal message box, which the launch watcher
// reads as a game that started and then hung — the wrong report entirely.
deepEq('ntleas takes the target first, then flags', localeCommand('ntleas', 'C:\\n\\ntleas.exe', 'G:\\g\\a.exe'), {
  exe: 'C:\\n\\ntleas.exe',
  args: ['G:\\g\\a.exe', 'C932', 'L1041', 'Q1']
})
check('ntleas is told to keep quiet', (localeCommand('ntleas', 'n.exe', 'a.exe')?.args ?? []).includes('Q1'))

// A line nobody can paste is not an instruction: these paths are full of spaces.
eq(
  'a command with spaces in it comes out quoted',
  localeCommandText({ exe: 'C:\\Program Files\\LE\\LEProc.exe', args: ['H:\\ero game\\a.exe'] }),
  '"C:\\Program Files\\LE\\LEProc.exe" "H:\\ero game\\a.exe"'
)
eq(
  '...and one with none does not gain quotes it does not need',
  localeCommandText({ exe: 'ntleas.exe', args: ['C932'] }),
  'ntleas.exe C932'
)

console.log('\n-- a pinned path is refused unless it is the tool --')

eq('the right file is accepted', pinnedToolOk('le', 'C:\\LE\\LEProc.exe'), true)
eq('...whatever its case', pinnedToolOk('le', 'C:\\LE\\leproc.EXE'), true)
// A bad pin outranks the automatic search from then on, and leaves the feature aimed at
// nothing while showing a path as though it worked.
eq('the installer is not the tool', pinnedToolOk('le', 'C:\\LE\\LEInstaller.exe'), false)
eq('another tool is not this one', pinnedToolOk('le', 'C:\\LR\\LRProc.exe'), false)
eq('a folder is not a tool', pinnedToolOk('le', 'C:\\LE'), false)
eq('an empty string is not a tool', pinnedToolOk('le', '   '), false)
eq('a non-string is not a tool', pinnedToolOk('le', 42), false)

console.log('\n-- the locale offer --')

// The gate that matters most here, and it is about a game that is FINE. `needs-locale`
// fires on a JP-era engine plus kana in the folder name, and both are true of a working
// Chinese fan translation — a large part of this library. 诊断 is on every tile's context
// menu, so without an observed failure this offer appeared under working games and
// recommended the one change that breaks them.
deepEq(
  'a locale finding alone says nothing — the game never failed',
  ids(facts({ codes: ['needs-locale'], localeTools: [{ tool: 'le', exe: 'C:\\LE\\LEProc.exe', fits: ['x86'] }] })),
  []
)
// A game sitting on an error box did start, and the box says more than any inference here.
deepEq(
  '...and a game showing an error box is not this either',
  ids(facts({ codes: ['needs-locale'], trouble: 'dialog', localeTools: [{ tool: 'le', exe: 'C:\\LE\\LEProc.exe', fits: ['x86'] }] })),
  []
)

const withLe = facts({
  codes: ['needs-locale'],
  trouble: 'earlyexit',
  localeTools: [{ tool: 'le', exe: 'C:\\LE\\LEProc.exe', fits: ['x86'] }]
})
check('a silent early exit is what unlocks it', repairsFor(withLe).length === 1)
check(
  '...as does a game that never appeared',
  repairsFor(facts({ ...withLe, trouble: 'noshow' })).length === 1
)
// **Never an action.** The first version rewrote `game.exe` to the emulator, which is one
// change with four consequences: the travelling sidecar gets a machine-specific path (the
// exe line has no `isUnder` guard, unlike the cover line beside it); a rescan reverts it
// whenever `exePinned` is unset, silently, while the journal still offers an undo; the
// compatibility repairs key on `game.exe`, so a later RUNASADMIN lands on LEProc.exe; and
// pressed twice it aims the emulator at itself.
check('a locale offer is a guide, never a button', repairsFor(withLe)[0]?.kind === 'guide')
deepEq('...and proposes no change to anything', repairsFor(withLe)[0]?.changes, [])
check(
  '...and hands over a command that can be pasted',
  repairsFor(withLe)[0]?.command?.includes('LEProc.exe') === true,
  repairsFor(withLe)[0]?.command
)
check(
  '...which is the bare-path form, not -run',
  repairsFor(withLe)[0]?.command?.includes('-run') === false
)

// Locale Remulator is found but cannot be driven, so the offer says that instead of
// printing a command line that would only produce a usage box.
const withLr = facts({
  codes: ['needs-locale'],
  trouble: 'earlyexit',
  localeTools: [{ tool: 'lr', exe: 'C:\\LR\\LRProc.exe', fits: ['x86', 'x64'] }]
})
check('a tool that needs a profile GUID offers no command', repairsFor(withLr)[0]?.command === undefined)
check('...and is still a guide', repairsFor(withLr)[0]?.kind === 'guide')

const wrongArch = facts({ ...withLe, arch: 'x64' })
check(
  'the same game at 64-bit gets a guide too, not a broken action',
  repairsFor(wrongArch)[0]?.kind === 'guide',
  JSON.stringify(repairsFor(wrongArch).map((o) => `${o.id}/${o.kind}`))
)
deepEq('no locale finding, no locale offer', ids(facts({ localeTools: [{ tool: 'lr', exe: 'x', fits: ['x86', 'x64'] }] })), [])
check(
  'with no emulator at all it still says something',
  repairsFor(facts({ codes: ['needs-locale'], trouble: 'earlyexit' }))[0]?.kind === 'guide'
)
// Nothing in the whole layer may rewrite the identity `game.exe` carries.
check(
  'no offer anywhere is an action that touches the main program',
  repairsFor(withLe).concat(repairsFor(withLr), repairsFor(wrongArch)).every((o) => o.kind === 'guide')
)

/* ------------------------------- read-only ------------------------------- */

console.log('\n-- read-only attributes --')

// A handful of read-only files is ordinary; firing on those would put a button under
// every game in the library.
deepEq('a few read-only files mean nothing', ids(facts({ readOnly: 5, fileCount: 200 })), [])
deepEq(
  'a folder copied off read-only media is offered',
  ids(facts({ readOnly: 180, fileCount: 200 })),
  ['clear-readonly']
)
deepEq(
  'a tiny folder is not a pattern, whatever the share',
  ids(facts({ readOnly: 3, fileCount: 3 })),
  []
)
eq('the share threshold is where the comment says', READONLY_SHARE, 0.6)
check('the file floor is above a handful', READONLY_MIN_FILES >= 5)
// Exactly at the threshold counts; just under does not.
deepEq('exactly at the share, it fires', ids(facts({ readOnly: 60, fileCount: 100 })), ['clear-readonly'])
deepEq('just under, it does not', ids(facts({ readOnly: 59, fileCount: 100 })), [])

/* ------------------------------ mark of the web ------------------------------ */

console.log('\n-- mark of the web --')

const blocked = repairsFor(facts({ blocked: ['C:\\g\\a.exe'] }))
deepEq('a marked executable is offered', blocked.map((o) => o.id), ['unblock'])
// Honest rather than reassuring: putting the mark back would be inventing a provenance.
eq('and it says it cannot be put back', blocked[0].undoable, false)
eq('it needs no elevation', blocked[0].needsAdmin, false)

/* ------------------------------ not writable ------------------------------ */

console.log('\n-- a folder that cannot be written --')

const stuck = repairsFor(facts({ folderWritable: false }))
check('an unwritable folder gets an action', stuck[0]?.kind === 'act')
eq('...that can be undone', stuck[0]?.undoable, true)
// Already elevated and still stuck: the honest answer is that the folder is the problem,
// and this program does not move a game folder.
const stuckTwice = repairsFor(facts({ folderWritable: false, layers: ['RUNASADMIN'] }))
check('already-elevated and still stuck becomes a guide', stuckTwice[0]?.kind === 'guide')
deepEq('...and proposes no change', stuckTwice[0]?.changes, [])

// The most dangerous false positive in the whole layer, and it is not hypothetical: a
// pre-Vista-manifest game under Program Files has been saving to the VirtualStore for
// years. RUNASADMIN would stop the redirection, the game would write the real path, and
// the entire save history would vanish from its load screen — right after the user pressed
// a button labelled "repair".
const virt = repairsFor(facts({ folderWritable: false, virtualStore: 'C:\\Users\\x\\AppData\\Local\\VirtualStore\\Program Files (x86)\\g' }))
check('a populated VirtualStore turns the offer into a guide', virt[0]?.kind === 'guide')
deepEq('...that changes nothing at all', virt[0]?.changes, [])
check(
  '...and never offers RUNASADMIN, which would destroy the saves',
  !repairsFor(facts({ folderWritable: false, virtualStore: 'C:\\vs\\g' })).some(
    (o) => o.kind === 'act'
  )
)
// It also outranks the already-elevated branch: that one still talks about moving the
// folder, which is the wrong advice when the game is saving perfectly well.
check(
  'a VirtualStore outranks the already-elevated wording',
  repairsFor(facts({ folderWritable: false, virtualStore: 'C:\\vs\\g', layers: ['RUNASADMIN'] }))[0]
    ?.reasons[0]
    ?.includes('C:\\vs\\g') === true
)
// And it says nothing when the folder is writable — a VirtualStore left over from one
// failed write years ago is not a finding.
deepEq(
  'a writable folder says nothing, VirtualStore or not',
  ids(facts({ virtualStore: 'C:\\vs\\g' })),
  []
)

/* -------------------------------- fonts --------------------------------- */

console.log('\n-- Japanese fonts --')

// Gated on a locale finding: a library that needs no Japanese font must not be nagged
// about one, and a machine missing MS Mincho is the ordinary state of Windows.
deepEq('missing fonts alone say nothing', ids(facts({ missingFonts: ['msmincho.ttc'] })), [])
const fonts = repairsFor(facts({ missingFonts: ['msmincho.ttc'], codes: ['needs-locale'] }))
check('with a locale finding they are worth saying', fonts.some((o) => o.id === 'install-fonts'))
const fontOffer = fonts.find((o) => o.id === 'install-fonts')
eq('and it is a guide, because it needs elevation', fontOffer?.kind, 'guide')
eq('which it says', fontOffer?.needsAdmin, true)
// `Jpan` with a script code, not `Ja-JP`. The wrong one fails with a message about an
// unknown capability, which reads like a broken machine rather than a typo.
check(
  'the capability name is the one that exists',
  fontOffer?.command?.includes('Language.Fonts.Jpan~~~und-JPAN~0.0.1.0') === true,
  fontOffer?.command
)

/* --------------------------- somebody else's shim --------------------------- */

console.log('\n-- a shim somebody else applied --')

const foreign = repairsFor(facts({ layers: ['WIN7RTM'] }))
check('a foreign layer is worth offering to clear', foreign.some((o) => o.id === 'compat-layer'))
// Ours is not foreign: offering to clear the thing we just set would be a loop.
deepEq('our own RUNASADMIN is not reported as foreign', ids(facts({ layers: ['RUNASADMIN'] })), [])

/* ---------------------------- module hygiene ---------------------------- */

console.log('\n-- module hygiene --')

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf-8'))
check('the harness is registered in package.json', pkg.scripts['repair-test'] === 'node scripts/repair-test.mts')

const source = fs.readFileSync(path.join(here, '..', 'src', 'main', 'repair-rules.ts'), 'utf-8')
check('the module reaches no electron', !/from ['"]electron/.test(source))
check('the module touches no filesystem', !/from ['"]node:fs['"]/.test(source))
const specifiers = [...source.matchAll(/from ['"](\.[^'"]*)['"]/g)].map((m) => m[1])
check(
  `every relative import names its extension (${specifiers.length} of them)`,
  specifiers.every((s) => s.endsWith('.ts'))
)

const clash = Object.keys(repairRules).filter((k) => k in binfixRules || k in diagnoseRules)
deepEq('no export name collides with another pure module', clash, [])

// Every tool in the table has to be drivable, or it is a menu entry that does nothing.
for (const [tool, spec] of Object.entries(LOCALE_TOOLS)) {
  check(`${tool} names the program it spawns`, spec.proc.toLowerCase().endsWith('.exe'))
  check(`${tool} says what it can drive`, spec.fits.length > 0)
}

/* -------------------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) process.exit(1)
