import { useMemo } from 'react'
import type { MessageKey } from '../../../shared/i18n'
import type { AutoTag, Game, TagFacet } from '../../../shared/types'
import { TAG_FACETS, tagLabel, tagReason, visibleTags } from '../../../shared/types'
import { useLang, useT } from '../lib/i18n'

interface Props {
  games: Game[]
  active: string[]
  showSpoilers: boolean
  showAdult: boolean
  onToggle: (tagId: string) => void
  onClear: () => void
}

/**
 * A tag applied to one game is a search, not a filter.
 *
 * Work numbers are the clear case — every game has its own, so listing them would put a
 * row of two hundred single-use chips on screen and bury the eight that actually divide
 * the library. The search box already matches tag text, so nothing becomes unreachable
 * by leaving them out; they simply stop crowding out the tags that sort things.
 */
const MIN_SHARED = 2

/** Facet order in the bar, and the key each heading is looked up under. */
const FACET_LABEL: Record<TagFacet, MessageKey> = {
  genre: 'facet.genre',
  year: 'facet.year'
}

interface Counted {
  tag: AutoTag
  count: number
}

export default function TagBar({
  games,
  active,
  showSpoilers,
  showAdult,
  onToggle,
  onClear
}: Props): React.JSX.Element | null {
  const t = useT()
  const lang = useLang()
  const selected = useMemo(() => new Set(active), [active])

  const byFacet = useMemo(() => {
    const counts = new Map<string, Counted>()
    for (const game of games) {
      for (const tag of visibleTags(game, showSpoilers, showAdult)) {
        const hit = counts.get(tag.id)
        if (hit) hit.count++
        else counts.set(tag.id, { tag, count: 1 })
      }
    }

    const groups = new Map<TagFacet, Counted[]>()
    for (const entry of counts.values()) {
      // A selected tag always stays listed even once it has filtered the library down to
      // one game — otherwise the chip the user just clicked vanishes and there is no way
      // back out of the filter they applied.
      if (entry.count < MIN_SHARED && !selected.has(entry.tag.id)) continue
      const list = groups.get(entry.tag.facet) ?? []
      list.push(entry)
      groups.set(entry.tag.facet, list)
    }
    for (const list of groups.values()) {
      list.sort(
        (a, b) =>
          b.count - a.count || tagLabel(a.tag, t, lang).localeCompare(tagLabel(b.tag, t, lang))
      )
    }
    return groups
  }, [games, showSpoilers, showAdult, selected, t, lang])

  const anyTags = TAG_FACETS.some((facet) => (byFacet.get(facet)?.length ?? 0) > 0)
  if (!anyTags) return null

  return (
    <div className="tagbar">
      {TAG_FACETS.filter((facet) => (byFacet.get(facet)?.length ?? 0) > 0).map((facet) => (
        <div className="tagbar-group" key={facet}>
          <span className="tagbar-facet">{t(FACET_LABEL[facet])}</span>
          {byFacet.get(facet)?.map(({ tag, count }) => (
            <button
              type="button"
              key={tag.id}
              className={`tagchip${selected.has(tag.id) ? ' active' : ''}`}
              title={tagReason(tag, t)}
              onClick={() => onToggle(tag.id)}
            >
              {tagLabel(tag, t, lang)}
              <span className="tagchip-count">{count}</span>
            </button>
          ))}
        </div>
      ))}

      {active.length > 0 && (
        <button type="button" className="tagbar-clear" onClick={onClear}>
          {t('tagbar.clear')}
        </button>
      )}
    </div>
  )
}
