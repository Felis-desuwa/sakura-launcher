// Extension spelled out so the harness in scripts/ can import this straight into node.

/**
 * Turning a Japanese blurb into a Chinese one.
 *
 * This is the one place in the program that puts words in somebody else's mouth, and it
 * exists because the alternative turned out to be worse. Bangumi carries the Japanese
 * store copy on a great many otherwise Chinese entries, so refusing everything that was
 * not already Chinese left most of a library with no description at all — including games
 * whose entry was matched perfectly. A machine translation, **labelled as one**, is
 * information; a blank panel is not.
 *
 * The labelling is not decoration. A translated blurb says so on screen and in the file
 * beside the game, because a reader has to be able to tell a sentence a person wrote from
 * a sentence a machine produced — the two read alike and are not worth the same.
 *
 * Nothing here reaches the network: this module builds the requests and reads the
 * answers, so the shape of both can be tested without a socket.
 */

/** Which service answered, so a failure can be reported as the right kind of failure. */
export type Translator = 'google' | 'mymemory'

/**
 * How much text goes in one request, per service.
 *
 * The request is a GET with the text in the query string, so the limit is the URL's, not
 * the paragraph's. Google is generous; MyMemory refuses anything over 500 **bytes**, and
 * a Japanese character is three of those — hence the much smaller figure, which is in
 * characters because that is what the splitter counts.
 */
export const CHUNK_CHARS: Record<Translator, number> = {
  google: 900,
  mymemory: 150
}

/**
 * Break a blurb into pieces a request will accept, without breaking a sentence.
 *
 * Sentence endings first, then line breaks, then — only when a single sentence is longer
 * than the limit, which happens — a hard cut. Splitting mid-sentence costs real accuracy:
 * a translator handed half a clause has nothing to work with, and the seam shows in the
 * result.
 */
export function splitForTranslation(text: string, limit: number): string[] {
  const source = text.replace(/\r\n?/g, '\n').trim()
  if (!source) return []

  // Kept as separate units so a paragraph break survives the round trip.
  const pieces = source.split(/(?<=[。．！？!?\n])/)
  const out: string[] = []
  let current = ''

  const flush = (): void => {
    if (current.trim()) out.push(current)
    current = ''
  }

  for (const piece of pieces) {
    if (piece.length > limit) {
      flush()
      for (let i = 0; i < piece.length; i += limit) out.push(piece.slice(i, i + limit))
      continue
    }
    if (current.length + piece.length > limit) flush()
    current += piece
  }
  flush()
  return out
}

/**
 * Google's public translate endpoint.
 *
 * The one used by the browser extension: no key, no account, and the same engine behind
 * the website. `dt=t` asks for the translation and nothing else.
 */
export function googleUrl(text: string, from = 'ja', to = 'zh-CN'): string {
  return (
    'https://translate.googleapis.com/translate_a/single?client=gtx' +
    `&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`
  )
}

/**
 * Read Google's answer.
 *
 * The response is nested arrays rather than an object: `[[[translated, original, …], …],
 * …]`, one entry per sentence it decided to split on. Anything that is not that shape is
 * refused rather than salvaged — a partly-read translation is a sentence nobody wrote.
 */
export function parseGoogle(body: unknown): string | null {
  if (!Array.isArray(body) || !Array.isArray(body[0])) return null
  const parts: string[] = []
  for (const row of body[0]) {
    if (!Array.isArray(row) || typeof row[0] !== 'string') return null
    parts.push(row[0])
  }
  const text = parts.join('')
  return text.trim() ? text : null
}

/** MyMemory's free endpoint: no key, and the fallback for a network Google is not on. */
export function myMemoryUrl(text: string, pair = 'ja|zh-CN'): string {
  return (
    'https://api.mymemory.translated.net/get' +
    `?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(pair)}`
  )
}

/**
 * Read MyMemory's answer.
 *
 * It answers 200 with `responseStatus` inside the body when it is unhappy, so the status
 * that matters is the one in the JSON. It also returns the *input* verbatim when it has
 * nothing — caught by the caller, which knows what it sent.
 */
export function parseMyMemory(body: unknown): string | null {
  const data = body as { responseData?: { translatedText?: unknown }; responseStatus?: unknown }
  const status = Number(data?.responseStatus ?? 0)
  if (status !== 200) return null
  const text = data?.responseData?.translatedText
  if (typeof text !== 'string' || !text.trim()) return null
  // MyMemory shouts its own error messages back in this field.
  if (/^(MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID)/i.test(text)) return null
  return text
}

/**
 * Whether the pieces add up to a translation.
 *
 * All of them or none: a blurb where the second half is still Japanese reads as a bug in
 * the game's own description, and there is no way for a reader to tell which half to
 * believe. Also refused when the result comes back identical to what was sent, which is
 * what both services do when they cannot translate at all.
 */
export function assembleTranslation(pieces: (string | null)[], original: string[]): string | null {
  if (pieces.length === 0 || pieces.length !== original.length) return null
  if (pieces.some((piece) => piece === null)) return null
  const text = (pieces as string[]).join('')
  if (!text.trim()) return null
  return text.replace(/\s+$/gm, '').trim() === original.join('').replace(/\s+$/gm, '').trim()
    ? null
    : text
}
