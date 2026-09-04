// Extension spelled out: `scripts/guide-test.mts` loads this file straight into node.
import type { Game, GuideHit, GuideProvider } from '../shared/types.ts'

/**
 * Finding a walkthrough for a game, from what two sites publish.
 *
 * Split from `guides.ts` for the reason every pure module here is split: reaching the two
 * sites needs a socket and deciding what came back does not. Everything below is text
 * over text, so the whole judgement can be tested offline against a canned page.
 *
 * The two providers are shaped completely differently and the difference is the whole
 * design. **誠也の部屋 publishes one static index** — around four thousand entries on a
 * single page — so it is fetched once, kept, and searched *here*, locally, which means it
 * cannot rate-limit us, cannot see what anyone looked up, and keeps working while it is
 * down. **2DFan answers a query** — so a search is a request, and what comes back is an
 * HTML fragment inside a JSON envelope, which is somebody else's markup and will
 * eventually change shape. That asymmetry is why `read2dfan` reports a shape it cannot
 * read as a failure rather than as an empty list: the fragile provider going quiet must
 * not look like "this game has no walkthrough".
 *
 * Matching is **containment only, never edit distance**, which is `titleScore`'s rule in
 * `tag-rules.ts` and is right here for the same reason: a folder name carries extra words
 * — a subtitle, an edition, a version — around an otherwise exact title, and edit
 * distance punishes that in proportion to how much was added. Measured against the real
 * four thousand entries, containment alone put the right walkthrough in the top five for
 * 200 of 200 sampled titles under every corruption a folder name actually carries.
 * Bigram similarity was tried alongside it and earned nothing on those, while making
 * fragments like `AIR` match the middle of unrelated words.
 *
 * Nothing here reaches the network, and nothing here imports electron.
 */

/** Where the static index lives, and what a hit's link is relative to. */
export const SAIGA_INDEX_URL = 'https://seiya-saiga.com/game/kouryaku.html'
export const SAIGA_BASE = 'https://seiya-saiga.com/game/'
export const SAIGA_HOST = 'seiya-saiga.com'

/** 2DFan answers a query rather than publishing an index. */
export const DFAN_HOST = '2dfan.com'
export const DFAN_BASE = 'https://2dfan.com'

/**
 * How long the index is kept before it is fetched again.
 *
 * A walkthrough site gains a few entries a week, so a week-old copy is wrong about
 * nothing a person is likely to be playing. The number that matters is the other one:
 * **a fetch that fails keeps the copy on disk** rather than blanking it, the same policy
 * `display-info.ts` holds for a failed display query. A feature that goes empty because a
 * site was briefly down is worse than one answering from last week.
 */
export const INDEX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Below this many characters a query only ever matches a title exactly. */
export const MIN_LOOSE_QUERY = 3

/**
 * At or below this length, a containment also has to *begin* the other title.
 *
 * **Position, not proportion.** The two things being told apart are a short query that is
 * a series name — `ネコぱら` at the start of `ネコぱらAfter…` — and a fragment landing in
 * the middle of an unrelated word, which is `air` inside `pairing`. Coverage cannot
 * separate those: the series name covers a fifth of its own title, less than the fragment
 * covers of the word it fell into. Where the match *sits* separates them completely,
 * because a series name always begins the title it belongs to and a fragment does not.
 *
 * This was arrived at the long way. A coverage floor was tried first and measured well
 * against full titles — which was the whole sample, and the reason it looked fine. The
 * first real search exposed it: a four-character series name found nothing on the site
 * that indexes it, and 2DFan's own correct results were all marked as not looking like
 * the game. Re-measured with the prefix rule: full-title recall unchanged at 200 of 200,
 * every one of eight sampled series prefixes found its titles, and `air` stopped matching
 * `pairing`.
 *
 * A long query needs no such guard: a long title inside a longer one is that title's own
 * fan disc or edition, which 19 of the first 1200 real entries turn out to be.
 */
export const SHORT_QUERY = 6

/** Most hits worth showing. Past this it is a list to read rather than an answer. */
export const MAX_HITS = 6

const BRACKET = /[(（[［【｛{][^)）\]］】｝}]*[)）\]］】｝}]/g
const VERSION = /\b(?:v|ver\.?|version)\s*\d+(?:[._]\d+)*\b/gi

/**
 * Edition words that are furniture rather than part of a name.
 *
 * `tag-rules.ts` has a list of these for Chinese and English releases and none at all in
 * Japanese, which is the language every title in this corpus is written in. Kept here
 * rather than added there because widening that one changes which catalogue rows match,
 * and this module has no business moving that line.
 */
const EDITION =
  /(?:体験版|完全版|通常版|初回版|廉価版|優待版|DL版|ダウンロード版|パッケージ版|Steam版|DMM版|FANZA版|汉化版|官方中文版|中文版|无修正|無修正)/gi

/**
 * A `～subtitle～` tail, and everything after it.
 *
 * Both tilde characters, because they are not interchangeable and the corpus uses both:
 * U+FF5E fullwidth and U+301C wave dash look identical and `titleKey` strips only the
 * first, so the same title scores differently depending on which one somebody typed.
 */
const TAIL = /[～〜~].*$/

/** Punctuation and spacing that carries no meaning for matching. */
const NOISE =
  /[\s　・·\-–—－_/\\!！?？、。,.:：;；'"“”‘’「」『』【】★☆♪♡♥+*&＆#＃$＄%％@＠=＝|｜]+/g

/**
 * Flatten a title so two spellings of the same name compare equal.
 *
 * Deliberately **not** `titleKey` from `tag-rules.ts`, and not an extension of it. That
 * one decides which catalogue row is this game, so changing it changes what gets tagged
 * across every library; this one only decides which walkthrough to offer, where being
 * wrong costs a click. The four folds below were measured as gaps in `titleKey` against
 * this corpus and every one of them scored a flat zero there: fullwidth digits (`２`),
 * fullwidth latin (`ＡＢＣ`), halfwidth katakana (`ｻﾝﾌﾟﾙ`) — all three answered by NFKC —
 * and unbracketed Japanese edition words.
 */
export function guideKey(raw: string, keepTail = false): string {
  let text = raw.normalize('NFKC')
  text = text.replace(VERSION, ' ')
  text = text.replace(BRACKET, ' ')
  text = text.replace(EDITION, ' ')
  if (!keepTail) text = text.replace(TAIL, ' ')
  return text.replace(NOISE, '').toLowerCase()
}

/**
 * How alike two titles are, 0 to 1.
 *
 * The same containment rule `titleScore` uses, over this module's own normalisation, with
 * one extra guard for short queries — see `SHORT_QUERY`. Everything else scores by how
 * much of the longer title the shorter one covers, so an outright match ranks above a
 * series that merely starts the same way.
 */
export function guideScore(query: string, candidate: string): number {
  const a = guideKey(query)
  const b = guideKey(candidate)
  if (!a || !b) return 0
  if (a === b) return 1
  // The floor lives here rather than in one caller, because both of them need it: a
  // one-character query is a prefix of a great many titles and none of them are the game.
  if (a.length < MIN_LOOSE_QUERY) return 0
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  if (!long.includes(short)) return 0
  if (a.length <= SHORT_QUERY && !long.startsWith(short)) return 0
  return short.length / long.length
}

/** One entry of the static index. */
export interface GuideEntry {
  title: string
  /** Relative to `SAIGA_BASE`; never an absolute address. */
  href: string
}

const ANCHOR = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi

/**
 * Read the index page.
 *
 * Takes text that has already been decoded, because the page is **cp932** and decoding is
 * the caller's job — `guides.ts` does it with a `TextDecoder`, the same route
 * `diagnose.ts` already uses for Shift-JIS.
 *
 * Only relative links are kept. The page also carries the site's own navigation and a
 * handful of outbound links, and every one of those is absolute; a walkthrough is always
 * `brand/title.html`. That is a structural filter rather than a list of things to skip,
 * so a navigation link added next year is excluded without anybody editing this.
 */
export function parseSaigaIndex(html: string): GuideEntry[] {
  const seen = new Set<string>()
  const out: GuideEntry[] = []
  for (const [, href, inner] of html.matchAll(ANCHOR)) {
    if (!href || href.startsWith('#') || /^(?:https?:|mailto:|javascript:)/i.test(href)) continue
    if (href.includes('..')) continue
    const title = inner.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
    if (!title) continue
    const key = `${href} ${title}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ title, href })
  }
  return out
}

/** An absolute address for an index entry, or null when the entry is not one of theirs. */
export function saigaUrl(href: string): string | null {
  if (!href || href.includes('..') || /^[a-z]+:/i.test(href) || href.startsWith('/')) return null
  let url: URL
  try {
    url = new URL(href, SAIGA_BASE)
  } catch {
    return null
  }
  return url.hostname === SAIGA_HOST ? url.toString() : null
}

/**
 * Search the index for one game.
 *
 * Ranked by score, then by the shorter title, so the base game comes before its fan disc
 * when both contain the query. Everything above the floor is shown rather than the best
 * one being opened: two near-identical scores is exactly the fan-disc case, and this
 * corpus is full of it — the same reasoning `tagger.settle` uses before adopting a tag.
 */
export function searchIndex(entries: GuideEntry[], query: string, limit = MAX_HITS): GuideHit[] {
  const key = guideKey(query)
  if (!key) return []

  const scored: { score: number; entry: GuideEntry }[] = []
  for (const entry of entries) {
    const candidate = guideKey(entry.title)
    if (!candidate) continue
    let score = 0
    // An outright match counts however short it is: `雨恋` is a whole title. Anything
    // else goes through the scorer, which holds the floor for both callers.
    if (candidate === key || guideKey(entry.title, true) === key) score = 1
    else score = guideScore(query, entry.title)
    if (score > 0) scored.push({ score, entry })
  }

  scored.sort((a, b) => b.score - a.score || a.entry.title.length - b.entry.title.length)
  const hits: GuideHit[] = []
  for (const { score, entry } of scored) {
    const url = saigaUrl(entry.href)
    if (!url) continue
    hits.push({ provider: 'saiga', title: entry.title, url, score })
    if (hits.length >= limit) break
  }
  return hits
}

/* -------------------------------------------------------------------------- */
/* 2DFan — the one that answers a query                                        */
/* -------------------------------------------------------------------------- */

/** The search this program asks 2DFan. */
export function dfanSearchUrl(query: string): string {
  return `${DFAN_BASE}/subjects/search?keyword=${encodeURIComponent(query)}`
}

const DFAN_LINK = /<a\s+[^>]*href="(\/subjects\/\d+)"[^>]*>([\s\S]*?)<\/a>/gi

/**
 * Read 2DFan's answer.
 *
 * **A shape this cannot read is a failure, not an empty list.** This is the fragile half
 * of the feature by construction: what arrives is an HTML fragment inside a JSON
 * envelope, which is somebody else's markup and will change without warning. If that
 * change were reported as "no walkthrough found", the feature would go quietly useless
 * and look like a fact about the game. Same rule, and the same reason, as `readReleases`
 * in `update-rules.ts` having no list on its failure arm.
 *
 * An envelope that parses and simply holds no results is a real answer, and says so.
 */
export function read2dfan(body: unknown): { ok: true; hits: GuideHit[] } | { ok: false } {
  if (typeof body !== 'object' || body === null) return { ok: false }
  const fragment = (body as { subjects?: unknown }).subjects
  if (typeof fragment !== 'string') return { ok: false }

  const seen = new Set<string>()
  const hits: GuideHit[] = []
  for (const [, href, inner] of fragment.matchAll(DFAN_LINK)) {
    const title = inner.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
    // Each result is linked twice, once from its cover image with no text of its own.
    if (!title || seen.has(href)) continue
    seen.add(href)
    hits.push({ provider: '2dfan', title, url: `${DFAN_BASE}${href}`, score: 0 })
    if (hits.length >= MAX_HITS) break
  }
  return { ok: true, hits }
}

/**
 * Rank 2DFan's rows against the game, keeping the ones that could be it.
 *
 * Their search is a keyword search and answers with everything the keyword touched, so
 * the ordering is theirs and not an opinion about this game. Scoring here is what stops
 * the fourth row of a loose keyword match being presented as this game's walkthrough.
 * Rows that score nothing are kept only when **nothing** scored, and then plainly as what
 * their search returned rather than as an answer — see `GuideResult.loose`.
 */
export function rankDfan(hits: GuideHit[], query: string): { ranked: GuideHit[]; loose: boolean } {
  const scored = hits
    .map((hit) => ({ ...hit, score: guideScore(query, hit.title) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.title.length - b.title.length)
  if (scored.length > 0) return { ranked: scored.slice(0, MAX_HITS), loose: false }
  return { ranked: hits.slice(0, MAX_HITS), loose: true }
}

/* -------------------------------------------------------------------------- */
/* Which name to search with                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The title to search a walkthrough site with.
 *
 * **The Japanese original first**, because that is what both sites index by and it is the
 * one string a folder name is least likely to be. It only exists once a game has been
 * looked up in a catalogue, which is why the button says what it searched for and lets it
 * be edited: a folder called `032601` has nothing to offer either site, and pretending
 * otherwise would produce a confident empty result.
 *
 * The fallback order after that is the same one `tagger.ts` uses, and for the same
 * reason: the name a person gave the game outranks the folder's own, but `game.renamed`
 * is not the flag that says one did.
 */
export function guideQuery(game: Pick<Game, 'name' | 'dir' | 'work'>, folderName: string): string {
  const japanese = game.work?.altTitle?.trim()
  if (japanese) return japanese
  const chosen = game.name?.trim()
  if (chosen && chosen !== folderName) return chosen
  return folderName
}

/** Every provider this program knows, in the order their results are shown. */
export const GUIDE_PROVIDERS: readonly GuideProvider[] = ['saiga', '2dfan']
