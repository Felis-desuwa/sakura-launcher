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

  return (
    <header className="topbar">
      {page === 'desktop' ? (
        <span className="brand">❀ Sakura</span>
      ) : (
        /* The brand mark alone was not a discoverable way back out of a sub-page. */
        <button type="button" className="btn primary back-btn" onClick={() => onPage('desktop')}>
          {t('top.back')}
        </button>
      )}

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
