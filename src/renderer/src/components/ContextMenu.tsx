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

export default function ContextMenu({ x, y, items, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [openSub, setOpenSub] = useState<number | null>(null)

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

  const render = (list: MenuItem[]): React.JSX.Element[] =>
    list.map((item, i) => {
      if (item.type === 'separator') return <div className="menu-sep" key={`sep-${i}`} />
      const hasSub = item.submenu && item.submenu.length > 0
      return (
        <div
          key={item.label ?? i}
          style={{ position: 'relative' }}
          onMouseEnter={() => setOpenSub(hasSub ? i : null)}
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
            {item.checked !== undefined && <span className="check">{item.checked ? '✓' : ''}</span>}
            <span style={{ flex: 1 }}>{item.label}</span>
            {hasSub && <span style={{ opacity: 0.55 }}>▸</span>}
          </button>
          {hasSub && openSub === i && <div className="menu submenu">{render(item.submenu!)}</div>}
        </div>
      )
    })

  return (
    <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }}>
      {render(items)}
    </div>
  )
}
