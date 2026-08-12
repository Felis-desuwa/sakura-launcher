import { shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { DiskInfo, RedundantArchive } from '../shared/types'
import * as db from './db'
import { findExtractedDir, walkRoot, type FoundArchive } from './scan-core'

function driveOf(p: string): string {
  const parsed = path.parse(path.resolve(p))
  return parsed.root
}

export function diskInfo(): DiskInfo[] {
  const drives = new Set<string>()
  for (const root of db.getSettings().roots) drives.add(driveOf(root))
  for (const game of db.getGames()) drives.add(driveOf(game.dir))

  const out: DiskInfo[] = []
  for (const drive of drives) {
    try {
      const st = fs.statfsSync(drive)
      out.push({
        drive,
        totalBytes: st.blocks * st.bsize,
        freeBytes: st.bavail * st.bsize
      })
    } catch {
      /* drive went away */
    }
  }
  return out.sort((a, b) => a.drive.localeCompare(b.drive))
}

/**
 * Archives that still sit next to an extracted copy of themselves.
 * These are pure duplication and usually the single biggest reclaimable chunk.
 */
export function redundantArchives(): RedundantArchive[] {
  const settings = db.getSettings()
  const out: RedundantArchive[] = []
  const seen = new Set<string>()

  for (const root of settings.roots) {
    if (!fs.existsSync(root)) continue
    const { games, archives } = walkRoot(root)
    const gameDirs = games.map((g) => g.dir)
    for (const archive of archives) {
      const extractedDir = findExtractedDir(archive, gameDirs)
      if (!extractedDir) continue
      const key = archive.volumes[0].toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        name: archive.name,
        volumes: archive.volumes,
        sizeBytes: archive.sizeBytes,
        extractedDir
      })
    }
  }
  return out.sort((a, b) => b.sizeBytes - a.sizeBytes)
}

export async function trashArchives(volumes: string[]): Promise<{ ok: boolean; error?: string }> {
  try {
    for (const v of volumes) {
      if (fs.existsSync(v)) await shell.trashItem(v)
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export type { FoundArchive }
