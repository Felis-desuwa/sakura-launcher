/**
 * The flowers the uninstall ritual asks you to copy out by hand.
 *
 * Typing the game's own name confirmed nothing an accidental click could not also
 * produce — it was sitting right there on screen to be copied. A flower drawn at random
 * has to be read and transcribed, which is the whole point of the step: not to verify
 * *which* game, that was step one, but to make the hand slow down.
 *
 * The name to copy is the English one. The Latin binomial is still shown, because it is
 * what makes the card feel like a page out of a herbarium, but `Chrysanthemum
 * morifolium` is a lot to ask of someone who only wants to delete a game.
 *
 * Each entry also carries how its petals look, because the flower that was drawn is the
 * one that falls while the tile comes apart.
 */

/** A rounded teardrop — cherry, plum, peach. */
const ROUND = '50% 0 50% 50%'
/** Wide and blunt-tipped — camellia, lotus, poppy. */
const BROAD = '50% 50% 42% 42% / 66% 66% 34% 34%'
/** Narrow and curling — spider lily, wisteria, chrysanthemum. */
const SLIM = '60% 40% 55% 45% / 84% 84% 16% 16%'

export interface Flower {
  /** The name the user is asked to write out. */
  en: string
  /** The binomial, shown but never typed. */
  latin: string
  /** Chinese name. */
  name: string
  /** What the flower is taken to mean. */
  meaning: string
  /** Petal fill, tip colour then base colour. */
  petal: [string, string]
  /** The petal's silhouette, as a CSS border-radius. */
  shape: string
  /** Petal size in px, width then height. */
  size: [number, number]
}

export const FLOWERS: Flower[] = [
  { en: 'Japanese Cherry', latin: 'Prunus serrulata', name: '山樱', meaning: '淡泊、生命之短暂', petal: ['#ffe0ea', '#ff9dc0'], shape: ROUND, size: [11, 11] },
  { en: 'Plum Blossom', latin: 'Prunus mume', name: '梅', meaning: '坚韧、凌寒独开', petal: ['#fff2f6', '#ffb0ca'], shape: ROUND, size: [10, 10] },
  { en: 'Peach Blossom', latin: 'Prunus persica', name: '桃', meaning: '爱慕、心之所向', petal: ['#ffd0e0', '#ff87ac'], shape: ROUND, size: [11, 11] },
  { en: 'Japanese Wisteria', latin: 'Wisteria floribunda', name: '多花紫藤', meaning: '沉迷的爱、执念', petal: ['#ddccf5', '#9b7fd4'], shape: SLIM, size: [8, 15] },
  { en: 'Camellia', latin: 'Camellia japonica', name: '山茶', meaning: '理想的爱、谦逊', petal: ['#f8829a', '#c72847'], shape: BROAD, size: [13, 11] },
  { en: 'Chinese Peony', latin: 'Paeonia lactiflora', name: '芍药', meaning: '依依惜别', petal: ['#ffcbdf', '#f4718f'], shape: BROAD, size: [13, 11] },
  { en: 'Yulan Magnolia', latin: 'Magnolia denudata', name: '玉兰', meaning: '报恩、高洁', petal: ['#fffaf0', '#f0dfc6'], shape: BROAD, size: [12, 14] },
  { en: 'Hydrangea', latin: 'Hydrangea macrophylla', name: '绣球', meaning: '希望、善变', petal: ['#d5e3f8', '#7fa9e0'], shape: BROAD, size: [12, 10] },
  { en: 'Red Spider Lily', latin: 'Lycoris radiata', name: '彼岸花', meaning: '分离、无法相见', petal: ['#ff8472', '#d3252c'], shape: SLIM, size: [7, 16] },
  { en: 'Sweet Osmanthus', latin: 'Osmanthus fragrans', name: '桂花', meaning: '收获、永伴', petal: ['#ffeeb8', '#f0b845'], shape: ROUND, size: [8, 8] },
  { en: 'Lotus', latin: 'Nelumbo nucifera', name: '荷花', meaning: '清白、出淤泥不染', petal: ['#ffdce6', '#f593ae'], shape: BROAD, size: [13, 15] },
  { en: 'Chrysanthemum', latin: 'Chrysanthemum morifolium', name: '菊', meaning: '怀念、高洁', petal: ['#fff0b8', '#e9bf49'], shape: SLIM, size: [7, 14] },
  { en: 'Cape Jasmine', latin: 'Gardenia jasminoides', name: '栀子', meaning: '永恒的约定', petal: ['#fdfbf2', '#e6dfc9'], shape: BROAD, size: [12, 12] },
  { en: 'Corn Poppy', latin: 'Papaver rhoeas', name: '虞美人', meaning: '安慰、告别', petal: ['#ff9179', '#e0342f'], shape: BROAD, size: [13, 12] },
  { en: 'Early Lilac', latin: 'Syringa oblata', name: '紫丁香', meaning: '初恋的悸动', petal: ['#e6d4f2', '#a87fce'], shape: ROUND, size: [9, 9] },
  { en: 'Beach Rose', latin: 'Rosa rugosa', name: '玫瑰', meaning: '美丽的爱情', petal: ['#f8a5c0', '#d8446e'], shape: BROAD, size: [12, 11] },
  { en: 'Fringed Iris', latin: 'Iris japonica', name: '蝴蝶花', meaning: '信念、传达', petal: ['#d0daf5', '#8a9bd8'], shape: SLIM, size: [9, 14] },
  { en: 'Arabian Jasmine', latin: 'Jasminum sambac', name: '茉莉', meaning: '清雅、你属于我', petal: ['#fffdf7', '#ece6d6'], shape: ROUND, size: [9, 9] }
]

/** Draw one at random. A different flower each time is what keeps it from being muscle memory. */
export function randomFlower(): Flower {
  return FLOWERS[Math.floor(Math.random() * FLOWERS.length)]
}

/**
 * Whether what was typed counts as the name.
 *
 * Case and stray spacing are not what the step is testing for — being made to type the
 * name at all is. Holding it to the capital J would only turn a deliberate act into a
 * guessing game.
 */
export function matchesFlower(typed: string, name: string): boolean {
  const normalize = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase()
  return normalize(typed) === normalize(name)
}
