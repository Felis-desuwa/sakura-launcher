/**
 * Turning a Chinese title into the name the work was actually released under.
 *
 * VNDB is the tag source, but it is indexed under Japanese and romaji, and only some
 * works carry a Chinese title. A folder called `另一个游戏` finds nothing there —
 * while Bangumi, a Chinese-language database, knows it as `ある少女の生活` and hands over
 * that name, at which point VNDB has it immediately.
 *
 * This is the whole job. Bangumi is asked *what a game is called*, never what it is
 * about, and the name it returns is one a person entered into a catalogue — it is looked
 * up, not translated. Nothing here guesses at a Japanese title and nothing machine
 * translates one; if Bangumi has no record, the answer is "no answer".
 *
 * Two things learned by probing the API, recorded so nobody has to find them twice:
 *
 * - **Search needs no token** and returns `name` (Japanese) and `name_cn` (Chinese).
 * - **The subject endpoints do.** Both `/v0/subjects/{id}` and the legacy
 *   `/subject/{id}` answer 404 for adult titles unless a logged-in token is sent, which
 *   is most of this library. That is why tags never come from here: the search response
 *   carries no tags, and the only place that does is behind the login.
 */

/** What a Bangumi search row gives us that is worth having. */
export interface BangumiWork {
  id: number
  /** The original name, usually Japanese. */
  name: string
  /** The Chinese name, when the entry has one. */
  nameCn?: string
  /** `YYYY-MM-DD`, when recorded. */
  date?: string
}

interface RawRow {
  id?: number
  name?: string
  name_cn?: string
  air_date?: string
}

/** `type=4` is Bangumi's category for games. Anything else here would be an anime or a book. */
const GAME_TYPE = 4

/**
 * Look a title up by name.
 *
 * `fetchJson` is injected rather than imported so this module stays free of electron and
 * can be exercised from the test harness against a canned response — the same split
 * `tag-rules.ts` keeps from `tag-online.ts`.
 */
export async function searchBangumi(
  query: string,
  fetchJson: (url: string) => Promise<unknown>,
  limit = 3
): Promise<BangumiWork[]> {
  const url =
    `https://api.bgm.tv/search/subject/${encodeURIComponent(query)}` +
    `?type=${GAME_TYPE}&responseGroup=small&max_results=${limit}`

  const body = (await fetchJson(url)) as { list?: RawRow[] } | null
  return parseBangumi(body)
}

/**
 * Read a search response.
 *
 * Bangumi answers a query it does not like with `{"results":0}` and no `list` at all
 * rather than an empty one, so the absent case is normal and not a sign of trouble.
 */
export function parseBangumi(body: unknown): BangumiWork[] {
  const rows = (body as { list?: RawRow[] } | null)?.list
  if (!Array.isArray(rows)) return []

  const out: BangumiWork[] = []
  for (const row of rows) {
    const name = (row.name ?? '').trim()
    if (!row.id || !name) continue
    out.push({
      id: row.id,
      name,
      nameCn: (row.name_cn ?? '').trim() || undefined,
      date: (row.air_date ?? '').trim() || undefined
    })
  }
  return out
}
