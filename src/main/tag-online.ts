import { net } from 'electron'
import { mainLang } from './i18n'
import { searchBangumi, type BangumiWork } from './tag-bangumi.ts'
import { dlsiteWork, vndbWorks, type DlsiteProduct, type VndbVn } from './tag-rules.ts'
import type { WorkMatch } from '../shared/types'

/**
 * The one place this program opens a socket.
 *
 * Everything else about Sakura Launcher is deliberately local, and that is not an
 * accident of implementation — it is the promise on the first page of the README. A
 * story's genre is the single thing a launcher cannot read off a disk, so this exists,
 * and it is switched off until the user switches it on.
 *
 * What leaves the machine is bounded and worth stating exactly, because "we only send
 * anonymous data" is what every program says: **a work number read out of the folder
 * name, or the folder's own name.** Not the path it sits at, not its size, not how long
 * it has been played, not the rating, not the library's shape, not an identifier for the
 * user or the installation. Nothing is ever sent about a game the user did not ask to
 * have tagged.
 *
 * Requests go through Electron's `net` rather than node's `https` so that a system proxy
 * is honoured — on the kind of connection these catalogues are usually reached over,
 * that is the difference between working and not.
 */

/** Long enough for a slow catalogue, short enough that a stalled library pass still ends. */
const TIMEOUT_MS = 15_000

/**
 * Gap between requests, per host.
 *
 * VNDB documents 200 requests per five minutes — 1.5 s apiece — and asks for a second of
 * execution time per minute on top; two seconds keeps a large library comfortably inside
 * both without ever having to handle a 429. DLsite publishes no limit, so it gets a
 * plain second of courtesy.
 *
 * Tracked per host rather than globally because they are unrelated services: making a
 * DLsite lookup wait on VNDB's budget doubles the time a library takes for no reason.
 */
const GAP_MS: Record<string, number> = { vndb: 2_000, dlsite: 1_000, bangumi: 1_000 }

const lastRequestAt: Record<string, number> = {}

async function pace(host: keyof typeof GAP_MS): Promise<void> {
  const wait = (lastRequestAt[host] ?? 0) + GAP_MS[host] - Date.now()
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  lastRequestAt[host] = Date.now()
}

interface FetchOptions {
  method: 'GET' | 'POST'
  url: string
  body?: string
}

/**
 * One request, resolving to the parsed body or null.
 *
 * Every failure — offline, timeout, rate limit, a catalogue that changed its shape —
 * comes back as null rather than an exception. A tagging pass over two hundred games
 * must not end because the ninetieth request timed out, and the user's answer to "we
 * could not reach the catalogue" is the same in all of those cases anyway.
 */
function request<T>({ method, url, body }: FetchOptions): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: T | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    let req: Electron.ClientRequest
    try {
      req = net.request({ method, url })
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
    }, TIMEOUT_MS)

    req.setHeader('Accept', 'application/json')
    // Identify the program honestly. A catalogue being able to see who is calling is what
    // lets it ask us to stop rather than simply block us.
    req.setHeader('User-Agent', 'SakuraLauncher/0.6 (local game library manager)')
    if (body !== undefined) req.setHeader('Content-Type', 'application/json; charset=utf-8')

    req.on('response', (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        clearTimeout(timer)
        if (res.statusCode < 200 || res.statusCode >= 300) return finish(null)
        try {
          finish(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T)
        } catch {
          finish(null)
        }
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

    if (body !== undefined) req.write(body, 'utf-8')
    req.end()
  })
}

/**
 * Look a DLsite work number up.
 *
 * The catalogue is asked in the interface language and answers in it — the genres come
 * back as 巨乳 or 巨乳/爆乳 under `zh_CN` and in Japanese under `ja_JP` — which is why
 * these tags need no translation table of ours.
 *
 * A work number identifies exactly one product, so a hit here is not a guess and is
 * adopted without troubling the user.
 */
export async function lookupDlsite(workNo: string): Promise<WorkMatch | null> {
  await pace('dlsite')
  const locale = mainLang() === 'zh' ? 'zh_CN' : 'ja_JP'
  const url = `https://www.dlsite.com/maniax/api/=/product.json?workno=${encodeURIComponent(
    workNo
  )}&locale=${locale}`
  const body = await request<DlsiteProduct[]>({ method: 'GET', url })
  if (!Array.isArray(body) || body.length === 0) return null
  return dlsiteWork(body[0])
}

/**
 * Fields asked of VNDB.
 *
 * `titles{}` is the one that matters and the one that was missing: a work carries a name
 * per language, and without them a Chinese folder name can never match anything, because
 * `title` is romaji and `alttitle` is Japanese. Asking for it costs nothing extra —
 * it is the same row either way.
 */
const VNDB_FIELDS =
  'id,title,alttitle,released,titles{lang,title,latin},tags.name,tags.rating,tags.spoiler,tags.category'

/**
 * One query against VNDB.
 *
 * `searchrank` is only a legal sort when the filter is a search — asking for it on an id
 * lookup is rejected outright, and the rejection arrives as a plain error body that reads
 * exactly like "no such work". So the sort travels with the search and not otherwise.
 */
async function queryVndb(
  filters: unknown,
  query: string,
  { results = 5, ranked = true } = {}
): Promise<WorkMatch[]> {
  await pace('vndb')
  const body = await request<{ results?: VndbVn[] }>({
    method: 'POST',
    url: 'https://api.vndb.org/kana/vn',
    body: JSON.stringify({
      filters,
      fields: VNDB_FIELDS,
      ...(ranked ? { sort: 'searchrank' } : {}),
      results
    })
  })
  if (!body || !Array.isArray(body.results)) return []
  return vndbWorks(body.results, query)
}

/**
 * Search VNDB by title.
 *
 * Returns every plausible entry rather than the best one. A title search can land on a
 * fan disc, a sequel or a different game that happens to share a word, and the user
 * asked to be shown the candidates in exactly that case — so the choosing does not
 * happen here.
 */
export function searchVndb(title: string): Promise<WorkMatch[]> {
  return queryVndb(['search', '=', title], title)
}

/**
 * Fetch one VNDB entry by its id.
 *
 * For the manual box, where somebody has pasted `v1234` or a link to it. An id is not a
 * guess, so the result is scored against its own title — it will match itself, and the
 * user gets an adopt button rather than a ranked list of one.
 */
export async function vndbById(id: string): Promise<WorkMatch | null> {
  const [match] = await queryVndb(['id', '=', id], '', { results: 1, ranked: false })
  if (!match) return null
  return { ...match, score: 1 }
}

/**
 * Ask Bangumi what a game is called.
 *
 * Only the search endpoint, and only for names — see `tag-bangumi.ts` for why the tags
 * are out of reach without a login.
 */
export async function bangumiSearch(query: string, limit = 3): Promise<BangumiWork[]> {
  await pace('bangumi')
  return searchBangumi(query, (url) => request<unknown>({ method: 'GET', url }), limit)
}
