import {
  instanceVerdict,
  mayStop,
  needsReinstall,
  supportsMagpie
} from '../src/main/magpie-rules.ts'
import {
  DEFAULT_MODE_ORDER,
  MAX_UPSCALE_TARGETS,
  effectiveUpscale,
  modeFromLabel,
  upscaleApplies,
  upscaleTargets
} from '../src/main/upscale-rules.ts'
import {
  buildConfig,
  listModes,
  modeIndexIn,
  parseConfig,
  shortcutCode,
  type DesiredMagpie
} from '../src/main/magpie-config.ts'
import {
  DEFAULT_SETTINGS,
  MAGPIE_MODES,
  normalizeUpscaleMode,
  type Game,
  type Settings,
  type UpscaleMode
} from '../src/shared/types.ts'

/**
 * Telling Magpie what to scale, judged on what it must not get wrong.
 *
 * Three of the things here are silent when they break, which is why they are tested at
 * all rather than left to be noticed in use:
 *
 *  - A scaling mode is stored as an **index** into a list the user can reorder. Get it
 *    wrong and the picture is scaled with a shader nobody chose, and nothing says so.
 *  - The config file is rewritten only when it has to be, because rewriting it means
 *    stopping Magpie. If `changed` were unstable — sensitive to the order of a list, or
 *    to a window position Magpie moved itself — that stop-and-restart would happen on
 *    every single launch.
 *  - The one destructive act here is ending a process. The obvious way to find it (match
 *    the name `Magpie.exe`) would kill the copy the *user* installed and is running for
 *    their own reasons.
 *
 * Nothing here touches a disk or starts anything.
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

function eq<T>(name: string, actual: T, expected: T): void {
  check(
    name,
    Object.is(actual, expected),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`
  )
}

function deepEq(name: string, actual: unknown, expected: unknown): void {
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`
  )
}

/** A game with only the fields any of this reads actually set. */
function game(over: Partial<Game> = {}): Game {
  return {
    id: 'g1',
    name: '示例游戏',
    dir: 'D:\\Library\\示例游戏',
    exe: 'D:\\Library\\示例游戏\\game.exe',
    kind: 'installed',
    sizeBytes: null,
    iconPath: null,
    coverPath: null,
    groupId: null,
    order: 0,
    wishlist: false,
    playing: false,
    played: false,
    tier: null,
    tierOrder: 0,
    rating: null,
    tags: [],
    lastLaunchedAt: null,
    launchCount: 0,
    playtimeMs: 0,
    sessions: [],
    mtimeMs: 0,
    childCount: 0,
    ...over
  }
}

function settings(over: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, upscale: true, ...over }
}

/* -------------------------------------------------------------------------- */
console.log('\n== the master switch, and the third state under it ==')

// The one that matters most. A game switched on individually must not bring the feature
// back to life once the user has turned it off wholesale — otherwise a choice made months
// ago on one tile starts a background process, and "why is this running" has no answer.
eq(
  'off wholesale beats on per-game',
  effectiveUpscale(settings({ upscale: false }), game({ upscale: true })).on,
  false
)

eq('absent follows the setting', effectiveUpscale(settings(), game()).on, true)
eq('off per-game is off', effectiveUpscale(settings(), game({ upscale: false })).on, false)
eq('on per-game is on', effectiveUpscale(settings(), game({ upscale: true })).on, true)

// The mode is a separate question from whether it is on, and absent means "the default".
eq(
  'no per-game mode means the setting',
  effectiveUpscale(settings({ upscaleMode: 'Anime4K' }), game()).mode,
  'Anime4K'
)
eq(
  'a per-game mode wins',
  effectiveUpscale(settings({ upscaleMode: 'Anime4K' }), game({ upscaleMode: 'FSR' })).mode,
  'FSR'
)
// A mode assembled in Magpie's own interface. The point of the field being a name.
eq(
  'a mode of the user\'s own making passes through',
  effectiveUpscale(settings(), game({ upscale: true, upscaleMode: 'CuNNy-8x32-NVL' })).mode,
  'CuNNy-8x32-NVL'
)
// Old keys are translated here, at the one place either stored value is read.
eq(
  'a key stored before this field held names',
  effectiveUpscale(settings({ upscaleMode: 'integer2x' }), game()).mode,
  'Integer Scale 2x'
)

/* -------------------------------------------------------------------------- */
console.log('\n== what can be scaled at all ==')

// A profile that can never match is worse than no profile: it is a line in a config file
// the user has to wonder about.
eq('an archive has no window', upscaleApplies(game({ kind: 'archive', exe: '' })), false)
eq('a missing folder has no exe to match', upscaleApplies(game({ missing: true })), false)
eq('an entry with no exe', upscaleApplies(game({ exe: '   ' })), false)
eq('an ordinary installed game', upscaleApplies(game()), true)

/* -------------------------------------------------------------------------- */
console.log('\n== the profile set ==')

// Two entries on one binary are one window as far as Magpie is concerned.
eq(
  'the same exe twice yields one profile',
  upscaleTargets(settings(), [
    game({ id: 'a', exe: 'D:\\g\\game.exe' }),
    game({ id: 'b', exe: 'd:\\G\\GAME.EXE' })
  ]).length,
  1
)

const many = Array.from({ length: MAX_UPSCALE_TARGETS + 1 }, (_, i) =>
  game({ id: `g${i}`, exe: `D:\\g${i}\\game.exe`, lastLaunchedAt: i })
)
const capped = upscaleTargets(settings(), many)
eq('the cap holds', capped.length, MAX_UPSCALE_TARGETS)
// Most recently played survive; the one never reached for is the one dropped.
eq('the cap drops the least recently played', capped.at(-1)?.exe, 'D:\\g1\\game.exe')

// `changed` is compared against the file on disk, so an unstable order would rewrite the
// config — and restart Magpie — on every launch.
const unplayed = [
  game({ id: 'b', exe: 'D:\\b\\game.exe' }),
  game({ id: 'a', exe: 'D:\\a\\game.exe' }),
  game({ id: 'c', exe: 'D:\\c\\game.exe' })
]
deepEq(
  'order is stable when nothing has been played',
  upscaleTargets(settings(), unplayed),
  upscaleTargets(settings(), [...unplayed].reverse())
)

// A name is shown in Magpie's own interface and written through JSON.
const nasty = upscaleTargets(settings(), [
  game({ name: 'a "quoted"\n\tname', exe: 'D:\\q\\game.exe' })
])
check('a name with quotes and newlines survives JSON', (() => {
  const round: unknown = JSON.parse(JSON.stringify(nasty[0]))
  return (round as { name: string }).name === 'a "quoted" name'
})())

/* -------------------------------------------------------------------------- */
console.log('\n== reading a mode back out of a hand-edited file ==')

eq('the name as written', modeFromLabel('Anime4K'), 'Anime4K')
eq('case does not matter', modeFromLabel('anime4k'), 'Anime4K')
eq('spaces and dashes do not matter', modeFromLabel(' integer scale 2x '), 'Integer Scale 2x')
eq('CRT-Geom either way round', modeFromLabel('crt geom'), 'CRT-Geom')
// The keys this field held before it held names. On disk in every sidecar written then,
// and in `db.json`; unmapped they would all silently fall back to the default shader.
eq('an old key becomes its name', modeFromLabel('integer2x'), 'Integer Scale 2x')
eq('...and so does the settings value', normalizeUpscaleMode('crtgeom'), 'CRT-Geom')
eq('a name is left alone', normalizeUpscaleMode('CuNNy-8x32 mine'), 'CuNNy-8x32 mine')
// A mode built in Magpie's own interface is called whatever its author called it, and
// nothing on this side can know the list — so an unfamiliar name is kept, not discarded.
// Whether it exists is `modeIndexIn`'s question, and its answer is Magpie's own default.
eq('an unfamiliar name is kept as typed', modeFromLabel('CuNNy-8x32-NVL'), 'CuNNy-8x32-NVL')
eq('nothing at all', modeFromLabel('   '), null)
eq('longer than a name has any business being', modeFromLabel('x'.repeat(200)), null)

/* -------------------------------------------------------------------------- */
console.log('\n== which Windows ==')

eq('Windows 11', supportsMagpie('10.0.26200'), true)
eq('exactly 1903', supportsMagpie('10.0.18362'), true)
eq('1809 is too old', supportsMagpie('10.0.17763'), false)
eq('Windows 7', supportsMagpie('6.1.7601'), false)
eq('nothing readable is a no', supportsMagpie(''), false)
eq('garbage is a no', supportsMagpie('not-a-version'), false)

/* -------------------------------------------------------------------------- */
console.log('\n== whose Magpie is running ==')

const OURS = 'C:\\Users\\A\\AppData\\Roaming\\sakura-launcher\\magpie\\Magpie.exe'
const THEIRS = 'C:\\Program Files\\Magpie\\Magpie.exe'

deepEq('nothing running', instanceVerdict([], OURS), { kind: 'none' })
deepEq('ours, spelled differently', instanceVerdict([OURS.toUpperCase()], OURS), { kind: 'ours' })
deepEq('theirs', instanceVerdict([THEIRS], OURS), { kind: 'foreign', path: THEIRS })
// Ours lost the single-instance race and is doing nothing, so theirs is the answer.
deepEq('both, theirs wins', instanceVerdict([OURS, THEIRS], OURS), {
  kind: 'foreign',
  path: THEIRS
})

// The guard on the only destructive act in this feature.
eq('we may stop our own', mayStop({ kind: 'ours' }), true)
eq('we may never stop theirs', mayStop({ kind: 'foreign', path: THEIRS }), false)
eq('nothing to stop', mayStop({ kind: 'none' }), false)

/* -------------------------------------------------------------------------- */
console.log('\n== the copy on disk ==')

eq('no stamp at all', needsReinstall(null, '0.12.1'), true)
eq('a stamp of the wrong shape', needsReinstall({ nope: 1 }, '0.12.1'), true)
eq('a stamp that is not an object', needsReinstall('0.12.1', '0.12.1'), true)
eq('an older Magpie', needsReinstall({ magpieVersion: '0.11.0' }, '0.12.1'), true)
eq('the version we ship', needsReinstall({ magpieVersion: '0.12.1' }, '0.12.1'), false)

/* -------------------------------------------------------------------------- */
console.log('\n== reading Magpie\'s config file ==')

eq('an empty file', parseConfig(''), null)
eq('a truncated file', parseConfig('{"profiles":'), null)
// A JSON array is valid JSON and not a config.
eq('a top-level array', parseConfig('[]'), null)
check('a BOM does not defeat it', parseConfig('\uFEFF{"language":"zh"}')?.language === 'zh')

/* -------------------------------------------------------------------------- */
console.log('\n== the mode index, which is a position and not a name ==')

const desired = (over: Partial<DesiredMagpie> = {}): DesiredMagpie => ({
  profiles: [{ exe: 'D:\\g\\game.exe', name: '示例游戏', mode: 'Anime4K' }],
  defaultMode: 'Lanczos',
  language: 'zh',
  ...over
})

// With no list of its own, the seed order is what will be written, so that is the index.
eq('no list yet', modeIndexIn(null, 'Lanczos'), 0)
eq('no list yet, Anime4K', modeIndexIn(null, 'Anime4K'), DEFAULT_MODE_ORDER.indexOf('Anime4K'))
// An empty list is not a list: the seed gets written, so the seed's order applies. This
// is deliberately not `-1` — `-1` would mean "Magpie's default", and with an empty list
// Magpie has no default to fall back to.
eq('an empty list is treated as absent', modeIndexIn({ scalingModes: [] }, 'Lanczos'), 0)

// The whole point. A user who dragged Anime4K to the top must get Anime4K.
const reordered = {
  scalingModes: [{ name: 'Anime4K' }, { name: 'Lanczos' }, { name: 'FSR' }]
}
eq('a reordered list is read by name', modeIndexIn(reordered, 'Anime4K'), 0)
eq('...and the built-in order is not assumed', modeIndexIn(reordered, 'Lanczos'), 1)
// A mode the user deleted from their list: -1 is Magpie's "use the default", and is the
// only value certain to be in range.
eq('a mode the list does not have', modeIndexIn(reordered, 'CRT-Geom'), -1)
// A mode built in Magpie's interface, chosen here and written into a sidecar. Nothing on
// this side has a list of these — the file is the list.
const homemade = { scalingModes: [{ name: 'Lanczos' }, { name: 'CuNNy-8x32-NVL' }] }
eq('a mode of the user\'s own making', modeIndexIn(homemade, 'CuNNy-8x32-NVL'), 1)
eq('...typed into a sidecar with the wrong case', modeIndexIn(homemade, 'cunny-8x32-nvl'), 1)
// An old key, from a settings file or a sidecar written before this field held names.
eq('an old key still resolves', modeIndexIn(null, 'integer2x'), 6)

/* -------------------------------------------------------------------------- */
console.log('\n== what modes there are to offer ==')

// The list the settings page and the right-click menu are built from. Read from the file
// because Magpie's own interface can add to it, and a mode built there that cannot be
// picked here is a mode this program has hidden from the user.
deepEq('nothing on disk offers the built-ins', listModes(null), [...MAGPIE_MODES])
deepEq('an empty list is not a list', listModes({ scalingModes: [] }), [...MAGPIE_MODES])
deepEq('what the file says, in its order', listModes(reordered), ['Anime4K', 'Lanczos', 'FSR'])
deepEq("and modes the user built", listModes(homemade), ['Lanczos', 'CuNNy-8x32-NVL'])
// Junk in the list is skipped rather than offered as a blank row, and Magpie permits two
// modes of one name — which could never be told apart in a menu.
deepEq(
  'unusable entries are left out',
  listModes({ scalingModes: [{ name: 'Lanczos' }, 7, { nom: 'x' }, { name: '  ' }, { name: 'Lanczos' }] }),
  ['Lanczos']
)

/* -------------------------------------------------------------------------- */
console.log('\n== the hotkey encoding ==')

eq('Alt+Shift+A', shortcutCode({ key: 65, alt: true, shift: true }), 0x400 | 0x800 | 65)
eq('Win+Ctrl+Z', shortcutCode({ key: 90, win: true, ctrl: true }), 0x100 | 0x200 | 90)
eq('no modifiers', shortcutCode({ key: 65 }), 65)

/* -------------------------------------------------------------------------- */
console.log('\n== merging the config ==')

const fresh = buildConfig(null, desired(), [])

eq('a brand new file is a change', fresh.changed, true)
eq('the seed list is written out', (fresh.config.scalingModes as unknown[]).length, 7)
eq('our profile is recorded as ours', fresh.owned.length, 1)
deepEq('recorded lower-cased, for the next merge', fresh.owned, ['d:\\g\\game.exe'])

const profiles = fresh.config.profiles as Record<string, unknown>[]
eq('the default profile is still first', profiles.length, 2)
eq('the default profile carries the default mode', profiles[0].scalingMode, 0)
eq('ours scales automatically', profiles[1].autoScale, true)
eq('ours matches on the full path', profiles[1].pathRule, 'D:\\g\\game.exe')
eq('ours is not a packaged app', profiles[1].packaged, false)
eq('ours uses the mode asked for', profiles[1].scalingMode, DEFAULT_MODE_ORDER.indexOf('Anime4K'))

// The steady state: the same library, the same settings, nothing to do. If this ever
// reported a change, Magpie would be stopped and restarted on every launch.
const again = buildConfig(fresh.config, desired(), fresh.owned)
eq('writing the same thing twice changes nothing', again.changed, false)

// Magpie moves its own window and records it here.
const moved = { ...fresh.config, windowPos: { x: 100, y: 200 } }
eq('a window Magpie moved is not our business', buildConfig(moved, desired(), fresh.owned).changed, false)
check('...and the position is kept', 'windowPos' in buildConfig(moved, desired(), fresh.owned).config)

// A future Magpie's fields must survive a launcher that predates them.
const futured = { ...fresh.config, somethingNew: { deep: [1, 2] } }
deepEq(
  'a field we have never heard of is kept',
  buildConfig(futured, desired(), fresh.owned).config.somethingNew,
  { deep: [1, 2] }
)

/* -------------------------------------------------------------------------- */
console.log('\n== what we insist on, and what we leave alone ==')

const meddled = {
  ...fresh.config,
  autoCheckForUpdates: true,
  showNotifyIcon: false,
  alwaysRunAsAdmin: true
}
const fixed = buildConfig(meddled, desired(), fresh.owned)
// This program does not go to the network, and a copy it ships does not either.
eq('update checks go back off', fixed.config.autoCheckForUpdates, false)
// The tray icon is the user's only handle on a Magpie that outlived its game.
eq('the tray icon comes back', fixed.config.showNotifyIcon, true)
eq('elevation is ours to decide', fixed.config.alwaysRunAsAdmin, false)
eq('and that counts as a change', fixed.changed, true)

// A rebound hotkey is the user's.
const rebound = { ...fresh.config, shortcuts: { scale: 999 } }
deepEq(
  'a hotkey they rebound is untouched',
  buildConfig(rebound, desired(), fresh.owned).config.shortcuts,
  { scale: 999 }
)
check(
  'a file with no hotkeys gets the defaults',
  (fresh.config.shortcuts as Record<string, number>).scale === (0x400 | 0x800 | 65)
)

/* -------------------------------------------------------------------------- */
console.log('\n== profiles that are not ours ==')

const theirProfile = { name: 'Some other game', pathRule: 'E:\\theirs\\other.exe', autoScale: false }
const withTheirs = {
  ...fresh.config,
  profiles: [profiles[0], theirProfile, profiles[1]]
}
const merged = buildConfig(withTheirs, desired(), fresh.owned)
const mergedProfiles = merged.config.profiles as Record<string, unknown>[]
check(
  'a profile the user added in Magpie survives',
  mergedProfiles.some((p) => p.pathRule === 'E:\\theirs\\other.exe' && p.autoScale === false)
)

// Dropping a game from the library must drop its profile — but only because we know we
// wrote it.
const dropped = buildConfig(fresh.config, desired({ profiles: [] }), fresh.owned)
eq('a game no longer enabled loses its profile', (dropped.config.profiles as unknown[]).length, 1)
eq('and that is a change', dropped.changed, true)
deepEq('nothing is owned any more', dropped.owned, [])

// Without the owned list we would have no way to tell our old profile from theirs, so it
// has to stay put rather than be guessed at.
const noMemory = buildConfig(fresh.config, desired({ profiles: [] }), [])
eq('with no record of ours, nothing is removed', (noMemory.config.profiles as unknown[]).length, 2)

// The user configured this executable themselves; their explicit choice outranks ours,
// and two profiles for one path would just be a duplicate to look at.
const theirsOnOurExe = {
  ...fresh.config,
  profiles: [profiles[0], { name: 'mine, thanks', pathRule: 'D:\\g\\game.exe', autoScale: false }]
}
const respected = buildConfig(theirsOnOurExe, desired(), [])
const respectedProfiles = respected.config.profiles as Record<string, unknown>[]
eq('we do not write a second profile for the same exe', respectedProfiles.length, 2)
eq('...and theirs is the one left standing', respectedProfiles[1].autoScale, false)
deepEq('...so we claim nothing', respected.owned, [])

/* -------------------------------------------------------------------------- */
console.log('\n== what Magpie writes onto our own profiles ==')

// A profile is Magpie's record as much as ours: open its interface, set a capture method or
// a frame-rate limit on a game this program added, and Magpie saves those fields onto that
// profile when it exits. Re-emitting only the six fields we care about would discard them —
// and, worse, would differ from the file on every comparison, so `changed` would be true
// forever and Magpie would be stopped and restarted on every single launch.
const magpieTouched = {
  ...fresh.config,
  profiles: [profiles[0], { ...profiles[1], captureMethod: 2, maxFrameRate: 60 }]
}
const rewritten = buildConfig(magpieTouched, desired(), fresh.owned)
const rewrittenOurs = (rewritten.config.profiles as Record<string, unknown>[])[1]
eq('a capture method set in Magpie survives', rewrittenOurs.captureMethod, 2)
eq('...and so does a frame-rate limit', rewrittenOurs.maxFrameRate, 60)
eq('...and our own fields are still ours', rewrittenOurs.autoScale, true)
// The one that matters most: no change means no stop-write-start.
eq('a profile Magpie has written to is not a change', rewritten.changed, false)

// The mode still wins over whatever is in the file — it is the field this program owns.
const remoded = buildConfig(magpieTouched, desired({ defaultMode: 'FSR' }), fresh.owned)
eq('changing the default mode is a change', remoded.changed, true)
eq(
  '...and the kept fields come through it',
  (remoded.config.profiles as Record<string, unknown>[])[1].captureMethod,
  2
)

/* -------------------------------------------------------------------------- */
console.log('\n== the language field, which Magpie normalises ==')

// Written when it disagrees, left alone when it already says the same thing. A plain
// assignment would fight Magpie's own spelling forever, restarting it on every launch.
const zhHans = { ...fresh.config, language: 'zh-Hans' }
eq('Magpie\'s own spelling of the same language is not a change', buildConfig(zhHans, desired(), fresh.owned).changed, false)
eq('...and is left as Magpie wrote it', buildConfig(zhHans, desired(), fresh.owned).config.language, 'zh-Hans')
const enFile = { ...fresh.config, language: 'en' }
eq('a different language is a change', buildConfig(enFile, desired(), fresh.owned).changed, true)
eq('...and becomes ours', buildConfig(enFile, desired(), fresh.owned).config.language, 'zh')

/* -------------------------------------------------------------------------- */
console.log('\n== a config file that got mangled ==')

const rebuilt = buildConfig(parseConfig('{ broken'), desired(), ['d:\\g\\game.exe'])
eq('a bad file is rebuilt', rebuilt.changed, true)
eq('...with the modes back', (rebuilt.config.scalingModes as unknown[]).length, 7)
eq('...and our profile back', (rebuilt.config.profiles as unknown[]).length, 2)

/* -------------------------------------------------------------------------- */
console.log('\n== every offered mode has a seed entry of the same name ==')

// The names offered in the interface and the names seeded into the file have to be the
// same strings: the setting stores a name and `modeIndexIn` finds it by that name, so a
// mode spelled one way here and another way there would resolve to Magpie's default and
// nothing would say why.
const seeded = buildConfig(null, desired(), []).config.scalingModes as { name: string }[]
for (const mode of DEFAULT_MODE_ORDER) {
  check(`${mode} is in the seed at the index it claims`, seeded[DEFAULT_MODE_ORDER.indexOf(mode)].name === mode)
}
eq('the seed and the order agree in length', seeded.length, DEFAULT_MODE_ORDER.length)

/* -------------------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) process.exit(1)
