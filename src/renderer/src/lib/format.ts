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

/**
 * Per-name hue offset (-30..+30) for the generated placeholder tiles.
 *
 * Only the offset is computed here; the theme's base hue and lightness are applied in
 * CSS. Building the whole colour in JS would freeze it at whatever theme was active
 * when the tile first rendered, since switching themes only swaps custom properties
 * and does not re-render the tree.
 */
export function placeholderHueOffset(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  return (Math.abs(hash) % 60) - 30
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
