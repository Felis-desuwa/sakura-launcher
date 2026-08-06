import type { SortKey, TabKey } from '../../../shared/types'
import { SORT_META, TAB_META } from '../../../shared/types'

export type PageKey = 'desktop' | 'tier' | 'wishlist' | 'disk' | 'settings'

const PAGES: [PageKey, string][] = [
  ['tier', '评价'],
  ['wishlist', '想玩选择'],
  ['disk', '磁盘'],
  ['settings', '设置']
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
  onSortChange
}: Props): React.JSX.Element {
  return (
    <header className="topbar">
      {page === 'desktop' ? (
        <span className="brand">❀ Sakura</span>
      ) : (
        /* The brand mark alone was not a discoverable way back out of a sub-page. */
        <button type="button" className="btn primary back-btn" onClick={() => onPage('desktop')}>
          ← 返回桌面
        </button>
      )}

      {page === 'desktop' && (
        <nav className="tabs">
          {(Object.keys(TAB_META) as TabKey[]).map((key) => (
            <button
              type="button"
              key={key}
              className={`tab${tab === key ? ' active' : ''}`}
              onClick={() => onTab(key)}
            >
              {TAB_META[key].label}
              <span className="badge">{counts[key]}</span>
            </button>
          ))}
        </nav>
      )}

      {page !== 'desktop' && (
        <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--ink)' }}>
          {PAGES.find(([k]) => k === page)?.[1]}
        </span>
      )}

      <span className="topbar-spacer" />

      {page === 'desktop' && (
        <>
          <select
            className="search sort-select"
            value={sortKey}
            title="排序方式"
            onChange={(e) => onSortChange(e.target.value as SortKey)}
          >
            {(Object.keys(SORT_META) as SortKey[]).map((key) => (
              <option key={key} value={key}>
                {SORT_META[key]}
              </option>
            ))}
          </select>
          <input
            className="search"
            placeholder="搜索游戏…"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
          />
        </>
      )}

      <button type="button" className="btn ghost" onClick={onRescan} disabled={scanning}>
        {scanning ? '扫描中…' : '扫描'}
      </button>

      <nav className="pagebtns">
        {PAGES.map(([key, label]) => (
          <button
            type="button"
            key={key}
            className={`pagebtn${page === key ? ' active' : ''}`}
            onClick={() => onPage(page === key ? 'desktop' : key)}
          >
            {label}
          </button>
        ))}
      </nav>
    </header>
  )
}
