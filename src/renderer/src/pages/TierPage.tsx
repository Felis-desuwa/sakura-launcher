import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Game, Tier } from '../../../shared/types'
import { TIERS, TIER_META } from '../../../shared/types'
import Artwork from '../components/Artwork'
import ConfirmDialog from '../components/ConfirmDialog'
import ContextMenu, { type MenuItem } from '../components/ContextMenu'
import { createDragProxy, type DragProxy } from '../lib/dragProxy'
import { useT } from '../lib/i18n'

type RowKey = Tier | 'unrated'

const ROWS: RowKey[] = [...TIERS, 'unrated']

/** Movement before a press becomes a drag. Below it the press is still a press. */
const DRAG_THRESHOLD_PX = 6

/** How long a finger rests before the tier menu opens instead. Matches `useTileDrag`. */
const HOLD_MS = 450

interface Props {
  games: Game[]
  onPatch: (id: string, patch: Partial<Game>) => void
  onClearAll: () => void
}

/**
 * Tier list. Icons only — no captions — so a row holds many at once; the name shows
 * on hover instead. Launching is disabled here on purpose: this page is for ranking.
 *
 * Dragging is pointer-driven, like the shelf's. It used to be native HTML5 drag-and-drop,
 * which no engine fires for touch — and since the icons deliberately have no click and no
 * keyboard activation either, that left **ranking a game reachable by mouse alone**. The
 * whole page was inert to a finger.
 *
 * Two things fix it, and both are needed. `touch-action: none` on the icons means the
 * browser never claims a finger's movement as a page pan, so press-and-move can be a drag
 * here without the mode the shelf needs — the icons are small and there is row background,
 * labels and page margin left to scroll from. And a press that *doesn't* move opens a menu
 * of the tiers, which is the route that stays available no matter how the drag goes.
 */
export default function TierPage({ games, onPatch, onClearAll }: Props): React.JSX.Element {
  const t = useT()
  const [dragId, setDragId] = useState<string | null>(null)
  const [overRow, setOverRow] = useState<RowKey | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null)
  const [menu, setMenu] = useState<{ game: Game; x: number; y: number } | null>(null)
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

  /*
   * Read through a ref so the window listeners below never need rebinding mid-gesture —
   * the same reason `useTileDrag` does it. Re-subscribing while a finger is down loses
   * the move that was in flight.
   */
  const latest = useRef({ rows, onPatch })
  latest.current = { rows, onPatch }

  const commit = useCallback((id: string, row: RowKey, beforeId?: string): void => {
    const tier: Tier | null = row === 'unrated' ? null : row
    const members = (latest.current.rows.get(row) ?? []).filter((g) => g.id !== id)
    const index = beforeId ? members.findIndex((g) => g.id === beforeId) : members.length
    const at = index < 0 ? members.length : index
    const ordered = [...members.slice(0, at), { id } as Game, ...members.slice(at)]
    ordered.forEach((g, i) => {
      if (g.id === id) latest.current.onPatch(id, { tier, tierOrder: i })
      else latest.current.onPatch(g.id, { tierOrder: i })
    })
  }, [])

  /** A press that has not moved far enough to be a drag yet. */
  const press = useRef<
    { id: string; game: Game; x: number; y: number; node: HTMLElement; pointerId: number; hold: number | null } | null
  >(null)
  const drag = useRef<{ id: string; proxy: DragProxy; row: RowKey | null; before?: string } | null>(
    null
  )

  const clearPress = useCallback((): void => {
    if (press.current?.hold != null) window.clearTimeout(press.current.hold)
    press.current = null
  }, [])

  /** Which row, and which icon to land in front of, is under this point. */
  const hitTest = useCallback((x: number, y: number): void => {
    const state = drag.current
    if (!state) return
    const under = document.elementFromPoint(x, y) as HTMLElement | null
    const rowEl = under?.closest<HTMLElement>('.tier-row')
    const row = (rowEl?.dataset.row as RowKey | undefined) ?? null
    state.row = row
    state.before = undefined
    if (row) {
      const iconEl = under?.closest<HTMLElement>('.tier-icon')
      const id = iconEl?.dataset.tierId
      // Landing before or after the icon under the finger, by which half of it that is.
      if (iconEl && id && id !== state.id) {
        const box = iconEl.getBoundingClientRect()
        state.before = x < box.left + box.width / 2 ? id : nextIconId(iconEl)
      }
    }
    setOverRow(row)
  }, [])

  const finish = useCallback(
    async (keep: boolean): Promise<void> => {
      const state = drag.current
      if (!state) return
      drag.current = null
      if (keep && state.row) commit(state.id, state.row, state.before)
      try {
        const home = document.querySelector<HTMLElement>(
          `.tier-icon[data-tier-id="${CSS.escape(state.id)}"]`
        )
        if (home) await state.proxy.settleInto(home.getBoundingClientRect())
      } finally {
        state.proxy.destroy()
        setDragId(null)
        setOverRow(null)
      }
    },
    [commit]
  )

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const state = drag.current
      if (state) {
        state.proxy.moveTo(e.clientX, e.clientY)
        hitTest(e.clientX, e.clientY)
        e.preventDefault()
        return
      }
      const pending = press.current
      if (!pending) return
      if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < DRAG_THRESHOLD_PX) return

      // Far enough to be a drag, so it is not a hold any more.
      if (pending.hold != null) window.clearTimeout(pending.hold)
      const rect = pending.node.getBoundingClientRect()
      const proxy = createDragProxy({
        sources: [pending.node],
        grabX: pending.x - rect.left,
        grabY: pending.y - rect.top
      })
      proxy.moveTo(e.clientX, e.clientY)
      drag.current = { id: pending.id, proxy, row: null }
      press.current = null
      setDragId(pending.id)
      hitTest(e.clientX, e.clientY)
    }

    const onUp = (): void => {
      if (drag.current) void finish(true)
      else clearPress()
    }

    // A cancelled pointer is not a released one: the gesture was taken away, so the icon
    // goes back where it came from rather than being ranked somewhere nobody chose.
    const onCancel = (): void => {
      if (drag.current) void finish(false)
      else clearPress()
    }

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && drag.current) void finish(false)
    }

    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey)
    }
  }, [clearPress, finish, hitTest])

  // Nothing may outlive the page: a proxy left in the body would sit over the next one.
  useEffect(() => {
    return () => {
      if (drag.current) {
        drag.current.proxy.destroy()
        drag.current = null
      }
      clearPress()
    }
  }, [clearPress])

  const startPress = (e: React.PointerEvent, game: Game): void => {
    if (e.button !== 0 || drag.current) return
    const node = e.currentTarget as HTMLElement
    const x = e.clientX
    const y = e.clientY
    press.current = { id: game.id, game, x, y, node, pointerId: e.pointerId, hold: null }
    try {
      node.setPointerCapture(e.pointerId)
    } catch {
      // Gone already; the release will tidy up.
    }
    if (e.pointerType === 'mouse') return
    press.current.hold = window.setTimeout(() => {
      if (!press.current || drag.current) return
      press.current = null
      setMenu({ game, x, y })
    }, HOLD_MS)
  }

  const tierMenu = (game: Game): MenuItem[] =>
    ROWS.map((row) => ({
      // `TIER_META.unrated.label` is deliberately empty — the row draws it as a bare
      // colour — but a menu entry with no words is not a choice anyone can make.
      label: row === 'unrated' ? t('tier.unrated') : TIER_META[row].label,
      checked: (game.tier ?? 'unrated') === row,
      onClick: () => commit(game.id, row)
    }))

  return (
    <div className="page">
      <div className="tier-head">
        <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: 0 }}>{t('tier.lede')}</p>
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
            data-row={row}
            className={`tier-row${overRow === row ? ' over' : ''}`}
            style={{ background: `${meta.color}1f` }}
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
                  data-tier-id={game.id}
                  className={`tier-icon${dragId === game.id ? ' dragging' : ''}`}
                  onPointerDown={(e) => startPress(e, game)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    clearPress()
                    setMenu({ game, x: e.clientX, y: e.clientY })
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

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={tierMenu(menu.game)}
          onClose={() => setMenu(null)}
        />
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

/** The icon after this one in the same row, or undefined at the end of it. */
function nextIconId(el: HTMLElement): string | undefined {
  const next = el.nextElementSibling as HTMLElement | null
  return next?.dataset.tierId
}
