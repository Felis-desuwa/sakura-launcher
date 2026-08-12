import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ShareJob, ShareOptions, ShareResult } from '../shared/types'
// Extension spelled out so `scripts/share-e2e.mts` can import this module straight into
// node; nothing fills it in there.
import { find7z } from './archive.ts'
import { t } from './i18n.ts'

/**
 * Packing a game up to send to someone.
 *
 * The one invariant: **the game folder is never written to.** Personal data is kept out
 * of the archive by telling 7-Zip to skip it, not by moving or deleting anything, so a
 * share that fails half way through leaves a partial archive and nothing else. That is
 * the same promise the rest of the app makes — removing a tile does not delete files,
 * renaming does not rename the folder — and it is the reason this feature can be run
 * without a confirmation ritual.
 */

/** Extensions written for each format. */
const EXT: Record<ShareOptions['format'], string> = { '7z': '.7z', zip: '.zip' }

export interface ShareHandle {
  cancel: () => void
}

export function archivePathFor(job: ShareJob, format: ShareOptions['format']): string {
  return path.join(job.outDir, job.name + EXT[format])
}

/**
 * Write the exclusion list 7-Zip reads.
 *
 * Concrete paths, not wildcards. The scan already resolved every rule to the files it
 * actually matched, and those are what the user ticked — feeding 7z the patterns instead
 * would let one of them match something else that was never shown to anybody. Paths are
 * relative to the folder we run from (the game folder's parent), which is how 7z stores
 * them and therefore how it matches them.
 *
 * UTF-8 with no BOM, paired with `-scsUTF-8`: 7z otherwise reads the list in the ANSI
 * codepage and every Chinese or Japanese path in it silently fails to match.
 */
export function writeExcludeFile(job: ShareJob, gameDir: string): string | null {
  if (job.exclude.length === 0) return null
  const parent = path.dirname(gameDir)
  const lines = job.exclude.map((abs) => path.relative(parent, abs))
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-share-')),
    'exclude.txt'
  )
  fs.writeFileSync(file, lines.join('\r\n'), { encoding: 'utf-8' })
  return file
}

function argsFor(
  job: ShareJob,
  gameDir: string,
  options: ShareOptions,
  excludeFile: string | null
): string[] {
  const args = [
    'a',
    options.format === 'zip' ? '-tzip' : '-t7z',
    archivePathFor(job, options.format),
    // The folder itself, so unpacking gives a folder rather than a heap of loose files.
    path.basename(gameDir),
    '-bsp1',
    '-y',
    // Console output in UTF-8. Without it 7z writes its messages in the OEM codepage
    // and anything it has to say about a failure reaches the user as mojibake — which
    // is exactly the moment the text matters most.
    '-sccUTF-8'
  ]
  if (excludeFile) args.push(`-x@${excludeFile}`, '-scsUTF-8')
  if (options.password) {
    args.push(`-p${options.password}`)
    // Names are only hideable in 7z; zip always leaves the listing readable.
    if (options.format === '7z' && options.encryptNames) args.push('-mhe=on')
    if (options.format === 'zip') args.push('-mem=AES256')
  }
  return args
}

export interface ShareProgress {
  gameId: string
  /** 0–100 for the archive currently being written. */
  percent: number
  /** 1-based position in the queue. */
  index: number
  total: number
}

/**
 * Run a queue of shares, one archive at a time.
 *
 * Sequential on purpose: 7-Zip already saturates the cores it is given, so two at once
 * only makes them fight over the disk and finishes both later than doing them in turn.
 *
 * A failure does not stop the queue — the point of selecting eight games is not to find
 * out that the third one has a permissions problem and the other five never ran.
 */
export function startShare(
  jobs: { job: ShareJob; gameDir: string }[],
  options: ShareOptions,
  onProgress: (progress: ShareProgress) => void,
  onDone: (results: ShareResult[]) => void
): ShareHandle {
  const exe = find7z()
  if (!exe) {
    onDone(
      jobs.map(({ job }) => ({
        gameId: job.gameId,
        ok: false,
        error: t('err.no7z')
      }))
    )
    return { cancel: () => {} }
  }

  const results: ShareResult[] = []
  let current: ChildProcess | null = null
  let cancelled = false

  /** Half an archive is worse than none — it looks finished in a file listing. */
  const discard = (file: string): void => {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* nothing to clean up */
    }
  }

  const runNext = (index: number): void => {
    if (cancelled || index >= jobs.length) {
      for (let i = index; i < jobs.length; i++) {
        results.push({ gameId: jobs[i].job.gameId, ok: false, skipped: true })
      }
      onDone(results)
      return
    }

    const { job, gameDir } = jobs[index]
    const out = archivePathFor(job, options.format)
    let excludeFile: string | null = null
    try {
      fs.mkdirSync(job.outDir, { recursive: true })
      if (options.overwrite) discard(out)
      excludeFile = writeExcludeFile(job, gameDir)
    } catch (err) {
      results.push({
        gameId: job.gameId,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      })
      runNext(index + 1)
      return
    }

    const cleanup = (): void => {
      if (excludeFile) {
        try {
          fs.rmSync(path.dirname(excludeFile), { recursive: true, force: true })
        } catch {
          /* the temp dir will be swept up by the OS eventually */
        }
      }
    }

    onProgress({ gameId: job.gameId, percent: 0, index: index + 1, total: jobs.length })

    const child = spawn(exe, argsFor(job, gameDir, options, excludeFile), {
      // Run from the parent so 7z stores paths as `<folder>\...`, which is what the
      // exclusion list is written against.
      cwd: path.dirname(gameDir),
      windowsHide: true
    })
    current = child

    let stderr = ''
    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      // `-bsp1` prints lines like " 42% 12 - name"; take the last percentage seen.
      const matches = chunk.match(/(\d{1,3})%/g)
      if (matches && matches.length > 0) {
        const pct = parseInt(matches[matches.length - 1], 10)
        if (!Number.isNaN(pct)) {
          onProgress({
            gameId: job.gameId,
            percent: Math.min(100, pct),
            index: index + 1,
            total: jobs.length
          })
        }
      }
    })
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.on('error', (err) => {
      current = null
      cleanup()
      discard(out)
      results.push({ gameId: job.gameId, ok: false, error: err.message })
      runNext(index + 1)
    })

    child.on('close', (code) => {
      current = null
      cleanup()
      if (cancelled) {
        discard(out)
        results.push({ gameId: job.gameId, ok: false, skipped: true })
        runNext(jobs.length)
        return
      }
      if (code === 0) {
        results.push({ gameId: job.gameId, ok: true, file: out })
      } else {
        discard(out)
        results.push({
          gameId: job.gameId,
          ok: false,
          // 7z warns with code 1 (e.g. a file was locked); anything else is a failure.
          error: stderr.trim() || t('err.7zExit', { code: String(code) })
        })
      }
      runNext(index + 1)
    })
  }

  runNext(0)
  return {
    cancel: () => {
      cancelled = true
      current?.kill()
    }
  }
}
