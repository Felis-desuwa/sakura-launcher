import type { Game } from '../../../shared/types'
import { TIER_META } from '../../../shared/types'
import { formatBytes } from '../lib/format'
import Artwork from './Artwork'

interface Props {
  game: Game
  selected: boolean
  nudging: boolean
  dragging: boolean
  dropTarget: boolean
  onClick: () => void
  onDoubleClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onDragStart: () => void
  onDragEnd: () => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
}

export default function Tile({
  game,
  selected,
  nudging,
  dragging,
  dropTarget,
  onClick,
  onDoubleClick,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop
}: Props): React.JSX.Element {
  const classes = [
    'tile',
    selected ? 'selected' : '',
    nudging ? 'nudge' : '',
    dragging ? 'dragging' : '',
    dropTarget ? 'drop-target' : '',
    game.kind === 'archive' ? 'archive' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type="button"
      className={classes}
      draggable
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      title={game.name}
    >
      <Artwork game={game} />

      {game.tier && (
        <span className="tile-tier" style={{ background: TIER_META[game.tier].color }}>
          {TIER_META[game.tier].label}
        </span>
      )}

      <span className="tile-flags">
        {game.wishlist && (
          <span className="flag" title="想玩">
            ✿
          </span>
        )}
        {game.playing && (
          <span className="flag" title="在玩" style={{ color: 'var(--pink-accent)' }}>
            ❀
          </span>
        )}
        {game.played && (
          <span className="flag" title="玩过">
            ✓
          </span>
        )}
      </span>

      <span className="tile-label">
        <span className="tile-name">{game.name}</span>
        <span className="tile-size">
          {game.kind === 'archive' ? `未安装 · ${formatBytes(game.sizeBytes)}` : formatBytes(game.sizeBytes)}
        </span>
      </span>
    </button>
  )
}
