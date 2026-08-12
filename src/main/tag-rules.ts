// Extensions spelled out: the harness in scripts/ imports this file straight into node,
// where nothing fills them in — the same reason scan-core.ts does it.
import type { AutoTag, WorkMatch } from '../shared/types.ts'
import { looksAdult } from '../shared/vndb-tags.ts'
import { coverFromDlsite, coverFromVndb } from './cover-rules.ts'

/**
 * Deciding which of a catalogue's tags are worth keeping.
 *
 * Tags here describe *what a game is about* and nothing else. An earlier version of this
 * also derived tags from the files — engine, size, whether the filenames were Japanese —
 * and that was a mistake twice over. It answered a question nobody was asking (the size
 * is on the tile already, the engine is in the drawer), and working it out meant walking
 * every game folder looking for saves, which on a library of multi-gigabyte folders
 * blocked the main process long enough to look like a hang.
 *
 * So: no filesystem, no guessing from folder names. The one thing read off a folder name
 * is the catalogue's own work number, because that is an identifier rather than an
 * inference — it names one product and cannot be a near miss.
 *
 * No electron import and no network: this is pure so that `scripts/tag-test.mts` can load
 * it directly under node's type stripping, the same arrangement `share-rules.ts` has.
 */

/* -------------------------------------------------------------------------- */
/* reading the folder name                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Bracketed segments, in the order they appear.
 *
 * Doujin releases are named `[190101][サークル名] 测试＊游戏 Ver1.02`, and every bracket
 * style in use here shows up: ASCII, full-width, and the Japanese lenticular pair.
 */
const BRACKET_RE = /[[【（(〔]([^\][】）)〕]{1,40})[\]】）)〕]/g

/** A DLsite work number. The one thing in a folder name that identifies rather than hints. */
const WORK_NO_RE = /\b((?:RJ|VJ|BJ)\d{5,8})\b/i

export function workNoIn(name: string): string | null {
  const match = WORK_NO_RE.exec(name)
  return match ? match[1].toUpperCase() : null
}

/**
 * Words a release added to the author's title.
 *
 * These have to come off whether or not they sit in brackets, which is the difference
 * between this list and bracket stripping. A real folder reads
 * `某某游戏的日常+ ～完美版 ～ 官方中文版 V1.5`: the brackets are already gone and the
 * catalogue still returns nothing, because `官方中文版` is in the query. Cleaned down to
 * `某某游戏的日常` it matches exactly.
 *
 * Kept to phrases that are unambiguously about a *release* rather than a work. The rule
 * is the one `share-rules.ts` keeps: erring towards leaving a word in costs a round of
 * confirmation, while erring towards taking one out can delete the title itself.
 */
const RELEASE_WORDS = [
  '官方中文版',
  '官方中文',
  '官中',
  '双汉化版',
  '个人汉化',
  '汉化版',
  '漢化版',
  '汉化',
  '漢化',
  '中文版',
  '简体中文',
  '繁體中文',
  '完整版',
  '完全版',
  '完美版',
  '典藏版',
  '豪华版',
  '重制版',
  '无修正',
  '無修正',
  '无修',
  '硬盘版',
  '免安装',
  '绿色版',
  '生肉',
  '熟肉',
  '机翻',
  '破解版',
  '内购版',
  'uncensored',
  'uncen',
  'repack',
  'cracked',
  'nodvd'
]

/** Language suffixes releases bolt on: `SampleGame_ver_1_0_d_Zh-Hant`. */
const LANG_SUFFIX_RE = /[_\-\s](zh|jp|ja|en|cn|tw)([_\-]?(hans|hant|cn|tw|us))?$/i

/** Archive tails, including the split-volume forms: `.7z`, `.part1.rar`, `.7z.001`. */
const ARCHIVE_TAIL_RE = /(\.part\d+)?\.(7z|zip|rar|tar|gz)(\.\d{3})?$/i

/**
 * Version markers, including the ones glued straight onto the title.
 *
 * `样例游戏2v1.1.0` and `另一个游戏7.6.9` are both real. The `v`-prefixed form can be
 * matched tightly, but a bare dotted number can only be taken from the *end* — a leading
 * or middle number is far more likely to be part of the name (`A.B.C.5`, `9-Sample`), and
 * `样例游戏2` has to keep its 2.
 */
const VERSION_NUMBER = String.raw`\d+([._\-]\d+)*[._\-]?[a-z]?\b`

/** `Ver1.02`, ` v1.1`, `_Ver_0_2_0` — the marker stands apart from the title. */
const VERSION_RE = new RegExp(String.raw`[_\-\s]+v(er)?\.?[_\-\s]*${VERSION_NUMBER}`, 'gi')

/**
 * `样例游戏2v1.1.0` — no separator at all, the marker glued to the title's own number.
 *
 * Matched only when a digit comes first, so the `v` of an ordinary word can never start
 * a match: `Ever17` keeps its v because that one follows a letter.
 */
const GLUED_VERSION_RE = new RegExp(String.raw`(?<=\d)v${VERSION_NUMBER}`, 'gi')

/**
 * A dotted number at the very end, like `另一个游戏7.6.9`.
 *
 * Anchored to the end and requiring at least two groups, so `A.B.C.5` keeps its 5 — one
 * trailing digit is part of a title far more often than it is a version.
 */
const TRAILING_DOTTED_VERSION_RE = /\d+(\.\d+){1,}[a-z]?$/i

function stripReleaseWords(text: string): string {
  let out = text
  for (const word of RELEASE_WORDS) {
    out = out.split(word).join(' ')
  }
  return out
}

/** Tidy up whatever the stripping left behind. */
function squeeze(text: string): string {
  return text
    .replace(/[_]+/g, ' ')
    .replace(/[～~]+\s*$/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-+~～·・.,]+|[\s\-+~～·・.,]+$/g, '')
    .trim()
}

/**
 * The queries to try, in order, for one folder name.
 *
 * A ladder rather than a single string, because the catalogue's search is a substring
 * match and not a fuzzy one: a query with one extra word returns *nothing at all*, while
 * a query with only part of the title works fine — `示例` and `测试` both land on the
 * right game. So when the careful cleaning misses, asking for less is the move that
 * recovers it, and asking for less is safe because a loose match is put to the user
 * rather than adopted.
 *
 * Duplicates are dropped so a name that needed no cleaning costs one request, not four.
 */
export function queryLadder(name: string): string[] {
  const out: string[] = []
  const add = (value: string): void => {
    const trimmed = squeeze(value)
    if (trimmed.length >= 2 && !out.includes(trimmed)) out.push(trimmed)
  }

  const withoutArchive = name.replace(ARCHIVE_TAIL_RE, '')
  const withoutBrackets = withoutArchive.replace(BRACKET_RE, ' ')

  // 1. Everything a release could have added, taken off.
  const full = squeeze(
    stripReleaseWords(
      withoutBrackets
        .replace(LANG_SUFFIX_RE, ' ')
        .replace(VERSION_RE, ' ')
        .replace(GLUED_VERSION_RE, ' ')
    )
  ).replace(TRAILING_DOTTED_VERSION_RE, '')
  add(full)

  // 2. Only the part before an addendum. `某某游戏的日常+ ～完美版 ～` keeps its head.
  const head = full.split(/[+＋]|～|〜|~/)[0]
  add(head)

  // 3. The leading run of one script. Folder names glue a title to a note with no
  //    separator at all — `某某游戏AI-Extra-Pack对外整合` — and the head of
  //    the string is the part that is still the title.
  const cjk = /^[぀-ヿ㐀-鿿ｦ-ﾟ]{2,}/.exec(head.trim())
  if (cjk) add(cjk[0])

  // 4. Failing all of that, the name as it stands. Something is better than not asking.
  add(withoutBrackets)
  add(name)

  return out
}

/**
 * The first rung of the ladder — what to show as a suggestion, and what most callers mean
 * by "the title of this folder".
 */
export function searchableTitle(name: string): string {
  return queryLadder(name)[0] ?? name.trim()
}

/* -------------------------------------------------------------------------- */
/* matching a folder to a catalogue entry                                      */
/* -------------------------------------------------------------------------- */

/**
 * Punctuation that carries no meaning for matching.
 *
 * The full-width half is not decoration — it is the difference between a hit and a miss.
 * A folder called `测试游戏` and VNDB's `测试＊游戏` are the same game, and they only
 * compare equal once the full-width asterisk is gone; with the ASCII set alone the title
 * fails to match itself and the game silently goes unrecognised.
 */
const NOISE_PUNCTUATION =
  /[\s　_\-–—~～'"'"「」『』【】・,.!?:;+*/\\|@#$%^&()[\]{}<>＊＋－＝／＼｜！？：；，。、「」＆＃＄％＠～’”（）［］｛｝〈〉《》]/g

/** Flatten a title so two spellings of the same name compare equal. */
export function titleKey(raw: string): string {
  return raw
    .replace(BRACKET_RE, ' ')
    .replace(/\bv?er?\.?\s*[\d.]+\b/gi, ' ')
    .replace(NOISE_PUNCTUATION, '')
    .toLowerCase()
}

/**
 * How alike two titles are, 0 to 1.
 *
 * Containment rather than edit distance, because the failure this has to survive is a
 * folder name carrying extra words — a subtitle, an edition — around an otherwise exact
 * title. Edit distance punishes that in proportion to how much was added, which is the
 * opposite of what it means here.
 */
export function titleScore(folder: string, candidate: string): number {
  const a = titleKey(folder)
  const b = titleKey(candidate)
  if (!a || !b) return 0
  if (a === b) return 1
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  if (long.includes(short)) return short.length / long.length
  return 0
}

/** Close enough to adopt without asking. Nothing but an exact match after normalising gets here. */
export const STRONG_MATCH = 0.92

/* -------------------------------------------------------------------------- */
/* the blurb                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How much of a description is worth keeping.
 *
 * A drawer is not a store page. Store copy runs to several thousand characters of
 * specification lists and campaign notices, and pasting all of it under the disk chart
 * turns a panel somebody opened to check a playtime into a wall of text.
 */
export const MAX_SUMMARY_CHARS = 1200

/** Marks the cut, so a truncated blurb does not read as a description that stops mid-sentence. */
const ELLIPSIS = '…'

/**
 * Store copy, made into a paragraph.
 *
 * Both sources hand over text meant for a web page: CRLF line endings, runs of blank
 * lines used as spacing, and — on the store side — the occasional stray tag. None of that
 * survives into the drawer.
 */
export function tidySummary(raw: string | undefined | null): string {
  const text = (raw ?? '')
    .replace(/<\/?[a-z][^>]{0,200}>/gi, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t　]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (text.length <= MAX_SUMMARY_CHARS) return text
  return text.slice(0, MAX_SUMMARY_CHARS).trimEnd() + ELLIPSIS
}

/**
 * Kana, which is what tells the two languages apart.
 *
 * Chinese and Japanese share their characters and cannot be separated by looking at
 * those; hiragana and katakana exist in only one of the two, so their share of the text
 * is the whole test. A ratio rather than a presence check, because a Chinese blurb
 * routinely quotes the Japanese title it is describing — a few kana inside two hundred
 * characters of Chinese is a citation, not a language.
 *
 * The threshold sits where it does because the two cases are not close: Japanese prose
 * runs around half kana, and even a kanji-heavy specification list stays well above a
 * third, while a title quoted inside a paragraph of Chinese is a handful of characters
 * out of a hundred. A short Chinese blurb quoting a long title is the only thing anywhere
 * near the line, so the line is set generously on that side.
 */
/** Hiragana and katakana, the two blocks that exist in Japanese and not in Chinese. */
const KANA_RE = /[぀-ゟ゠-ヿ]/g
/**
 * A quoted title, which is the citation this test must not be fooled by.
 *
 * A Chinese blurb naming the work it describes — `本作原名《サンプルゲーム》…` — is kana
 * inside Chinese, and in a short sentence the quote can be a third of the characters. It
 * is also marked as a quotation by the brackets around it, so it is taken out before
 * anything is counted rather than being weighed against a threshold that cannot tell it
 * from Japanese.
 */
const QUOTED_RE = /[《〈「『【][^》〉」』】]{0,80}[》〉」』】]/g
/** Han characters — CJK Unified Ideographs and its extension A, which is where rarer names live. */
const HAN_RE = /[㐀-䶿一-鿿]/g
const KANA_SHARE = 0.15

/**
 * Whether a description is in Chinese.
 *
 * The catalogues are asked for Chinese and answer in it most of the time; the exception
 * is a doujin entry whose blurb was copied out of a Japanese store page, and there is no
 * flag on the record saying which of the two arrived. So it is read off the text.
 *
 * Anything with no Han characters at all — English, Korean, a row of symbols — is not
 * Chinese either, and is refused by the same rule rather than by a second one.
 */
export function isChineseText(raw: string | undefined | null): boolean {
  const text = (raw ?? '').replace(QUOTED_RE, ' ')
  const han = text.match(HAN_RE)?.length ?? 0
  if (han === 0) return false
  const kana = text.match(KANA_RE)?.length ?? 0
  return kana / (kana + han) <= KANA_SHARE
}

/**
 * DLsite's own description of a product, when it happens to be Chinese.
 *
 * `intro_s` is the short blurb; the long `intro` is markup for a store page and is left
 * alone. The catalogue is asked in `zh_CN` and still answers with the work's own language
 * here — the locale governs the genre names, not the copy somebody wrote — so most of
 * these are Japanese and get refused. The ones that survive are the Chinese-language
 * releases, and for those this is the best description obtainable: it is about exactly
 * the work whose number was read out of the folder name, with nothing to match and
 * therefore nothing to get wrong.
 */
export function dlsiteIntro(product: DlsiteProduct): string | undefined {
  const text = tidySummary(typeof product.intro_s === 'string' ? product.intro_s : '')
  return text && isChineseText(text) ? text : undefined
}

/**
 * The Chinese blurb for a work, from a Bangumi search response.
 *
 * The row has to *be* the work — a description is the one piece of catalogue text that
 * cannot be half right, because the wrong one is a fluent, confident paragraph about a
 * different game, and nothing on screen would say so. So the same threshold that lets a
 * genre match be adopted without asking applies here, against every name the work is
 * known by.
 *
 * Only the matching row is considered. If that row's blurb turns out to be Japanese,
 * the answer is that there is no Chinese description — taking the next row's would be
 * describing somebody else's game.
 */
export function pickBangumiSummary(
  rows: { name: string; nameCn?: string; summary?: string }[],
  names: (string | undefined)[]
): string | undefined {
  const wanted = names.filter((n): n is string => Boolean(n && n.trim()))
  if (wanted.length === 0) return undefined

  for (const row of rows) {
    const score = [row.name, row.nameCn]
      .filter((n): n is string => Boolean(n))
      .reduce((best, candidate) => {
        return Math.max(best, ...wanted.map((name) => titleScore(name, candidate)))
      }, 0)
    if (score < STRONG_MATCH) continue
    const text = tidySummary(row.summary)
    return text && isChineseText(text) ? text : undefined
  }
  return undefined
}

/* -------------------------------------------------------------------------- */
/* judging what a catalogue sent back                                           */
/* -------------------------------------------------------------------------- */

/**
 * How strongly VNDB's voters had to agree before a tag is worth showing.
 *
 * The rating runs 0 to 3 and is an average of votes, so a tag someone applied once and
 * nobody seconded sits near the bottom. Taking everything would put "Sexual Content" at
 * 0.67 next to "High School" at 2.6 as though they were the same claim.
 */
export const VNDB_MIN_RATING = 1.6

export interface VndbTag {
  name: string
  rating: number
  spoiler: number
  category: string
}

/**
 * Quotas rather than one ranked list.
 *
 * A straight top-N by rating is dominated by whichever category the voters were more
 * emphatic about, and on this catalogue that is reliably the sexual content — which
 * pushed "High School" off the end for a game largely set in a school. Since the point
 * of these tags is to answer "what is this game like", the story keeps its own allowance
 * and cannot be crowded out.
 *
 * `tech` is dropped entirely: VNDB saying "ADV" or "Multiple Endings" describes the
 * interface, not the story.
 */
const CONT_QUOTA = 8
const ERO_QUOTA = 4

export function pickVndbTags(tags: VndbTag[]): VndbTag[] {
  const eligible = tags
    .filter((tag) => tag.rating >= VNDB_MIN_RATING)
    .sort((a, b) => b.rating - a.rating)
  return [
    ...eligible.filter((tag) => tag.category === 'cont').slice(0, CONT_QUOTA),
    ...eligible.filter((tag) => tag.category === 'ero').slice(0, ERO_QUOTA)
  ]
}

/**
 * DLsite genres that describe the file rather than the work.
 *
 * The catalogue mixes format in with content — "ASMR", "WAV", "双声道立体声" are about
 * how it was recorded, which is not what anybody is browsing a shelf for.
 */
const FORMAT_EXACT = /^(asmr|wav|mp3|flac|ogg|voice|ボイス|動画|动画|ムービー)$/i

/**
 * Format words that arrive glued to others.
 *
 * The catalogue writes `双声道立体声`, not `双声道` and `立体声` — so an exact list never
 * matches. These are matched anywhere in the segment, which is safe only because each one
 * is a term of art about recording rather than a word that turns up in a genre.
 */
const FORMAT_PART = /バイノーラル|ダミヘ|双声道|立体声|人头麦|人頭|音声あり|有声音/

function isFormatWord(part: string): boolean {
  return FORMAT_EXACT.test(part) || FORMAT_PART.test(part)
}

export interface DlsiteGenre {
  /** As the catalogue wrote it in the interface language — what gets shown. */
  name: string
  /** The Japanese original, which does not move with the locale — what gets classified. */
  base: string
}

export function pickDlsiteGenres(genres: DlsiteGenre[], limit = 12): DlsiteGenre[] {
  const out: DlsiteGenre[] = []
  for (const genre of genres) {
    const name = genre.name.trim()
    if (!name) continue
    // "双声道立体声/人头麦" — the catalogue joins alternatives with a slash, so a rule
    // has to look at each half before deciding the whole thing is about the format.
    if (name.split('/').every((part) => isFormatWord(part.trim()))) continue
    if (out.some((g) => g.name === name)) continue
    out.push({ name, base: genre.base.trim() || name })
    if (out.length >= limit) break
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* turning a catalogue response into tags                                       */
/* -------------------------------------------------------------------------- */

/**
 * The release year, as a tag.
 *
 * Only ever the catalogue's date. A year read out of a folder name is the date whoever
 * packed the release typed, which is a different thing and frequently wrong.
 */
export function yearTag(released: string | undefined): AutoTag | null {
  const match = /^(\d{4})/.exec((released ?? '').trim())
  if (!match) return null
  const year = Number(match[1])
  if (year < 1980 || year > 2100) return null
  return {
    id: `year:${year}`,
    facet: 'year',
    label: String(year),
    reasonKey: 'tag.why.year',
    vars: { year }
  }
}

/** The slice of DLsite's product record this program reads. */
export interface DlsiteProduct {
  workno?: string
  work_name?: string
  regist_date?: string
  /**
   * `name` follows the locale the catalogue was asked in; `name_base` is always the
   * Japanese original. Classification keys on the base name so that a Chinese interface
   * and a Japanese one reach the same verdict about the same genre.
   */
  genres?: { name?: string; name_base?: string }[]
  /** The product image, as a protocol-relative address. `image_thumb` is the small one. */
  image_main?: { url?: string }
  image_thumb?: { url?: string }
  /**
   * DLsite rates the work, not the picture. `age_category_string` reads `adult` /
   * `r15` / `general`; the numeric `age_category` says 3 for adult. Both are read,
   * because the JSON API has answered with one or the other over the years.
   */
  age_category_string?: string
  age_category?: number
  /**
   * The short blurb. The long `intro` is a store page's markup and is not read.
   *
   * In the work's own language whatever locale the catalogue was asked in, so it is only
   * a Chinese description for a Chinese-language release — see `dlsiteIntro()`.
   */
  intro_s?: string
}

/**
 * One DLsite product, as a match.
 *
 * The genre names arrive already in the interface language — the catalogue is asked in
 * `zh_CN` or `ja_JP` and answers in kind — so these carry their own label and need no
 * dictionary entry of ours. That is also why a language switch does not invalidate them:
 * they are proper nouns from a catalogue, not sentences this program wrote.
 */
export function dlsiteWork(product: DlsiteProduct): WorkMatch | null {
  const workId = (product.workno ?? '').toUpperCase()
  const title = (product.work_name ?? '').trim()
  if (!workId || !title) return null

  const released = (product.regist_date ?? '').slice(0, 10) || undefined
  const year = yearTag(released)
  const genres = pickDlsiteGenres(
    (product.genres ?? []).map((g) => ({ name: g.name ?? '', base: g.name_base ?? g.name ?? '' }))
  )

  return {
    source: 'dlsite',
    workId,
    title,
    released,
    cover: coverFromDlsite(product) ?? undefined,
    summary: dlsiteIntro(product),
    // Read out of the folder name, so it names exactly one work and cannot be a near miss.
    score: 1,
    tags: [
      ...genres.map((genre) => ({
        id: `genre:${genre.name.toLowerCase()}`,
        facet: 'genre' as const,
        source: 'dlsite' as const,
        label: genre.name,
        reasonKey: 'tag.why.dlsite' as const,
        vars: { code: workId },
        // DLsite rates the work, not the genre, so this is our reading of the base name.
        adult: looksAdult(genre.base)
      })),
      ...(year ? [year] : [])
    ]
  }
}

/** One of the names a work goes by, in one language. */
export interface VndbTitle {
  lang?: string
  title?: string
  latin?: string
}

/** The slice of VNDB's `/vn` response this program reads. */
export interface VndbVn {
  id?: string
  title?: string
  alttitle?: string
  released?: string
  titles?: VndbTitle[]
  tags?: VndbTag[]
  /**
   * The work's cover.
   *
   * `sexual` and `violence` are VNDB's own 0–2 ratings of that picture, voted on by its
   * users. Read by `cover-rules.ts`; the tags do not use them.
   */
  image?: { url?: string; sexual?: number; violence?: number }
}

/** The Chinese name a work is released under, when it has one. */
function chineseTitle(item: VndbVn): string | undefined {
  const hit = (item.titles ?? []).find((t) => (t.lang ?? '').toLowerCase().startsWith('zh'))
  return hit?.title?.trim() || undefined
}

/** The original Japanese name, which is what `alttitle` usually already is. */
function japaneseTitle(item: VndbVn): string | undefined {
  const hit = (item.titles ?? []).find((t) => (t.lang ?? '').toLowerCase() === 'ja')
  return hit?.title?.trim() || item.alttitle?.trim() || undefined
}

/**
 * VNDB entries as ranked matches.
 *
 * Two things here were wrong before and are worth naming, because both made the feature
 * look like the catalogue had never heard of half the library.
 *
 * **Every title is scored, not two.** A work carries a name per language, and a Chinese
 * folder name can only ever match the `zh-Hans` one — `示例游戏` scores zero
 * against both `Sample Game` and `サンプルゲーム`, and one against the Chinese
 * title sitting in the same response.
 *
 * **A score of zero no longer discards the entry.** VNDB's own search decided this work
 * was worth returning for that query; our scoring exists to rank, and to decide whether
 * to adopt silently or ask. Using it as a filter meant throwing away answers the
 * catalogue had already found — which is exactly what it was doing.
 */
export function vndbWorks(items: VndbVn[], query: string): WorkMatch[] {
  const out: WorkMatch[] = []
  for (const item of items) {
    const workId = item.id ?? ''
    const title = (item.title ?? item.alttitle ?? '').trim()
    if (!workId || !title) continue

    const names = [
      item.title,
      item.alttitle,
      ...(item.titles ?? []).flatMap((t) => [t.title, t.latin])
    ].filter((n): n is string => Boolean(n))
    const score = names.reduce((best, name) => Math.max(best, titleScore(query, name)), 0)

    const year = yearTag(item.released)
    out.push({
      source: 'vndb',
      workId,
      title,
      altTitle: japaneseTitle(item) !== title ? japaneseTitle(item) : undefined,
      zhTitle: chineseTitle(item),
      released: item.released,
      cover: coverFromVndb(item) ?? undefined,
      score,
      tags: [
        ...pickVndbTags(item.tags ?? []).map((tag) => ({
          id: `genre:${tag.name.toLowerCase()}`,
          facet: 'genre' as const,
          source: 'vndb' as const,
          label: tag.name,
          reasonKey: 'tag.why.vndb' as const,
          vars: { rating: tag.rating.toFixed(1) },
          spoiler: tag.spoiler > 0 ? true : undefined,
          // The catalogue's own classification, which beats reading the name.
          adult: tag.category === 'ero'
        })),
        ...(year ? [year] : [])
      ]
    })
  }
  return out.sort((a, b) => b.score - a.score)
}
