import type { Game } from '../../../shared/types'
import { formatDurationShort } from '../../../shared/types'
import { formatBytes } from '../lib/format'
import { useLang, useT } from '../lib/i18n'
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
  const t = useT()
  const lang = useLang()
  // The top-right corner is shared: the status flags sit there, and so does the R18 badge
  // on a blurred cover. Whether anything else is up there is not something CSS can ask
  // from inside the artwork — the flags are a later sibling — so the tile carries the
  // answer and the badge reads it off.
  const hasFlags = game.wishlist || game.playing || game.played
  const classes = [
    'tile',
    hasFlags ? 'has-flags' : '',
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
  const played = formatDurationShort(game.playtimeMs, lang)
  const subtitle = game.missing
    ? t('tile.missing')
    : game.kind === 'archive'
      ? t('tile.notInstalled', { size: formatBytes(game.sizeBytes) })
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
          <span className="flag" title={t('tab.wishlist')}>
            ✿
          </span>
        )}
        {game.playing && (
          <span className="flag" title={t('tab.playing')} style={{ color: 'var(--accent)' }}>
            ❀
          </span>
        )}
        {game.played && (
          <span className="flag" title={t('tab.played')}>
            ✓
          </span>
        )}
      </span>

      {playing && <span className="tile-running">{t('tile.running')}</span>}

      <span className="tile-label">
        <span className="tile-name">{game.name}</span>
        <span className="tile-meta">
          <span className="tile-size">{subtitle}</span>
          {/* Unrated stays blank: an empty row of stars would read as a zero-star verdict. */}
          {game.rating !== null && (
            <span className="tile-stars" title={t('tile.ratingTitle', { n: game.rating })}>
              {'★'.repeat(game.rating)}
              <span className="dim">{'★'.repeat(5 - game.rating)}</span>
            </span>
          )}
        </span>
      </span>
    </button>
  )
}
