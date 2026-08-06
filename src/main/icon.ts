import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { extractLargestIcon } from './pe-icon'
import { iconCacheDir } from './db'

/**
 * Only filenames that clearly mean "this is the artwork" are auto-adopted.
 * Matching any image in the folder picks up manuals and screenshots instead.
 */
const COVER_NAMES = /^(preview|cover|folder|thumb|thumbnail|banner|title|logo|封面|预览)$/i
const IMAGE_EXT = /\.(jpg|jpeg|png|webp|bmp)$/i

/** Below this the icon looks worse upscaled than a generated placeholder does. */
export const MIN_USABLE_ICON_PX = 64

function hashKey(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 16)
}

export function findCoverImage(dir: string): string | null {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    if (!e.isFile() || !IMAGE_EXT.test(e.name)) continue
    const base = e.name.replace(IMAGE_EXT, '')
    if (COVER_NAMES.test(base)) return path.join(dir, e.name)
  }
  return null
}

/**
 * Extract the executable's largest icon into the cache and return its path.
 * Returns null when the executable has no icon, or only one too small to enlarge —
 * the renderer then draws a generated tile instead.
 */
export function cacheIconFor(exePath: string): string | null {
  let mtimeMs = 0
  try {
    mtimeMs = fs.statSync(exePath).mtimeMs
  } catch {
    return null
  }

  const key = hashKey(`${exePath}:${mtimeMs}`)
  const outPath = path.join(iconCacheDir(), `${key}.ico`)
  if (fs.existsSync(outPath)) return outPath

  const icon = extractLargestIcon(exePath)
  if (!icon || icon.width < MIN_USABLE_ICON_PX) return null

  try {
    fs.writeFileSync(outPath, icon.ico)
  } catch {
    return null
  }
  return outPath
}

/** Cover art wins over the executable icon; both are optional. */
export function resolveArtwork(
  dir: string,
  exePath: string
): { iconPath: string | null; coverPath: string | null } {
  const coverPath = findCoverImage(dir)
  const iconPath = exePath ? cacheIconFor(exePath) : null
  return { iconPath, coverPath }
}
