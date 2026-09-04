import { net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import * as db from './db'
import {
  DFAN_HOST,
  INDEX_MAX_AGE_MS,
  SAIGA_HOST,
  SAIGA_INDEX_URL,
  dfanSearchUrl,
  parseSaigaIndex,
  rankDfan,
  read2dfan,
  searchIndex,
  type GuideEntry
} from './guide-rules'
import type { GuideProviderResult, GuideSearch } from '../shared/types'

/**
 * Reaching the two walkthrough sites.
 *
 * **Only ever from the button in the drawer.** Nothing here runs on a scan, a refresh, a
 * launch or at startup; the one entry point below is called from one IPC handler and from
 * nowhere else. That is the same shape the update check has, and for the same reason.
 *
 * The socket lives here rather than in `tag-online.ts` because neither response can go
 * through `getJson`: 誠也の部屋 answers with **cp932 HTML**, which that function would put
 * through `JSON.parse` after decoding as UTF-8, and 2DFan's envelope holds markup rather
 * than data. Decoding needs no dependency — `TextDecoder('shift_jis')` is already how
 * `diagnose.ts` reads an engine's own error box.
 *
 * What leaves the machine is the game's title. That is more than the update check sends
 * and it is worth saying plainly: 2DFan is asked, live, what this game is called. 誠也の
 * 部屋 is not — its index is fetched whole and searched here, so it never learns which
 * game anybody looked up.
 */

const TIMEOUT_MS = 20_000

/** The index is a megabyte of HTML. Anything far past that is not the page we asked for. */
const MAX_INDEX_BYTES = 8 * 1024 * 1024

/** 2DFan's answer is a page of results. */
const MAX_ANSWER_BYTES = 2 * 1024 * 1024

interface CachedIndex {
  fetchedAt: number
  entries: GuideEntry[]
}

/** Held for the session too, so a second search in one sitting reads nothing at all. */
let memory: CachedIndex | null = null

function indexPath(): string {
  return path.join(db.guideCacheDir(), 'saiga.json')
}

/** One GET, returning the raw bytes so the caller can decide the encoding. */
function fetchBytes(url: string, accept: string, cap: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: Buffer | null): void => {
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
    }, TIMEOUT_MS)

    req.setHeader('Accept', accept)
    req.setHeader('User-Agent', 'SakuraLauncher (local game library manager)')

    req.on('response', (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        // Capped while it arrives, not after: refusing eight megabytes once eighty have
        // been received is not a cap.
        if (size > cap) {
          clearTimeout(timer)
          try {
            req.abort()
          } catch {
            /* already gone */
          }
          return finish(null)
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        clearTimeout(timer)
        if (res.statusCode < 200 || res.statusCode >= 300) return finish(null)
        finish(Buffer.concat(chunks))
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

/** Read the copy on disk, however old it is. */
function readCache(): CachedIndex | null {
  if (memory) return memory
  try {
    const cached = JSON.parse(fs.readFileSync(indexPath(), 'utf-8')) as CachedIndex
    if (!Array.isArray(cached.entries) || cached.entries.length === 0) return null
    memory = cached
    return cached
  } catch {
    return null
  }
}

/**
 * The index, fetched if there is no fresh copy.
 *
 * **A failed fetch keeps whatever is on disk** rather than blanking it, the same policy
 * `display-info.ts` holds for a failed display query: a feature that goes empty because a
 * site was briefly unreachable is worse than one answering from last week, and the answer
 * it would give — "no walkthrough for this game" — is a lie rather than a shrug.
 */
async function loadIndex(): Promise<CachedIndex | null> {
  const cached = readCache()
  if (cached && Date.now() - cached.fetchedAt < INDEX_MAX_AGE_MS) return cached

  const bytes = await fetchBytes(SAIGA_INDEX_URL, 'text/html', MAX_INDEX_BYTES)
  if (!bytes) return cached

  // The page is cp932. Decoded as UTF-8 every title would be mojibake and every search
  // would find nothing, which is the quiet way this feature could fail.
  const html = new TextDecoder('shift_jis').decode(bytes)
  const entries = parseSaigaIndex(html)
  // A page that parsed to nothing is a page that changed shape, not an empty site.
  if (entries.length === 0) return cached

  const fresh: CachedIndex = { fetchedAt: Date.now(), entries }
  memory = fresh
  try {
    fs.writeFileSync(indexPath(), JSON.stringify(fresh), 'utf-8')
  } catch {
    /* the cache is best-effort; the session copy is enough to answer with */
  }
  return fresh
}

async function askSaiga(query: string): Promise<GuideProviderResult> {
  const index = await loadIndex()
  if (!index) return { provider: 'saiga', state: 'failed', hits: [] }
  const hits = searchIndex(index.entries, query)
  return {
    provider: 'saiga',
    state: hits.length > 0 ? 'hits' : 'none',
    hits,
    fetchedAt: index.fetchedAt
  }
}

async function askDfan(query: string): Promise<GuideProviderResult> {
  const bytes = await fetchBytes(dfanSearchUrl(query), 'application/json', MAX_ANSWER_BYTES)
  if (!bytes) return { provider: '2dfan', state: 'failed', hits: [] }

  let body: unknown
  try {
    body = JSON.parse(bytes.toString('utf-8'))
  } catch {
    return { provider: '2dfan', state: 'failed', hits: [] }
  }

  const read = read2dfan(body)
  // Markup that changed shape is a failure, never an empty list. Reporting it as "no
  // walkthrough found" would make a broken reader look like a fact about the game.
  if (!read.ok) return { provider: '2dfan', state: 'failed', hits: [] }
  if (read.hits.length === 0) return { provider: '2dfan', state: 'none', hits: [] }

  const { ranked, loose } = rankDfan(read.hits, query)
  return { provider: '2dfan', state: 'hits', hits: ranked, loose }
}

/**
 * Both sites, for one game.
 *
 * Asked in parallel because they share nothing: one is a local search over a page already
 * on disk and the other is a request, so waiting for the second to start the first buys
 * nothing. Neither can fail the other — each reports its own state.
 */
export async function searchGuides(query: string): Promise<GuideSearch> {
  const trimmed = query.trim()
  if (!trimmed) return { query: trimmed, results: [] }
  const results = await Promise.all([askSaiga(trimmed), askDfan(trimmed)])
  return { query: trimmed, results }
}

/** Hosts this feature reaches, for the note in the interface. */
export const GUIDE_HOSTS = [SAIGA_HOST, DFAN_HOST]
