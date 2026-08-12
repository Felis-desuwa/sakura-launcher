import { useMemo, useState } from 'react'
import type { Game } from '../../../shared/types'
import Artwork from '../components/Artwork'
import { useT } from '../lib/i18n'

interface Props {
  games: Game[]
  onPatch: (id: string, patch: Partial<Game>) => void
}

/** Bulk editor for the wishlist. Toggles only — this page never launches anything. */
export default function WishlistPage({ games, onPatch }: Props): React.JSX.Element {
  const t = useT()
  const [query, setQuery] = useState('')
  const [onlySelected, setOnlySelected] = useState(false)

  const selectedCount = games.filter((g) => g.wishlist).length

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return games
      .filter((g) => (onlySelected ? g.wishlist : true))
      .filter((g) => (q ? g.name.toLowerCase().includes(q) : true))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }, [games, query, onlySelected])

  return (
    <div className="page">
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          marginBottom: 16,
          flexWrap: 'wrap'
        }}
      >
        <input
          className="search"
          style={{ width: 240 }}
          placeholder={t('top.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className={`btn ${onlySelected ? 'primary' : 'ghost'}`}
          onClick={() => setOnlySelected(!onlySelected)}
        >
          {t('wish.onlySelected')}
        </button>
        <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
          {t('wish.selected', { n: selectedCount, total: games.length })}
        </span>
      </div>

      <div className="wish-list">
        {list.map((game) => (
          <div
            key={game.id}
            className="wish-row"
            onClick={() => onPatch(game.id, { wishlist: !game.wishlist })}
          >
            <div className="wish-icon">
              <Artwork game={game} />
            </div>
            <div className="wish-name">{game.name}</div>
            <button
              type="button"
              className={`switch${game.wishlist ? ' on' : ''}`}
              aria-label={game.wishlist ? t('wish.remove') : t('wish.add')}
              aria-pressed={game.wishlist}
              onClick={(e) => {
                e.stopPropagation()
                onPatch(game.id, { wishlist: !game.wishlist })
              }}
            />
          </div>
        ))}
      </div>

      {list.length === 0 && (
        <div className="empty" style={{ minHeight: 260 }}>
          <h2>{t('wish.noMatch')}</h2>
          <p>{t('wish.noMatchHint')}</p>
        </div>
      )}
    </div>
  )
}
