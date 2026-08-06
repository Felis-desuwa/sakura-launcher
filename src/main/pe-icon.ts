import fs from 'node:fs'
import { NtExecutable, NtExecutableResource, Resource } from 'resedit'

const RT_ICON = 3

export interface ExtractedIcon {
  width: number
  height: number
  /** A complete single-image .ico file. */
  ico: Buffer
}

interface CachedProbe {
  maxSize: number
  mtimeMs: number
}

const probeCache = new Map<string, CachedProbe>()

function readExeResources(exePath: string): NtExecutableResource | null {
  let buf: Buffer
  try {
    buf = fs.readFileSync(exePath)
  } catch {
    return null
  }
  try {
    // ignoreCert: signed executables carry a trailing certificate table that would
    // otherwise make parsing fail; we only ever read resources here.
    const exe = NtExecutable.from(buf, { ignoreCert: true })
    return NtExecutableResource.from(exe)
  } catch {
    return null
  }
}

/** ICO dimensions use 0 to mean 256. */
function realDim(v: number): number {
  return v === 0 ? 256 : v
}

/**
 * Largest icon dimension embedded in the executable, or 0 if it has none.
 * Cached per path+mtime because the scanner uses it as a tie-break while ranking
 * candidate executables.
 */
export function probeMaxIconSize(exePath: string): number {
  let mtimeMs = 0
  try {
    mtimeMs = fs.statSync(exePath).mtimeMs
  } catch {
    return 0
  }
  const hit = probeCache.get(exePath)
  if (hit && hit.mtimeMs === mtimeMs) return hit.maxSize

  let maxSize = 0
  const res = readExeResources(exePath)
  if (res) {
    try {
      for (const group of Resource.IconGroupEntry.fromEntries(res.entries)) {
        for (const icon of group.icons) {
          maxSize = Math.max(maxSize, realDim(icon.width))
        }
      }
    } catch {
      maxSize = 0
    }
  }
  probeCache.set(exePath, { maxSize, mtimeMs })
  return maxSize
}

/** Wrap a raw RT_ICON payload (BITMAPINFOHEADER + masks, or a PNG) in an .ico container. */
function buildIco(image: Buffer, width: number, height: number, bitCount: number): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(1, 4) // one image

  const entry = Buffer.alloc(16)
  entry.writeUInt8(width >= 256 ? 0 : width, 0)
  entry.writeUInt8(height >= 256 ? 0 : height, 1)
  entry.writeUInt8(0, 2) // palette size
  entry.writeUInt8(0, 3) // reserved
  entry.writeUInt16LE(1, 4) // color planes
  entry.writeUInt16LE(bitCount, 6)
  entry.writeUInt32LE(image.length, 8)
  entry.writeUInt32LE(header.length + entry.length, 12)

  return Buffer.concat([header, entry, image])
}

/**
 * Pull the highest-resolution icon out of an executable.
 * Most modern game executables ship a 256x256 entry, which is what makes large
 * tiles look sharp; callers should fall back to a placeholder when this returns
 * something too small to scale up.
 */
export function extractLargestIcon(exePath: string): ExtractedIcon | null {
  const res = readExeResources(exePath)
  if (!res) return null

  let groups: ReturnType<typeof Resource.IconGroupEntry.fromEntries>
  try {
    groups = Resource.IconGroupEntry.fromEntries(res.entries)
  } catch {
    return null
  }
  if (groups.length === 0) return null

  let best: { id: number | string; width: number; height: number; bitCount: number } | null = null
  for (const group of groups) {
    for (const icon of group.icons) {
      const w = realDim(icon.width)
      const h = realDim(icon.height)
      if (!best || w > best.width || (w === best.width && icon.bitCount > best.bitCount)) {
        best = { id: icon.iconID, width: w, height: h, bitCount: icon.bitCount }
      }
    }
  }
  if (!best) return null

  const iconEntry = res.entries.find(
    (e) => e.type === RT_ICON && String(e.id) === String(best!.id)
  )
  if (!iconEntry) return null

  const image = Buffer.from(iconEntry.bin)
  // A 256px icon is often stored as a PNG blob rather than a DIB; both are legal
  // inside an .ico and Chromium decodes either.
  return {
    width: best.width,
    height: best.height,
    ico: buildIco(image, best.width, best.height, best.bitCount)
  }
}
