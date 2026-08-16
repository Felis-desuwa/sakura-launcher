import { useEffect, useState } from 'react'
import type { CoverChoice, Game } from '../../../shared/types'
import { TAG_SOURCE_LABEL } from '../../../shared/types'
import { useT } from '../lib/i18n'

interface Props {
  choices: CoverChoice[]
  /** Whether explicit pictures may be drawn unblurred — the same switch the tiles use. */
  showAdult: boolean
  /** A game whose cover changed, so the grid behind the dialog updates with it. */
  onSettled: (game: Game) => void
  onClose: () => void
}

/**
 * Choosing between the cover on the tile and the one the catalogue has.
 *
 * This dialog only ever appears for a cover the user set themselves. The rule used to be
 * that a batch skipped those and a single lookup replaced them, and both halves were
 * wrong in the same way: neither showed the two pictures together, so the decision was
 * being made — silently, either direction — by something that had never seen them.
 *
 * Nothing has been written by the time this opens. The catalogue's picture is sitting in
 * a holding file, the tile still has what it always had, and closing without answering
 * throws the holding file away. That is what makes it safe to raise the question for
 * eighty games at once instead of interrupting the run eighty times.
 */
export default function CoverChoiceDialog({
  choices,
  showAdult,
  onSettled,
  onClose
}: Props): React.JSX.Element {
  const t = useT()
  const [settled, setSettled] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)

  const remaining = choices.filter((c) => !settled.has(c.gameId))

  /** Walking away is an answer too: every offer still open is dropped, not left waiting. */
  const close = (): void => {
    const ids = remaining.map((c) => c.gameId)
    if (ids.length > 0) void window.sakura.dropCoverChoices(ids)
    onClose()
  }

  // Rebound every render on purpose: `close` has to drop whatever is still outstanding,
  // and a listener captured once would go on offering to drop the list as it stood when
  // the dialog opened — including entries the user has since settled.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const settle = async (choice: CoverChoice, take: boolean): Promise<void> => {
    setBusy(choice.gameId)
    try {
      const updated = await window.sakura.chooseCover(choice.gameId, take)
      if (updated) onSettled(updated)
      setSettled((cur) => new Set(cur).add(choice.gameId))
    } finally {
      setBusy(null)
    }
  }

  const side = (
    choice: CoverChoice,
    which: 'mine' | 'theirs'
  ): React.JSX.Element => {
    const mine = which === 'mine'
    const file = mine ? choice.currentPath : choice.candidatePath
    const adult = mine ? choice.currentAdult : choice.candidateAdult
    const blurred = adult && !showAdult
    return (
      <div className="cover-side">
        <div className={`cover-shot${blurred ? ' blurred' : ''}`}>
          <img src={window.sakura.assetUrl(file)} alt="" draggable={false} />
          {blurred && <span className="art-badge">{t('covers.adultBadge')}</span>}
        </div>
        <span className="cover-side-label">
          {mine
            ? // Named where it is known. Most covers on a shelf were fetched too, so
              // calling this side "yours" would be wrong far more often than right.
              choice.currentFrom && choice.currentFrom !== 'user'
              ? t('cover.mineFrom', { source: TAG_SOURCE_LABEL[choice.currentFrom] })
              : t('cover.mine')
            : t('cover.theirs', { source: TAG_SOURCE_LABEL[choice.candidateFrom] })}
        </span>
        <button
          type="button"
          className={`btn small${mine ? ' ghost' : ' primary'}`}
          disabled={busy !== null}
          onClick={() => void settle(choice, !mine)}
        >
          {/* Taking the catalogue's picture writes a file and rewrites the sidecar, so the
              button says it is working rather than sitting still for a moment. */}
          {busy === choice.gameId && !mine ? t('cover.taking') : mine ? t('cover.keep') : t('cover.take')}
        </button>
      </div>
    )
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="modal import-modal">
        <h2>{t('cover.title')}</h2>
        <p className="exe-lede">{t('cover.intro')}</p>

        <div className="import-list">
          {remaining.map((choice) => (
            <div className="import-section" key={choice.gameId}>
              <div className="import-section-head">
                <span className="import-section-title">
                  {t('common.quoted', { name: choice.gameName })}
                </span>
              </div>
              <div className="cover-pair">
                {side(choice, 'mine')}
                {side(choice, 'theirs')}
              </div>
            </div>
          ))}
          {remaining.length === 0 && <p className="exe-lede">{t('cover.allSettled')}</p>}
        </div>

        {remaining.some((c) => c.currentAdult || c.candidateAdult) && !showAdult && (
          <div className="settings-hint" style={{ margin: '0 0 4px' }}>
            {t('cover.blurNote')}
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={close}>
            {remaining.length > 0 ? t('cover.keepAll') : t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
