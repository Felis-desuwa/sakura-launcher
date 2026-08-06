export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '计算中…'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`
}

export function formatPercent(part: number, whole: number): string {
  if (whole <= 0) return '0%'
  const pct = (part / whole) * 100
  if (pct > 0 && pct < 0.1) return '<0.1%'
  return `${pct.toFixed(pct >= 10 ? 0 : 1)}%`
}

export function formatDate(ts: number | null): string {
  if (!ts) return '从未启动'
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Deterministic sakura-toned gradient so a game without artwork still looks placed, not broken. */
export function placeholderGradient(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  const hue = 320 + (Math.abs(hash) % 60) - 30 // 290..350, the pink/rose arc
  const hue2 = hue + 18
  return `linear-gradient(150deg, hsl(${hue} 72% 76%) 0%, hsl(${hue2} 64% 62%) 100%)`
}

/** First meaningful character(s) for the placeholder tile. */
export function placeholderInitial(name: string): string {
  const cleaned = name.replace(/^[\[\(【（][^\]\)】）]*[\]\)】）]\s*/, '').trim()
  const source = cleaned || name
  const first = [...source][0] ?? '?'
  // CJK reads better as a single glyph; latin gets two letters.
  if (/[　-鿿가-힯]/.test(first)) return first
  return source.slice(0, 2).toUpperCase()
}
