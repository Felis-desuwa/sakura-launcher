import path from 'node:path'
import type { CoverChoice, Game, PendingMatch, WorkMatch } from '../shared/types'
import { workRecordOf } from '../shared/types'
import { coverSourceOf } from './cover-rules.ts'
import { applyCover, applySummary, discardCover, dropCoverCandidates } from './covers'
import * as db from './db'
import { writeGameSidecar } from './sidecar-sync'
import { displayNameFor } from './scan-core'
import { queryLadder, searchableTitle, STRONG_MATCH, workNoIn } from './tag-rules.ts'
import type { BangumiWork } from './tag-bangumi.ts'
import { bangumiSearch, lookupDlsite, searchVndb, vndbById } from './tag-online'

/**
 * Working out what a game is.
 *
 * Only ever by asking a catalogue, and only when the user has switched that on. Genres —
 * 校园, NTR, 催泪 — are judgements about a story. They are not in the files, and no
 * amount of reading a directory produces them.
 *
 * One lookup brings back everything, because it is all one record: the tags, the cover
 * and the description hang off the same catalogue entry, so they are settled together.
 * They used to be two menu entries and two passes, which meant asking the same catalogue
 * the same question twice and a library where the tags were fetched and the covers were
 * not — the second half being something you had to know to go and ask for.
 *
 * An earlier version also derived tags from the folder itself. Removing that fixed more
 * than it cost: it walked every game directory hunting for save files, synchronously, on
 * the main process — on a library of multi-gigabyte folders that blocked every IPC call
 * for long enough that the application looked hung. Nothing here touches the disk now
 * beyond reading a folder's *name*.
 */

export interface TagProgress {
  done: number
  total: number
  /** The game being worked on, so the user can see it is not stuck. */
  name: string
}

export interface TagRun {
  /** How many games were looked up. */
  looked: number
  /** How many came back with a confident answer. */
  matched: number
  /** Covers written. */
  covers: number
  /** Descriptions brought back. Fewer than the covers, and that is normal — see `covers.ts`. */
  summaries: number
  /**
   * Games that already had a cover of the user's own when the catalogue offered another.
   *
   * Nothing has been written for these — both pictures exist and the user picks. Collected
   * over the whole run and put up once at the end, for the same reason `pending` is: a
   * pass over eighty games must not stop eighty times to ask a question.
   */
  coverChoices: CoverChoice[]
  /** Title searches too uncertain to adopt, for the user to settle. */
  pending: PendingMatch[]
  /** Every lookup failed, so the UI can say "no network" once instead of per game. */
  offline: boolean
  /** The user stopped it part way. */
  cancelled: boolean
}

/**
 * Set while a pass is running, so it can be stopped.
 *
 * A pass over two hundred games paced for a free catalogue takes minutes, and a user who
 * started it by accident — or who realises the catalogue is not answering — needs a way
 * out that is not killing the program.
 */
let cancelled = false
let running = false

export function cancelTagRun(): void {
  if (running) cancelled = true
}

export function tagRunActive(): boolean {
  return running
}

export interface LookupResult {
  match?: WorkMatch
  candidates?: WorkMatch[]
  /** A Japanese name Bangumi resolved, to seed the manual box when nothing else worked. */
  suggestion?: string
  reached: boolean
}

/**
 * Walk the query ladder until a catalogue answers.
 *
 * VNDB's search is a substring match, so one stray word in the query returns nothing at
 * all while a *shorter* query returns the right game. Trying the cleaned name, then its
 * head, then its leading run is what turns `某某游戏的日常+ ～完美版 ～ 官方中文版 V1.5`
 * into a hit. Stops at the first rung that answers, so a tidy name costs one request.
 */
async function searchLadder(name: string): Promise<{ hits: WorkMatch[]; reached: boolean }> {
  let reached = false
  for (const query of queryLadder(name)) {
    const hits = await searchVndb(query)
    if (hits.length > 0) return { hits, reached: true }
    reached = true
  }
  return { hits: [], reached }
}

/**
 * Ask Bangumi what the game is called in Japanese, down the same ladder.
 *
 * Stops at the first rung that answers. The name that comes back is one somebody entered
 * into a catalogue against this exact work — it is looked up, never derived from the
 * Chinese and never machine translated.
 */
async function resolveJapaneseName(name: string): Promise<BangumiWork[]> {
  for (const query of queryLadder(name)) {
    const hits = await bangumiSearch(query, 3)
    if (hits.length > 0) return hits
  }
  return []
}

/**
 * The title a person gave this game, if one did.
 *
 * Not `game.renamed`, which looks like the right flag and is not: the sidecar is the
 * source of truth for a title, so the first sync after a rename clears the flag while
 * keeping the name. Reading it would mean a game called 多娜多娜 in a folder called
 * `032601` gets looked up as `032601` — the string that has already failed — and then
 * offered `032601` back in the box that asks what it is really called.
 *
 * Comparing against the folder's own display name catches both routes at once: renaming
 * the tile, and typing a name into the file by hand.
 */
function chosenName(game: Game): string | undefined {
  const name = game.name?.trim()
  if (!name) return undefined
  return name === displayNameFor(game.dir) ? undefined : name
}

/**
 * Ask the catalogues what this game is.
 *
 * Three sources, each doing the one thing it is good at. A work number goes to DLsite and
 * is taken as given. A title goes to VNDB. A title VNDB has never heard of goes to
 * Bangumi — not for tags, which are behind a login there, but for the *name*: it is a
 * Chinese-language database and knows `另一个游戏` is `ある少女の生活`, which VNDB then
 * recognises at once. The Japanese name is read out of a catalogue record, never derived
 * from the Chinese one.
 */
export async function lookupGame(game: Game): Promise<LookupResult> {
  // A work already settled is not asked about again — straight to the id. Searching for
  // it a second time can only produce a different answer than the one that was agreed,
  // and it costs a whole ladder of requests to maybe do so.
  if (game.work) {
    const match =
      game.work.source === 'dlsite'
        ? await lookupDlsite(game.work.workId)
        : await vndbById(game.work.workId)
    if (match) return { match, reached: true }
  }

  const folderName = path.basename(game.dir)
  const workNo = workNoIn(folderName)

  if (workNo) {
    const match = await lookupDlsite(workNo)
    // A work number the catalogue does not know is a dead end, not a reason to go
    // guessing at titles — the number was the more specific claim and it failed.
    return match ? { match, reached: true } : { reached: false }
  }

  // Search on the name the user sees. A tile somebody renamed is them telling us what
  // this game is called, which is better information than the folder name they renamed it
  // away from.
  const name = chosenName(game) ?? folderName
  const direct = await searchLadder(name)
  if (direct.hits.length > 0) return settle(direct.hits, direct.reached)

  // Nothing under that name. If it is a Chinese title, the name VNDB indexes it under is
  // a different string entirely, and Bangumi is where the two are written down together.
  //
  // Asked down the same ladder, for the same reason VNDB is: a folder that reads
  // `某某游戏AI-Extra-Pack对外整合` has the title glued to somebody's note, and
  // only the shortened rung — `某某游戏` — finds anything.
  const resolved = await resolveJapaneseName(name)
  for (const work of resolved) {
    const viaJapanese = await searchVndb(work.name)
    if (viaJapanese.length > 0) return settle(viaJapanese, true)
  }

  // Bangumi knew the game and VNDB does not have it — common for doujin work that is not
  // a visual novel. No tags to be had, but the real Japanese name is worth handing over
  // so the manual box starts from something true rather than from a folder name.
  return { suggestion: resolved[0]?.name, reached: true }
}

/**
 * Adopt or ask.
 *
 * Silently only when one entry is an effectively exact match *and* nothing else comes
 * close. Two near-identical scores is precisely the fan-disc case, and guessing between
 * them is how a library ends up quietly mistagged.
 */
function settle(hits: WorkMatch[], reached: boolean): LookupResult {
  const [best, runnerUp] = hits
  if (best.score >= STRONG_MATCH && (!runnerUp || runnerUp.score < STRONG_MATCH)) {
    return { match: best, reached }
  }
  return { candidates: hits, reached }
}

/**
 * What the manual box runs.
 *
 * An id is not a guess, so `v1234` / `RJ01234567` / a link to either goes straight to the
 * work. Anything else is a title and takes the same route an automatic lookup does,
 * Bangumi resolution included — the user typing a Chinese name deserves the same help the
 * folder name got.
 */
export async function searchWorks(query: string): Promise<WorkMatch[]> {
  const text = query.trim()
  if (!text) return []

  const workNo = workNoIn(text)
  if (workNo) {
    const match = await lookupDlsite(workNo)
    if (match) return [match]
  }

  const vndbId = /(?:^|\/)(v\d+)\b/i.exec(text)
  if (vndbId) {
    const match = await vndbById(vndbId[1].toLowerCase())
    if (match) return [match]
  }

  const bangumiId = /bgm\.tv\/subject\/(\d+)|bangumi\.tv\/subject\/(\d+)/i.exec(text)
  if (bangumiId) {
    // Bangumi cannot give tags, so an id there is resolved to a name and handed to VNDB.
    const id = bangumiId[1] ?? bangumiId[2]
    const resolved = await bangumiSearch(id, 1)
    if (resolved[0]) {
      const hits = await searchVndb(resolved[0].name)
      if (hits.length > 0) return hits
    }
  }

  const direct = await searchLadder(text)
  if (direct.hits.length > 0) return direct.hits

  for (const work of await resolveJapaneseName(text)) {
    const hits = await searchVndb(work.name)
    if (hits.length > 0) return hits
  }
  return []
}

/**
 * Which games a pass should actually look up.
 *
 * The ones never asked about — not the ones without an answer. A game the catalogue
 * simply does not have would otherwise sit in this list forever, being re-queried on
 * every run to be told the same thing, which is both a wait for the user and an
 * imposition on a free service.
 *
 * Getting back to those is still possible and still cheap: "look everything up again"
 * covers the library, and the tile's own menu covers one game — which is the case that
 * matters, since the usual reason a game was not found is a folder name nothing could
 * match, and the fix for that is renaming the tile and asking again.
 */
export function pendingTargets(games: Game[]): Game[] {
  // Archive entries are included: an uninstalled game is still a game, and the volume it
  // sits in is named after it just as well as an extracted folder would be.
  return games.filter((g) => !g.taggedAt)
}

/**
 * Look games up and take everything the record has.
 *
 * `ids` names the games; `null` means the ones never asked about, which is what the
 * library-wide button runs. `scope` says how to treat a description already on file — one
 * game asked about deliberately is asked again, a selection is not. Covers no longer take
 * it: a cover the user chose is never written over on either route, it is offered against
 * the catalogue's and left for them to settle (`TagRun.coverChoices`).
 */
export async function computeTags(
  ids: string[] | null,
  scope: 'single' | 'bulk',
  onProgress: (progress: TagProgress) => void
): Promise<TagRun> {
  const settings = db.getSettings()
  const games = db.getGames()
  const targets = ids
    ? games.filter((g) => ids.includes(g.id) && !g.missing)
    : pendingTargets(games)

  const empty: TagRun = {
    looked: 0,
    matched: 0,
    covers: 0,
    summaries: 0,
    coverChoices: [],
    pending: [],
    offline: false,
    cancelled: false
  }
  if (!settings.onlineTags || targets.length === 0) return empty

  running = true
  cancelled = false
  const pending: PendingMatch[] = []
  const coverChoices: CoverChoice[] = []
  let matched = 0
  let looked = 0
  let covers = 0
  let summaries = 0
  let reachedAny = false

  try {
    for (const [index, game] of targets.entries()) {
      if (cancelled) break
      onProgress({ done: index, total: targets.length, name: game.name })

      const result = await lookupGame(game)
      looked++
      reachedAny ||= result.reached

      if (result.match) {
        matched++
        db.updateGame(game.id, {
          autoTags: result.match.tags,
          work: workRecordOf(result.match),
          taggedAt: Date.now()
        })

        // The rest of the same record. Read from the database again rather than from
        // `game`, because the write above is what tells `applyCover` which file to
        // replace.
        const fresh = db.findGame(game.id) ?? game
        if (settings.onlineCovers) {
          const { outcome, choice } = await applyCover(fresh, result.match)
          if (outcome === 'written') covers++
          else if (choice) coverChoices.push(choice)
        }
        if (settings.onlineSummary && settings.onlineCovers) {
          if (await applySummary(fresh, result.match, scope)) summaries++
        }

        // Straight out to the file beside the game. The alternative is that everything
        // just fetched lives only in the database until somebody happens to run a scan —
        // and a lookup that has to be paid for twice is exactly what writing it down is
        // meant to prevent.
        const written = db.findGame(game.id)
        if (written) writeGameSidecar(written)
      } else {
        // Records that it was asked, so a second pass does not ask again about a game the
        // catalogue simply does not have.
        db.updateGame(game.id, { taggedAt: Date.now() })
        // Everything unresolved goes to the user, candidates or not. A game nothing
        // matched is precisely the one that needs the manual box, and leaving it out of
        // the dialog was leaving it with no way in at all.
        pending.push({
          gameId: game.id,
          gameName: game.name,
          candidates: result.candidates ?? [],
          // The name a person gave it comes first. That is somebody having already
          // answered the question this box is about to ask, and offering them `032601`
          // back — the string that just failed — instead of the title they typed is the
          // box ignoring the one good piece of information it has.
          suggestion:
            chosenName(game) ?? result.suggestion ?? searchableTitle(path.basename(game.dir))
        })
      }
    }

    onProgress({ done: targets.length, total: targets.length, name: '' })
    db.flush()
    return {
      looked,
      matched,
      covers,
      summaries,
      coverChoices,
      pending,
      offline: looked > 0 && !reachedAny,
      cancelled
    }
  } finally {
    running = false
    cancelled = false
  }
}

/**
 * Adopt the catalogue entry the user picked.
 *
 * Replaces wholesale rather than merging: the user has just said this game is a different
 * work than we thought, and tags from the work it is not have no claim to stay.
 */
export async function applyMatch(
  gameId: string,
  match: WorkMatch
): Promise<{ game?: Game; coverChoice?: CoverChoice }> {
  if (!db.findGame(gameId)) return {}
  const settings = db.getSettings()
  db.updateGame(gameId, {
    autoTags: match.tags,
    work: workRecordOf(match),
    taggedAt: Date.now()
  })

  // The rest of the same record, exactly as an automatic match would take it. This is the
  // route for a folder called `032601`, which no search can resolve — somebody types the
  // name once, and typing it once has to be enough. Leaving the cover and the description
  // out meant the games that needed the most help ended up with the least, and with no
  // way to ask for the remainder: they were matched, so no later pass would look at them
  // again. `'single'` because this is one game, named deliberately.
  const scope = 'single' as const
  const game = db.findGame(gameId)
  // A cover the user chose is put to them rather than replaced, exactly as in a run —
  // naming the work is not the same act as agreeing to a different picture, and this is
  // the route a game reaches when nothing could be matched automatically, so it is the
  // one most likely to already carry a cover somebody set by hand.
  let coverChoice: CoverChoice | undefined
  if (game && settings.onlineCovers) {
    coverChoice = (await applyCover(game, match)).choice
  }
  if (game && settings.onlineCovers && settings.onlineSummary) {
    await applySummary(game, match, scope)
  }

  // Settled by hand, which is the answer least worth losing: written straight out to the
  // file beside the game rather than waiting for a scan.
  const updated = db.findGame(gameId)
  if (updated) writeGameSidecar(updated)
  db.flush()
  return { game: updated, coverChoice }
}

/**
 * Put a game back to knowing nothing about what work it is.
 *
 * The case this exists for: the catalogue answered, the answer was wrong, and there is no
 * right answer to be had — a doujin release nothing indexes, a folder whose name matched
 * some other studio's game. Until now the only way out was to strike the tags out one at a
 * time, clear the cover separately, and leave the description standing, because nothing
 * could remove a description at all.
 *
 * **Only what a catalogue supplied comes off.** The tags the user typed, the name, the
 * rating, the status flags, the playtime and a cover they chose themselves all stay: none
 * of them came from the record that was wrong. That is also why the cover is checked
 * against `coverSourceOf` rather than simply deleted — a hand-picked picture has nothing
 * to do with the lookup being a mistake.
 *
 * **`taggedAt` deliberately stays set.** It records that this game has been asked about,
 * and a library-wide pass looks up exactly the games that have not been. Clearing it would
 * mean the next such pass fetches the same wrong record straight back — the user would
 * have to undo this every time. The game can still be looked up on purpose from its own
 * menu, which is the route somebody takes when they think the answer will be different.
 *
 * Written out to the sidecar at once: the file beside the game is where a lookup was
 * recorded, so leaving it there would have the next sync read the record back in.
 */
export function clearWorkData(gameIds: string[]): Game[] {
  const out: Game[] = []
  for (const id of gameIds) {
    const game = db.findGame(id)
    if (!game) continue

    // An offer waiting to be answered was made by the record being thrown out.
    dropCoverCandidates([id])

    const theirs = Boolean(game.coverPath) && coverSourceOf(game) !== 'user'
    if (theirs) discardCover(game)

    const updated = db.updateGame(id, {
      autoTags: [],
      // Strikeouts only ever applied to the tags above. Left behind they would silently
      // hide a tag that came back from some later, correct lookup, on the strength of a
      // decision the user made about a different work entirely.
      hiddenTags: [],
      work: undefined,
      summary: undefined,
      summaryFrom: undefined,
      summaryTranslated: undefined,
      ...(theirs ? { coverPath: null, coverFrom: undefined, coverAdult: undefined } : {})
    })
    if (!updated) continue
    writeGameSidecar(updated)
    out.push(updated)
  }
  db.flush()
  return out
}

/**
 * Strike a tag out, or put it back.
 *
 * Recorded per game rather than as a library-wide rule. The user is saying "not this
 * game", and turning one wrong tag into a global ban would be a much larger claim than
 * the one they made. The tag stays in the record and is filtered when read, so this
 * stays reversible without asking the catalogue all over again.
 */
export function setTagHidden(gameId: string, tagId: string, hidden: boolean): Game | undefined {
  const game = db.findGame(gameId)
  if (!game) return undefined
  const current = new Set(game.hiddenTags ?? [])
  if (hidden) current.add(tagId)
  else current.delete(tagId)
  return db.updateGame(gameId, { hiddenTags: [...current] })
}
