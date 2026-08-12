/**
 * VNDB tag names, in Chinese.
 *
 * VNDB is an English-language database; its tags read `High School` and `Netorare` no
 * matter what language you ask in. DLsite localises its own genres and needs nothing from
 * this file — this exists only because half the tags a Chinese-reading user sees would
 * otherwise be in a language they did not choose.
 *
 * Three rules hold this table together:
 *
 * **It is a lookup, not a conversion.** The English name stays in the record as the tag's
 * identity; this is consulted when drawing. So a line added here fixes every game already
 * tagged, with no catalogue round trip and no data migration.
 *
 * **A missing entry shows the English.** Nothing is guessed and nothing is machine
 * translated — a wrong Chinese name on a tag is worse than a right English one, because
 * the English is at least checkable against VNDB.
 *
 * **Only the common ones.** VNDB has thousands of tags and a long tail nobody meets.
 * These are the ones that survive the rating and category filters in `tag-rules.ts` on a
 * library like this; the rest fall through to English, which is the correct outcome
 * rather than a gap to be filled by guesswork.
 */

const TABLE: Record<string, string> = {
  /* ---- setting ---- */
  'high school': '校园',
  'school life': '校园生活',
  'university': '大学',
  'modern day': '现代',
  'contemporary fantasy': '现代奇幻',
  'urban fantasy': '都市奇幻',
  'fantasy': '奇幻',
  'science fiction': '科幻',
  'post apocalyptic earth': '末世',
  'alternate history': '架空历史',
  'japan': '日本',
  'countryside': '乡村',
  'urban': '都市',
  'shinto shrine': '神社',
  'summer': '夏天',
  'winter': '冬天',
  'club activities': '社团活动',
  'festival': '祭典',
  'hot springs': '温泉',
  'school festival': '学园祭',
  'dormitory': '宿舍',
  'island': '孤岛',
  'another world': '异世界',
  'isekai': '异世界转移',
  'virtual reality': '虚拟现实',

  /* ---- story ---- */
  'romance': '恋爱',
  'drama': '剧情向',
  'comedy': '喜剧',
  'slice of life': '日常',
  'slice of life comedy': '日常喜剧',
  'tear-jerker': '催泪',
  'nakige': '泣系',
  'utsuge': '鬱系',
  'happy ending': '欢乐结局',
  'bad ending': '悲惨结局',
  'multiple endings': '多结局',
  'unavoidable heroine death': '女主必死',
  'death of a heroine': '女主死亡',
  'mystery': '悬疑',
  'horror': '恐怖',
  'psychological': '心理',
  'thriller': '惊悚',
  'battle': '战斗',
  'war': '战争',
  'time travel': '时间旅行',
  'time loop': '时间循环',
  'amnesia': '失忆',
  'revenge': '复仇',
  'coming of age': '成长',
  'friendship': '友情',
  'family': '家庭',
  'love overcomes all': '爱能战胜一切',
  'love triangle': '三角关系',
  'netorare': 'NTR',
  'netorase': '寝取らせ',
  'netori': '寝取り',
  'cheating': '出轨',
  'harem ending': '后宫结局',
  'polygamy ending': '一夫多妻结局',
  'sexual content': '性描写',
  'descriptions of violence': '暴力描写',
  'rape': '强暴',
  'incest': '近亲',
  'cousin incest': '表亲近亲',
  'sibling incest': '兄妹近亲',

  /* ---- protagonist ---- */
  'male protagonist': '男主角',
  'female protagonist': '女主角',
  'adult protagonist': '成年主角',
  'student protagonist': '学生主角',
  'high school student protagonist': '高中生主角',
  'fighting protagonist': '战斗系主角',
  'donkan protagonist': '迟钝主角',
  'kind protagonist': '善良主角',
  'protagonist with a face': '有脸主角',
  'unvoiced protagonist': '主角无配音',
  'protagonist with a name': '有名字的主角',

  /* ---- heroines ---- */
  'childhood friend heroine': '幼驯染',
  'childhood friend': '幼驯染',
  'imouto-type heroine': '妹系女主',
  'oneesan-type heroine': '姐系女主',
  'loli heroine': '萝莉女主',
  'kuudere heroine': '冷娇女主',
  'tsundere heroine': '傲娇女主',
  'yandere heroine': '病娇女主',
  'genki heroine': '元气女主',
  'ojousama heroine': '大小姐女主',
  'miko heroine': '巫女女主',
  'kunoichi heroine': '女忍者',
  'maid heroine': '女仆女主',
  'waitress heroine': '女招待女主',
  'nurse heroine': '护士女主',
  'teacher heroine': '教师女主',
  'idol heroine': '偶像女主',
  'kemonomimi heroine': '兽耳女主',
  'catgirl heroine': '猫娘',
  'fighting heroine': '战斗系女主',
  'knight heroine': '女骑士',
  'sentient weapon heroine': '有意识的武器',
  'heroine with zettai ryouiki': '绝对领域',
  'only virgin heroines': '女主全处',
  'non-virgin heroine': '非处女主',
  'twin heroines': '双胞胎女主',
  'shy heroine': '害羞女主',

  /* ---- side cast ---- */
  'friend support character': '友人角色',
  'foolish friend': '损友',
  'father support character': '父亲角色',
  'grandfather support character': '祖父角色',
  'mother support character': '母亲角色',
  'sister support character': '姐妹角色',

  /* ---- ero ---- */
  'sex with protagonist only': '仅与主角发生关系',
  'defloration': '破处',
  'vaginal masturbation': '自慰',
  'single blowjob': '口交',
  'group sex': '群交',
  'threesome': '3P',
  'outdoor sex': '野外',
  'bathroom sex': '浴室',
  'creampie': '中出',
  'pregnancy': '怀孕',
  'lactation': '泌乳',
  'bondage': '束缚',
  'tentacle rape': '触手',
  'big breasts': '巨乳',
  'small breasts': '贫乳',
  'anal': '肛交',
  'footjob': '足交',
  'paizuri': '乳交',
  'handjob': '手交',
  'cunnilingus': '口爱',
  'sixty-nine': '69',
  'cosplay sex': 'COS play',
  'first person perspective sex': '第一人称视角',

  /* ---- form ---- */
  'curse': '诅咒',
  'magic': '魔法',
  'sword combat': '剑戟战斗',
  'knife/dagger combat': '短刃战斗',
  'gun combat': '枪战',
  'martial arts': '武术',
  'superpowers': '超能力',
  'esp': '精神感应',
  'vampires': '吸血鬼',
  'ghosts': '幽灵',
  'youkai': '妖怪',
  'gods': '神明',
  'demons': '恶魔',
  'angels': '天使',
  'robots': '机器人',
  'animal companion': '动物伙伴',
  'cooking': '料理',
  'music': '音乐',
  'sports': '运动',
  'idols': '偶像'
}

/**
 * The Chinese reading of a VNDB tag, or the tag itself.
 *
 * Matched case-insensitively because VNDB's own capitalisation is not perfectly
 * consistent and a tag missing its translation over a capital letter would be a silly
 * way to lose one.
 */
export function vndbTagZh(name: string): string {
  return TABLE[name.trim().toLowerCase()] ?? name
}

/*
 * Which tags are explicit.
 *
 * A fallback, not the primary test. VNDB states the category outright and DLsite's genre
 * objects carry a locale-independent `name_base`, so both are classified when they
 * arrive; these lists exist for tags stored before the flag did, which would otherwise
 * stay on screen after the switch was turned off — a toggle that only works on tags
 * fetched since it shipped is not a toggle anyone can rely on.
 */

/**
 * English markers, matched at a word boundary.
 *
 * The boundary is not fussiness. Matched as a bare substring, `ero` is inside `Heroine` —
 * so `Waitress Heroine` came back explicit, which is both wrong and funny in a way that
 * would stop anybody trusting the switch again.
 */
const ADULT_WORDS = [
  'sex',
  'sexual',
  'ero',
  'erotic',
  'eroge',
  'ecchi',
  'nude',
  'nudity',
  'naked',
  'nipple',
  'nipples',
  'breast',
  'breasts',
  'boob',
  'boobs',
  'blowjob',
  'handjob',
  'footjob',
  'paizuri',
  'cunnilingus',
  'anal',
  'creampie',
  'defloration',
  'masturbation',
  'orgasm',
  'orgy',
  'bukkake',
  'bondage',
  'rape',
  'netorare',
  'netori',
  'netorase',
  'incest',
  'lactation',
  'pregnancy',
  'virgin',
  'virgins',
  'prostitution',
  'tentacle',
  'tentacles',
  'bestiality',
  'futanari',
  'threesome',
  'moans',
  'moaning',
  'copulation',
  'genitals',
  'undressing',
  'striptease',
  'fetish'
]

/** Phrases, where a single word would be too blunt to match on. */
const ADULT_PHRASES = ['harem end', 'sixty-nine', 'sex with', 'sounds of']

const ADULT_WORD_RE = new RegExp(`\\b(${ADULT_WORDS.join('|')})\\b`, 'i')

/**
 * DLsite markers, matched against the Japanese `name_base`.
 *
 * Substrings rather than words, because Japanese has no word boundaries to anchor to and
 * these catalogues compound freely — `中出し・孕ませ`, `巨乳/爆乳`.
 */
const ADULT_SUBSTRINGS = [
  '淫語',
  'おっぱい',
  '巨乳',
  '爆乳',
  '貧乳',
  '中出し',
  'フェラ',
  'パイズリ',
  'アナル',
  '手コキ',
  '足コキ',
  '乱交',
  '複数プレイ',
  '逆レイプ',
  'レイプ',
  '陵辱',
  '調教',
  '寝取',
  '近親',
  'ぶっかけ',
  'オナニー',
  '処女',
  '母乳',
  '妊娠',
  '拘束',
  '触手',
  '獣姦',
  '露出',
  '痴漢',
  '性行為',
  'セックス',
  '女装',
  'ふたなり',
  'ハーレム'
]

/** Whether a tag name reads as explicit. Used when a stored tag predates the flag. */
export function looksAdult(name: string): boolean {
  const text = name.trim()
  if (!text) return false
  const lowered = text.toLowerCase()
  if (ADULT_WORD_RE.test(lowered)) return true
  if (ADULT_PHRASES.some((phrase) => lowered.includes(phrase))) return true
  return ADULT_SUBSTRINGS.some((marker) => text.includes(marker))
}

/** How much of the table is filled in. Used by the test to guard against a truncated file. */
export const VNDB_TAG_COUNT = Object.keys(TABLE).length
