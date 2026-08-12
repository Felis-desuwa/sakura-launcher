import fs from 'node:fs'
import path from 'node:path'
import type { Game, PendingMatch, SummarySource, WorkMatch } from '../shared/types'
import { acceptCover, coverSourceOf, mayReplaceCover, mayReplaceSummary } from './cover-rules.ts'
import * as db from './db'
import { pickBangumiSummary } from './tag-rules.ts'
import { lookupGame } from './tagger'
import { bangumiSearch, fetchImage, lookupDlsite, paceImage, vndbById } from './tag-online'

/**
 * Bringing back the picture a catalogue holds for a game.
 *
 * The match is the hard part and it is already solved: a game that has been tagged
 * carries `work = {source, workId}`, and the cover hangs off that same record. So a
 * cover for a matched game is one request to an id, with nothing to guess at.
 *
 * Never automatic. Tags run over a whole library because a wrong tag is a small thing
 * quietly hidden; a cover is painted across the tile at the size of a playing card, and
 * getting one wrong is the most visible mistake this program can make. So it takes an
 * explicit menu action every time — one game, or a selection.
 *
 * The description rides along here rather than having a button of its own, because it is
 * the same record: the picture and the blurb hang off the entry a match already settled,
 * and asking for them separately would be two trips for one answer.
 */

export interface CoverProgress {
  done: number
  total: number
  name: string
}

export interface CoverRun {
  /** Covers actually written. */
  fetched: number
  /** Descriptions brought back. Counted apart: a game can get one without the other. */
  summaries: number
  /** Games skipped because the user had chosen their own cover. */
  keptUser: number
  /** Games the catalogue had no picture for, or whose download failed. */
  missed: number
  /** Games that could not be matched at all — these need the manual dialog. */
  pending: PendingMatch[]
  /** Every request failed, so the UI can say "no network" once rather than per game. */
  offline: boolean
  cancelled: boolean
}

let cancelled = false
let running = false

export function cancelCoverRun(): void {
  if (running) cancelled = true
}

export function coverRunActive(): boolean {
  return running
}

/**
 * The catalogue record for a game whose work is already known.
 *
 * Straight to the id — no search, no ladder, no scoring. The work was settled when the
 * game was tagged (or when the user picked it in the match dialog), and asking the
 * catalogue the same question twice could only produce a different answer.
 */
async function matchForKnownWork(game: Game): Promise<WorkMatch | null> {
  const work = game.work
  if (!work) return null
  if (work.source === 'dlsite') return lookupDlsite(work.workId)
  return vndbById(work.workId)
}

/**
 * Write one cover to disk.
 *
 * The bytes are sniffed before they land: this file goes into the app's data directory
 * and is handed to the renderer through the asset protocol, and what a server sends is
 * not always what its headers promised. An HTML error page returned with status 200 is
 * the ordinary case, and it must not become `cover.jpg`.
 */
function writeCover(game: Game, bytes: Buffer, source: string): string | null {
  const kind = acceptCover(bytes)
  if (!kind) return null

  const dest = path.join(db.coverDir(), `${game.id}-${source}.${kind}`)
  try {
    fs.mkdirSync(db.coverDir(), { recursive: true })
    fs.writeFileSync(dest, bytes)
  } catch {
    return null
  }

  // An earlier cover for the same game under a different extension would otherwise sit
  // there for ever, unreferenced and taking up room.
  const previous = game.coverPath
  if (previous && path.resolve(previous) !== path.resolve(dest)) {
    const inOurs = path.resolve(previous).startsWith(path.resolve(db.coverDir()))
    if (inOurs) {
      try {
        fs.rmSync(previous, { force: true })
      } catch {
        /* a cover we could not remove is untidy, not broken */
      }
    }
  }
  return dest
}

/**
 * The Chinese description of a work.
 *
 * Two routes, and the cheap one is exact. A DLsite record reached by work number carries
 * its own copy, and that copy is about that product with nothing to match — so when it is
 * Chinese, it is taken and no further request is made.
 *
 * Otherwise Bangumi, which is where a Chinese description of a Japanese game is written
 * down and the only one reachable without a login. One search, under the name the work
 * was released as, and the row has to *be* the work: a description is the one piece of
 * catalogue text where being nearly right is worse than being absent, since the wrong one
 * is a fluent paragraph about a different game and nothing on screen would say so.
 */
async function fetchSummary(
  match: WorkMatch
): Promise<{ text: string; from: SummarySource } | null> {
  if (match.summary && match.source === 'dlsite') {
    return { text: match.summary, from: 'dlsite' }
  }
  // The original name rather than the romaji one: Bangumi indexes Japanese and Chinese,
  // and a romaji title finds nothing there.
  const query = match.altTitle ?? match.title
  if (!query.trim()) return null
  const rows = await bangumiSearch(query, 3)
  const text = pickBangumiSummary(rows, [match.title, match.altTitle, match.zhTitle])
  return text ? { text, from: 'bangumi' } : null
}

/**
 * Fetch covers — and, when that is switched on, descriptions — for the given games.
 *
 * `scope` decides what happens to what is already there. A selection of many games leaves
 * a cover the user chose alone and says how many it left; one game picked from its own
 * menu replaces it, because that is unambiguously what was asked for.
 */
export async function fetchCovers(
  ids: string[],
  scope: 'single' | 'bulk',
  onProgress: (progress: CoverProgress) => void
): Promise<CoverRun> {
  const idle: CoverRun = {
    fetched: 0,
    summaries: 0,
    keptUser: 0,
    missed: 0,
    pending: [],
    offline: false,
    cancelled: false
  }
  if (running) return idle
  running = true
  cancelled = false

  const wantSummaries = db.getSettings().onlineSummary
  const games = ids
    .map((id) => db.findGame(id))
    .filter((game): game is Game => Boolean(game) && !game!.missing)

  let fetched = 0
  let summaries = 0
  let keptUser = 0
  let missed = 0
  let reachedAny = false
  let asked = 0
  const pending: PendingMatch[] = []

  try {
    for (const [index, game] of games.entries()) {
      if (cancelled) break
      onProgress({ done: index, total: games.length, name: game.name })

      const wantCover = mayReplaceCover(coverSourceOf(game), scope)
      if (!wantCover) keptUser++
      // A hand-picked cover says nothing about whether the game has a description, so the
      // blurb is still worth asking for — but a description already fetched is not
      // re-fetched over a whole selection, for the same reason a tag pass does not.
      const wantSummary = wantSummaries && mayReplaceSummary(Boolean(game.summary), scope)
      if (!wantCover && !wantSummary) continue

      let match = await matchForKnownWork(game)
      asked++

      // Not tagged yet: the same ladder the tag pass walks, so a cover can be the first
      // thing anybody asks for without having to run tags first.
      if (!match && !game.work) {
        const result = await lookupGame(game)
        reachedAny ||= result.reached
        if (result.match) {
          match = result.match
          // The work was resolved on the way past; recording it means the next cover or
          // tag request for this game is a single lookup by id.
          db.updateGame(game.id, {
            work: {
              source: result.match.source,
              workId: result.match.workId,
              title: result.match.title
            }
          })
        } else {
          pending.push({
            gameId: game.id,
            gameName: game.name,
            candidates: result.candidates ?? [],
            suggestion: result.suggestion
          })
          continue
        }
      }

      if (!match) {
        if (wantCover) missed++
        continue
      }
      reachedAny = true

      if (wantCover) {
        if (!match.cover) missed++
        else {
          await paceImage()
          const bytes = await fetchImage(match.cover.url)
          const dest = bytes ? writeCover(game, bytes, match.source) : null
          if (!dest) missed++
          else {
            db.updateGame(game.id, {
              coverPath: dest,
              coverFrom: match.source,
              coverAdult: match.cover.adult
            })
            fetched++
          }
        }
      }

      // Separately from the picture: a work with no cover on file may still have a
      // description, and a game whose cover was left alone certainly does.
      if (wantSummary) {
        const blurb = await fetchSummary(match)
        if (blurb) {
          db.updateGame(game.id, { summary: blurb.text, summaryFrom: blurb.from })
          summaries++
        }
      }
    }

    onProgress({ done: games.length, total: games.length, name: '' })
    db.flush()
    return {
      fetched,
      summaries,
      keptUser,
      missed,
      pending,
      offline: asked > 0 && !reachedAny,
      cancelled
    }
  } finally {
    running = false
    cancelled = false
  }
}
