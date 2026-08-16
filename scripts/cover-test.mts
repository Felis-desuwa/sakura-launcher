import {
  absoluteUrl,
  acceptCover,
  coverFromDlsite,
  coverFromVndb,
  coverSourceOf,
  coverVerdict,
  mayReplaceSummary,
  sniffImage,
  MAX_COVER_BYTES
} from '../src/main/cover-rules.ts'

/**
 * Cover art, judged on what it must refuse.
 *
 * A cover is the most visible thing this program can get wrong: it is painted across the
 * whole tile at the size of a playing card. So the cases that matter here are the refusals
 * — an error page that arrived with status 200 and must never be written as `cover.jpg`,
 * an explicit picture that must be recognised as one, and a cover the user chose by hand
 * that a batch must not overwrite.
 *
 * Nothing here opens a socket. The catalogues' shapes are pinned by fixtures.
 */

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  check(
    name,
    Object.is(actual, expected),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`
  )
}

/* -------------------------------------------------------------------------- */
console.log('\n== addresses as the catalogues write them ==')

// DLsite answers with protocol-relative addresses, which are valid in a page and useless
// to a downloader.
eq(
  'a protocol-relative address becomes https',
  absoluteUrl('//img.dlsite.jp/modpub/images2/work/doujin/RJ01234567/RJ01234567_img_main.jpg'),
  'https://img.dlsite.jp/modpub/images2/work/doujin/RJ01234567/RJ01234567_img_main.jpg'
)
eq('an https address is left alone', absoluteUrl('https://t.vndb.org/cv/34/1234.jpg'), 'https://t.vndb.org/cv/34/1234.jpg')
eq('http is accepted too', absoluteUrl('http://example.test/a.png'), 'http://example.test/a.png')
eq('surrounding space is trimmed', absoluteUrl('  https://t.vndb.org/cv/1.jpg '), 'https://t.vndb.org/cv/1.jpg')

// Anything that is not plainly http(s) is refused rather than guessed at: a data: or
// file: URL arriving in a catalogue response is not a cover, it is something going wrong.
eq('an empty address is nothing', absoluteUrl(''), null)
eq('undefined is nothing', absoluteUrl(undefined), null)
eq('a data URL is refused', absoluteUrl('data:image/png;base64,iVBORw0KGgo='), null)
eq('a file URL is refused', absoluteUrl('file:///C:/windows/system32/calc.exe'), null)
eq('a bare path is refused', absoluteUrl('/cv/34/1234.jpg'), null)

/* -------------------------------------------------------------------------- */
console.log('\n== VNDB: the catalogue rates its own picture ==')

const vn = (image: Record<string, unknown> | undefined): Parameters<typeof coverFromVndb>[0] =>
  ({ id: 'v1234', title: 'Sample Game', image }) as Parameters<typeof coverFromVndb>[0]

eq(
  'the url comes through',
  coverFromVndb(vn({ url: 'https://t.vndb.org/cv/34/1234.jpg', sexual: 0, violence: 0 }))?.url,
  'https://t.vndb.org/cv/34/1234.jpg'
)
check(
  'an unrated picture is not treated as explicit',
  coverFromVndb(vn({ url: 'https://t.vndb.org/cv/34/1234.jpg', sexual: 0, violence: 0 }))?.adult === false
)
check(
  'any sexual rating above zero is explicit',
  coverFromVndb(vn({ url: 'https://t.vndb.org/cv/1.jpg', sexual: 0.6, violence: 0 }))?.adult === true
)
check(
  'so is violence on its own',
  coverFromVndb(vn({ url: 'https://t.vndb.org/cv/1.jpg', sexual: 0, violence: 1.4 }))?.adult === true
)
// A work whose image nobody has voted on reports nothing at all. Treating that as
// explicit would blur most of a library on a technicality.
check(
  'a picture with no ratings at all is not explicit',
  coverFromVndb(vn({ url: 'https://t.vndb.org/cv/1.jpg' }))?.adult === false
)
eq('a work with no image is nothing', coverFromVndb(vn(undefined)), null)
eq('an image with no url is nothing', coverFromVndb(vn({ sexual: 2 })), null)

/* -------------------------------------------------------------------------- */
console.log('\n== DLsite: the catalogue rates the work ==')

const product = (extra: Record<string, unknown>): Parameters<typeof coverFromDlsite>[0] =>
  ({ workno: 'RJ01234567', work_name: 'ある作品', ...extra }) as Parameters<typeof coverFromDlsite>[0]

check(
  'an adult work makes its cover adult',
  coverFromDlsite(
    product({ image_main: { url: '//img.dlsite.jp/a.jpg' }, age_category_string: 'adult' })
  )?.adult === true
)
check(
  'the numeric form is read as well',
  coverFromDlsite(product({ image_main: { url: '//img.dlsite.jp/a.jpg' }, age_category: 3 }))
    ?.adult === true
)
check(
  'an all-ages work is not',
  coverFromDlsite(
    product({ image_main: { url: '//img.dlsite.jp/a.jpg' }, age_category_string: 'general' })
  )?.adult === false
)
// The thumbnail is the fallback, not the preference: it is the smaller picture.
eq(
  'the thumbnail stands in when there is no main image',
  coverFromDlsite(product({ image_thumb: { url: '//img.dlsite.jp/t.jpg' } }))?.url,
  'https://img.dlsite.jp/t.jpg'
)
eq('a product with no picture is nothing', coverFromDlsite(product({})), null)

/* -------------------------------------------------------------------------- */
console.log('\n== what came down the wire is not what the header claimed ==')

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values)
const pad = (head: number[], length = 32): Uint8Array => {
  const out = new Uint8Array(length)
  out.set(head)
  return out
}

eq('JPEG is recognised', sniffImage(pad([0xff, 0xd8, 0xff, 0xe0])), 'jpg')
eq('PNG is recognised', sniffImage(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png')
eq(
  'WebP is recognised through its RIFF wrapper',
  sniffImage(
    pad([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])
  ),
  'webp'
)

/*
 * The failure that actually happens: a catalogue answering 200 with an error page. The
 * header says image/jpeg often enough that trusting it is how markup ends up on disk
 * being served to the renderer as a cover.
 */
const html = new TextEncoder().encode('<!doctype html><html><body>404 not found</body></html>')
eq('an HTML error page is not an image', sniffImage(html), null)
eq('a RIFF file that is not WebP is refused', sniffImage(pad([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20])), null)
eq('a truncated response is refused', sniffImage(bytes(0xff, 0xd8)), null)
eq('an empty body is refused', sniffImage(new Uint8Array(0)), null)

eq('acceptCover agrees on a real JPEG', acceptCover(pad([0xff, 0xd8, 0xff, 0xe0])), 'jpg')
eq('acceptCover refuses an empty body', acceptCover(new Uint8Array(0)), null)
// The size cap is enforced while downloading as well; this is the second line of defence.
const huge = new Uint8Array(MAX_COVER_BYTES + 1)
huge.set([0xff, 0xd8, 0xff, 0xe0])
eq('an absurdly large image is refused even though it is an image', acceptCover(huge), null)

/* -------------------------------------------------------------------------- */
console.log("\n== a cover the user chose is the user's ==")

/*
 * The rule is no longer "skip it" or "replace it" but "put both up and ask", and what
 * matters is that the asking does not depend on where the cover came from. Gating it on
 * `coverFrom === 'user'` looked careful and was useless: in a real library nearly every
 * cover has been fetched, so the dialog would almost never appear and a lookup would go
 * on silently doing the one thing it must not.
 */
eq('a cover already on the tile is put to the user', coverVerdict(true, false), 'ask')
eq('a game with no cover has nothing to ask about', coverVerdict(false, false), 'replace')
// The ordinary result of looking the same game up twice. Asking somebody to choose
// between two copies of one picture is noise, and it would be the common case.
eq('the identical picture is left alone', coverVerdict(true, true), 'keep')
// Nothing there to be identical to; the flag cannot make a no-op out of a first cover.
eq('sameness is meaningless without a cover', coverVerdict(false, true), 'replace')

/*
 * The library that predates `coverFrom`: a path and no source. Every one of those was set
 * by hand, and reading them as unowned would have a batch overwrite precisely the covers
 * somebody chose themselves — the failure the rule above is meant to prevent, arriving
 * through the back door.
 */
eq(
  'a cover from before the field existed belongs to the user',
  coverSourceOf({ coverPath: 'C:\\pics\\a.png' }),
  'user'
)
eq(
  'a catalogue cover says so itself',
  coverSourceOf({ coverFrom: 'dlsite', coverPath: 'C:\\x.jpg' }),
  'dlsite'
)
eq('and no cover belongs to nobody', coverSourceOf({ coverPath: null }), undefined)
/*
 * `coverSourceOf` still earns its keep, just not here: it decides whether undoing a
 * lookup may delete the cover file. A picture the user chose is not part of what a
 * lookup did, so it survives the lookup being taken back.
 */
check(
  "clearing a lookup keeps a cover with no recorded source, reading it as the user's",
  coverSourceOf({ coverPath: 'C:\\pics\\a.png' }) === 'user'
)
check(
  'and deletes one the catalogue supplied',
  coverSourceOf({ coverFrom: 'vndb', coverPath: 'C:\\x.jpg' }) !== 'user'
)

/* -------------------------------------------------------------------------- */
console.log('\n== fetching a description again ==')

/*
 * Nobody types a description in, so this is about traffic rather than ownership: a
 * selection of eighty games does not ask a free catalogue eighty questions it has already
 * answered, while asking for one game means asking for it again.
 */
check('a game with no description is asked about', mayReplaceSummary(false, 'bulk') === true)
check('one that already has it is left out of a batch', mayReplaceSummary(true, 'bulk') === false)
check('but a single game is asked again', mayReplaceSummary(true, 'single') === true)

/* -------------------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
