import type { Game } from '../../../shared/types'
import { placeholderHueOffset, placeholderInitial } from '../lib/format'

interface Props {
  game: Game
  className?: string
}

/**
 * Whether explicit covers may be drawn unblurred.
 *
 * A module variable rather than a prop, following `format.ts`: `App` sets it during
 * render, before any child renders, so the very first paint after the switch is flipped
 * is already right. The reason it is not a prop is that artwork is drawn from six places
 * — tiles, the tier board, the wishlist, the uninstall ritual — and a call site that
 * forgot to pass it would render an explicit cover at full size with no indication
 * anything had been missed. That failure is silent, and this is the one thing here that
 * must not fail silently.
 */
let showAdultArt = false

export function setShowAdultArt(show: boolean): void {
  showAdultArt = show
}

/**
 * Cover art if the user set one (or a catalogue supplied one),
 * otherwise the executable's extracted icon, otherwise a generated tile.
 * Upscaling a 48px icon to a 180px tile looks far worse than a clean placeholder,
 * which is why the extractor refuses to cache anything below 64px.
 */
export default function Artwork({ game, className }: Props): React.JSX.Element {
  const cover = game.coverPath
  const icon = game.iconPath

  if (cover) {
    // Blurred in CSS rather than by storing a blurred copy: the picture stays intact, so
    // turning the switch on shows it at once with no catalogue round trip — the same
    // arrangement the explicit *tags* use.
    const blurred = Boolean(game.coverAdult) && !showAdultArt
    return (
      <div className={`tile-art cover ${blurred ? 'blurred ' : ''}${className ?? ''}`}>
        <img src={window.sakura.assetUrl(cover)} alt="" draggable={false} />
        {blurred && <span className="art-badge">R18</span>}
      </div>
    )
  }
  if (icon) {
    return (
      <div className={`tile-art ${className ?? ''}`}>
        <img src={window.sakura.assetUrl(icon)} alt="" draggable={false} />
      </div>
    )
  }
  return (
    <div className={`tile-art ${className ?? ''}`}>
      <div
        className="tile-placeholder"
        style={{ ['--h-offset' as string]: placeholderHueOffset(game.name) }}
      >
        {placeholderInitial(game.name)}
      </div>
    </div>
  )
}
