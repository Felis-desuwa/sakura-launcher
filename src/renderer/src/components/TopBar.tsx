import { useEffect, useRef } from 'react'
import type { MessageKey } from '../../../shared/i18n'
import type { SortKey, TabKey } from '../../../shared/types'
import { SORT_KEYS, TAB_KEYS } from '../../../shared/types'
import { useT } from '../lib/i18n'
import WindowControls from './WindowControls'

export type PageKey = 'desktop' | 'tier' | 'disk' | 'settings'

/** Sub-pages, with the key their name is looked up under. */
const PAGES: [PageKey, MessageKey][] = [
  ['tier', 'page.tier'],
  ['disk', 'page.disk'],
  ['settings', 'page.settings']
]

interface Props {
  page: PageKey
  /** What this build was packaged as. Empty until the main process has answered. */
  version: string
  tab: TabKey
  counts: Record<TabKey, number>
  search: string
  scanning: boolean
  sortKey: SortKey
  onPage: (page: PageKey) => void
  onTab: (tab: TabKey) => void
  onSearch: (value: string) => void
  onRescan: () => void
  onDownload: () => void
  onSortChange: (key: SortKey) => void
}

export default function TopBar({
  page,
  version,
  tab,
  counts,
  search,
  scanning,
  sortKey,
  onPage,
  onTab,
  onSearch,
  onRescan,
  onDownload,
  onSortChange
}: Props): React.JSX.Element {
  const t = useT()

  /*
   * Moving the window with a finger, because the bar's `-webkit-app-region: drag` only
   * answers to a mouse — under touch a frameless window is otherwise stuck where it
   * opened.
   *
   * Only non-mouse pointers take this path, so nothing about the mouse behaviour changes,
   * and only presses on the bar itself: `e.target !== e.currentTarget` leaves every
   * control on it alone, exactly as the `no-drag` opt-outs do for the mouse.
   */
  const drag = useRef<{ x: number; y: number; winX: number; winY: number } | null>(null)
  const frame = useRef<number | null>(null)

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const from = drag.current
      if (!from) return
      e.preventDefault()
      // Coalesced to one move per frame: setPosition crosses to the main process, and a
      // finger produces far more events than the window needs to keep up with.
      if (frame.current !== null) return
      frame.current = requestAnimationFrame(() => {
        frame.current = null
        const now = drag.current
        if (!now) return
        void window.sakura.moveWindow(now.winX + (e.clientX - now.x), now.winY + (e.clientY - now.y))
      })
    }
    const stop = (): void => {
      drag.current = null
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current)
        frame.current = null
      }
    }
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    }
  }, [])

  const startDrag = (e: React.PointerEvent): void => {
    if (e.pointerType === 'mouse' || e.button !== 0) return
    if (e.target !== e.currentTarget) return
    const x = e.clientX
    const y = e.clientY
    void window.sakura.startWindowDrag().then(([winX, winY]) => {
      drag.current = { x, y, winX, winY }
    })
  }

  return (
    <header className="topbar" onPointerDown={startDrag}>
      {page === 'desktop' ? (
        <span className="brand">❀ Sakura</span>
      ) : (
        /* The brand mark alone was not a discoverable way back out of a sub-page. */
        <button type="button" className="btn primary back-btn" onClick={() => onPage('desktop')}>
          {t('top.back')}
        </button>
      )}

      {/* The build's own version. Deliberately a label and not a control: a `span` in the
          top bar stays inside `-webkit-app-region: drag`, so this is one more place the
          window can be picked up rather than one more thing to miss when aiming for it. */}
      {version && <span className="version-chip">{version}</span>}

      {page === 'desktop' && (
        <nav className="tabs">
          {TAB_KEYS.map((key) => (
            <button
              type="button"
              key={key}
              className={`tab${tab === key ? ' active' : ''}`}
              onClick={() => onTab(key)}
            >
              {t(`tab.${key}` as MessageKey)}
              <span className="badge">{counts[key]}</span>
            </button>
          ))}
        </nav>
      )}

      {page !== 'desktop' && (
        <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--ink)' }}>
          {t(PAGES.find(([k]) => k === page)?.[1] ?? 'page.library')}
        </span>
      )}

      <span className="topbar-spacer" />

      {page === 'desktop' && (
        <>
          <select
            className="search sort-select"
            value={sortKey}
            title={t('top.sortTitle')}
            onChange={(e) => onSortChange(e.target.value as SortKey)}
          >
            {SORT_KEYS.map((key) => (
              <option key={key} value={key}>
                {t(`sort.${key}` as MessageKey)}
              </option>
            ))}
          </select>
          <input
            className="search"
            placeholder={t('top.search')}
            value={search}
            onChange={(e) => onSearch(e.target.value)}
          />
        </>
      )}

      {page === 'desktop' && (
        <button type="button" className="btn primary" onClick={onDownload}>
          {t('top.download')}
        </button>
      )}

      {/* Sync only. Taking in games that were not there before is a separate, deliberate
          act with a preview attached — Settings → Rescan and add. */}
      <button
        type="button"
        className="btn ghost"
        onClick={onRescan}
        disabled={scanning}
        title={t('top.refreshTitle')}
      >
        {scanning ? t('top.refreshing') : t('top.refresh')}
      </button>

      <nav className="pagebtns">
        {PAGES.map(([key, labelKey]) => (
          <button
            type="button"
            key={key}
            className={`pagebtn${page === key ? ' active' : ''}`}
            onClick={() => onPage(page === key ? 'desktop' : key)}
          >
            {t(labelKey)}
          </button>
        ))}
      </nav>

      {/* The window has no frame, so the bar ends where the caption buttons used to be. */}
      <WindowControls />
    </header>
  )
}
