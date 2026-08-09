import type { Game } from '../../../shared/types'
import { formatDurationShort } from '../../../shared/types'
import { formatBytes } from '../lib/format'
import Artwork from './Artwork'

interface Props {
  game: Game
  selected: boolean
  /** A play session is open for this game right now. */
  playing: boolean
  nudging: boolean
  /** Lifted out of the grid by a drag: drawn as the hole it will drop back into. */
  hole: boolean
  /** Dropping here would merge the two into a group. */
  merging: boolean
  onClick: (e: React.MouseEvent) => void
  onDoubleClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onPointerDown: (e: React.PointerEvent) => void
}

export default function Tile({
  game,
  selected,
  playing,
  nudging,
  hole,
  merging,
  onClick,
  onDoubleClick,
  onContextMenu,
  onPointerDown
}: Props): React.JSX.Element {
  const classes = [
    'tile',
    selected ? 'selected' : '',
    nudging ? 'nudge' : '',
    hole ? 'dragging' : '',
    merging ? 'drop-target' : '',
    game.kind === 'archive' ? 'archive' : '',
    game.missing ? 'missing' : '',
    playing ? 'running' : ''
  ]
    .filter(Boolean)
    .join(' ')

  // Time played leads when there is any: it is the more interesting number about a
  // game you own, and the size is still one click away in the detail panel.
  const played = formatDurationShort(game.playtimeMs)
  const subtitle = game.missing
    ? '未找到'
    : game.kind === 'archive'
      ? `未安装 · ${formatBytes(game.sizeBytes)}`
      : played
        ? `${played} · ${formatBytes(game.sizeBytes)}`
        : formatBytes(game.sizeBytes)

  return (
    <button
      type="button"
      className={classes}
      data-game-id={game.id}
      data-flip-id={game.id}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      title={game.name}
    >
      <Artwork game={game} />

      <span className="tile-flags">
        {game.wishlist && (
          <span className="flag" title="想玩">
            ✿
          </span>
        )}
        {game.playing && (
          <span className="flag" title="在玩" style={{ color: 'var(--accent)' }}>
            ❀
          </span>
        )}
        {game.played && (
          <span className="flag" title="玩过">
            ✓
          </span>
        )}
      </span>

      {playing && <span className="tile-running">游玩中</span>}

      <span className="tile-label">
        <span className="tile-name">{game.name}</span>
        <span className="tile-meta">
          <span className="tile-size">{subtitle}</span>
          {/* Unrated stays blank: an empty row of stars would read as a zero-star verdict. */}
          {game.rating !== null && (
            <span className="tile-stars" title={`评分 ${game.rating} / 5`}>
              {'★'.repeat(game.rating)}
              <span className="dim">{'★'.repeat(5 - game.rating)}</span>
            </span>
          )}
        </span>
      </span>
    </button>
  )
}
