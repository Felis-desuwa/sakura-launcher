import {
  LS_APP_ID,
  SAKURA_PREFIX,
  installDirOf,
  isOurProfile,
  looksLikeLossless,
  ourProfileTitle,
  steamLibraries
} from '../src/main/lossless-rules.ts'
import {
  activeHdrSupport,
  buildSettingsXml,
  countOurProfiles,
  listProfiles,
  parseProfiles,
  startsElevated
} from '../src/main/lossless-config.ts'
import type { UpscaleTarget } from '../src/main/upscale-rules.ts'
import { LOSSLESS_PRESETS, losslessPresetFor } from '../src/shared/types.ts'

/**
 * Editing somebody else's configuration file, judged on what it must not get wrong.
 *
 * Lossless Scaling is paid software the user installed themselves, and its `Settings.xml`
 * has no second copy — there is no equivalent of the private Magpie under `%APPDATA%` to
 * make a mistake in. Everything asserted here is a way that editing it could go badly and
 * not be noticed:
 *
 *  - **Anything outside `<GameProfiles>` must survive byte for byte.** A parse-and-write
 *    round trip would reformat the file and drop elements a future version adds, and the
 *    user would find out weeks later when a setting they never touched had reverted.
 *  - **The result has to be stable.** Rewriting requires Lossless Scaling to be closed,
 *    and this program is not allowed to close it. If the same library produced a different
 *    file on every launch, the config could never be brought up to date once the first
 *    game of a session had started it — so `changed` being false in the steady state is
 *    not a nicety, it is the whole feature.
 *  - **Only our own profiles are ever removed.** They are recognised by one prefix and by
 *    nothing else; a rule that was any looser would delete a profile the user made.
 *  - **A mode naming no profile of theirs writes nothing.** Inventing picture settings in
 *    somebody else's program, under a name that looks like this one endorsed them, is
 *    worse than not scaling.
 *  - **The one measured field is written to presets and to nothing else.** `HdrSupport`
 *    describes the screen rather than the game, and a preset that inherited a stale `false`
 *    on an HDR display produced visibly wrong colour with nothing reporting a fault. An
 *    unknown must still write nothing: `false` on a display that could not be measured is
 *    the same bug pointing the other way.
 *
 * Nothing here touches a disk or starts anything. The fixture is shaped like a real
 * `Settings.xml` — the element names and nesting are taken from one — but every name in it
 * is a placeholder.
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

/** One profile block, so the fixture reads as a file rather than as a wall of XML. */
function profile(title: string, extra: string[] = []): string {
  return [
    '    <Profile>',
    `      <Title>${title}</Title>`,
    '      <AutoScale>false</AutoScale>',
    '      <AutoScaleDelay>0</AutoScaleDelay>',
    '      <ScalingMode>Custom</ScalingMode>',
    '      <ScaleFactor>2.1</ScaleFactor>',
    '      <ScalingType>Anime4K</ScalingType>',
    '      <LSFG3Mode1>FIXED</LSFG3Mode1>',
    '      <LSFGSize>PERFORMANCE</LSFGSize>',
    '      <FrameGeneration>Off</FrameGeneration>',
    '      <CaptureApi>WGC</CaptureApi>',
    ...extra.map((line) => `      ${line}`),
    '    </Profile>'
  ].join('\n')
}

function settingsXml(profiles: string[]): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Settings xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">',
    '  <WindowWidth>1170</WindowWidth>',
    '  <Hotkey>S</Hotkey>',
    '  <HotkeyModifierKeys>Alt Control</HotkeyModifierKeys>',
    '  <StartAsAdmin>true</StartAsAdmin>',
    '  <Language>System</Language>',
    '  <SomeFutureFieldThisProgramHasNeverHeardOf>42</SomeFutureFieldThisProgramHasNeverHeardOf>',
    '  <GameProfiles>',
    ...profiles,
    '  </GameProfiles>',
    '</Settings>',
    ''
  ].join('\n')
}

const BASE = settingsXml([profile('默认'), profile('锐化'), profile('补帧', ['<VRS>true</VRS>'])])

function target(exe: string, name: string, mode: string): UpscaleTarget {
  return { exe, name, mode }
}

/* -------------------------------------------------------------------------- */
console.log('\n== reading what is there ==')

const parsed = parseProfiles(BASE)
eq('three profiles found', parsed.length, 3)
eq('titles read', parsed.map((p) => p.title).join(','), '默认,锐化,补帧')
eq('no filter on any of them', parsed.filter((p) => p.path === null).length, 3)
eq('none of them are ours', parsed.filter((p) => p.ours).length, 0)
eq('offered as modes', listProfiles(BASE).join(','), '默认,锐化,补帧')
eq('their elevation setting is read', startsElevated(BASE), true)
eq('...and read as false when it says so', startsElevated(BASE.replace('<StartAsAdmin>true<', '<StartAsAdmin>false<')), false)
eq('a file with no GameProfiles reads as nothing', parseProfiles('<Settings></Settings>').length, 0)

/* -------------------------------------------------------------------------- */
console.log('\n== writing our own, and nothing else ==')

const one = buildSettingsXml(BASE, {
  targets: [target('D:\\games\\示例游戏\\game.exe', '示例游戏', '默认')],
  delaySeconds: 2, hdr: null
})

eq('it changed', one.changed, true)
eq('one profile written', one.written, 1)
eq('nothing missing', one.missing.length, 0)
eq('now four profiles', parseProfiles(one.xml).length, 4)
eq('exactly one is ours', countOurProfiles(one.xml), 1)
check('ours is titled after theirs', one.xml.includes(`<Title>${SAKURA_PREFIX}默认</Title>`))
check('the exe is the filter', one.xml.includes('<Path>D:\\games\\示例游戏\\game.exe</Path>'))
check('auto scale is on', /<Title>Sakura · 默认<\/Title>[\s\S]*?<AutoScale>true<\/AutoScale>/.test(one.xml))
check('the delay we asked for', /<Title>Sakura · 默认<\/Title>[\s\S]*?<AutoScaleDelay>2<\/AutoScaleDelay>/.test(one.xml))
check(
  'the clone kept fields this program cannot name',
  /<Title>Sakura · 默认<\/Title>[\s\S]*?<LSFGSize>PERFORMANCE<\/LSFGSize>[\s\S]*?<\/Profile>/.test(one.xml)
)

// The assertion this harness exists for.
const outside = (xml: string): string =>
  xml.slice(0, xml.indexOf('<GameProfiles>')) + xml.slice(xml.indexOf('</GameProfiles>'))
eq('every byte outside GameProfiles is unchanged', outside(one.xml), outside(BASE))
check("their own profiles are untouched", one.xml.includes(profile('锐化')) && one.xml.includes(profile('默认')))

/* -------------------------------------------------------------------------- */
console.log('\n== the steady state ==')

const again = buildSettingsXml(one.xml, {
  targets: [target('D:\\games\\示例游戏\\game.exe', '示例游戏', '默认')],
  delaySeconds: 2, hdr: null
})
eq('the same library writes the same file', again.changed, false)
eq('...byte for byte', again.xml, one.xml)

// Ranking changes on every launch; the written order must not.
const ranked = buildSettingsXml(BASE, {
  targets: [
    target('D:\\games\\示例游戏\\game.exe', '示例游戏', '默认'),
    target('D:\\games\\サンプルゲーム\\start.exe', 'サンプルゲーム', '锐化')
  ],
  delaySeconds: 2, hdr: null
})
const reranked = buildSettingsXml(BASE, {
  targets: [
    target('D:\\games\\サンプルゲーム\\start.exe', 'サンプルゲーム', '锐化'),
    target('D:\\games\\示例游戏\\game.exe', '示例游戏', '默认')
  ],
  delaySeconds: 2, hdr: null
})
eq('play order does not reach the file', reranked.xml, ranked.xml)

const swapped = buildSettingsXml(BASE, {
  targets: [
    target('D:\\games\\RJ01234567\\b.exe', 'B', '默认'),
    target('D:\\games\\v1234\\a.exe', 'A', '默认')
  ],
  delaySeconds: 2, hdr: null
})
const swappedBack = buildSettingsXml(BASE, {
  targets: [
    target('D:\\games\\v1234\\a.exe', 'A', '默认'),
    target('D:\\games\\RJ01234567\\b.exe', 'B', '默认')
  ],
  delaySeconds: 2, hdr: null
})
eq('nor to the order inside one filter', swappedBack.xml, swapped.xml)

/* -------------------------------------------------------------------------- */
console.log('\n== one profile per mode, not per game ==')

const grouped = buildSettingsXml(BASE, {
  targets: [
    target('D:\\games\\a\\a.exe', 'A', '默认'),
    target('D:\\games\\b\\b.exe', 'B', '默认'),
    target('D:\\games\\c\\c.exe', 'C', '锐化')
  ],
  delaySeconds: 2, hdr: null
})
eq('two modes, two profiles', grouped.written, 2)
check('the shared mode joins with a semicolon', grouped.xml.includes('<Path>D:\\games\\a\\a.exe;D:\\games\\b\\b.exe</Path>'))
eq('and the library is still five profiles', parseProfiles(grouped.xml).length, 5)

const deduped = buildSettingsXml(BASE, {
  targets: [target('D:\\games\\a\\a.exe', 'A', '默认'), target('D:\\games\\a\\a.exe', 'A again', '默认')],
  delaySeconds: 2, hdr: null
})
check('one exe named twice is written once', deduped.xml.includes('<Path>D:\\games\\a\\a.exe</Path>'))

/* -------------------------------------------------------------------------- */
console.log('\n== cleaning up after ourselves, and only after ourselves ==')

const cleared = buildSettingsXml(grouped.xml, { targets: [], delaySeconds: 2, hdr: null })
eq('ours are gone', countOurProfiles(cleared.xml), 0)
eq('theirs are all still there', parseProfiles(cleared.xml).length, 3)
eq('which is a change', cleared.changed, true)
eq('and the rest of the file is still untouched', outside(cleared.xml), outside(BASE))
eq('clearing twice is a no-op', buildSettingsXml(cleared.xml, { targets: [], delaySeconds: 2, hdr: null }).changed, false)

// A file holding nothing but ours still has to end up empty, not left as it was.
const onlyOurs = buildSettingsXml(settingsXml([profile('默认')]), {
  targets: [target('D:\\games\\a\\a.exe', 'A', '默认')],
  delaySeconds: 2, hdr: null
})
const emptied = buildSettingsXml(
  settingsXml(parseProfiles(onlyOurs.xml).filter((p) => p.ours).map((p) => p.block.split('\n').map((l, i) => (i === 0 ? `    ${l}` : l)).join('\n'))),
  { targets: [], delaySeconds: 2, hdr: null }
)
eq('a region of nothing but ours empties out', countOurProfiles(emptied.xml), 0)

/* -------------------------------------------------------------------------- */
console.log('\n== a mode that names nothing of theirs ==')

const unknown = buildSettingsXml(BASE, {
  targets: [target('D:\\games\\a\\a.exe', 'A', 'Anime4K'), target('D:\\games\\b\\b.exe', 'B', '默认')],
  delaySeconds: 2, hdr: null
})
eq('nothing invented for it', unknown.written, 1)
eq('and it is reported', unknown.missing.join(','), 'Anime4K')
eq('the other one still went in', countOurProfiles(unknown.xml), 1)

const noRegion = buildSettingsXml('<Settings><Hotkey>S</Hotkey></Settings>', {
  targets: [target('D:\\games\\a\\a.exe', 'A', '默认')],
  delaySeconds: 2, hdr: null
})
eq('a file with no profiles at all is left alone', noRegion.changed, false)
eq('...and says so', noRegion.missing.join(','), '默认')

/* -------------------------------------------------------------------------- */
console.log('\n== matching a title the way a person would type it ==')

const loose = buildSettingsXml(settingsXml([profile('Anime4K')]), {
  targets: [target('D:\\games\\a\\a.exe', 'A', 'anime4k')],
  delaySeconds: 2, hdr: null
})
eq('case is forgiven', loose.written, 1)
check('but the profile is named as they spell it', loose.xml.includes('<Title>Sakura · Anime4K</Title>'))

/* -------------------------------------------------------------------------- */
console.log('\n== a path with characters XML cares about ==')

const amp = buildSettingsXml(BASE, {
  targets: [target('D:\\games\\A & B <demo>\\game.exe', 'A & B', '默认')],
  delaySeconds: 2, hdr: null
})
check('written as entities', amp.xml.includes('<Path>D:\\games\\A &amp; B &lt;demo&gt;\\game.exe</Path>'))
eq('and read back whole', parseProfiles(amp.xml).find((p) => p.ours)?.path, 'D:\\games\\A & B <demo>\\game.exe')
eq('rewriting it is stable', buildSettingsXml(amp.xml, {
  targets: [target('D:\\games\\A & B <demo>\\game.exe', 'A & B', '默认')],
  delaySeconds: 2, hdr: null
}).changed, false)

/* -------------------------------------------------------------------------- */
console.log('\n== the delay is clamped, not trusted ==')

const wild = buildSettingsXml(BASE, {
  targets: [target('D:\\games\\a\\a.exe', 'A', '默认')],
  delaySeconds: 900, hdr: null
})
check('an absurd delay comes back inside the range', wild.xml.includes('<AutoScaleDelay>30</AutoScaleDelay>'))
const negative = buildSettingsXml(BASE, {
  targets: [target('D:\\games\\a\\a.exe', 'A', '默认')],
  delaySeconds: -5, hdr: null
})
check('and so does a negative one', /<Title>Sakura · 默认<\/Title>[\s\S]*?<AutoScaleDelay>0<\/AutoScaleDelay>/.test(negative.xml))

/* -------------------------------------------------------------------------- */
console.log('\n== our profiles are never offered as modes ==')

eq('the mode list stays theirs', listProfiles(one.xml).join(','), '默认,锐化,补帧')
check('the prefix decides', isOurProfile(ourProfileTitle('默认')) && !isOurProfile('默认'))

/* -------------------------------------------------------------------------- */
console.log('\n== the ready-made presets ==')

// Every value a preset writes has to be a member of the enum it belongs to. These lists
// were read out of `LosslessScaling.dll`'s metadata; a value outside them does not scale a
// game wrong, it makes .NET's XmlSerializer throw on **the whole settings file**.
const ENUMS: Record<string, string[]> = {
  ScalingType: [
    'Off', 'LS1', 'FSR', 'NIS', 'SGSR', 'BicubicCAS', 'Anime4K', 'XBR', 'SharpBilinear',
    'Integer', 'Nearest'
  ],
  Anime4kType: ['S', 'M', 'L', 'VL', 'UL'],
  ScalingMode: ['Auto', 'Custom'],
  ScalingFitMode: ['AspectRatio', 'Fullscreen'],
  FrameGeneration: ['Off', 'LSFG3', 'LSFG2', 'LSFG1', 'LSFI', 'LSFI1'],
  LS1Type: ['BALANCED', 'PERFORMANCE'],
  LSFGSize: ['BALANCED', 'PERFORMANCE'],
  CaptureApi: ['DXGI', 'WGC', 'GDI'],
  SyncMode: ['OFF', 'DEFAULT', 'VSYNC1', 'VSYNC2', 'VSYNC3', 'VSYNC4'],
  // Booleans rather than enums, and the distinction matters: an unknown *enum* value makes
  // .NET's XmlSerializer throw on the whole file and costs the user every setting they
  // have, while a boolean has only two spellings and no such cliff. Pinned here anyway so
  // a future field cannot be added without somebody checking which kind it is.
  VRS: ['true', 'false'],
  ScaleCursor: ['true', 'false'],
  HdrSupport: ['true', 'false'],
  GsyncSupport: ['true', 'false'],
  // And this one is neither: a plain integer. Lossless Scaling's own note on it describes
  // exactly three depths, so three is what is allowed here — an int has no cliff, but a
  // depth it has never documented is a value nobody has seen it handle.
  QueueTarget: ['0', '1', '2']
}

for (const preset of LOSSLESS_PRESETS) {
  for (const [field, value] of Object.entries(preset.fields)) {
    const allowed = ENUMS[field]
    check(
      `${preset.id}: ${field}=${value} is a real value`,
      allowed !== undefined && allowed.includes(value),
      allowed === undefined ? `no verified list for ${field}` : `not one of ${allowed.join('/')}`
    )
  }
  check(`${preset.id} never generates frames`, preset.fields.FrameGeneration === 'Off')
  check(`${preset.id} keeps the aspect ratio`, preset.fields.ScalingFitMode === 'AspectRatio')
  // The only capture path that can carry a *moving* cursor. What DXGI hands over is the
  // desktop image, which does not contain the cursor at all, so Lossless Scaling can only
  // draw one itself — and it draws when a frame arrives. A visual novel is a still picture,
  // so the pointer freezes where it was. Everything this program is built for is played
  // with a mouse.
  check(`${preset.id} captures through WGC`, preset.fields.CaptureApi === 'WGC')
  // Deliberately absent, all three. `ScaleCursor` was tried and is the bug wearing another
  // face: it makes a pointer appear and then freezes it between redraws. The other two
  // change how the mouse *moves* rather than whether it can be seen, and trapping
  // somebody's cursor is not a default to hand out.
  check(`${preset.id} does not draw its own cursor`, preset.fields.ScaleCursor === undefined)
  check(`${preset.id} does not trap the mouse`, preset.fields.ClipCursor === undefined)
  check(`${preset.id} does not touch mouse speed`, preset.fields.AdjustCursorSpeed === undefined)
  // The two consequences of capturing through WGC, and both are wrong without it. A source
  // that produces almost no frames drives a variable-refresh panel to its floor, and
  // Lossless Scaling's own note warns that a hardware cursor under WGC needs multi-plane
  // overlay support before variable refresh behaves — between them, the cursor WGC just
  // made visible blinks and stutters. And a capture queue offered for “uncapped or
  // unstable frame rates under GPU load” is not a buffer on a still page of text, it is a
  // delay: depth 0 is the one that always uses the last captured frame.
  check(`${preset.id} does not force variable refresh`, preset.fields.GsyncSupport === 'false')
  check(`${preset.id} does not buffer the capture`, preset.fields.QueueTarget === '0')
}
eq('a preset id resolves', losslessPresetFor('Sakura:Quality')?.title, 'Quality')
eq('...case-insensitively', losslessPresetFor('sakura:quality')?.title, 'Quality')
eq('a profile title is not a preset', losslessPresetFor('默认'), null)

const preset = buildSettingsXml(BASE, {
  targets: [target('D:\\games\\示例游戏\\game.exe', '示例游戏', 'Sakura:Ultra')],
  delaySeconds: 2, hdr: null
})
eq('a preset writes a profile', preset.written, 1)
eq('nothing reported missing', preset.missing.length, 0)
eq('and it had a base to clone', preset.noBase, false)
check('named as ours', preset.xml.includes(`<Title>${SAKURA_PREFIX}Ultra</Title>`))
const ultra = parseProfiles(preset.xml).find((p) => p.ours)!.block
check('the algorithm is set', ultra.includes('<ScalingType>Anime4K</ScalingType>'))
check('captured the one way that carries a cursor', ultra.includes('<CaptureApi>WGC</CaptureApi>'))
// Only the one that decides whether a pointer exists. How the mouse *moves* is theirs:
// a base carrying all four comes back with three of them exactly as they were.
const CURSORS = settingsXml([
  profile('默认', [
    '<ClipCursor>false</ClipCursor>',
    '<AdjustCursorSpeed>false</AdjustCursorSpeed>',
    '<HideCursor>false</HideCursor>',
    '<ScaleCursor>false</ScaleCursor>'
  ])
])
const cursored = parseProfiles(
  buildSettingsXml(CURSORS, {
    targets: [target('D:\games\a\a.exe', 'A', 'Sakura:Ultra')],
    delaySeconds: 2,
    hdr: null
  }).xml
).find((p) => p.ours)!.block
check('every cursor option is left as theirs', cursored.includes('<ScaleCursor>false</ScaleCursor>'))
check('the mouse is not trapped for them', cursored.includes('<ClipCursor>false</ClipCursor>'))
check('their sensitivity is left alone', cursored.includes('<AdjustCursorSpeed>false</AdjustCursorSpeed>'))
check('and nothing is hidden', cursored.includes('<HideCursor>false</HideCursor>'))
check('...at the heaviest size', ultra.includes('<Anime4kType>UL</Anime4kType>'))
check('proportions kept', ultra.includes('<ScalingFitMode>AspectRatio</ScalingFitMode>'))
check('fitted rather than a fixed factor', ultra.includes('<ScalingMode>Auto</ScalingMode>'))
check('frame generation off', ultra.includes('<FrameGeneration>Off</FrameGeneration>'))
// The half that makes a preset a clone rather than an invention.
check('everything unnamed is inherited', ultra.includes('<LSFG3Mode1>FIXED</LSFG3Mode1>'))
check('...including fields with no preset opinion', ultra.includes('<LSFGSize>PERFORMANCE</LSFGSize>'))
eq('the rest of the file is untouched', outside(preset.xml), outside(BASE))
eq(
  'a preset is stable too',
  buildSettingsXml(preset.xml, {
    targets: [target('D:\\games\\示例游戏\\game.exe', '示例游戏', 'Sakura:Ultra')],
    delaySeconds: 2, hdr: null
  }).changed,
  false
)

// The base is their default — the first profile — even though the mode names none of them.
// Marked with a field no preset sets. `CaptureApi` used to serve here and stopped meaning
// anything the day a preset began writing it — the assertion still passed, on a stray
// second element the fixture happened to carry.
const secondBase = buildSettingsXml(settingsXml([profile('别的', ['<LSFGFlowScale>42</LSFGFlowScale>']), profile('默认')]), {
  targets: [target('D:\\games\\a\\a.exe', 'A', 'Sakura:Performance')],
  delaySeconds: 2, hdr: null
})
check('cloned from the first profile', parseProfiles(secondBase.xml).find((p) => p.ours)!.block.includes('<LSFGFlowScale>42</LSFGFlowScale>'))

const noProfiles = buildSettingsXml(settingsXml([]), {
  targets: [target('D:\\games\\a\\a.exe', 'A', 'Sakura:Quality')],
  delaySeconds: 2, hdr: null
})
eq('a preset with nothing to clone writes nothing', noProfiles.written, 0)
eq('...and says so as its own problem', noProfiles.noBase, true)
eq('...not as a name they got wrong', noProfiles.missing.length, 0)

// A profile of theirs called exactly what a preset is called.
const clash = buildSettingsXml(settingsXml([profile('Quality')]), {
  targets: [
    target('D:\\games\\a\\a.exe', 'A', 'Sakura:Quality'),
    target('D:\\games\\b\\b.exe', 'B', 'Quality')
  ],
  delaySeconds: 2, hdr: null
})
eq('both are written', clash.written, 2)
const titles = parseProfiles(clash.xml).filter((p) => p.ours).map((p) => p.title)
eq('with names that can be told apart', new Set(titles).size, 2)
eq('and both are still recognisably ours', titles.filter((x) => x.startsWith(SAKURA_PREFIX)).length, 2)
eq(
  'the tiebreak is deterministic',
  buildSettingsXml(settingsXml([profile('Quality')]), {
    targets: [
      target('D:\\games\\b\\b.exe', 'B', 'Quality'),
      target('D:\\games\\a\\a.exe', 'A', 'Sakura:Quality')
    ],
    delaySeconds: 2, hdr: null
  }).xml,
  clash.xml
)

// Presets go away with everything else of ours.
eq('presets are cleaned up too', countOurProfiles(buildSettingsXml(preset.xml, { targets: [], delaySeconds: 2, hdr: null }).xml), 0)
eq('and are never offered back as modes', listProfiles(preset.xml).join(','), '默认,锐化,补帧')

/* -------------------------------------------------------------------------- */
console.log('\n== the one field read off the machine ==')

const hdrOn = buildSettingsXml(BASE, {
  targets: [target('D:\\games\\示例游戏\\game.exe', '示例游戏', 'Sakura:Sharp')],
  delaySeconds: 2,
  hdr: true
})
const sharpBlock = (xml: string): string => parseProfiles(xml).find((p) => p.ours)!.block
check('an HDR screen is written into a preset', sharpBlock(hdrOn.xml).includes('<HdrSupport>true</HdrSupport>'))
eq('...exactly once', sharpBlock(hdrOn.xml).split('<HdrSupport>').length - 1, 1)
eq('...and nothing outside GameProfiles moved', outside(hdrOn.xml), outside(BASE))

const hdrOff = buildSettingsXml(BASE, {
  targets: [target('D:\\games\\示例游戏\\game.exe', '示例游戏', 'Sakura:Sharp')],
  delaySeconds: 2,
  hdr: false
})
check('an SDR screen is written too', sharpBlock(hdrOff.xml).includes('<HdrSupport>false</HdrSupport>'))

// The whole point of null. A display query that could not answer must leave the cloned
// value exactly as it found it — writing `false` on an unknown is the same fault as the
// stale `false` this feature exists to correct.
const hdrUnknown = buildSettingsXml(BASE, {
  targets: [target('D:\\games\\示例游戏\\game.exe', '示例游戏', 'Sakura:Sharp')],
  delaySeconds: 2,
  hdr: null
})
check('an unmeasured screen writes nothing at all', !sharpBlock(hdrUnknown.xml).includes('<HdrSupport>'))

// Replacing rather than adding, on a file that already carries the element — which every
// real `Settings.xml` does, because Lossless Scaling writes all forty-odd fields every time.
const WITH_HDR = settingsXml([profile('默认', ['<HdrSupport>false</HdrSupport>'])])
const flipped = buildSettingsXml(WITH_HDR, {
  targets: [target('D:\\games\\a\\a.exe', 'A', 'Sakura:Sharp')],
  delaySeconds: 2,
  hdr: true
})
check('an existing element is replaced', sharpBlock(flipped.xml).includes('<HdrSupport>true</HdrSupport>'))
eq('...not duplicated', sharpBlock(flipped.xml).split('<HdrSupport>').length - 1, 1)
check("their own profile keeps its own answer", flipped.xml.includes(profile('默认', ['<HdrSupport>false</HdrSupport>'])))

// `<Name />` is what .NET writes for an element it considers empty. Unreachable until this
// module began writing a boolean, and a duplicate here would leave the file holding two
// answers to one question.
const SELF_CLOSED = settingsXml([profile('默认', ['<HdrSupport />'])])
const closed = buildSettingsXml(SELF_CLOSED, {
  targets: [target('D:\\games\\a\\a.exe', 'A', 'Sakura:Sharp')],
  delaySeconds: 2,
  hdr: true
})
check('a self-closing element is filled in', sharpBlock(closed.xml).includes('<HdrSupport>true</HdrSupport>'))
eq('...and not left beside a second one', sharpBlock(closed.xml).split('HdrSupport').length - 1, 2)

// A mode naming one of their profiles is cloned and corrected in nothing. The screen is
// still measured, and still not applied here: that value is theirs.
const theirMode = buildSettingsXml(WITH_HDR, {
  targets: [target('D:\\games\\a\\a.exe', 'A', '默认')],
  delaySeconds: 2,
  hdr: true
})
check('a clone of their profile keeps their HDR answer', sharpBlock(theirMode.xml).includes('<HdrSupport>false</HdrSupport>'))

eq(
  'a measured screen still settles',
  buildSettingsXml(hdrOn.xml, {
    targets: [target('D:\\games\\示例游戏\\game.exe', '示例游戏', 'Sakura:Sharp')],
    delaySeconds: 2,
    hdr: true
  }).changed,
  false
)
eq(
  'and changing the screen is a change',
  buildSettingsXml(hdrOn.xml, {
    targets: [target('D:\\games\\示例游戏\\game.exe', '示例游戏', 'Sakura:Sharp')],
    delaySeconds: 2,
    hdr: false
  }).changed,
  true
)

// Read back from *our* profile, never from the one it was cloned from: a correction made
// to the base does not reach ours until the file can be rewritten, and reading the base
// would report a fix as landed when it had not. That is how the original bug survived.
eq('what is in force is read from our own profile', activeHdrSupport(hdrOn.xml, 'Sakura:Sharp'), true)
eq('...both ways', activeHdrSupport(hdrOff.xml, 'Sakura:Sharp'), false)
eq('a profile that says nothing claims nothing', activeHdrSupport(hdrUnknown.xml, 'Sakura:Sharp'), null)
eq('nor does a mode with no profile of ours yet', activeHdrSupport(BASE, 'Sakura:Sharp'), null)
eq('a clone of theirs reports what it cloned', activeHdrSupport(theirMode.xml, '默认'), false)
// The case that let the original bug hide: their base profile is corrected while ours,
// which is the one Lossless Scaling will actually use, still holds the old value because
// the file could not be rewritten. Reading the base would call that fixed.
const staleClone = hdrOff.xml.replace(
  profile('默认'),
  profile('默认', ['<HdrSupport>true</HdrSupport>'])
)
eq('a corrected base is not mistaken for a corrected clone', activeHdrSupport(staleClone, 'Sakura:Sharp'), false)

/* -------------------------------------------------------------------------- */
console.log('\n== finding their install ==')

const VDF = [
  '"libraryfolders"',
  '{',
  '\t"0"',
  '\t{',
  '\t\t"path"\t\t"D:\\\\steam"',
  '\t\t"apps"',
  '\t\t{',
  `\t\t\t"${LS_APP_ID}"\t\t"183809856"`,
  '\t\t}',
  '\t}',
  '\t"1"',
  '\t{',
  '\t\t"path"\t\t"E:\\\\SteamLibrary"',
  '\t}',
  '}'
].join('\n')

eq('both libraries, main first', steamLibraries(VDF).join('|'), 'D:\\steam|E:\\SteamLibrary')
eq('doubled backslashes are halved', steamLibraries(VDF)[0], 'D:\\steam')
eq('nothing in an empty file', steamLibraries('').length, 0)

const ACF = ['"AppState"', '{', '\t"appid"\t\t"993090"', '\t"name"\t\t"示例应用"', '\t"installdir"\t\t"示例应用"', '}'].join('\n')
eq('the folder name is read, not assumed', installDirOf(ACF), '示例应用')
eq('a manifest without one says so', installDirOf('"AppState" { }'), null)

check('the executable is recognised by name', looksLikeLossless('D:\\steam\\steamapps\\common\\X\\LosslessScaling.exe'))
check('...whatever the case', looksLikeLossless('D:\\x\\losslessscaling.EXE'))
check('...and wherever it was copied to', looksLikeLossless('E:\\tools\\LosslessScaling.exe'))
check('a game executable is not it', !looksLikeLossless('D:\\games\\示例游戏\\game.exe'))
check('nor is the folder', !looksLikeLossless('D:\\steam\\steamapps\\common\\Lossless Scaling'))

/* -------------------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) process.exit(1)
