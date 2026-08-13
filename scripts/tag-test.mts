import {
  dlsiteIntro,
  dlsiteWork,
  isChineseText,
  pickBangumiSummary,
  pickDlsiteGenres,
  pickVndbTags,
  queryLadder,
  searchableTitle,
  tidySummary,
  titleKey,
  titleScore,
  vndbWorks,
  workNoIn,
  yearTag,
  MAX_SUMMARY_CHARS,
  VNDB_MIN_RATING,
  type VndbTag
} from '../src/main/tag-rules.ts'
import { parseBangumi } from '../src/main/tag-bangumi.ts'
import {
  isAdultTag,
  tagFacetOf,
  tagLabel,
  toggleTagFilter,
  visibleTags,
  type AutoTag,
  type Game
} from '../src/shared/types.ts'
import { looksAdult, vndbTagZh, VNDB_TAG_COUNT } from '../src/shared/vndb-tags.ts'
import { makeT } from '../src/shared/i18n.ts'

/**
 * The genre tags, judged on what they must refuse to say.
 *
 * A library is a place people trust at a glance. A wrong tag on a game is worse than a
 * blank one — the blank you go and look up, the wrong one you believe. So much of what
 * follows is negative: the title that matches a fan disc rather than the game, the
 * catalogue genre that describes the audio format, the tag three people voted on.
 *
 * Nothing here reaches a catalogue. The catalogue's *shape* is pinned by fixtures taken
 * from real responses, so a change in how we read them fails here rather than in front
 * of a user.
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
console.log('\n== work numbers: the one thing a folder name states outright ==')

eq('a work number is read', workNoIn('[RJ01234567] 作品'), 'RJ01234567')
eq('without brackets too', workNoIn('RJ123456 作品'), 'RJ123456')
eq('lower case is normalised', workNoIn('rj123456 作品'), 'RJ123456')
eq('VJ numbers too', workNoIn('[VJ012345] 作品'), 'VJ012345')
eq('a lookalike is not a work number', workNoIn('[AB123456] x'), null)
eq('too few digits is not a work number', workNoIn('RJ123 x'), null)
eq('an ordinary title has none', workNoIn('サンプルゲーム'), null)

/* -------------------------------------------------------------------------- */
console.log('\n== cleaning a folder name into something searchable ==')

/*
 * These shapes are all real. The catalogue's search is a substring match, so one word of
 * release furniture left in the query returns *nothing at all* — which reads exactly like
 * "the catalogue has never heard of this game", and is why half a library looked
 * unmatchable when it was in fact indexed all along.
 */
const first = (name: string): string => queryLadder(name)[0]

eq('brackets and version come off', first('[190101][サークル名] 测试＊游戏 Ver1.02'), '测试＊游戏')
eq('a clean name is left alone', first('PlainTitle'), 'PlainTitle')
eq('the title itself is never truncated', first('サンプルゲーム'), 'サンプルゲーム')

// Release furniture *outside* brackets — the case the first version missed entirely.
eq('trailing release words come off', first('测试游戏 官方中文版'), '测试游戏')
eq('汉化版 comes off', first('某游戏 汉化版'), '某游戏')
eq('无修正 comes off', first('某游戏 无修正'), '某游戏')

// Versions glued straight onto the title, with the title's own digits kept.
eq('a glued v-version comes off but the title keeps its number', first('样例游戏2v1.1.0'), '样例游戏2')
eq('a trailing dotted version comes off', first('另一个游戏7.6.9'), '另一个游戏')
eq('a title that is mostly digits survives', first('A.B.C.5'), 'A.B.C.5')

// Underscores, language suffixes, archive tails.
eq('underscores become spaces', first('Sample_Gothic_Room_Ver_0_2_0'), 'Sample Gothic Room')
eq('a language suffix comes off', first('SampleGame_ver_1_0_d_Zh-Hant'), 'SampleGame')
eq('an archive tail comes off', first('示例游戏.7z'), '示例游戏')
eq('a split-volume tail comes off', first('另一个游戏7.6.9.part1.rar'), '另一个游戏')

// The ladder itself: when the careful clean still carries an addendum, a shorter query is
// what recovers it. Asking for less is safe because a loose match is put to the user.
const ladder = queryLadder('某某游戏的日常+ ～完美版 ～ 官方中文版 V1.5')
check('the ladder reaches the bare title', ladder.includes('某某游戏的日常'), ladder.join(' | '))
check('a tidy name costs exactly one rung', queryLadder('PlainTitle').length === 1)

// A title glued to a note with no separator at all.
const glued = queryLadder('某某游戏AI-Extra-Pack对外整合')
check('the leading run is offered when a note is glued on', glued.some((q) => q.startsWith('某某游戏')), glued.join(' | '))

eq('searchableTitle is the first rung', searchableTitle('[190101] 测试＊游戏 Ver1.02'), '测试＊游戏')

/* -------------------------------------------------------------------------- */
console.log('\n== title matching ==')

eq('version markers come off before comparing', titleKey('测试＊游戏 Ver1.02'), titleKey('测试＊游戏'))
check('an exact match scores 1', titleScore('测试＊游戏', '测试＊游戏') === 1)
check('an unrelated title scores 0', titleScore('PlainTitle', '测试＊游戏') === 0)

// The failure this has to survive: a fan disc whose title contains the original's.
const fanDisc = titleScore('测试＊游戏', '测试＊游戏 ファンディスク')
check('a fan disc scores below an exact match', fanDisc < 1 && fanDisc > 0)

// Full-width punctuation, which is where a real miss came from: the folder said
// 测试游戏 and VNDB says 测试＊游戏, and with only the ASCII set stripped those two
// never compared equal — so a game that was indexed all along looked unrecognised.
check('full-width punctuation does not block a match', titleScore('测试游戏', '测试＊游戏') === 1)
check('so does a full-width tilde', titleScore('ある作品', 'ある作品～序章～') > 0)
check('an unrelated title is still unrelated', titleScore('测试游戏', 'サンプルゲーム') === 0)

/* -------------------------------------------------------------------------- */
console.log('\n== VNDB: which tags survive ==')

const vndbTags: VndbTag[] = [
  { name: 'High School', rating: 2.6, spoiler: 0, category: 'cont' },
  { name: 'Sexual Content', rating: 0.66, spoiler: 0, category: 'cont' },
  { name: 'ADV', rating: 2.6, spoiler: 0, category: 'tech' },
  { name: 'Multiple Endings', rating: 2.8, spoiler: 0, category: 'tech' },
  { name: 'Netorare', rating: 2.4, spoiler: 0, category: 'ero' },
  { name: 'Cousin Incest', rating: 2.0, spoiler: 1, category: 'ero' }
]
const kept = pickVndbTags(vndbTags).map((t) => t.name)
check('story tags are kept', kept.includes('High School'))
check('ero tags are kept — this library sorts by them', kept.includes('Netorare'))
// The engine and the interface are things the folder already answers, and answers better.
check('tech tags are dropped', !kept.includes('ADV') && !kept.includes('Multiple Endings'))
check(`tags below ${VNDB_MIN_RATING} are dropped`, !kept.includes('Sexual Content'))
check('a spoiler tag is kept but marked, not silently dropped', kept.includes('Cousin Incest'))
check('story tags come first', kept[0] === 'High School')

// The quota exists so an emphatic ero tag cannot push the story off the end.
const flooded = pickVndbTags([
  { name: 'High School', rating: 2.1, spoiler: 0, category: 'cont' },
  ...Array.from({ length: 20 }, (_, i) => ({
    name: `Ero ${i}`,
    rating: 2.9,
    spoiler: 0,
    category: 'ero'
  }))
]).map((t) => t.name)
check('a story tag survives a flood of higher-rated ero tags', flooded.includes('High School'))
check('and the ero tags are capped', flooded.filter((n) => n.startsWith('Ero ')).length === 4)

const [work] = vndbWorks(
  [
    {
      id: 'v5678',
      title: 'Sample * Game',
      alttitle: 'サンプル＊ゲーム',
      released: '2016-01-01',
      tags: vndbTags
    }
  ],
  'サンプル＊ゲーム'
)
check('the Japanese title matches even though the entry is titled in romaji', work.score === 1)
check(
  'spoiler tags are flagged',
  work.tags.some((t) => t.id.includes('cousin incest') && t.spoiler)
)
check('the release year comes through as a tag', work.tags.some((t) => t.id === 'year:2016'))
check('the year tag is not a genre', work.tags.find((t) => t.id === 'year:2016')?.facet === 'year')

/* -------------------------------------------------------------------------- */
console.log('\n== DLsite: which genres survive ==')

// Taken verbatim from a real zh_CN response, which is where the slash form and the
// Japanese base names both come from.
const dlGenres = [
  { name: 'ASMR', base: 'ASMR' },
  { name: '淫语', base: '淫語' },
  { name: '胸部/奶子', base: 'おっぱい' },
  { name: '双声道立体声/人头麦', base: 'バイノーラル/ダミヘ' },
  { name: '修女', base: 'シスター' },
  { name: '后宫', base: 'ハーレム' },
  { name: '巨乳/爆乳', base: '巨乳/爆乳' }
]
const dlKept = pickDlsiteGenres(dlGenres).map((g) => g.name)
check('content genres survive', dlKept.includes('修女') && dlKept.includes('后宫'))
check('a pure format genre is dropped', !dlKept.includes('ASMR'))
check('a format genre is dropped even when slash-joined', !dlKept.includes('双声道立体声/人头麦'))
check('a content genre with a slash survives', dlKept.includes('巨乳/爆乳'))

const dl = dlsiteWork({
  workno: 'RJ01234567',
  work_name: 'ある作品',
  regist_date: '2022-12-26 00:00:00',
  genres: dlGenres.map((g) => ({ name: g.name, name_base: g.base }))
})
check('a work number match scores 1 and is never put to the user', dl?.score === 1)
check('the release date is trimmed to a day', dl?.released === '2022-12-26')
check('the year becomes a tag', dl?.tags.some((t) => t.id === 'year:2022') ?? false)
check(
  'genres carry their own text, since the catalogue localised them',
  dl?.tags.every((t) => Boolean(t.label)) ?? false
)

/* -------------------------------------------------------------------------- */
console.log('\n== the year tag ==')

check('a bare year is read', yearTag('2016-01-01')?.id === 'year:2016')
check('an empty date yields nothing', yearTag('') === null)
check('an absent date yields nothing', yearTag(undefined) === null)
check('a nonsense year is refused', yearTag('0001-01-01') === null)
check('a far-future year is refused', yearTag('9999-01-01') === null)

/* -------------------------------------------------------------------------- */
console.log('\n== hiding a tag, and getting it back ==')

const game = {
  autoTags: [
    { id: 'genre:ntr', facet: 'genre', label: 'NTR', reasonKey: 'tag.why.vndb' },
    { id: 'year:2016', facet: 'year', label: '2016', reasonKey: 'tag.why.year' }
  ],
  hiddenTags: ['genre:ntr']
} as unknown as Game

check('a hidden tag does not show', !visibleTags(game, true).some((t) => t.id === 'genre:ntr'))
check('the others still do', visibleTags(game, true).some((t) => t.id === 'year:2016'))
// The whole point of hiding at read time: the record still holds it, so this is reversible
// without asking the catalogue the same question all over again.
check(
  'a hidden tag is still in the record',
  (game.autoTags ?? []).some((t) => t.id === 'genre:ntr')
)
check(
  'unhiding brings it straight back',
  visibleTags({ ...game, hiddenTags: [] } as Game, true).some((t) => t.id === 'genre:ntr')
)

const spoilered = {
  autoTags: [
    { id: 'genre:x', facet: 'genre', label: 'X', reasonKey: 'tag.why.vndb', spoiler: true }
  ],
  hiddenTags: []
} as unknown as Game
check('spoiler tags are hidden by default', visibleTags(spoilered, false).length === 0)
check('and shown when asked for', visibleTags(spoilered, true).length === 1)

/* -------------------------------------------------------------------------- */
console.log('\n== the bug that made half a library look unmatchable ==')

/*
 * A Chinese folder name can only match the Chinese title, and that lives in `titles[]` —
 * not in `title` (romaji) or `alttitle` (Japanese). Scoring only those two gave every
 * Chinese name a zero, and a zero used to mean "discard": VNDB would find the game and
 * this code would throw the answer away.
 *
 * The fixture is a real response, trimmed.
 */
const eustia = {
  id: 'v1234',
  title: 'Sample Game',
  alttitle: 'サンプルゲーム',
  released: '2011-01-01',
  titles: [
    { lang: 'en', title: 'Sample Game' },
    { lang: 'ja', title: 'サンプルゲーム', latin: 'Sample Game' },
    { lang: 'zh-Hans', title: '示例游戏', latin: 'Shili Youxi' }
  ],
  tags: vndbTags
}

const [zhHit] = vndbWorks([eustia], '示例游戏')
check('a Chinese folder name scores against the Chinese title', zhHit.score === 1)
check('the Japanese name is carried through for display', zhHit.altTitle === 'サンプルゲーム')
check('so is the Chinese one', zhHit.zhTitle === '示例游戏')
check('a Chinese match is strong enough to adopt', zhHit.score >= 0.92)

check('the Japanese name still scores 1', vndbWorks([eustia], 'サンプルゲーム')[0].score === 1)
check('so does the romaji', vndbWorks([eustia], 'Sample Game')[0].score === 1)

// The other half of the bug: a result the catalogue returned stays a candidate even when
// our own scoring cannot see why. VNDB's search already decided it was relevant.
const unscored = vndbWorks([eustia], 'something else entirely')
check('a zero-scoring result is kept as a candidate, not discarded', unscored.length === 1)
check('and it is honestly scored zero rather than flattered', unscored[0].score === 0)

/* -------------------------------------------------------------------------- */
console.log('\n== Bangumi: names, and only names ==')

// Trimmed from a real search response. The detail endpoints answer 404 for adult titles
// without a login, so tags never come from here — only the pair of names.
const bgm = parseBangumi({
  list: [
    {
      id: 999999,
      name: 'サンプル妖精ゲーム',
      name_cn: '某某游戏AI-Extra-Pack',
      air_date: '2023-01-01'
    },
    { id: 1, name: '' },
    { name: 'no id' }
  ]
})
check('a row becomes a work', bgm.length === 1)
check('the Japanese name is read', bgm[0].name === 'サンプル妖精ゲーム')
check('the Chinese name is read', bgm[0].nameCn === '某某游戏AI-Extra-Pack')
// Bangumi answers a query it dislikes with no list at all rather than an empty one.
check('a response with no list is not a crash', parseBangumi({ results: 0 }).length === 0)
check('nor is nonsense', parseBangumi(null).length === 0)

/* -------------------------------------------------------------------------- */
console.log('\n== VNDB tag names in Chinese ==')

const tzh = makeT('zh')
const vndbTag: AutoTag = {
  id: 'genre:high school',
  facet: 'genre',
  source: 'vndb',
  label: 'High School',
  reasonKey: 'tag.why.vndb'
}
check('the table has been filled in', VNDB_TAG_COUNT > 100, String(VNDB_TAG_COUNT))
eq('a known tag reads in Chinese', tagLabel(vndbTag, tzh, 'zh'), '校园')
eq('and in English under an English UI', tagLabel(vndbTag, tzh, 'en'), 'High School')
eq('NTR is spelled the way people say it', vndbTagZh('Netorare'), 'NTR')
eq('capitalisation does not lose a translation', vndbTagZh('high school'), '校园')
// Nothing is guessed: a tag the table does not carry keeps the catalogue's own wording.
eq('an unknown tag falls back to English', vndbTagZh('Some Obscure Tag'), 'Some Obscure Tag')
eq(
  'and falls back through tagLabel too',
  tagLabel({ ...vndbTag, label: 'Obscure Thing' }, tzh, 'zh'),
  'Obscure Thing'
)
// DLsite localises its own genres, so those must never go through the table.
eq(
  'a DLsite genre is left exactly as the catalogue wrote it',
  tagLabel({ ...vndbTag, source: 'dlsite', label: '修女' }, tzh, 'zh'),
  '修女'
)

/* -------------------------------------------------------------------------- */
console.log('\n== the R18 switch ==')

// VNDB states the category, which beats reading the name.
const eroTag = pickVndbTags(vndbTags).find((t) => t.name === 'Netorare')
check('VNDB ero tags are classified from the category', eroTag !== undefined)
const [scored] = vndbWorks([eustia], '示例游戏')
const ntr = scored.tags.find((t) => t.label === 'Netorare')
check('and the flag lands on the tag', ntr?.adult === true)
const school = scored.tags.find((t) => t.label === 'High School')
check('a story tag is not marked adult', school?.adult === false)

// DLsite rates the work rather than the genre, so the base name is what gets read — and
// the base name is Japanese whatever language the catalogue was asked in.
const dl18 = dlsiteWork({
  workno: 'RJ1',
  work_name: 'x',
  genres: [
    { name: '淫语', name_base: '淫語' },
    { name: '修女', name_base: 'シスター' },
    { name: '胸部/奶子', name_base: 'おっぱい' }
  ]
})
const byName = (n: string): boolean =>
  dl18?.tags.find((t) => t.label === n)?.adult === true
check('an explicit DLsite genre is marked', byName('淫语'))
check('so is one whose display name gives no clue', byName('胸部/奶子'))
check('a non-explicit one is left alone', dl18?.tags.find((t) => t.label === '修女')?.adult === false)

/*
 * The name fallback, against a real VNDB tag set.
 *
 * `Waitress Heroine` is the case that matters: matched as a bare substring, `ero` sits
 * inside `h-ero-ine`, and a switch that calls a waitress explicit is one nobody will
 * trust with anything. Latin markers are matched at a word boundary for that reason;
 * Japanese ones cannot be, so they stay substrings.
 */
for (const explicit of [
  'Only Virgin Heroines',
  'Heroine with Big Breasts',
  'Background Moans',
  'Sounds of Copulation',
  'Sex with Protagonist Only',
  'Single Blowjob'
]) {
  check(`caught: ${explicit}`, looksAdult(explicit))
}
for (const innocent of [
  'Waitress Heroine',
  'Miko Heroine',
  'Superhero',
  'Analysis',
  'High School',
  'Tear-jerker',
  'Urban Fantasy',
  'Male Protagonist',
  '修女',
  '后宫'
]) {
  check(`left alone: ${innocent}`, !looksAdult(innocent))
}

// The switch has to work on tags stored before the flag existed, or it is not a switch
// anybody can rely on.
const legacy: AutoTag = { id: 'genre:netorare', facet: 'genre', label: 'Netorare', reasonKey: 'tag.why.vndb' }
check('a tag with no flag falls back to its name', isAdultTag(legacy))
const legacyClean: AutoTag = { id: 'genre:drama', facet: 'genre', label: 'Drama', reasonKey: 'tag.why.vndb' }
check('and an innocent one stays visible', !isAdultTag(legacyClean))
// An explicit flag always wins over the name.
check('the stored flag overrides the name', !isAdultTag({ ...legacy, adult: false }))

const mixed = {
  autoTags: [
    { id: 'genre:high school', facet: 'genre', label: 'High School', reasonKey: 'tag.why.vndb', adult: false },
    { id: 'genre:netorare', facet: 'genre', label: 'Netorare', reasonKey: 'tag.why.vndb', adult: true }
  ],
  hiddenTags: []
} as unknown as Game
check('adult tags are withheld by default', visibleTags(mixed, true, false).length === 1)
check('and the story tag is the one that stays', visibleTags(mixed, true, false)[0].label === 'High School')
check('turning the switch on brings them back', visibleTags(mixed, true, true).length === 2)
// Nothing is deleted, so flipping the switch costs no catalogue traffic.
check('the record keeps both either way', (mixed.autoTags ?? []).length === 2)

console.log('\n== picking chips in the tag bar ==')

/*
 * Two years at once is the one combination that can only ever show nothing: a game has
 * exactly one release year, so "narrow with each chip" — right for genres — turns into an
 * empty screen. Picking a second year replaces the first instead.
 */
check('facets are read off the id', tagFacetOf('year:2016') === 'year')
check('and genres likewise', tagFacetOf('genre:high school') === 'genre')
check('an id with no prefix has no facet', tagFacetOf('2016') === null)
check('nor does an unknown one', tagFacetOf('engine:kirikiri') === null)

check(
  'genres stack, because a game really is both',
  JSON.stringify(toggleTagFilter(['genre:high school'], 'genre:tear-jerker')) ===
    JSON.stringify(['genre:high school', 'genre:tear-jerker'])
)
check(
  'a second year replaces the first',
  JSON.stringify(toggleTagFilter(['year:2016'], 'year:2017')) === JSON.stringify(['year:2017'])
)
check(
  'and leaves the genres alone while doing it',
  JSON.stringify(toggleTagFilter(['genre:high school', 'year:2016'], 'year:2017')) ===
    JSON.stringify(['genre:high school', 'year:2017'])
)
check(
  'clicking the same year again clears it',
  toggleTagFilter(['genre:high school', 'year:2017'], 'year:2017').length === 1
)
check(
  'a year can still be the first thing picked',
  JSON.stringify(toggleTagFilter([], 'year:2017')) === JSON.stringify(['year:2017'])
)

console.log('\n== the blurb ==')

/*
 * A description is the one piece of catalogue text that cannot be half right. A genre
 * that lands on the wrong game is a word somebody can argue with; a paragraph that lands
 * on the wrong game is fluent, confident, and reads exactly like the truth. So the tests
 * here are about refusing: the wrong language, the near-miss title, the fan disc.
 */

const ZH_BLURB =
  '这是一部以校园为舞台的恋爱冒险游戏。主角在春天转学到一所海边的高中，' +
  '遇见了三位性格迥异的少女。随着季节推移，藏在小镇里的往事被一点点揭开。' +
  '原名为《サンプルゲーム》，由示例社发行。'
const JA_BLURB =
  'ある春の日、海辺の高校に転校してきた主人公は、three人の少女と出会う。' +
  '季節が移ろうにつれて、小さな町に隠されていた出来事が少しずつ明らかになっていく。'

check('a Chinese blurb reads as Chinese', isChineseText(ZH_BLURB))
check('a Japanese one does not', !isChineseText(JA_BLURB))
check(
  'a Chinese blurb quoting a Japanese title is still Chinese',
  isChineseText('本作原名《サンプルゲーム》，讲的是一个海边小镇的夏天。')
)
check('English is not Chinese either', !isChineseText('A love story set in a seaside town.'))
check('nor is a row of symbols', !isChineseText('★★★ 2016/07/29 ★★★'))
check('nor is nothing at all', !isChineseText(''))
check('nor is a Japanese title on its own', !isChineseText('サンプルゲーム'))

eq(
  'store copy loses its line-ending noise',
  tidySummary('第一行。\r\n第二行。\r\n\r\n\r\n第三行。'),
  '第一行。\n第二行。\n\n第三行。'
)
eq('and its stray markup', tidySummary('<br>一段介绍。<b>重点</b>'), '一段介绍。 重点')
eq('and the spacing somebody used for layout', tidySummary('  一段　　介绍。  '), '一段 介绍。')

const LONG = '这是一段很长的介绍。'.repeat(400)
const capped = tidySummary(LONG)
check('a store page is cut down to a paragraph', capped.length <= MAX_SUMMARY_CHARS + 1)
check('and the cut is marked, not silent', capped.endsWith('…'))
check('a blurb that already fits is untouched', tidySummary(ZH_BLURB) === ZH_BLURB)

/*
 * DLsite answers in the work's own language whatever locale it was asked in, so most of
 * these are Japanese and the interesting case is that they are refused rather than shown.
 */
/*
 * The blurb comes back with the one thing the caller has to know — which language it is
 * in — rather than being dropped here. Refusing Japanese in this module meant it was gone
 * before anything could translate it, and a library where most descriptions were blank.
 */
eq('a Chinese DLsite blurb is Chinese', dlsiteIntro({ intro_s: ZH_BLURB })?.chinese, true)
eq('and comes back whole', dlsiteIntro({ intro_s: ZH_BLURB })?.text, ZH_BLURB)
eq('a Japanese one comes back too', dlsiteIntro({ intro_s: JA_BLURB })?.text, JA_BLURB)
eq('but says it is not Chinese', dlsiteIntro({ intro_s: JA_BLURB })?.chinese, false)
eq('a missing one is nothing at all', dlsiteIntro({}), undefined)
eq(
  'the long store-page intro is never read',
  dlsiteIntro({ intro_s: '', intro: ZH_BLURB } as Parameters<typeof dlsiteIntro>[0] & {
    intro: string
  }),
  undefined
)

const withIntro = dlsiteWork({
  workno: 'RJ01234567',
  work_name: '示例游戏',
  regist_date: '2016-07-29',
  intro_s: ZH_BLURB,
  genres: [{ name: '校园', name_base: '学園' }]
})
eq('a work number carries its own blurb through', withIntro?.blurb?.text, ZH_BLURB)

const BGM_ROWS = [
  { name: 'サンプルゲーム', nameCn: '示例游戏', summary: ZH_BLURB },
  { name: 'サンプルゲーム ファンディスク', nameCn: '示例游戏 FD', summary: '另一段介绍。' }
]

eq(
  'the row that is the work gives up its blurb',
  pickBangumiSummary(BGM_ROWS, ['サンプルゲーム'])?.text,
  ZH_BLURB
)
eq(
  'matching on the Chinese name works too',
  pickBangumiSummary(BGM_ROWS, ['示例游戏'])?.text,
  ZH_BLURB
)
eq('a fan disc is not the game', pickBangumiSummary([BGM_ROWS[1]], ['サンプルゲーム']), undefined)
eq(
  'a Japanese blurb on the right row is still that row',
  pickBangumiSummary([{ name: 'サンプルゲーム', summary: JA_BLURB }], ['サンプルゲーム'])?.chinese,
  false
)
/* The failure this guards against: taking the *next* row's text once the matching row
   turns out to be in the wrong language, which is describing somebody else's game.
   Translating this one is the caller's business; borrowing another game's is nobody's. */
eq(
  'and it does not fall through to the row below',
  pickBangumiSummary(
    [
      { name: 'サンプルゲーム', summary: JA_BLURB },
      { name: '别的游戏', summary: '另一段介绍。' }
    ],
    ['サンプルゲーム']
  )?.text,
  JA_BLURB
)
eq('nothing to match against, nothing taken', pickBangumiSummary(BGM_ROWS, [undefined, '']), undefined)
eq('nothing came back, nothing taken', pickBangumiSummary([], ['サンプルゲーム']), undefined)

/*
 * Bangumi's search rows are where the Chinese text comes from — the summary is the field
 * `responseGroup=medium` exists for, and the reason this request asks for more than names.
 */
const bgmParsed = parseBangumi({
  list: [{ id: 12345, name: 'サンプルゲーム', name_cn: '示例游戏', summary: ZH_BLURB }]
})
eq('a search row carries its summary', bgmParsed[0]?.summary, ZH_BLURB)
eq(
  'a row without one says so rather than carrying an empty string',
  parseBangumi({ list: [{ id: 12345, name: 'サンプルゲーム', summary: '   ' }] })[0]?.summary,
  undefined
)

/* -------------------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
