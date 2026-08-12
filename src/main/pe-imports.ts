import fs from 'node:fs'

/**
 * Reading what an executable needs in order to start.
 *
 * This is a hand-written PE reader rather than a call into `resedit`, and that is a
 * deliberate choice. `NtExecutable.from()` declines some perfectly valid PE layouts
 * outright — `scan-core.ts` already records that the BGI engine binary in サンプルゲーム
 * is one of them. Those are exactly the executables a launch diagnosis exists to explain,
 * so the parser that answers "why did nothing happen" cannot be the one that gives up on
 * them. Resources (the manifest) still go through resedit, because they are a secondary
 * signal and degrading to "unknown" there costs nothing.
 *
 * Nothing here reads more of the file than it has to: game executables run to hundreds of
 * megabytes and only a few kilobytes of that is header and import table.
 */

/** Data directory indices. Fixed by the PE format. */
const DIR_IMPORT = 1
const DIR_RESOURCE = 2
const DIR_DELAY_IMPORT = 13
const DIR_CLR = 14

/**
 * Most we will read while hunting for the manifest. Resource sections carry the artwork
 * too, and a game that ships a 4K splash has no business costing us a long read.
 */
const MAX_RESOURCE_SCAN = 8 * 1024 * 1024

/** Refuse to follow a descriptor table further than this — a corrupt file must not hang us. */
const MAX_DESCRIPTORS = 4096
/** Longest DLL name we will read before deciding the table is garbage. */
const MAX_NAME_LEN = 256

export type PeArch = 'x86' | 'x64' | 'arm64' | 'arm' | 'unknown'

export interface PeInfo {
  arch: PeArch
  /**
   * A DOS or 16-bit Windows binary. 64-bit Windows cannot run these at all, which is a
   * definitive answer rather than a guess.
   */
  is16bit: boolean
  /** Has a CLR header — needs the .NET runtime rather than a C++ redistributable. */
  isDotNet: boolean
  /** Lowercased DLL names from the import table. Missing one of these is fatal. */
  imports: string[]
  /**
   * Lowercased DLL names loaded on first use. A missing one only bites if the code path
   * that needs it is reached, so these are reported separately and never as the headline.
   */
  delayImports: string[]
  /**
   * The embedded manifest asks to run elevated. `null` means there was no manifest to
   * read, which is not the same as a manifest that asked for nothing.
   */
  requiresAdmin: boolean | null
  /**
   * Section names, which is how a packer gives itself away — `UPX0`, `.aspack`, `.themida`.
   * A packed executable's import table describes the stub, not the program, so knowing
   * the table is uninformative matters more than anything in it.
   */
  sections: string[]
}

interface Section {
  va: number
  vsize: number
  raw: number
  rawSize: number
}

function readAt(fd: number, offset: number, length: number): Buffer | null {
  if (offset < 0 || length <= 0) return null
  const buf = Buffer.alloc(length)
  try {
    const read = fs.readSync(fd, buf, 0, length, offset)
    if (read < length) return read > 0 ? buf.subarray(0, read) : null
  } catch {
    return null
  }
  return buf
}

/** Map a virtual address to a file offset using the section table. */
function rvaToOffset(sections: Section[], rva: number): number | null {
  for (const s of sections) {
    const size = Math.max(s.vsize, s.rawSize)
    if (rva >= s.va && rva < s.va + size) {
      const delta = rva - s.va
      // Past the raw data means it lives only in memory (.bss and friends) — there is
      // nothing in the file to read.
      if (delta >= s.rawSize) return null
      return s.raw + delta
    }
  }
  return null
}

/** Read a NUL-terminated ASCII string, in bounded chunks. */
function readCString(fd: number, offset: number): string | null {
  const buf = readAt(fd, offset, MAX_NAME_LEN)
  if (!buf) return null
  const end = buf.indexOf(0)
  if (end <= 0) return null
  const name = buf.subarray(0, end).toString('latin1')
  // DLL names are ASCII by specification; anything else means we followed a bad pointer.
  return /^[\x20-\x7e]+$/.test(name) ? name : null
}

/**
 * Whether the embedded manifest demands elevation.
 *
 * Scanning the resource section as text rather than walking the resource tree. The
 * manifest is ASCII XML and `requestedExecutionLevel` is not a string that turns up by
 * accident, so a directory walk would buy precision that changes no answer — and this way
 * a resource tree the parser cannot make sense of still yields the one fact we came for.
 * The read is bounded to the resource directory, so it never touches the bulk of a large
 * executable.
 */
function readManifestElevation(
  fd: number,
  sections: Section[],
  rva: number,
  size: number
): boolean | null {
  if (!rva || !size) return null
  const offset = rvaToOffset(sections, rva)
  if (offset === null) return null
  const buf = readAt(fd, offset, Math.min(size, MAX_RESOURCE_SCAN))
  if (!buf) return null

  const text = buf.toString('latin1')
  const match = /requestedExecutionLevel[^>]*\blevel\s*=\s*["']([^"']+)["']/i.exec(text)
  if (!match) return text.includes('requestedExecutionLevel') ? false : null
  // Only `requireAdministrator` is unambiguous. `highestAvailable` gives a standard user
  // exactly what they already had, so treating it as "needs admin" would accuse a game
  // that starts perfectly well for most people.
  return /requireAdministrator/i.test(match[1])
}

function archOf(machine: number): PeArch {
  switch (machine) {
    case 0x014c:
      return 'x86'
    case 0x8664:
      return 'x64'
    case 0xaa64:
      return 'arm64'
    case 0x01c0:
    case 0x01c4:
      return 'arm'
    default:
      return 'unknown'
  }
}

/**
 * Walk an import descriptor table.
 *
 * Both the normal and the delay-load table are arrays of fixed-size records terminated
 * by an all-zero entry, differing only in record size and in where the name pointer sits.
 */
function readDescriptors(
  fd: number,
  sections: Section[],
  tableRva: number,
  recordSize: number,
  namePointerAt: number,
  /** Delay-load tables from older toolchains store virtual addresses, not RVAs. */
  imageBase: number,
  namesAreVa: boolean
): string[] {
  const start = rvaToOffset(sections, tableRva)
  if (start === null) return []

  const names: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < MAX_DESCRIPTORS; i++) {
    const rec = readAt(fd, start + i * recordSize, recordSize)
    if (!rec || rec.length < recordSize) break
    // The terminator is an all-zero record.
    let allZero = true
    for (const byte of rec) {
      if (byte !== 0) {
        allZero = false
        break
      }
    }
    if (allZero) break

    let nameRva = rec.readUInt32LE(namePointerAt)
    if (nameRva === 0) break
    if (namesAreVa) {
      if (nameRva < imageBase) break
      nameRva -= imageBase
    }
    const off = rvaToOffset(sections, nameRva)
    if (off === null) continue
    const name = readCString(fd, off)
    if (!name) continue
    const lower = name.toLowerCase()
    if (!seen.has(lower)) {
      seen.add(lower)
      names.push(lower)
    }
  }
  return names
}

/**
 * Parse an executable's headers and import tables.
 *
 * Returns null when the file cannot be read or is not a PE at all. A file that *is* a PE
 * but whose import table cannot be followed comes back with empty `imports` rather than
 * null, so the caller can tell "not an executable" from "nothing to report".
 */
export function readPe(exePath: string): PeInfo | null {
  let fd: number
  try {
    fd = fs.openSync(exePath, 'r')
  } catch {
    return null
  }

  try {
    const dos = readAt(fd, 0, 0x40)
    if (!dos || dos.length < 0x40 || dos.readUInt16LE(0) !== 0x5a4d) return null // 'MZ'

    const peOffset = dos.readUInt32LE(0x3c)
    const sig = readAt(fd, peOffset, 4)
    if (!sig || sig.length < 4) {
      // No new-executable header at all: a plain DOS program.
      return {
        arch: 'unknown',
        is16bit: true,
        isDotNet: false,
        imports: [],
        delayImports: [],
        requiresAdmin: null,
        sections: []
      }
    }
    const signature = sig.readUInt32LE(0)
    if (signature !== 0x00004550) {
      // 'PE\0\0'
      // 'NE' is 16-bit Windows, 'LE'/'LX' are OS/2 or VxD. None of them run on 64-bit
      // Windows, and saying so is more useful than saying "not an executable".
      const tag = sig.subarray(0, 2).toString('latin1')
      const is16 = tag === 'NE' || tag === 'LE' || tag === 'LX'
      if (!is16) return null
      return {
        arch: 'unknown',
        is16bit: true,
        isDotNet: false,
        imports: [],
        delayImports: [],
        requiresAdmin: null,
        sections: []
      }
    }

    const coff = readAt(fd, peOffset + 4, 20)
    if (!coff || coff.length < 20) return null
    const machine = coff.readUInt16LE(0)
    const sectionCount = coff.readUInt16LE(2)
    const optionalSize = coff.readUInt16LE(16)

    const optionalOffset = peOffset + 24
    const optional = readAt(fd, optionalOffset, Math.max(optionalSize, 96))
    if (!optional || optional.length < 96) return null

    const magic = optional.readUInt16LE(0)
    const isPe32Plus = magic === 0x20b
    // Data directories sit right after the fixed part of the optional header, whose size
    // is the only thing that differs between PE32 and PE32+.
    const dirOffset = isPe32Plus ? 112 : 96
    const dirCountOffset = isPe32Plus ? 108 : 92
    const imageBase = isPe32Plus
      ? Number(optional.readBigUInt64LE(24))
      : optional.readUInt32LE(28)
    const dirCount =
      optional.length > dirCountOffset + 4 ? optional.readUInt32LE(dirCountOffset) : 0

    const dirRva = (index: number): number => {
      if (index >= dirCount) return 0
      const at = dirOffset + index * 8
      if (optional.length < at + 8) return 0
      return optional.readUInt32LE(at)
    }

    const sections: Section[] = []
    const sectionNames: string[] = []
    const sectionTable = optionalOffset + optionalSize
    for (let i = 0; i < Math.min(sectionCount, 96); i++) {
      const s = readAt(fd, sectionTable + i * 40, 40)
      if (!s || s.length < 40) break
      sections.push({
        vsize: s.readUInt32LE(8),
        va: s.readUInt32LE(12),
        rawSize: s.readUInt32LE(16),
        raw: s.readUInt32LE(20)
      })
      // Eight bytes, NUL-padded rather than NUL-terminated when full.
      sectionNames.push(s.subarray(0, 8).toString('latin1').replace(/\0+$/, ''))
    }

    const importRva = dirRva(DIR_IMPORT)
    const delayRva = dirRva(DIR_DELAY_IMPORT)

    const dirSize = (index: number): number => {
      if (index >= dirCount) return 0
      const at = dirOffset + index * 8 + 4
      return optional.length < at + 4 ? 0 : optional.readUInt32LE(at)
    }

    // Delay-load descriptor, field 0 is Attributes; bit 0 set means the pointers in this
    // record are RVAs. Older MSVC emitted virtual addresses with the bit clear.
    let delayNamesAreVa = false
    if (delayRva) {
      const at = rvaToOffset(sections, delayRva)
      const head = at === null ? null : readAt(fd, at, 4)
      if (head && head.length === 4) delayNamesAreVa = (head.readUInt32LE(0) & 1) === 0
    }

    return {
      arch: archOf(machine),
      is16bit: false,
      isDotNet: dirRva(DIR_CLR) !== 0,
      imports: importRva
        ? readDescriptors(fd, sections, importRva, 20, 12, imageBase, false)
        : [],
      delayImports: delayRva
        ? readDescriptors(fd, sections, delayRva, 32, 4, imageBase, delayNamesAreVa)
        : [],
      requiresAdmin: readManifestElevation(
        fd,
        sections,
        dirRva(DIR_RESOURCE),
        dirSize(DIR_RESOURCE)
      ),
      sections: sectionNames
    }
  } finally {
    fs.closeSync(fd)
  }
}
