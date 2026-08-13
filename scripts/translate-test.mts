import {
  assembleTranslation,
  CHUNK_CHARS,
  googleUrl,
  myMemoryUrl,
  parseGoogle,
  parseMyMemory,
  splitForTranslation
} from '../src/main/translate-rules.ts'
import { isChineseText } from '../src/main/tag-rules.ts'

/**
 * The one place this program puts words in somebody else's mouth.
 *
 * So the cases that matter are the refusals: a response that is not the shape it should
 * be, a service shouting its own error message into the field where the translation goes,
 * and — the one that would be least visible — a blurb where only some of the chunks came
 * back, which reads as a fault in the game's own description rather than as ours.
 *
 * Nothing here reaches the network. The response shapes are pinned by real answers from
 * both services, taken once by hand.
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

console.log('\n== cutting a blurb into requests ==')

const JA =
  '瀬戸内海に面した企業城下町。ここに住む市民らは一企業にすべてを制御される生活を送っている。' +
  '不満も疑問も口にすることはない。\nある日、主人公はひとりの少女と出会う。'

const chunks = splitForTranslation(JA, 40)
check('every piece fits the limit', chunks.every((c) => c.length <= 40), JSON.stringify(chunks))
eq('and nothing is lost', chunks.join(''), JA.replace(/\r\n?/g, '\n'))
check(
  'sentences are kept whole',
  chunks.every((c) => !/[^。！？\n]$/.test(c.trim()) || c.length >= 30)
)
eq('a blurb that already fits stays one request', splitForTranslation(JA, 500).length, 1)
eq('nothing in, nothing out', splitForTranslation('   ', 100).length, 0)

/* A single sentence longer than the limit still has to go somewhere. */
const long = 'あ'.repeat(250)
const cut = splitForTranslation(long, 100)
eq('an over-long sentence is cut rather than dropped', cut.join(''), long)
check('and the cuts respect the limit', cut.every((c) => c.length <= 100))

check('MyMemory gets much smaller pieces than Google', CHUNK_CHARS.mymemory < CHUNK_CHARS.google)
check(
  'small enough for its 500-byte limit',
  CHUNK_CHARS.mymemory * 3 < 500,
  'Japanese is three bytes a character in UTF-8'
)

console.log('\n== the addresses ==')

check('Google is asked for ja → zh', googleUrl('テスト').includes('sl=ja&tl=zh-CN'))
check('and the text is escaped', googleUrl('テスト').includes(encodeURIComponent('テスト')))
check('MyMemory is asked for the same pair', myMemoryUrl('テスト').includes(encodeURIComponent('ja|zh-CN')))

console.log('\n== reading the answers ==')

/* Google's real shape: nested arrays, one row per sentence it split on. */
const GOOGLE_OK = [
  [
    ['面向濑户内海的商业城下町。', '瀬戸内海に面した企業城下町。', null, null, 3],
    ['居住在这里的居民过着被控制的生活。', 'ここに住む市民らは…', null, null, 3]
  ],
  null,
  'ja'
]
eq(
  'the sentences are joined back up',
  parseGoogle(GOOGLE_OK),
  '面向濑户内海的商业城下町。居住在这里的居民过着被控制的生活。'
)
check('and the result reads as Chinese', isChineseText(parseGoogle(GOOGLE_OK) ?? ''))
eq('an empty body is refused', parseGoogle([]), null)
eq('so is an error page parsed as JSON', parseGoogle({ error: 'quota' }), null)
eq('so is a row with no text in it', parseGoogle([[[null, 'x']]]), null)
/* Half a translation is worse than none: it reads as a fault in the game's own blurb, and
   nothing on screen would say which half to believe. */
eq(
  'one unreadable row refuses the whole response',
  parseGoogle([[['前半句。', 'x'], [42, 'y']]]),
  null
)

const MYMEMORY_OK = {
  responseData: { translatedText: '面向濑户内海的企业城。', match: 0.85 },
  responseStatus: 200
}
eq('MyMemory hands over its text', parseMyMemory(MYMEMORY_OK), '面向濑户内海的企业城。')
eq(
  'the status inside the body is the one that counts',
  parseMyMemory({ responseData: { translatedText: 'x' }, responseStatus: 403 }),
  null
)
eq(
  'and it shouts its errors into the same field',
  parseMyMemory({
    responseData: { translatedText: 'QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS' },
    responseStatus: 200
  }),
  null
)
eq('nothing at all is nothing', parseMyMemory(null), null)

console.log('\n== all of it, or none ==')

eq('the pieces are joined in order', assembleTranslation(['甲', '乙'], ['A', 'B']), '甲乙')
eq('one missing piece loses the lot', assembleTranslation(['甲', null], ['A', 'B']), null)
eq('a short count loses it too', assembleTranslation(['甲'], ['A', 'B']), null)
eq('nothing to assemble', assembleTranslation([], []), null)
/* Both services answer with the input verbatim when they cannot translate at all. */
eq('text that came back unchanged is not a translation', assembleTranslation(['A'], ['A']), null)

/* -------------------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
