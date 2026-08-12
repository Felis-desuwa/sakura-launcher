import {
  BASELINE_SLACK_MS,
  MIN_ALIAS,
  ROOT_DEPTH,
  aliasesFor,
  destNameFor,
  engineWrites,
  foldName,
  isOversized,
  isPrepacked,
  isSaveDirName,
  isSystemDir,
  nameMatches,
  pickOutside,
  rootsToSearch,
  sanitizeFolderName,
  stampFor,
  uniqueName
} from '../src/main/save-rules.ts'

/**
 * Finding a game's saves, judged on what it must refuse to claim.
 *
 * Detection here is a name search across the places Windows lets a game write, and a
 * name search is wrong in two directions. It can miss — which costs the user a backup
 * they thought they had — and it can over-claim, which is worse: a folder confidently
 * labelled "this game's saves" that belongs to something else sends the user away
 * believing a file is safe when it was never copied.
 *
 * So most of this file is about the second kind. A one-word folder name must not match.
 * A Windows directory must not be offered because it happened to sit at the root of C:.
 * And a save that has not been written since before the user owned the game must be
 * called what it is — somebody else's, shipped inside the download — rather than counted
 * as progress.
 *
 * Nothing here touches a disk.
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

/* -------------------------------------------------------------------------- */
console.log('\n== names, reduced to the part that survives being retyped ==')

// The folder on disk, the title in a catalogue and whatever the publisher called their
// AppData directory are the same name written three ways. What is left has to match.
eq('case and spaces go', foldName('Sample Game'), 'samplegame')
eq('brackets and punctuation go', foldName('[汉化组] 示例游戏 (v1.2)'), '汉化组示例游戏v12')
eq('full-width forms normalise', foldName('ＳＡＭＰＬＥ'), 'sample')
eq('Japanese survives intact', foldName('サンプルゲーム'), 'サンプルゲーム')
eq('an underscore is not part of a name', foldName('sample_game'), 'samplegame')
eq('nothing but punctuation folds to nothing', foldName('---'), '')

/* -------------------------------------------------------------------------- */
console.log('\n== which names are worth searching on ==')

const aliases = aliasesFor({
  name: '示例游戏',
  dir: 'H:\\lib\\[汉化组] 示例游戏 v1.2',
  exe: 'H:\\lib\\示例游戏\\SampleGame.exe',
  workTitle: 'Sample Game'
})
check('the display name is one', aliases.includes('示例游戏'))
check('so is the executable', aliases.includes('samplegame'))
check('and the catalogue title folds onto the same string', aliases.filter((a) => a === 'samplegame').length === 1)

// A folder called `Game` would otherwise match `%APPDATA%\Game`, which belongs to
// something else — and the row would carry no hint that it came from a coincidence.
eq('a one-word generic name is not an alias', aliasesFor({ name: 'Game' }).length, 0)
eq('nor is "data"', aliasesFor({ name: 'data' }).length, 0)
eq('nor is "save"', aliasesFor({ dir: 'C:\\Save' }).length, 0)
eq('a name too short to identify anything is dropped', aliasesFor({ name: 'AB' }).length, 0)
check('the floor is three characters', MIN_ALIAS === 3)
eq('nothing at all yields nothing', aliasesFor({}).length, 0)

/* -------------------------------------------------------------------------- */
console.log('\n== matching a folder found out in the wild ==')

const own = ['samplegame', '示例游戏']
check('an exact match counts', nameMatches('SampleGame', own))
check('so does one written differently', nameMatches('Sample Game', own))
// A publisher's folder is as often longer than the title as shorter.
check('the folder may carry extra words', nameMatches('SampleGameTrial', own))
check('or be a prefix of it', nameMatches('Sample', own))
check('Chinese matches too', nameMatches('示例游戏', own))

check('an unrelated folder does not match', nameMatches('Microsoft', own) === false)
check('nor does one sharing three letters', nameMatches('Sam', own) === false)
check('an empty name matches nothing', nameMatches('', own) === false)
check('our own data folder is never a game save', nameMatches('sakura-launcher', ['sakuralauncher']) === false)

/* -------------------------------------------------------------------------- */
console.log('\n== where each engine actually writes ==')

check('Ren’Py keeps the authoritative copy in Roaming', engineWrites('renpy', 'appdata'))
check('Unity uses LocalLow', engineWrites('unity', 'locallow'))
check('Unreal uses Local', engineWrites('unreal', 'localappdata'))
check('NW.js — so RPG Maker MV — uses Local', engineWrites('nwjs', 'localappdata'))
// Wolf writes beside the game, so nothing outside it is where Wolf "usually" writes.
check('Wolf claims no outside root', engineWrites('wolf', 'appdata') === false)
check('Unity does not write to Roaming', engineWrites('unity', 'appdata') === false)
check('an unknown engine claims nothing', engineWrites(null, 'appdata') === false)

// Every root is searched whatever the engine — the engine only decides confidence.
eq('six roots are searched', rootsToSearch().length, 6)
check('the AppData family is searched two deep', ROOT_DEPTH.appdata === 2 && ROOT_DEPTH.locallow === 2)
check('the drive root is not descended into', ROOT_DEPTH.systemdrive === 1)

/* -------------------------------------------------------------------------- */
console.log('\n== picking this game out of everything found ==')

const entry = (
  name: string,
  root: Parameters<typeof pickOutside>[0][number]['root'],
  depth = 1
): Parameters<typeof pickOutside>[0][number] => ({
  path: `X:\\${root}\\${name}`,
  name,
  root,
  depth
})

const hits = pickOutside(
  [
    entry('SampleGame', 'appdata'),
    entry('Microsoft', 'appdata'),
    entry('SampleGame', 'documents'),
    entry('Windows', 'systemdrive'),
    entry('Save', 'systemdrive'),
    entry('sakura-launcher', 'appdata')
  ],
  own,
  'renpy'
)

// Six went in; three come out — the two name matches and the bare `Save` at the drive
// root. `Microsoft` matches nothing, and the other two are refused by name.
eq('three of the six rows survive', hits.length, 3)
check(
  'the one under the engine’s own root is strong',
  hits.find((h) => h.root === 'appdata' && h.via === 'alias')?.confidence === 'strong'
)
check(
  'the same name somewhere the engine never writes is only weak',
  hits.find((h) => h.root === 'documents')?.confidence === 'weak'
)
check('Windows’ own folder is not offered', hits.some((h) => h.name === 'Windows') === false)
check('neither is our own data folder', hits.some((h) => h.name === 'sakura-launcher') === false)
check(
  'a folder merely called Save at the drive root is offered, unticked',
  hits.find((h) => h.name === 'Save')?.via === 'generic' &&
    hits.find((h) => h.name === 'Save')?.confidence === 'weak'
)

// The same folder name anywhere but the drive root says nothing at all and is noise.
eq(
  'a folder called Save inside AppData is not raised on its name alone',
  pickOutside([entry('Save', 'appdata')], own, 'renpy').length,
  0
)
// With no engine known, a name match is still evidence — just never conclusive.
check(
  'an unknown engine downgrades every hit to weak',
  pickOutside([entry('SampleGame', 'appdata')], own, null)[0].confidence === 'weak'
)

check('Windows’ folders are known by name', isSystemDir('Program Files (x86)') && isSystemDir('$Recycle.Bin'))
check('a game folder at the root is not one of them', isSystemDir('SampleGame') === false)
check('the save-folder names are shared with the share scan', isSaveDirName('セーブデータ') && isSaveDirName('存档'))

/* -------------------------------------------------------------------------- */
console.log('\n== whose save is it ==')

// The discriminator that needs no engine knowledge: the user cannot have written a save
// before they had the folder. Anything older came inside the download.
const added = new Date('2026-03-01T12:00:00').getTime()
const hour = 3_600_000

check('a save written after the game was added is the user’s', isPrepacked(added + hour, added) === false)
check('one untouched since long before it is not', isPrepacked(added - 30 * hour, added) === true)
check(
  'a file stamped moments before the scan is not held against it',
  isPrepacked(added - BASELINE_SLACK_MS / 2, added) === false
)
// The honest answer for a library that predates the baseline is "cannot tell" — never a
// verdict either way, because a made-up baseline would call every real save a stranger's.
check('no baseline means no verdict', isPrepacked(added - 30 * hour, null) === false)
check('an unreadable timestamp means no verdict either', isPrepacked(0, added) === false)

/* -------------------------------------------------------------------------- */
console.log('\n== a rule that has caught the game instead of the saves ==')

check('a third of the install is not a save folder', isOversized(400, 1000) === true)
check('a few megabytes out of a gigabyte is', isOversized(4_000_000, 4_000_000_000) === false)
check('an unmeasured game accuses nothing', isOversized(400, 0) === false)

/* -------------------------------------------------------------------------- */
console.log('\n== where the copies land ==')

const gameDir = 'H:\\lib\\示例游戏'
eq(
  'an in-folder save keeps its path under the game',
  destNameFor({ path: `${gameDir}\\savedata\\save1.dat`, root: 'game' }, gameDir),
  'game\\savedata\\save1.dat'
)
eq(
  'anything from outside is filed under the root it came from',
  destNameFor({ path: 'C:\\Users\\a\\AppData\\Roaming\\RenPy\\SampleGame', root: 'appdata' }, gameDir),
  'appdata\\SampleGame'
)

// A backup that overwrites the previous one can destroy a good copy with a bad one,
// which is the exact failure this feature exists to prevent.
eq('a free name is taken as it is', uniqueName('2026-08-12_1530', () => false), '2026-08-12_1530')
const used = new Set(['2026-08-12_1530', '2026-08-12_1530-2'])
eq(
  'a taken one steps aside rather than overwriting',
  uniqueName('2026-08-12_1530', (n) => used.has(n)),
  '2026-08-12_1530-3'
)

eq('the stamp reads in the local clock', stampFor(new Date(2026, 7, 12, 15, 30)), '2026-08-12_1530')
eq('single digits are padded', stampFor(new Date(2026, 0, 2, 3, 4)), '2026-01-02_0304')

eq('a name Windows rejects is cleaned', sanitizeFolderName('Sample: Game?'), 'Sample Game')
eq('a trailing dot goes', sanitizeFolderName('Sample.'), 'Sample')
eq('a name that cleans away to nothing still names a folder', sanitizeFolderName('???'), 'game')

/* -------------------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
