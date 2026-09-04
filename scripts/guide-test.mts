import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  dfanSearchUrl,
  guideKey,
  guideQuery,
  guideScore,
  MAX_HITS,
  parseSaigaIndex,
  rankDfan,
  read2dfan,
  saigaUrl,
  searchIndex
} from '../src/main/guide-rules.ts'
import * as guideRules from '../src/main/guide-rules.ts'
import * as tagRules from '../src/main/tag-rules.ts'
import type { GuideHit } from '../src/shared/types.ts'

/**
 * Finding a walkthrough: what normalises away, what counts as a match, what the two sites
 * hand back.
 *
 * Weighted towards the two ways this can lie. A fragment matching the middle of an
 * unrelated word offers somebody another game's walkthrough under their game's name; and
 * a provider whose markup changed reporting an empty list makes a broken reader look like
 * a fact about the game.
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

function eq<T>(name: string, got: T, want: T): void {
  check(name, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

function deepEq(name: string, got: unknown, want: unknown): void {
  check(
    name,
    JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`
  )
}

/**
 * A page shaped like the real index: navigation with absolute links, entries with
 * relative ones. Placeholder titles only, per the repo rule.
 */
const INDEX_PAGE = `<!DOCTYPE HTML><HTML><HEAD><meta charset="Shift_JIS"><title>攻略一覧</title></HEAD><BODY>
<a href="https://example.invalid/">サイトの案内</a>
<a href="#top">ページの先頭へ</a>
<a href="mailto:nobody@example.invalid">れんらく</a>
<a href="brandone/sample.html">サンプルゲーム ～序章～</a>
<a href="brandone/sample_fd.html">サンプルゲーム ファンディスク</a>
<a href="brandtwo/another.html"><b>示例ゲーム</b>2</a>
<a href="brandtwo/short.html">雨恋</a>
<a href="brandthree/nested.html">テストタイトル（Steam版）</a>
<a href="../escape/x.html">のがれる</a>
<a href="brandone/sample.html">サンプルゲーム ～序章～</a>
</BODY></HTML>`

const entries = parseSaigaIndex(INDEX_PAGE)

/* -------------------------------------------------------------------------- */
console.log('\n== flattening a title ==')

eq('a version marker comes off', guideKey('サンプルゲーム v1.02'), guideKey('サンプルゲーム'))
eq('a bracketed edition comes off', guideKey('サンプルゲーム（Steam版）'), guideKey('サンプルゲーム'))
eq('...and an unbracketed one too', guideKey('サンプルゲーム 体験版'), guideKey('サンプルゲーム'))
eq('a Chinese release word comes off', guideKey('测试游戏 官方中文版'), guideKey('测试游戏'))

// Four folds measured as flat-zero gaps in tag-rules' titleKey against this corpus.
eq('fullwidth digits fold', guideKey('サンプルゲーム２'), guideKey('サンプルゲーム2'))
eq('fullwidth latin folds', guideKey('ＡＢＣ'), guideKey('abc'))
eq('halfwidth katakana folds', guideKey('ｻﾝﾌﾟﾙ'), guideKey('サンプル'))
eq('a katakana middle dot is noise', guideKey('サンプル・ゲーム'), guideKey('サンプルゲーム'))

// The two tildes look identical and are different characters. titleKey strips only one,
// so the same title scores differently depending on which one somebody typed.
eq('a fullwidth tilde tail comes off', guideKey('サンプルゲーム～序章～'), guideKey('サンプルゲーム'))
eq('...and a wave dash tail too', guideKey('サンプルゲーム〜序章〜'), guideKey('サンプルゲーム'))
check('a tail can be kept when asked', guideKey('サンプルゲーム～序章～', true).includes('序章'))

eq('spacing is noise', guideKey('サンプル ゲーム'), guideKey('サンプルゲーム'))
eq('nothing is nothing', guideKey('   '), '')

/* -------------------------------------------------------------------------- */
console.log('\n== how alike two titles are ==')

eq('a title matches itself', guideScore('サンプルゲーム', 'サンプルゲーム'), 1)
eq('a subtitle tail does not stop it', guideScore('サンプルゲーム', 'サンプルゲーム ～序章～'), 1)
check('a fan disc scores below an exact match', guideScore('サンプルゲーム', 'サンプルゲーム ファンディスク') < 1)
// A long title inside a longer one is that title's own fan disc, and it has to survive
// the floor that exists to reject fragments. Gating the floor on query length is what
// lets both hold: measured, 19 of the first 1200 real entries look exactly like this.
check('...and above nothing', guideScore('サンプルゲーム', 'サンプルゲーム ファンディスク') > 0)
// A short query has to BEGIN the other title. This is the pair that settles the rule:
// a series name starts the title it belongs to, and a fragment lands in the middle.
check('a short query that begins a title is a series', guideScore('雨恋と雪', '雨恋と雪の物語') > 0)
eq('...but the same length landing mid-title is not', guideScore('雪の物語', '雨恋と雪の物語'), 0)
// Two characters is a prefix of a great many titles and none of them are the game, so
// below the floor nothing but an outright match counts — for both callers, not just the
// index search: 2DFan's ranking runs through the same scorer.
eq('below the floor even a prefix scores nothing', guideScore('雨恋', '雨恋と雪の物語'), 0)
eq('an unrelated title scores nothing', guideScore('サンプルゲーム', '测试游戏'), 0)

// The one failure this was measured to have: a short query inside an unrelated word.
eq('a fragment inside a longer word scores nothing', guideScore('air', 'とあるペアリング物語'), 0)
eq('...even when it is a real word there', guideScore('air', 'pairing'), 0)
check('but a title that really starts with it is offered', guideScore('air', 'airy fairy') > 0)
eq('...however common the fragment', guideScore('恋', '恋するなにかの物語です'), 0)
check('a real short title still matches itself', guideScore('雨恋', '雨恋') === 1)

/* -------------------------------------------------------------------------- */
console.log('\n== reading the index ==')

eq('every walkthrough is kept', entries.length, 5)
check('an absolute link is not a walkthrough', !entries.some((e) => e.href.startsWith('http')))
check('nor is an anchor', !entries.some((e) => e.href.startsWith('#')))
check('nor is an address', !entries.some((e) => e.href.startsWith('mailto')))
check('nor is a climb out of the folder', !entries.some((e) => e.href.includes('..')))
check('markup inside a title is stripped', entries.some((e) => e.title === '示例ゲーム2'))
eq('a repeated entry is listed once', entries.filter((e) => e.href === 'brandone/sample.html').length, 1)

eq('an entry becomes an address', saigaUrl('brandone/sample.html'), 'https://seiya-saiga.com/game/brandone/sample.html')
eq('an absolute href is not theirs to serve', saigaUrl('https://example.invalid/x.html'), null)
eq('a rooted path is refused', saigaUrl('/etc/passwd'), null)
eq('a climb is refused', saigaUrl('../../x.html'), null)
eq('nothing is refused', saigaUrl(''), null)

/* -------------------------------------------------------------------------- */
console.log('\n== searching it ==')

const exact = searchIndex(entries, 'サンプルゲーム')
check('the game is found', exact.length > 0)
eq('...and it is first, not its fan disc', exact[0]?.title, 'サンプルゲーム ～序章～')
check('the fan disc is still offered', exact.some((h) => h.title.includes('ファンディスク')))
check('every hit carries an address', exact.every((h) => h.url.startsWith('https://seiya-saiga.com/game/')))
check('every hit says where it came from', exact.every((h) => h.provider === 'saiga'))

eq('a folder name matches through its version marker', searchIndex(entries, 'サンプルゲーム Ver1.02')[0]?.title, 'サンプルゲーム ～序章～')
eq('...and through a bracketed edition', searchIndex(entries, 'テストタイトル')[0]?.title, 'テストタイトル（Steam版）')
eq('...and through fullwidth digits', searchIndex(entries, '示例ゲーム２')[0]?.title, '示例ゲーム2')

// A folder that was never looked up has nothing either site can match, and saying so is
// the honest answer.
deepEq('a folder name that is a number finds nothing', searchIndex(entries, '032601'), [])
deepEq('an unrelated name finds nothing', searchIndex(entries, 'まったく別の作品'), [])
deepEq('nothing finds nothing', searchIndex(entries, ''), [])

// Below the loose floor only an outright match counts.
eq('a two-character fragment is not a search', searchIndex(entries, '恋').length, 0)
eq('...but a two-character title is', searchIndex(entries, '雨恋')[0]?.title, '雨恋')

// The case the first real search exposed: a short series name, which is the start of
// every title in its series and covers very little of any of them.
const series = searchIndex(entries, 'サンプル')
check('a short series name finds its titles', series.length >= 2, JSON.stringify(series.map((h) => h.title)))

check('the list is capped', searchIndex(entries, 'サンプルゲーム', 1).length <= 1)

/* -------------------------------------------------------------------------- */
console.log('\n== what 2DFan hands back ==')

const fragment =
  '<a href="/subjects/111"><img src="x.jpg"></a>' +
  '<a href="/subjects/111">サンプルゲーム</a>' +
  '<a href="/subjects/222">サンプルゲーム ファンディスク</a>' +
  '<a href="/subjects/333">まったく別の作品</a>'

const good = read2dfan({ subjects: fragment })
check('a well-formed answer is read', good.ok)
eq('each result is listed once', good.ok && good.hits.length, 3)
eq('a result carries an address', good.ok && good.hits[0].url, 'https://2dfan.com/subjects/111')
check('every hit says where it came from', good.ok && good.hits.every((h) => h.provider === '2dfan'))

eq('an empty result set is a real answer', read2dfan({ subjects: '' }).ok, true)
eq('...and holds nothing', read2dfan({ subjects: '' }).ok && read2dfan({ subjects: '' }).hits.length, 0)

// A shape that cannot be read must never look like "this game has no walkthrough".
eq('markup that changed shape is a failure', read2dfan({ subjects: 42 }).ok, false)
eq('a missing envelope is a failure', read2dfan({}).ok, false)
eq('an error body is a failure', read2dfan({ error: 'nope' }).ok, false)
eq('a page instead of JSON is a failure', read2dfan('<html>sign in</html>').ok, false)
eq('null is a failure', read2dfan(null).ok, false)

check('the search address carries the query', dfanSearchUrl('サンプルゲーム').includes(encodeURIComponent('サンプルゲーム')))

/* -------------------------------------------------------------------------- */
console.log('\n== ranking their keyword search ==')

const rows = good.ok ? good.hits : ([] as GuideHit[])
const ranked = rankDfan(rows, 'サンプルゲーム')
eq('rows that could be the game are kept', ranked.ranked.length, 2)
eq('...the game first, its fan disc after', ranked.ranked[0].title, 'サンプルゲーム')
eq('...and it is not called loose', ranked.loose, false)
check('the unrelated row is dropped', !ranked.ranked.some((h) => h.title === 'まったく別の作品'))

// Their search answers with everything the keyword touched. When none of it looks like
// the game, what came back is still shown -- but as their search, not as an answer.
const nothing = rankDfan(rows, '完全に無関係な作品名')
eq('nothing matching is marked loose', nothing.loose, true)
check('...and their rows are still offered', nothing.ranked.length > 0)
deepEq('no rows at all stays empty', rankDfan([], 'サンプルゲーム').ranked, [])

/* -------------------------------------------------------------------------- */
console.log('\n== which name to search with ==')

const folder = '032601'
eq(
  'the Japanese original wins',
  guideQuery({ name: '多娜多娜', dir: 'C:/x/032601', work: { altTitle: 'サンプルゲーム' } } as never, folder),
  'サンプルゲーム'
)
eq(
  'a name a person gave it comes next',
  guideQuery({ name: '多娜多娜', dir: 'C:/x/032601', work: undefined } as never, folder),
  '多娜多娜'
)
eq(
  'a name equal to the folder is not a name somebody gave it',
  guideQuery({ name: folder, dir: 'C:/x/032601', work: undefined } as never, folder),
  folder
)
eq(
  'an empty original does not win',
  guideQuery({ name: '多娜多娜', dir: 'C:/x/032601', work: { altTitle: '  ' } } as never, folder),
  '多娜多娜'
)

/* -------------------------------------------------------------------------- */
console.log('\n== against the repository itself ==')

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'src', 'main', 'guide-rules.ts'), 'utf-8')
check('the module reaches no electron', !/from ['"]electron/.test(source))
const specifiers = [...source.matchAll(/from ['"](\.[^'"]*)['"]/g)].map((m) => m[1])
check(`every relative import names its extension (${specifiers.length})`, specifiers.every((s) => s.endsWith('.ts')))

// tag-rules.ts owns title matching for the catalogue. This module deliberately has its
// own normaliser, and the two must not answer to one name.
const clash = Object.keys(guideRules).filter((k) => k in tagRules)
deepEq('no export name collides with tag-rules', clash, [])

const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf-8')) as {
  scripts: Record<string, string>
}
check('the harness is registered in package.json', pkg.scripts['guide-test'] === 'node scripts/guide-test.mts')
check('the cap is a small number', MAX_HITS > 0 && MAX_HITS <= 10)

/* -------------------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) process.exit(1)
