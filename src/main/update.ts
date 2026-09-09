import { app, net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import {
  checkSize,
  decideUpdate,
  httpProblem,
  rateLimitReset,
  releasesUrl,
  requestHeaders,
  uniqueDownloadName
} from './update-rules'
import type { UpdateAssetKind, UpdateChannel, UpdateDownload, UpdateVerdict } from '../shared/types'

/**
 * Asking GitHub whether there is a newer release, and fetching one file of it.
 *
 * **Only ever from a button.** Nothing here is reachable from startup, a scan, a refresh
 * or a launch — the two entry points below are called from two IPC handlers and from
 * nowhere else, which is what leaves "scanning, refreshing and launching never go near
 * the network" true in both READMEs.
 *
 * The socket lives here rather than in `tag-online.ts`, which is otherwise the one file
 * that opens one, for two reasons that are about shape rather than tidiness. The check
 * needs the **status line and the headers** — a spent rate limit and an unreachable host
 * are different sentences, and `request()` there resolves every failure to a bare `null`
 * on purpose. And the download needs a **stream to a file the user chose**, where
 * `fetchImage` buffers into memory under an 8 MB cap; an installer is a hundred times
 * that.
 *
 * What leaves the machine is a GET with a User-Agent naming the program and its version.
 * No identifier, nothing about the library, nothing about the machine.
 */

/** Long enough for a slow link, short enough that a dead one does not look like work. */
const CHECK_TIMEOUT_MS = 15_000

/** A stalled transfer, not a slow one: this is the gap between chunks, not the total. */
const STALL_MS = 60_000

/**
 * The last verdict this process worked out, and the only source of a download address.
 *
 * The renderer asks for a `kind` and never for a URL, the same way it names a game id and
 * a yes or no when a cover is offered. A path or an address arriving from the renderer is
 * a path this process did not choose.
 */
let lastVerdict: UpdateVerdict | null = null

/** The transfer in flight, so it can be called off. At most one. */
let inFlight: { abort: () => void } | null = null

/** One GET, with the status line and headers kept. */
function getWithStatus(
  url: string,
  headers: Record<string, string>
): Promise<{ status: number; headers: Record<string, string>; body: string } | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: { status: number; headers: Record<string, string>; body: string } | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    let req: Electron.ClientRequest
    try {
      req = net.request({ method: 'GET', url })
    } catch {
      return finish(null)
    }

    const timer = setTimeout(() => {
      try {
        req.abort()
      } catch {
        /* already gone */
      }
      finish(null)
    }, CHECK_TIMEOUT_MS)

    for (const [name, value] of Object.entries(headers)) req.setHeader(name, value)

    req.on('response', (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        clearTimeout(timer)
        const flat: Record<string, string> = {}
        for (const [name, value] of Object.entries(res.headers)) {
          flat[name] = Array.isArray(value) ? value.join(', ') : String(value)
        }
        finish({ status: res.statusCode, headers: flat, body: Buffer.concat(chunks).toString('utf-8') })
      })
      res.on('error', () => {
        clearTimeout(timer)
        finish(null)
      })
    })
    req.on('error', () => {
      clearTimeout(timer)
      finish(null)
    })
    req.end()
  })
}

/**
 * Ask once whether there is something newer.
 *
 * Every distinguishable failure gets its own reason, because the answers differ: a rate
 * limit is a wait, an unreachable host is a network to look at, and a version this build
 * cannot state is a packaging fault that has nothing to do with either.
 */
export async function checkForUpdate(channel: UpdateChannel): Promise<UpdateVerdict> {
  const running = app.getVersion()
  const answer = await getWithStatus(releasesUrl(), requestHeaders(running))

  if (!answer) {
    lastVerdict = { kind: 'failed', channel, running, reason: 'offline' }
    return lastVerdict
  }

  const problem = httpProblem(answer.status, answer.headers)
  if (problem) {
    const retryAt = problem === 'rateLimited' ? rateLimitReset(answer.headers, Date.now()) : null
    lastVerdict = {
      kind: 'failed',
      channel,
      running,
      reason: problem,
      detail: String(answer.status),
      ...(retryAt ? { retryAt } : {})
    }
    return lastVerdict
  }

  let body: unknown
  try {
    body = JSON.parse(answer.body)
  } catch {
    // Reached something, and it was not JSON — a captive portal, or a proxy's error page.
    lastVerdict = { kind: 'failed', channel, running, reason: 'badResponse' }
    return lastVerdict
  }

  lastVerdict = decideUpdate({ running, channel, releases: body })
  return lastVerdict
}

/** The release this process last found, for the download to resolve a `kind` against. */
export function offeredAsset(kind: UpdateAssetKind): { url: string; name: string; size: number } | null {
  if (!lastVerdict) return null
  if (lastVerdict.kind !== 'available' && lastVerdict.kind !== 'ahead') return null
  const asset = lastVerdict.release.assets.find((a) => a.kind === kind)
  return asset ? { url: asset.url, name: asset.name, size: asset.size } : null
}

/** Call off the transfer in flight, if there is one. */
export function cancelDownload(): void {
  inFlight?.abort()
}

/**
 * Fetch one release asset into a folder the user picked.
 *
 * Written to `<name>.part` and renamed only once the whole thing has arrived at the size
 * the release declared. A hundred megabytes that stopped at sixty is not a smaller
 * installer, it is a program that will fail halfway through doing something to somebody's
 * machine — and left under its real name it is a program they would double-click.
 *
 * Nothing is installed and nothing is replaced. The file lands in a folder and the folder
 * is opened; what to do with it is the user's.
 */
export function downloadAsset(
  url: string,
  suggested: string,
  dir: string,
  expected: number,
  onProgress: (received: number, total: number) => void
): Promise<UpdateDownload> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: UpdateDownload): void => {
      if (settled) return
      settled = true
      inFlight = null
      resolve(value)
    }

    let final: string
    try {
      const name = uniqueDownloadName(suggested, (candidate) => fs.existsSync(path.join(dir, candidate)))
      final = path.join(dir, name)
    } catch (err) {
      return finish({ ok: false, error: 'write', detail: String(err) })
    }
    const part = `${final}.part`

    let out: fs.WriteStream
    try {
      out = fs.createWriteStream(part)
    } catch (err) {
      return finish({ ok: false, error: 'write', detail: String(err) })
    }

    const scrap = (): void => {
      try {
        out.destroy()
      } catch {
        /* already gone */
      }
      try {
        if (fs.existsSync(part)) fs.unlinkSync(part)
      } catch {
        /* leaving a .part behind is the lesser harm */
      }
    }

    let req: Electron.ClientRequest
    try {
      req = net.request({ method: 'GET', url })
    } catch {
      scrap()
      return finish({ ok: false, error: 'network' })
    }

    let stall: NodeJS.Timeout | null = null
    const touch = (): void => {
      if (stall) clearTimeout(stall)
      stall = setTimeout(() => {
        try {
          req.abort()
        } catch {
          /* already gone */
        }
        scrap()
        finish({ ok: false, error: 'network', detail: 'stalled' })
      }, STALL_MS)
    }

    inFlight = {
      abort: () => {
        if (stall) clearTimeout(stall)
        try {
          req.abort()
        } catch {
          /* already gone */
        }
        scrap()
        finish({ ok: false, error: 'refused', detail: 'cancelled' })
      }
    }

    req.setHeader('User-Agent', requestHeaders(app.getVersion())['User-Agent'])
    touch()

    req.on('response', (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        if (stall) clearTimeout(stall)
        scrap()
        return finish({ ok: false, error: 'network', detail: String(res.statusCode) })
      }
      // `net` follows the redirect to the object store on its own, and the length on the
      // final response is the one that counts. Zero when it declared none.
      const declared = Number(res.headers['content-length'] ?? 0)
      const total = Number.isFinite(declared) && declared > 0 ? declared : expected
      let received = 0

      res.on('data', (chunk: Buffer) => {
        received += chunk.length
        touch()
        // No backpressure dance: Electron's IncomingMessage does not offer pause/resume,
        // and a local disk outruns a download by orders of magnitude, so the write
        // stream's own buffer is never the thing that fills up.
        out.write(chunk)
        onProgress(received, total)
      })
      res.on('end', () => {
        if (stall) clearTimeout(stall)
        out.end(() => {
          const verdict = checkSize(total, received)
          if (verdict === 'short' || verdict === 'long') {
            scrap()
            return finish({ ok: false, error: 'truncated', detail: `${received}/${total}` })
          }
          try {
            fs.renameSync(part, final)
          } catch (err) {
            scrap()
            return finish({ ok: false, error: 'write', detail: String(err) })
          }
          finish({ ok: true, path: final })
        })
      })
      res.on('error', () => {
        if (stall) clearTimeout(stall)
        scrap()
        finish({ ok: false, error: 'network' })
      })
    })
    req.on('error', () => {
      if (stall) clearTimeout(stall)
      scrap()
      finish({ ok: false, error: 'network' })
    })
    req.end()
  })
}
