import { useState } from 'react'
import { formatBytes, formatPercent } from '../lib/format'

export interface Slice {
  name: string
  value: number
  color: string
  /** Present when the slice can be drilled into. */
  path?: string
  isDir?: boolean
}

interface Props {
  slices: Slice[]
  centerValue: string
  centerLabel: string
  onSliceClick?: (slice: Slice) => void
  onChartClick?: () => void
}

const SIZE = 240
const R_OUTER = 108
const R_INNER = 66
const GAP_DEG = 1.6

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]
}

function arcPath(startDeg: number, endDeg: number): string {
  const c = SIZE / 2
  const large = endDeg - startDeg > 180 ? 1 : 0
  const [x1, y1] = polar(c, c, R_OUTER, startDeg)
  const [x2, y2] = polar(c, c, R_OUTER, endDeg)
  const [x3, y3] = polar(c, c, R_INNER, endDeg)
  const [x4, y4] = polar(c, c, R_INNER, startDeg)
  return [
    `M ${x1} ${y1}`,
    `A ${R_OUTER} ${R_OUTER} 0 ${large} 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${R_INNER} ${R_INNER} 0 ${large} 0 ${x4} ${y4}`,
    'Z'
  ].join(' ')
}

/**
 * Donut for part-to-whole size reads. Slice count is capped by the caller — past six
 * slices the ordinal ramp can no longer keep adjacent steps distinguishable, so the
 * remainder is folded into "其他" and the full list lives in the legend below.
 */
export default function SizeDonut({
  slices,
  centerValue,
  centerLabel,
  onSliceClick,
  onChartClick
}: Props): React.JSX.Element {
  const [hover, setHover] = useState<{ slice: Slice; x: number; y: number } | null>(null)
  const total = slices.reduce((sum, s) => sum + s.value, 0)

  let cursor = 0
  const arcs = slices.map((slice) => {
    const sweep = total > 0 ? (slice.value / total) * 360 : 0
    const start = cursor
    const end = cursor + sweep
    cursor = end
    // Keep a hairline of surface between neighbours so equal-ish slices stay separable.
    const gap = sweep > GAP_DEG * 2 ? GAP_DEG / 2 : 0
    return { slice, start: start + gap, end: end - gap, sweep, mid: (start + end) / 2 }
  })

  return (
    <div className="donut-wrap">
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        onClick={(e) => {
          // Clicks land on the chart body; a slice handler stops propagation itself.
          if (e.currentTarget === e.target || !onSliceClick) onChartClick?.()
        }}
      >
        {arcs.map(({ slice, start, end, sweep, mid }) => {
          if (sweep <= 0.05) return null
          const [lx, ly] = polar(SIZE / 2, SIZE / 2, (R_OUTER + R_INNER) / 2, mid)
          return (
            <g key={slice.name}>
              <path
                d={arcPath(start, end)}
                fill={slice.color}
                style={{ cursor: slice.isDir && onSliceClick ? 'pointer' : 'inherit' }}
                onMouseMove={(e) => setHover({ slice, x: e.clientX, y: e.clientY })}
                onMouseLeave={() => setHover(null)}
                onClick={(e) => {
                  if (slice.isDir && onSliceClick) {
                    e.stopPropagation()
                    onSliceClick(slice)
                  } else {
                    e.stopPropagation()
                    onChartClick?.()
                  }
                }}
              />
              {/* Only label slices with room; small ones would collide into mush. */}
              {sweep >= 26 && (
                <text
                  x={lx}
                  y={ly}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={12}
                  fontWeight={700}
                  fill="#fff"
                  pointerEvents="none"
                >
                  {formatPercent(slice.value, total)}
                </text>
              )}
            </g>
          )
        })}
        <text
          x={SIZE / 2}
          y={SIZE / 2 - 6}
          textAnchor="middle"
          className="donut-center-value"
          pointerEvents="none"
        >
          {centerValue}
        </text>
        <text
          x={SIZE / 2}
          y={SIZE / 2 + 14}
          textAnchor="middle"
          className="donut-center-label"
          pointerEvents="none"
        >
          {centerLabel}
        </text>
      </svg>

      {hover && (
        <div className="tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <div style={{ fontWeight: 600 }}>{hover.slice.name}</div>
          <div style={{ opacity: 0.82 }}>
            {formatBytes(hover.slice.value)} · {formatPercent(hover.slice.value, total)}
          </div>
        </div>
      )}
    </div>
  )
}
