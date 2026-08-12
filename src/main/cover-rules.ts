// Extension spelled out so the harness in scripts/ can import this straight into node.
import type { DlsiteProduct, VndbVn } from './tag-rules.ts'

/**
 * Which picture to take, and whether it can be shown.
 *
 * Nothing here reaches the network — this module decides what a catalogue record is
 * offering and whether the bytes that come back are really an image. The fetching itself
 * lives in `tag-online.ts`, and the orchestration in `covers.ts`, so the judgement can be
 * tested without a socket.
 *
 * The judgement matters more than it looks. A cover is not a tag: it is painted across
 * the whole tile, at the size of a playing card, on a shelf somebody may have open when
 * another person walks past. Getting "is this explicit" wrong is not a wrong label, it is
 * a picture on screen.
 */

/**
 * Anything larger is refused.
 *
 * Box art from either catalogue is a few hundred kilobytes; a megabyte is already
 * generous. The cap exists because the response is written to disk under the app's own
 * data directory, and "however many bytes the other end feels like sending" is not a
 * size.
 */
export const MAX_COVER_BYTES = 8 * 1024 * 1024

export interface CoverPick {
  url: string
  /**
   * The picture is explicit.
   *
   * Kept with the cover rather than derived at display time, because the two catalogues
   * answer this question at different resolutions and only one of them can be asked
   * again cheaply.
   */
  adult: boolean
}

/**
 * A URL as the catalogue wrote it, made absolute.
 *
 * DLsite answers with protocol-relative addresses (`//img.dlsite.jp/...`), which are
 * perfectly valid in a page and useless to a downloader. Anything that is not plainly
 * http(s) after that is refused rather than guessed at — a `data:` or `file:` URL
 * arriving from a catalogue response is not a cover, it is something going wrong.
 */
export function absoluteUrl(raw: string | undefined | null): string | null {
  const url = (raw ?? '').trim()
  if (!url) return null
  const absolute = url.startsWith('//') ? `https:${url}` : url
  return /^https?:\/\/./i.test(absolute) ? absolute : null
}

/**
 * VNDB's cover for a work.
 *
 * VNDB rates each image itself, on two axes, by public vote: `sexual` and `violence`,
 * 0 to 2. That is the catalogue's own word about its own picture, which beats anything
 * this program could infer, so anything above zero on either axis counts as explicit.
 * A work whose image has never been voted on reports 0 — treated as safe, because the
 * alternative is blurring the entire library on a technicality.
 */
export function coverFromVndb(vn: VndbVn): CoverPick | null {
  const url = absoluteUrl(vn.image?.url)
  if (!url) return null
  const sexual = vn.image?.sexual ?? 0
  const violence = vn.image?.violence ?? 0
  return { url, adult: sexual > 0 || violence > 0 }
}

/**
 * DLsite's main product image.
 *
 * DLsite has no per-image rating — it rates the *work*, and `age_category_string` is the
 * field that says so. So on DLsite the whole cover of an adult work is treated as
 * explicit, which is coarser than VNDB and correct in the direction that matters: the
 * error it can make is blurring something harmless, not the other way round.
 */
export function coverFromDlsite(product: DlsiteProduct): CoverPick | null {
  const url = absoluteUrl(product.image_main?.url ?? product.image_thumb?.url)
  if (!url) return null
  const category = (product.age_category_string ?? '').toLowerCase()
  return { url, adult: category === 'adult' || product.age_category === 3 }
}

export type ImageKind = 'jpg' | 'png' | 'webp'

/**
 * What the downloaded bytes actually are.
 *
 * Read off the leading bytes rather than the `Content-Type` header, because this file is
 * about to be written into the app's data directory and served to the renderer through
 * the asset protocol. A header is what the other end claims; the magic number is what the
 * file is. An HTML error page saved as `cover.jpg` is the ordinary failure here — a
 * catalogue answering 200 with "not found" markup — and it must not reach disk.
 */
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  if (bytes.length < 12) return null
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (png.every((b, i) => bytes[i] === b)) return 'png'
  // WebP: "RIFF" .... "WEBP"
  const riff = [0x52, 0x49, 0x46, 0x46]
  const webp = [0x57, 0x45, 0x42, 0x50]
  if (riff.every((b, i) => bytes[i] === b) && webp.every((b, i) => bytes[i + 8] === b)) return 'webp'
  return null
}

/** Whether a downloaded body is a usable cover: an image, and not an absurd one. */
export function acceptCover(bytes: Uint8Array): ImageKind | null {
  if (bytes.length === 0 || bytes.length > MAX_COVER_BYTES) return null
  return sniffImage(bytes)
}

/**
 * Whether a cover may be written over.
 *
 * A cover the user chose by hand is their decision about their own library, and the same
 * protection `renamed` gives a hand-typed title applies here: a pass over many games must
 * never quietly undo it. One game, picked deliberately from its own menu, is a different
 * act — that is somebody asking for this game's cover to be replaced, and it is honoured.
 */
export function mayReplaceCover(
  coverFrom: string | undefined | null,
  scope: 'single' | 'bulk'
): boolean {
  if (coverFrom !== 'user') return true
  return scope === 'single'
}
