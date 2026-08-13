import fs from 'node:fs'
import path from 'node:path'
import type { Game, SummarySource, WorkMatch } from '../shared/types'
import { acceptCover, coverSourceOf, mayReplaceCover, mayReplaceSummary } from './cover-rules.ts'
import * as db from './db'
import { pickBangumiSummary } from './tag-rules.ts'
import { bangumiSearch, fetchImage, paceImage } from './tag-online'

/**
 * What a catalogue record holds besides its tags: the picture, and the blurb.
 *
 * The match is the hard part and it is solved elsewhere — `tagger.ts` settles which work
 * a game is, and hands the record here. So nothing in this file searches for anything,
 * which is also what keeps it out of an import cycle with the module that does.
 *
 * Never automatic. A tag is a word quietly filed away; a cover is painted across the tile
 * at the size of a playing card, and getting one wrong is the most visible mistake this
 * program can make. So it happens when somebody asks for a game to be looked up — one
 * game, or a selection — and never on a scan, a refresh or a launch.
 */

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

/** What became of one game's cover, so a run can say what it did rather than a bare count. */
export type CoverOutcome = 'written' | 'keptUser' | 'missed'

/**
 * Take the catalogue's picture for a game.
 *
 * `scope` decides what happens to a cover that is already there. A pass over a selection
 * leaves a cover the user chose alone and says so; one game picked out of its own menu
 * replaces it, because that is unambiguous about which cover was meant.
 */
export async function applyCover(
  game: Game,
  match: WorkMatch,
  scope: 'single' | 'bulk'
): Promise<CoverOutcome> {
  if (!mayReplaceCover(coverSourceOf(game), scope)) return 'keptUser'
  if (!match.cover) return 'missed'

  await paceImage()
  const bytes = await fetchImage(match.cover.url)
  const dest = bytes ? writeCover(game, bytes, match.source) : null
  if (!dest) return 'missed'

  db.updateGame(game.id, {
    coverPath: dest,
    coverFrom: match.source,
    coverAdult: match.cover.adult
  })
  return 'written'
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
 *
 * Plenty of works have no Chinese blurb anywhere — Bangumi routinely carries the Japanese
 * store copy on an otherwise Chinese entry — and those come back with nothing, which is
 * the intended answer and not a failure to report.
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
 * Take the catalogue's description for a game, if it has a Chinese one.
 *
 * Independent of the cover: a game whose picture was left alone because the user chose it
 * themselves may still have no description, and a work with no picture on file may still
 * have text. Over a selection, a game that already has one is left out rather than asking
 * a free catalogue a question it has already answered.
 */
export async function applySummary(
  game: Game,
  match: WorkMatch,
  scope: 'single' | 'bulk'
): Promise<boolean> {
  if (!mayReplaceSummary(Boolean(game.summary), scope)) return false
  const blurb = await fetchSummary(match)
  if (!blurb) return false
  db.updateGame(game.id, { summary: blurb.text, summaryFrom: blurb.from })
  return true
}
