import type { Game } from '../../../shared/types'
import { placeholderHueOffset, placeholderInitial } from '../lib/format'

interface Props {
  game: Game
  className?: string
}

/**
 * Cover art if the user set one (or the folder shipped a recognisable one),
 * otherwise the executable's extracted icon, otherwise a generated tile.
 * Upscaling a 48px icon to a 180px tile looks far worse than a clean placeholder,
 * which is why the extractor refuses to cache anything below 64px.
 */
export default function Artwork({ game, className }: Props): React.JSX.Element {
  const cover = game.coverPath
  const icon = game.iconPath

  if (cover) {
    return (
      <div className={`tile-art cover ${className ?? ''}`}>
        <img src={window.sakura.assetUrl(cover)} alt="" draggable={false} />
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
