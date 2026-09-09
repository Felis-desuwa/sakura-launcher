import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_ALL_HITS,
  expandEnv,
  hitLimitFor,
  MAX_DECLARABLE_HITS,
  MIN_FIXED_BYTES,
  MIN_SIG_BYTES,
  packMatches,
  parseAddr,
  parseFixBytes,
  parseSig,
  patchProblems,
  readFixPack
} from '../src/main/binfix-rules.ts'
import * as binfixRules from '../src/main/binfix-rules.ts'
import * as updateRules from '../src/main/update-rules.ts'
import * as guideRules from '../src/main/guide-rules.ts'
import { FIX_PACK_FORMAT } from '../src/shared/types.ts'

/**
 * Reading a binary fix pack: what parses, and — far more of this file — what does not.
 *
 * Everything downstream of `readFixPack` writes into another process's memory, so a pack
 * that gets through here is a pack that gets executed. The weighting reflects that: the
 * accepting cases are a handful, and the rest of the suite is one refusal per way a pack
 * could ask for a write that was never verified.
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

/** Refused for at least one reason, and the reason mentions `about`. */
function refused(name: string, raw: unknown, about: string): void {
  const read = readFixPack(raw)
  if (read.ok) {
    fail++
    console.log(`  FAIL  ${name} — accepted, and it should not have been`)
    return
  }
  check(name, read.problems.some((p) => p.includes(about)), `problems: ${read.problems.join(' | ')}`)
}

const SHA = 'a'.repeat(64)

/** A signature long enough and pinned enough to be legal, so cases can vary one thing. */
const GOOD_SIG = '6A 00 FF 15 ?? ?? ?? ?? 85 C0 0F 8C ?? ?? ?? ?? E8 ?? ?? ?? ?? 85 C0 0F 84 ?? ?? ?? ??'

function patch(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'locale gate', sig: GOOD_SIG, offset: 23, fix: '90 90 90 90 90 90', ...over }
}

function pack(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: FIX_PACK_FORMAT,
    name: '示例游戏 (BGI/Ethornell)',
    exeSha256: SHA,
    patches: [patch()],
    ...over
  }
}

/* ---------------------------- signatures ---------------------------- */

console.log('\n-- signatures --')

deepEq('a plain signature parses to bytes and an all-true mask', parseSig('6A 00 FF'), {
  bytes: [0x6a, 0x00, 0xff],
  mask: [true, true, true]
})
deepEq('?? is a wildcard and contributes a zero byte', parseSig('6A ?? FF'), {
  bytes: [0x6a, 0x00, 0xff],
  mask: [true, false, true]
})
deepEq('a single ? is the same wildcard', parseSig('? 00'), {
  bytes: [0, 0],
  mask: [false, true]
})
deepEq('commas and runs of spaces separate as well as one space does', parseSig('6A,00   FF'), {
  bytes: [0x6a, 0x00, 0xff],
  mask: [true, true, true]
})
eq('lowercase hex is the same as uppercase', JSON.stringify(parseSig('6a ff')), JSON.stringify(parseSig('6A FF')))

// The one input that must never be half-understood: half a signature still matches.
eq('a single hex digit is not a byte', parseSig('6A F'), null)
eq('three hex digits are not a byte', parseSig('6A FFF'), null)
eq('a non-hex token is refused', parseSig('6A ZZ'), null)
eq('an empty signature is refused', parseSig('   '), null)
eq('a non-string is refused', parseSig(['6A']), null)
eq('an absurdly long signature is refused', parseSig(Array(300).fill('90').join(' ')), null)

// A wildcard in a replacement would have to mean "leave this byte" — a different
// operation with the same spelling, so it is refused rather than guessed at.
eq('a wildcard in the replacement is refused', parseFixBytes('90 ?? 90'), null)
deepEq('a plain replacement parses', parseFixBytes('90 90'), [0x90, 0x90])
eq('an empty replacement is refused', parseFixBytes(''), null)

/* ---------------------------- addresses ---------------------------- */

console.log('\n-- addresses --')

eq('hex with 0x parses', parseAddr('0x400000'), 0x400000)
eq('bare decimal parses', parseAddr('4194304'), 4194304)
eq('a number parses', parseAddr(0x400000), 0x400000)
eq('hex without 0x is refused, because 400000 is ambiguous', parseAddr('400000'), 400000)
eq('a negative address is refused', parseAddr(-1), null)
eq('rubbish is refused', parseAddr('0xZZ'), null)
eq('an empty string is refused', parseAddr(''), null)

/* ---------------------------- whole packs ---------------------------- */

console.log('\n-- a pack that should be accepted --')

const good = readFixPack(pack())
check('the reference pack parses', good.ok, good.ok ? '' : good.problems.join(' | '))
if (good.ok) {
  eq('...and keeps its name', good.pack.name, '示例游戏 (BGI/Ethornell)')
  eq('...and defaults required to false', good.pack.patches[0].required, false)
  eq('...and defaults all to false', good.pack.patches[0].all, false)
  eq('...and fills in the default scan range', good.pack.scan?.from, '0x400000')
  eq('...and the default timeout', good.pack.scan?.timeoutMs, 15_000)
}

const cased = readFixPack(pack({ exeSha256: SHA.toUpperCase() }))
check('an uppercase hash is accepted and folded down', cased.ok && cased.pack.exeSha256 === SHA)

console.log('\n-- packs that must be refused --')

refused('a pack from a future format', pack({ formatVersion: 2 }), 'formatVersion')
refused('a pack with no format at all', pack({ formatVersion: undefined }), 'formatVersion')
refused('a nameless pack', pack({ name: '' }), 'name')
refused('a pack with no hash', pack({ exeSha256: undefined }), 'exeSha256')
refused('a hash of the wrong length', pack({ exeSha256: 'abc' }), 'exeSha256')
refused('a hash with non-hex in it', pack({ exeSha256: 'z'.repeat(64) }), 'exeSha256')
refused('a pack with no patches', pack({ patches: [] }), 'patches is empty')
refused('a pack whose patches are not a list', pack({ patches: {} }), 'patches is empty')
refused('a pack with an absurd number of patches', pack({ patches: Array(65).fill(patch()) }), 'more than 64')
refused('a negative exeSize', pack({ exeSize: -1 }), 'exeSize')
refused('a scan range that runs backwards', pack({ scan: { from: '0x1000', to: '0x100', timeoutMs: 1000 } }), 'scan')
refused('a scan timeout of an hour', pack({ scan: { from: '0x400000', to: '0x500000', timeoutMs: 3_600_000 } }), 'scan')

/* -------------------- the safety property, on its own -------------------- */

console.log('\n-- a patch may only overwrite bytes its signature matched --')

// This is the rule that makes a write outside verified bytes unreachable rather than
// unlikely. Each case below is one way a pack could ask to step outside it.
refused(
  'a replacement that runs off the end of the signature',
  pack({ patches: [patch({ offset: 26, fix: '90 90 90 90' })] }),
  'past the end'
)
refused(
  'an offset past the signature entirely',
  pack({ patches: [patch({ offset: 999, fix: '90' })] }),
  'past the end'
)
refused('a negative offset', pack({ patches: [patch({ offset: -1 })] }), 'offset')
refused('a fractional offset', pack({ patches: [patch({ offset: 1.5 })] }), 'offset')

// The boundary itself, from both sides.
const exact = readFixPack(pack({ patches: [patch({ offset: 23, fix: '90 90 90 90 90 90' })] }))
check('a replacement ending exactly at the signature end is allowed', exact.ok)
refused(
  '...and one byte more is not',
  pack({ patches: [patch({ offset: 23, fix: '90 90 90 90 90 90 90' })] }),
  'past the end'
)

console.log('\n-- a signature has to be able to name one place --')

// The floor is low on purpose, and this is the case that set it. `cmp eax, 0EF40h` and
// the jump after it is six bytes and is an entire real fix; an earlier sixteen-byte floor
// refused it, which bought no safety and cost the feature.
const short = readFixPack(pack({ patches: [patch({ sig: '3D 40 EF 00 00 73', offset: 5, fix: '74' })] }))
check('a six-byte all-fixed signature is accepted', short.ok, short.ok ? '' : short.problems.join(' | '))

refused(
  'a signature under the length floor',
  pack({ patches: [patch({ sig: '6A 00 FF', offset: 0, fix: '90' })] }),
  `${MIN_SIG_BYTES} is the minimum`
)
refused(
  'a signature that is long but almost all wildcards',
  pack({
    patches: [patch({ sig: '6A 00 ' + Array(20).fill('??').join(' '), offset: 0, fix: '90' })]
  }),
  `${MIN_FIXED_BYTES} is the minimum`
)
refused(
  'a signature starting with a wildcard',
  pack({ patches: [patch({ sig: '?? ' + GOOD_SIG, offset: 1, fix: '90' })] }),
  'starts with a wildcard'
)

console.log('\n-- how many matches a patch is allowed --')

// The real guard: a count the pack declares, checked against what the sweep measures.
// Length is a guess about byte entropy; this is a fact about the build in front of us.
eq('a plain patch expects exactly one match', hitLimitFor({}), 1)
eq('...and `all` raises it to the inlining default', hitLimitFor({ all: true }), DEFAULT_ALL_HITS)
eq('...and a declared count wins over both', hitLimitFor({ all: true, maxHits: 2 }), 2)
eq('...including down to one', hitLimitFor({ all: true, maxHits: 1 }), 1)

const counted = readFixPack(pack({ patches: [patch({ all: true, maxHits: 2 })] }))
check('a pack may declare how many places it expects', counted.ok)
refused('a count of zero', pack({ patches: [patch({ maxHits: 0 })] }), 'maxHits')
refused('a negative count', pack({ patches: [patch({ maxHits: -1 })] }), 'maxHits')
refused('a fractional count', pack({ patches: [patch({ maxHits: 1.5 })] }), 'maxHits')
refused(
  'a count past the ceiling',
  pack({ patches: [patch({ maxHits: MAX_DECLARABLE_HITS + 1 })] }),
  'maxHits'
)

console.log('\n-- conditions --')

const conditional = readFixPack(
  pack({ patches: [patch({ unless: { skipIfFileExists: '%WINDIR%\\Fonts\\msmincho.ttc' } })] })
)
check('a patch may carry a skip-if-present condition', conditional.ok)
refused(
  'an empty condition names nothing and is refused',
  pack({ patches: [patch({ unless: {} })] }),
  'names no condition'
)
refused(
  'a condition that is not an object',
  pack({ patches: [patch({ unless: 'msmincho.ttc' })] }),
  'not an object'
)

eq(
  'a variable is expanded',
  expandEnv('%WINDIR%\\Fonts\\x.ttc', { WINDIR: 'C:\\Windows' }),
  'C:\\Windows\\Fonts\\x.ttc'
)
eq(
  'expansion is case-insensitive, as Windows is',
  expandEnv('%windir%\\a', { WINDIR: 'C:\\Windows' }),
  'C:\\Windows\\a'
)
// Left as literal text it would name a path that never exists, which silently promotes a
// conditional patch to an unconditional one.
eq('an unset variable expands to nothing rather than staying literal', expandEnv('%NOPE%\\a', {}), '\\a')

console.log('\n-- matching a pack to an executable --')

eq(
  'the right hash and size match',
  packMatches({ exeSha256: SHA, exeSize: 100 }, { sha256: SHA, size: 100 }),
  true
)
eq(
  'a different size is a different build, whatever the hash says',
  packMatches({ exeSha256: SHA, exeSize: 100 }, { sha256: SHA, size: 101 }),
  false
)
eq(
  'a different hash never matches',
  packMatches({ exeSha256: SHA }, { sha256: 'b'.repeat(64), size: 100 }),
  false
)
eq(
  'an uppercase hash on the file side still matches',
  packMatches({ exeSha256: SHA }, { sha256: SHA.toUpperCase(), size: 1 }),
  true
)
eq(
  'a pack with no size recorded matches on the hash alone',
  packMatches({ exeSha256: SHA }, { sha256: SHA, size: 999 }),
  true
)

console.log('\n-- the failure arm carries no pack --')

// Same construction as `readReleases` and `read2dfan`, for the same reason: it has to be
// impossible to write `read.pack ?? somethingEmpty` and get a pack that never parsed.
const bad = readFixPack({ nonsense: true })
check('a refused read has no pack field at all', !bad.ok && !('pack' in bad))
check('...and says why, in at least one sentence', !bad.ok && bad.problems.length > 0)

console.log('\n-- every problem names its patch --')

const twoBad = readFixPack(pack({ patches: [patch(), patch({ sig: 'nonsense' })] }))
check(
  'a problem in the second patch is reported as patches[1]',
  !twoBad.ok && twoBad.problems.some((p) => p.startsWith('patches[1]')),
  !twoBad.ok ? twoBad.problems.join(' | ') : ''
)
deepEq('a patch that is not an object is reported once', patchProblems(42, 0), [
  'patches[0] is not an object'
])

/* ---------------------------- the module itself ---------------------------- */

console.log('\n-- module hygiene --')

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf-8'))
check('the harness is registered in package.json', pkg.scripts['binfix-test'] === 'node scripts/binfix-test.mts')

const source = fs.readFileSync(path.join(here, '..', 'src', 'main', 'binfix-rules.ts'), 'utf-8')
check('the module reaches no electron', !/from ['"]electron/.test(source))
const specifiers = [...source.matchAll(/from ['"](\.[^'"]*)['"]/g)].map((m) => m[1])
check(
  `every relative import names its extension (${specifiers.length} of them)`,
  specifiers.every((s) => s.endsWith('.ts'))
)
// No filesystem in the rules half: `unless.skipIfFileExists` is *described* here and
// tested next door, so that a pack can be validated without a disk under it.
check('the module touches no filesystem', !/from ['"]node:fs['"]/.test(source))

const clash = Object.keys(binfixRules).filter((k) => k in updateRules || k in guideRules)
deepEq('no export name collides with another pure module', clash, [])

/* -------------------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) process.exit(1)
