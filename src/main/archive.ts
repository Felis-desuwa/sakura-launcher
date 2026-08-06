import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const SEVENZIP_CANDIDATES = [
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  'C:\\Program Files\\NanaZip\\7z.exe'
]

export function find7z(): string | null {
  for (const c of SEVENZIP_CANDIDATES) {
    if (fs.existsSync(c)) return c
  }
  return null
}

export interface ExtractHandle {
  cancel: () => void
}

/**
 * Extract an archive with 7-Zip, reporting progress parsed from its stdout.
 * The first volume is passed to 7z; it picks up the remaining parts itself.
 */
export function extractArchive(
  firstVolume: string,
  destDir: string,
  onProgress: (percent: number) => void,
  onDone: (result: { ok: boolean; error?: string; destDir: string }) => void
): ExtractHandle | null {
  const exe = find7z()
  if (!exe) {
    onDone({ ok: false, error: '未找到 7-Zip，请先安装或在设置中指定路径', destDir })
    return null
  }

  fs.mkdirSync(destDir, { recursive: true })

  const child = spawn(exe, ['x', firstVolume, `-o${destDir}`, '-y', '-bsp1'], {
    windowsHide: true
  })

  let stderr = ''
  child.stdout.setEncoding('utf-8')
  child.stdout.on('data', (chunk: string) => {
    // `-bsp1` prints lines like " 42% 12 - name"; take the last percentage seen.
    const matches = chunk.match(/(\d{1,3})%/g)
    if (matches && matches.length > 0) {
      const pct = parseInt(matches[matches.length - 1], 10)
      if (!Number.isNaN(pct)) onProgress(Math.min(100, pct))
    }
  })
  child.stderr.setEncoding('utf-8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  child.on('error', (err) => onDone({ ok: false, error: err.message, destDir }))
  child.on('close', (code) => {
    if (code === 0) onDone({ ok: true, destDir })
    else onDone({ ok: false, error: stderr.trim() || `7z 退出码 ${code}`, destDir })
  })

  return { cancel: () => child.kill() }
}

/** Default extraction target: a sibling folder named after the archive. */
export function defaultDestFor(firstVolume: string): string {
  const dir = path.dirname(firstVolume)
  const base = path
    .basename(firstVolume)
    .replace(/\.7z\.\d{3}$/i, '')
    .replace(/\.part\d+\.rar$/i, '')
    .replace(/\.(7z|zip|rar)$/i, '')
  return path.join(dir, base)
}
