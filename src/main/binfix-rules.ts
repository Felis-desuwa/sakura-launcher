// Extensions spelled out: `scripts/binfix-test.mts` loads this straight into node, where
// nothing fills them in.
import {
  DEFAULT_FIX_SCAN,
  FIX_PACK_FORMAT,
  type FixPack,
  type FixPatch,
  type FixScanRange
} from '../shared/types.ts'


/**
 * Reading a fix pack, and deciding whether it is safe to run.
 *
 * The judgement half of the binary repair, with no disk and no process access in it. What
 * it is guarding against is narrow and severe: everything downstream of here writes into
 * another program's address space, so a pack that parses is a pack that will be executed.
 * Every rule below exists to make one specific bad write unreachable rather than unlikely.
 *
 * The standard is different from the rest of the diagnosis. Elsewhere a false positive
 * costs trust; here it corrupts a running process, and the user's evidence is a game that
 * crashes strangely some minutes later with nothing connecting it to us. So this refuses
 * far more than it accepts, and every refusal names the field.
 */

/** A parsed signature: the bytes to match, and which of them actually have to match. */
export interface Signature {
  bytes: number[]
  /** False where the pack wrote `??` — a relocated address, a jump displacement. */
  mask: boolean[]
}

/**
 * The shortest signature worth having — and deliberately not the safety mechanism.
 *
 * The first version of this file set the floor at sixteen bytes with ten pinned down, on
 * the reasoning that short patterns are not unique in megabytes of x86. Then it met the
 * real patches it was written for, and every one of the interesting ones was refused:
 * `3D 40 EF 00 00 73` — `cmp eax, 0EF40h` followed by the jump that is wrong — is six
 * bytes, all fixed, and is the entire fix for a rendering bug. A floor that rejects the
 * genuine article to feel safe has not bought safety, it has bought a feature nobody can
 * use, so the floor came down to where it only catches the degenerate.
 *
 * **What actually keeps a write honest is counted, not guessed** — see `hitLimitFor`. A
 * signature is a hypothesis about where something is; the number of places it matches is
 * a measurement, and a pack that says how many it expects can be checked against reality
 * before a single byte is written. That is a fact about this machine's copy of this build,
 * which no amount of arithmetic about byte entropy can substitute for.
 */
export const MIN_SIG_BYTES = 6
export const MIN_FIXED_BYTES = 6

/**
 * How many matches a patch may have before it is refused as ambiguous.
 *
 * A patch that names one site and finds nine has not found its site nine times; it has
 * found something else, and writing to all nine is how a working game becomes a mystery.
 * The default is exactly one, which is what a signature is normally for. `all` raises it
 * because inlining genuinely does put the same helper in an image more than once — the
 * lead-byte test this was written against is there twice, independently compiled — and a
 * pack may pin the number down further with `maxHits` when it knows it.
 */
export const DEFAULT_ALL_HITS = 4
export const MAX_DECLARABLE_HITS = 32

export function hitLimitFor(patch: Pick<FixPatch, 'all' | 'maxHits'>): number {
  if (typeof patch.maxHits === 'number') return patch.maxHits
  return patch.all === true ? DEFAULT_ALL_HITS : 1
}

/** Nothing sane needs a bigger one, and it bounds the memory the sweep touches. */
export const MAX_SIG_BYTES = 256

/** SHA-256 as this writes it and as it is compared: lowercase hex, no separators. */
const SHA256_RE = /^[0-9a-f]{64}$/

const HEX_BYTE_RE = /^[0-9a-fA-F]{2}$/

/**
 * Parse `6A 00 FF 15 ?? ?? ?? ??` into bytes and a mask.
 *
 * Returns null rather than a partial parse. A signature that was half understood is the
 * one input this must never accept: the understood half would still match somewhere.
 */
export function parseSig(text: unknown): Signature | null {
  if (typeof text !== 'string') return null
  const tokens = text.trim().split(/[\s,]+/).filter(Boolean)
  if (tokens.length === 0 || tokens.length > MAX_SIG_BYTES) return null

  const bytes: number[] = []
  const mask: boolean[] = []
  for (const token of tokens) {
    if (token === '??' || token === '?') {
      bytes.push(0)
      mask.push(false)
      continue
    }
    if (!HEX_BYTE_RE.test(token)) return null
    bytes.push(parseInt(token, 16))
    mask.push(true)
  }
  return { bytes, mask }
}

/**
 * Parse the replacement bytes.
 *
 * Wildcards are rejected outright — a `??` in a signature means "whatever is here", and
 * the same token in a replacement would have to mean "leave this byte alone", which is a
 * different operation wearing the same spelling. A pack wanting that writes two patches.
 */
export function parseFixBytes(text: unknown): number[] | null {
  if (typeof text !== 'string') return null
  const tokens = text.trim().split(/[\s,]+/).filter(Boolean)
  if (tokens.length === 0 || tokens.length > MAX_SIG_BYTES) return null
  const bytes: number[] = []
  for (const token of tokens) {
    if (!HEX_BYTE_RE.test(token)) return null
    bytes.push(parseInt(token, 16))
  }
  return bytes
}

/** `0x400000` or `4194304`, and nothing else. */
export function parseAddr(text: unknown): number | null {
  if (typeof text === 'number') {
    return Number.isSafeInteger(text) && text >= 0 ? text : null
  }
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  const value = /^0x[0-9a-fA-F]+$/.test(trimmed)
    ? parseInt(trimmed.slice(2), 16)
    : /^\d+$/.test(trimmed)
      ? parseInt(trimmed, 10)
      : NaN
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function readScan(raw: unknown): FixScanRange | null {
  if (raw === undefined || raw === null) return DEFAULT_FIX_SCAN
  if (typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const from = parseAddr(r.from ?? DEFAULT_FIX_SCAN.from)
  const to = parseAddr(r.to ?? DEFAULT_FIX_SCAN.to)
  const timeoutMs =
    typeof r.timeoutMs === 'number' && Number.isFinite(r.timeoutMs)
      ? r.timeoutMs
      : DEFAULT_FIX_SCAN.timeoutMs
  if (from === null || to === null || to <= from) return null
  // A minute is already far past the point where a user has decided nothing happened, and
  // the sweep holds a process handle the whole time.
  if (timeoutMs < 500 || timeoutMs > 60_000) return null
  return { from: '0x' + from.toString(16), to: '0x' + to.toString(16), timeoutMs }
}

/** Everything wrong with one patch, or an empty list. */
export function patchProblems(raw: unknown, index: number): string[] {
  const where = `patches[${index}]`
  if (typeof raw !== 'object' || raw === null) return [`${where} is not an object`]
  const p = raw as Record<string, unknown>
  const problems: string[] = []

  if (typeof p.name !== 'string' || p.name.trim() === '') problems.push(`${where}.name is empty`)

  const sig = parseSig(p.sig)
  if (!sig) {
    problems.push(`${where}.sig is not a readable signature`)
  } else {
    if (sig.bytes.length < MIN_SIG_BYTES) {
      problems.push(`${where}.sig is ${sig.bytes.length} bytes, and ${MIN_SIG_BYTES} is the minimum`)
    }
    const fixed = sig.mask.filter(Boolean).length
    if (fixed < MIN_FIXED_BYTES) {
      problems.push(`${where}.sig pins down only ${fixed} bytes, and ${MIN_FIXED_BYTES} is the minimum`)
    }
    // A wildcard first byte would make the sweep's fast path meaningless and, worse, says
    // the author does not know where the pattern begins.
    if (!sig.mask[0]) problems.push(`${where}.sig starts with a wildcard`)
  }

  const fix = parseFixBytes(p.fix)
  if (!fix) problems.push(`${where}.fix is not a readable byte string`)

  const offset = typeof p.offset === 'number' ? p.offset : 0
  if (!Number.isSafeInteger(offset) || offset < 0) {
    problems.push(`${where}.offset is not a whole number of bytes`)
  }

  // The rule that makes an out-of-signature write unreachable. Everything else here is
  // hygiene; this one is the safety property.
  if (sig && fix && Number.isSafeInteger(offset) && offset >= 0) {
    if (offset + fix.length > sig.bytes.length) {
      problems.push(
        `${where} would write ${fix.length} bytes at offset ${offset}, past the end of a ` +
          `${sig.bytes.length}-byte signature — a patch may only overwrite bytes the signature matched`
      )
    }
  }

  if (p.maxHits !== undefined) {
    const limit = p.maxHits
    if (
      typeof limit !== 'number' ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_DECLARABLE_HITS
    ) {
      problems.push(`${where}.maxHits is not a count between 1 and ${MAX_DECLARABLE_HITS}`)
    }
  }

  if (p.unless !== undefined) {
    if (typeof p.unless !== 'object' || p.unless === null) {
      problems.push(`${where}.unless is not an object`)
    } else {
      const u = p.unless as Record<string, unknown>
      const known = u.skipIfFileExists
      if (known !== undefined && (typeof known !== 'string' || known.trim() === '')) {
        problems.push(`${where}.unless.skipIfFileExists is not a path`)
      }
      if (known === undefined) problems.push(`${where}.unless names no condition`)
    }
  }

  return problems
}

/**
 * The outcome of reading a pack.
 *
 * The failure arm carries **no `pack` field**, which is the same construction
 * `readReleases` and `read2dfan` use and is there for the same reason: it makes
 * `parsed.pack ?? []`-shaped mistakes fail to compile rather than fail to protect. A pack
 * that could not be read must never reach the patcher as an empty pack.
 */
export type FixPackRead = { ok: true; pack: FixPack } | { ok: false; problems: string[] }

export function readFixPack(raw: unknown): FixPackRead {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, problems: ['the file does not contain a JSON object'] }
  }
  const r = raw as Record<string, unknown>
  const problems: string[] = []

  if (r.formatVersion !== FIX_PACK_FORMAT) {
    problems.push(
      `formatVersion is ${JSON.stringify(r.formatVersion)}, and this build reads ${FIX_PACK_FORMAT}`
    )
  }
  if (typeof r.name !== 'string' || r.name.trim() === '') problems.push('name is empty')
  if (r.note !== undefined && typeof r.note !== 'string') problems.push('note is not text')

  const sha = typeof r.exeSha256 === 'string' ? r.exeSha256.trim().toLowerCase() : ''
  if (!SHA256_RE.test(sha)) {
    problems.push('exeSha256 is not a 64-character hex SHA-256')
  }
  let exeSize: number | undefined
  if (r.exeSize !== undefined) {
    if (typeof r.exeSize === 'number' && Number.isSafeInteger(r.exeSize) && r.exeSize > 0) {
      exeSize = r.exeSize
    } else {
      problems.push('exeSize is not a positive whole number')
    }
  }

  const scan = readScan(r.scan)
  if (!scan) problems.push('scan is not a usable address range')

  const rawPatches = Array.isArray(r.patches) ? r.patches : null
  if (!rawPatches || rawPatches.length === 0) {
    problems.push('patches is empty')
  } else {
    if (rawPatches.length > 64) problems.push('patches has more than 64 entries')
    rawPatches.forEach((p, i) => problems.push(...patchProblems(p, i)))
  }

  if (problems.length > 0) return { ok: false, problems }

  const patches: FixPatch[] = (rawPatches as Record<string, unknown>[]).map((p) => ({
    name: String(p.name),
    sig: String(p.sig),
    offset: typeof p.offset === 'number' ? p.offset : 0,
    fix: String(p.fix),
    required: p.required === true,
    all: p.all === true,
    ...(typeof p.maxHits === 'number' ? { maxHits: p.maxHits } : {}),
    ...(p.unless
      ? {
          unless: {
            skipIfFileExists: (p.unless as Record<string, unknown>).skipIfFileExists as
              | string
              | undefined
          }
        }
      : {})
  }))

  return {
    ok: true,
    pack: {
      formatVersion: FIX_PACK_FORMAT,
      name: String(r.name),
      ...(typeof r.note === 'string' ? { note: r.note } : {}),
      exeSha256: sha,
      ...(exeSize !== undefined ? { exeSize } : {}),
      scan: scan as FixScanRange,
      patches
    }
  }
}

/**
 * Whether this pack was written for this executable.
 *
 * The size is checked first because it is free and because a mismatch there means the hash
 * was computed over some other file — a pack edited by hand, a build that got patched. The
 * hash is the answer; the size is a check on the question.
 */
export function packMatches(
  pack: Pick<FixPack, 'exeSha256' | 'exeSize'>,
  exe: { sha256: string; size: number }
): boolean {
  if (pack.exeSize !== undefined && pack.exeSize !== exe.size) return false
  return pack.exeSha256 === exe.sha256.trim().toLowerCase()
}

/**
 * Expand `%WINDIR%`-style variables in a condition path.
 *
 * Anything unset expands to nothing rather than being left as literal text: a path
 * containing `%NOSUCHVAR%` would otherwise be tested as-is, never exist, and quietly turn
 * a conditional patch into an unconditional one.
 */
export function expandEnv(text: string, env: Record<string, string | undefined>): string {
  return text.replace(/%([^%]+)%/g, (_all, name: string) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
    return key ? (env[key] ?? '') : ''
  })
}
