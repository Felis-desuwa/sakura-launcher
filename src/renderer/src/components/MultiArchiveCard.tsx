import type { MultiArchiveNotice } from '../../../shared/types'
import { useT } from '../lib/i18n'

/**
 * How much of the front every name shares.
 *
 * Releases of this shape name their parts by suffix — one long title repeated, then
 * `本体` / `追加1` / `特典` at the very end. Ellipsing from the right, which is what a
 * one-line cell does by default, cuts off precisely the part that differs and leaves
 * six identical rows. So the shared head is dropped and the tails are shown instead;
 * the whole name is still on the row's tooltip.
 *
 * Counted in code points, so a name split mid-surrogate cannot be produced.
 */
function sharedPrefixLength(names: string[]): number {
  if (names.length < 2) return 0
  const heads = names.map((n) => Array.from(n))
  let i = 0
  while (heads.every((h) => i < h.length - 1 && h[i] === heads[0][i])) i++
  // Not worth the ellipsis unless it buys back real room.
  return i >= 8 ? i : 0
}

/**
 * A download came back as several unrelated archives, so nothing was extracted.
 *
 * Deliberately not a modal: it interrupts nothing, and the library stays usable behind
 * it. Deliberately not a toast either — it carries the only record of what landed and
 * where, so it waits to be acknowledged instead of fading on a timer. Same reasoning as
 * the launch-diagnosis card, which is why they look alike.
 */
export default function MultiArchiveCard({
  notice,
  onClose
}: {
  notice: MultiArchiveNotice
  onClose: () => void
}): React.JSX.Element {
  const t = useT()
  const shared = sharedPrefixLength(notice.sets.map((s) => s.name))
  const short = (name: string): string =>
    shared > 0 ? `…${Array.from(name).slice(shared).join('')}` : name
  return (
    <div className="archive-card" role="alertdialog" aria-labelledby="archive-card-title">
      <b id="archive-card-title">{t('multiArchive.title')}</b>
      <span className="archive-card-body">
        {t('multiArchive.body', { n: notice.sets.length })}
      </span>
      <ul className="archive-card-list">
        {notice.sets.map((set) => (
          <li key={set.name} title={set.name}>
            {set.volumes > 1
              ? t('multiArchive.setLine', { name: short(set.name), n: set.volumes })
              : t('multiArchive.setLineOne', { name: short(set.name) })}
          </li>
        ))}
      </ul>
      <div className="archive-card-actions">
        <button
          type="button"
          className="btn small"
          onClick={() => void window.sakura.openPath(notice.dir)}
        >
          {t('multiArchive.open')}
        </button>
        <button type="button" className="btn primary small" onClick={onClose}>
          {t('multiArchive.ack')}
        </button>
      </div>
    </div>
  )
}
