import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuItem {
  type?: 'item' | 'separator'
  label?: string
  checked?: boolean
  danger?: boolean
  disabled?: boolean
  onClick?: () => void
  submenu?: MenuItem[]
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

/** Kept between a menu and the window edge, so nothing sits flush against it. */
const EDGE_MARGIN = 6

/**
 * How long an open submenu survives the pointer being somewhere else.
 *
 * A submenu that had to open leftwards and upwards is reached by crossing the rows of
 * its own parent, every one of which would otherwise close it before the pointer
 * arrives. The grace period is the whole reason that trip is possible.
 */
const SUBMENU_GRACE_MS = 260

/**
 * A submenu that stays inside the window.
 *
 * Opening to the right is right until the parent menu is already against the right
 * edge — and it always is, for a tile in the last column, because the parent flips back
 * inside precisely there. The submenu then opened entirely off-screen, which made 评分
 * unreachable for exactly the tiles at the edge of the grid. Measured once after layout
 * and flipped to the other side, or lifted, when it does not fit.
 */
function Submenu({
  children,
  onMouseEnter
}: {
  children: React.ReactNode
  onMouseEnter: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<React.CSSProperties>()

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const next: React.CSSProperties = {}

    if (rect.right > window.innerWidth - EDGE_MARGIN) {
      // Out to the left of the parent menu instead of the right.
      next.left = 'auto'
      next.right = '100%'
      next.marginLeft = 0
      next.marginRight = 2
    }
    const overflowY = rect.bottom - (window.innerHeight - EDGE_MARGIN)
    if (overflowY > 0) {
      // `top` is relative to the row this submenu hangs off and -6 is its resting
      // offset, so lifting by the overflow keeps the last entry on screen. Never lift
      // further than the top edge allows: a submenu taller than the window would
      // otherwise trade its bottom for its head.
      const lift = Math.max(0, Math.min(overflowY, rect.top - EDGE_MARGIN))
      next.top = -6 - lift
    }

    if (Object.keys(next).length > 0) setStyle(next)
  }, [])

  return (
    <div className="menu submenu" ref={ref} style={style} onMouseEnter={onMouseEnter}>
      {children}
    </div>
  )
}

/**
 * One level of a menu.
 *
 * A component rather than a render function, because each level needs its own idea of
 * which of *its* rows is expanded. Sharing one piece of state across levels meant that
 * hovering a row inside a submenu — a star in 评分, say — set the shared value to "no
 * submenu open" and closed the very list the pointer had just landed on.
 */
function MenuLevel({
  items,
  onClose
}: {
  items: MenuItem[]
  onClose: () => void
}): React.JSX.Element {
  const [openSub, setOpenSub] = useState<number | null>(null)
  const closeTimer = useRef<number | null>(null)

  const cancelClose = (): void => {
    if (closeTimer.current === null) return
    window.clearTimeout(closeTimer.current)
    closeTimer.current = null
  }

  useEffect(() => cancelClose, [])

  /** Entering a row: open its submenu at once, or start letting the open one go. */
  const enterRow = (index: number, hasSub: boolean): void => {
    cancelClose()
    if (hasSub) {
      setOpenSub(index)
      return
    }
    if (openSub === null) return
    closeTimer.current = window.setTimeout(() => setOpenSub(null), SUBMENU_GRACE_MS)
  }

  return (
    <>
      {items.map((item, i) => {
        if (item.type === 'separator') return <div className="menu-sep" key={`sep-${i}`} />
        const hasSub = !!item.submenu && item.submenu.length > 0
        return (
          <div
            key={item.label ?? i}
            style={{ position: 'relative' }}
            onMouseEnter={() => enterRow(i, hasSub)}
          >
            <button
              type="button"
              className={`menu-item${item.danger ? ' danger' : ''}`}
              disabled={item.disabled}
              style={item.disabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
              onClick={() => {
                if (hasSub || item.disabled) return
                item.onClick?.()
                onClose()
              }}
            >
              {item.checked !== undefined && (
                <span className="check">{item.checked ? '✓' : ''}</span>
              )}
              <span style={{ flex: 1 }}>{item.label}</span>
              {hasSub && <span style={{ opacity: 0.55 }}>▸</span>}
            </button>
            {hasSub && openSub === i && (
              <Submenu onMouseEnter={cancelClose}>
                <MenuLevel items={item.submenu!} onClose={onClose} />
              </Submenu>
            )}
          </div>
        )
      })}
    </>
  )
}

export default function ContextMenu({ x, y, items, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // Flip back inside the window rather than letting the menu run off-screen.
    const nx = x + rect.width > window.innerWidth ? Math.max(4, window.innerWidth - rect.width - 6) : x
    const ny =
      y + rect.height > window.innerHeight ? Math.max(4, window.innerHeight - rect.height - 6) : y
    setPos({ x: nx, y: ny })
  }, [x, y])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return (
    <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }}>
      <MenuLevel items={items} onClose={onClose} />
    </div>
  )
}
