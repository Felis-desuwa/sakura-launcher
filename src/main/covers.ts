import fs from 'node:fs'
import path from 'node:path'
import type { Game, SummarySource, WorkMatch } from '../shared/types'
import { acceptCover, coverSourceOf, mayReplaceCover, mayReplaceSummary } from './cover-rules.ts'
import * as db from './db'
import { COVER_BASE, COVER_EXTS, isUnder } from './scan-core'
import { pickBangumiSummary } from './tag-rules.ts'
import { bangumiSearch, fetchImage, paceImage } from './tag-online'
import { translateToChinese } from './translate'

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
 * Where a cover for this game should be written.
 *
 * **Beside the game**, as `sakura-cover.<ext>`, so it travels with the folder the way the
 * sidecar does: rename the folder, move it to another disk, hand it to somebody else, and
 * the picture is still there and still findable — the sidecar names the file, and a scan
 * can find it by name even if the sidecar is gone. A cover kept under `%APPDATA%` and
 * pointed at by an absolute path is lost by every one of those moves.
 *
 * The app's own folder stays as the fallback, for the cases where there is nowhere to
 * write: an archive that has no folder of its own, a read-only disc, a share with no
 * permission. A cover in the wrong place beats no cover.
 */
function coverDestination(game: Game, kind: string): { dest: string; portable: boolean } {
  if (game.kind === 'installed' && !game.missing) {
    try {
      fs.accessSync(game.dir, fs.constants.W_OK)
      return { dest: path.join(game.dir, `${COVER_BASE}.${kind}`), portable: true }
    } catch {
      /* not writable — fall through to the app's own folder */
    }
  }
  return { dest: path.join(db.coverDir(), `${game.id}.${kind}`), portable: false }
}

/**
 * Write one cover to disk.
 *
 * The bytes are sniffed before they land: this file is handed to the renderer through the
 * asset protocol, and what a server sends is not always what its headers promised. An
 * HTML error page returned with status 200 is the ordinary case, and it must not become
 * `sakura-cover.jpg`.
 */
function writeCover(game: Game, bytes: Buffer): string | null {
  const kind = acceptCover(bytes)
  if (!kind) return null

  const { dest, portable } = coverDestination(game, kind)
  try {
    if (!portable) fs.mkdirSync(db.coverDir(), { recursive: true })
    fs.writeFileSync(dest, bytes)
  } catch {
    return null
  }

  // Anything left behind: the same cover under another extension, and — after the move
  // out of the app's data directory — the copy that used to live there.
  clearStale(game, dest)
  return dest
}

/**
 * Take a cover the user picked and put it where the game is.
 *
 * The same place a fetched one goes, for the same reason: a picture chosen by hand is the
 * one nobody wants to choose twice, and left as a path into somebody's Pictures folder it
 * survives neither moving the library nor tidying that folder up. Copied rather than
 * referenced, and recorded in the sidecar as the user's, which is what stops a later pass
 * over the library replacing it.
 */
export function adoptCover(game: Game, source: string): string | null {
  const ext = path.extname(source).replace(/^\./, '').toLowerCase() || 'jpg'
  const { dest, portable } = coverDestination(game, ext)
  try {
    if (!portable) fs.mkdirSync(db.coverDir(), { recursive: true })
    fs.copyFileSync(source, dest)
  } catch {
    return null
  }
  clearStale(game, dest)
  return dest
}

/**
 * Remove the cover file this program put there.
 *
 * Only ever ours — the one named `sakura-cover.*` beside the game, or the copy under the
 * app's own folder. Without this, "clear the cover" would remove it from the database and
 * the next scan would find the file still sitting in the folder and put it straight back.
 */
export function discardCover(game: Game): void {
  clearStale(game, '')
}

/** Delete our own leftovers around `keep`, and never a file we did not write. */
function clearStale(game: Game, keep: string): void {
  const candidates = [game.coverPath, ...coverNamesIn(game.dir), ...coverNamesIn(db.coverDir(), game.id)]
  for (const stale of candidates) {
    if (!stale) continue
    if (keep && path.resolve(stale) === path.resolve(keep)) continue
    const ours =
      isUnder(stale, db.coverDir()) ||
      path.basename(stale).toLowerCase().startsWith(`${COVER_BASE}.`)
    if (!ours) continue
    try {
      fs.rmSync(stale, { force: true })
    } catch {
      /* a cover we could not remove is untidy, not broken */
    }
  }
}

/** Every name a cover of ours could go by in one folder. */
function coverNamesIn(dir: string, base = COVER_BASE): string[] {
  return COVER_EXTS.map((ext) => path.join(dir, `${base}.${ext}`))
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
  const dest = bytes ? writeCover(game, bytes) : null
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
 * store copy on an otherwise Chinese entry. Those are translated, and marked as
 * translated, which is the only honest way to show a sentence nobody wrote.
 */
async function fetchSummary(
  match: WorkMatch,
  alsoKnownAs?: string
): Promise<{ text: string; from: SummarySource; translated?: boolean } | null> {
  const blurb = await findBlurb(match, alsoKnownAs)
  if (!blurb) return null
  if (blurb.chinese) return { text: blurb.text, from: blurb.from }

  // Not Chinese, which on Bangumi is the common case rather than the exception: a great
  // many entries carry the Japanese store copy. Refusing those left most of a library
  // with no description at all, including works whose entry had matched perfectly — so
  // the text is translated and *said to be translated*, on screen and in the file.
  if (!db.getSettings().translateSummary) return null
  const zh = await translateToChinese(blurb.text)
  return zh ? { text: zh, from: blurb.from, translated: true } : null
}

/** The description on the record, whatever language it turned out to be in. */
async function findBlurb(
  match: WorkMatch,
  alsoKnownAs?: string
): Promise<{ text: string; chinese: boolean; from: SummarySource } | null> {
  if (match.blurb && match.source === 'dlsite') {
    return { ...match.blurb, from: 'dlsite' }
  }
  // The original name rather than the romaji one: Bangumi indexes Japanese and Chinese,
  // and a romaji title finds nothing there.
  const query = match.altTitle ?? match.title
  if (!query.trim()) return null
  const rows = await bangumiSearch(query, 3)
  // The name the user gave this game counts too. Somebody typing 多娜多娜 into the match
  // box is naming the work, and that name is often the one Bangumi files it under while
  // VNDB's romaji title matches nothing there. It still has to clear the same threshold
  // against a row, so it widens what can be recognised without widening what is accepted.
  const found = pickBangumiSummary(rows, [match.title, match.altTitle, match.zhTitle, alsoKnownAs])
  return found ? { ...found, from: 'bangumi' } : null
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
  const blurb = await fetchSummary(match, game.name)
  if (!blurb) return false
  db.updateGame(game.id, {
    summary: blurb.text,
    summaryFrom: blurb.from,
    summaryTranslated: blurb.translated
  })
  return true
}
