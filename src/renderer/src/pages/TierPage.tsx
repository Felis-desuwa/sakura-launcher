import { useMemo, useState } from 'react'
import type { Game, Tier } from '../../../shared/types'
import { TIERS, TIER_META } from '../../../shared/types'
import Artwork from '../components/Artwork'
import ConfirmDialog from '../components/ConfirmDialog'
import { useT } from '../lib/i18n'

type RowKey = Tier | 'unrated'

const ROWS: RowKey[] = [...TIERS, 'unrated']

interface Props {
  games: Game[]
  onPatch: (id: string, patch: Partial<Game>) => void
  onClearAll: () => void
}

/**
 * Tier list. Icons only — no captions — so a row holds many at once; the name shows
 * on hover instead. Launching is disabled here on purpose: this page is for ranking.
 */
export default function TierPage({ games, onPatch, onClearAll }: Props): React.JSX.Element {
  const t = useT()
  const [dragId, setDragId] = useState<string | null>(null)
  const [overRow, setOverRow] = useState<RowKey | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null)
  const hoverTimer = useState<{ id: number | null }>({ id: null })[0]

  const rows = useMemo(() => {
    const map = new Map<RowKey, Game[]>()
    for (const row of ROWS) map.set(row, [])
    for (const game of games) {
      // Not-yet-installed archives have nothing to judge yet, so they stay out of the
      // ranking entirely rather than cluttering the unrated row.
      if (game.kind !== 'installed') continue
      const key: RowKey = game.tier ?? 'unrated'
      map.get(key)?.push(game)
    }
    for (const list of map.values()) list.sort((a, b) => a.tierOrder - b.tierOrder)
    return map
  }, [games])

  const rated = useMemo(
    () => games.filter((g) => g.kind === 'installed' && g.tier !== null).length,
    [games]
  )

  const showTip = (e: React.MouseEvent, name: string): void => {
    const { clientX, clientY } = e
    if (hoverTimer.id) window.clearTimeout(hoverTimer.id)
    hoverTimer.id = window.setTimeout(() => {
      setTip({ text: name, x: clientX, y: clientY })
    }, 300)
  }

  const hideTip = (): void => {
    if (hoverTimer.id) window.clearTimeout(hoverTimer.id)
    hoverTimer.id = null
    setTip(null)
  }

  const dropOn = (row: RowKey, beforeId?: string): void => {
    if (!dragId) return
    const tier: Tier | null = row === 'unrated' ? null : row
    const members = (rows.get(row) ?? []).filter((g) => g.id !== dragId)
    const index = beforeId ? members.findIndex((g) => g.id === beforeId) : members.length
    const at = index < 0 ? members.length : index
    const ordered = [...members.slice(0, at), { id: dragId } as Game, ...members.slice(at)]

    ordered.forEach((g, i) => {
      if (g.id === dragId) onPatch(dragId, { tier, tierOrder: i })
      else onPatch(g.id, { tierOrder: i })
    })
    setDragId(null)
    setOverRow(null)
  }

  return (
    <div className="page" onDragEnd={() => setOverRow(null)}>
      <div className="tier-head">
        <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: 0 }}>
          {t('tier.lede')}
        </p>
        <button
          type="button"
          className="btn ghost small"
          disabled={rated === 0}
          onClick={() => setConfirmClear(true)}
        >
          {t('tier.clearAll')}
        </button>
      </div>

      {ROWS.map((row) => {
        const meta = TIER_META[row]
        const members = rows.get(row) ?? []
        return (
          <div
            key={row}
            className={`tier-row${overRow === row ? ' over' : ''}`}
            style={{ background: `${meta.color}1f` }}
            onDragOver={(e) => {
              e.preventDefault()
              setOverRow(row)
            }}
            onDragLeave={() => setOverRow((cur) => (cur === row ? null : cur))}
            onDrop={(e) => {
              e.preventDefault()
              dropOn(row)
            }}
          >
            <div className="tier-label" style={{ background: meta.color }}>
              <span>{meta.label}</span>
              <span className="tier-count">{members.length}</span>
            </div>
            <div className="tier-items">
              {members.map((game) => (
                <button
                  type="button"
                  key={game.id}
                  className={`tier-icon${dragId === game.id ? ' dragging' : ''}`}
                  draggable
                  onDragStart={() => setDragId(game.id)}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    dropOn(row, game.id)
                  }}
                  onMouseEnter={(e) => showTip(e, game.name)}
                  onMouseMove={(e) => tip && setTip({ text: game.name, x: e.clientX, y: e.clientY })}
                  onMouseLeave={hideTip}
                  /* No onDoubleClick and no keyboard activation: ranking view never launches. */
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') e.preventDefault()
                  }}
                >
                  <Artwork game={game} />
                </button>
              ))}
              {members.length === 0 && (
                <span style={{ fontSize: 12, color: 'var(--ink-soft)', alignSelf: 'center' }}>
                  {t('tier.dropHere')}
                </span>
              )}
            </div>
          </div>
        )
      })}

      {tip && (
        <div className="tooltip" style={{ left: tip.x + 14, top: tip.y + 18 }}>
          {tip.text}
        </div>
      )}

      {confirmClear && (
        <ConfirmDialog
          title={t('tier.clearTitle', { n: rated })}
          danger
          confirmLabel={t('tier.clearConfirm')}
          body={
            <>
              {t('tier.clearDetail')}
              <br />
              <br />
              {t('tier.clearDetail2')}
            </>
          }
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false)
            onClearAll()
          }}
        />
      )}
    </div>
  )
}
