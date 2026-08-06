import { useMemo, useState } from 'react'
import type { Game } from '../../../shared/types'
import Artwork from '../components/Artwork'

interface Props {
  games: Game[]
  onPatch: (id: string, patch: Partial<Game>) => void
}

/** Bulk editor for the wishlist. Toggles only — this page never launches anything. */
export default function WishlistPage({ games, onPatch }: Props): React.JSX.Element {
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
          placeholder="搜索游戏…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className={`btn ${onlySelected ? 'primary' : 'ghost'}`}
          onClick={() => setOnlySelected(!onlySelected)}
        >
          只看已选
        </button>
        <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
          已选 <b style={{ color: 'var(--pink-accent)' }}>{selectedCount}</b> / {games.length}
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
              aria-label={game.wishlist ? '移出想玩' : '加入想玩'}
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
          <h2>没有匹配的游戏</h2>
          <p>换个关键词，或者关掉「只看已选」。</p>
        </div>
      )}
    </div>
  )
}
