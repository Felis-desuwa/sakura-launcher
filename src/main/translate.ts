import {
  assembleTranslation,
  CHUNK_CHARS,
  googleUrl,
  myMemoryUrl,
  parseGoogle,
  parseMyMemory,
  splitForTranslation,
  type Translator
} from './translate-rules.ts'
import { getJson, paceTranslate } from './tag-online'

/**
 * Getting a Japanese blurb into Chinese.
 *
 * Two services, tried in order, because neither is reachable everywhere: Google reads
 * better and is blocked in some of the places this program is used, MyMemory is reachable
 * almost anywhere and reads worse. Whichever answers first wins, and if neither does the
 * answer is no description — never a half-translated one.
 *
 * What leaves the machine here is the catalogue's own paragraph about a game. That is a
 * larger thing to send than a title, which is why it has a switch of its own and why both
 * READMEs name the hosts.
 */

/** The order they are tried in: quality first, reach second. */
const PROVIDERS: Translator[] = ['google', 'mymemory']

async function translateChunk(text: string, via: Translator): Promise<string | null> {
  await paceTranslate()
  if (via === 'google') {
    return parseGoogle(await getJson<unknown>(googleUrl(text)))
  }
  return parseMyMemory(await getJson<unknown>(myMemoryUrl(text)))
}

/**
 * Translate a whole blurb, or nothing.
 *
 * A blurb whose second half is still Japanese reads as a fault in the game's own
 * description and gives the reader no way to tell which half to trust, so a chunk that
 * fails takes the rest of that attempt with it and the next service starts over.
 */
async function translateVia(text: string, via: Translator): Promise<string | null> {
  const chunks = splitForTranslation(text, CHUNK_CHARS[via])
  if (chunks.length === 0) return null

  const done: (string | null)[] = []
  for (const chunk of chunks) {
    const piece = await translateChunk(chunk, via)
    if (piece === null) return null
    done.push(piece)
  }
  return assembleTranslation(done, chunks)
}

export async function translateToChinese(text: string): Promise<string | null> {
  for (const via of PROVIDERS) {
    const out = await translateVia(text, via)
    if (out) return out
  }
  return null
}
