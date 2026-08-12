import { useEffect, useState } from 'react'
import type { PendingMatch, WorkMatch } from '../../../shared/types'
import { isAdultTag, TAG_SOURCE_LABEL, tagLabel } from '../../../shared/types'
import { useLang, useT } from '../lib/i18n'

interface Props {
  pending: PendingMatch[]
  showSpoilers: boolean
  showAdult: boolean
  onApply: (gameId: string, match: WorkMatch) => Promise<void>
  onClose: () => void
}

/**
 * Settling the matches the launcher would not settle on its own.
 *
 * Anything identified by a work number has already been taken — a number names one
 * product and cannot be a near miss. What reaches this dialog came from a title search,
 * where a fan disc, a sequel, or an unrelated game sharing a word all look alike from
 * the outside; or from a folder name nothing matched at all.
 *
 * That second case is why there is a search box. A folder called `123456` or `abcd` is
 * never going to be recognised, and no amount of cleverness will change that — the only
 * thing that helps is somewhere to type what the game actually is. It takes a title in
 * any language, or an id pasted straight in.
 */
export default function MatchDialog({
  pending,
  showSpoilers,
  showAdult,
  onApply,
  onClose
}: Props): React.JSX.Element {
  const t = useT()
  const lang = useLang()
  const [settled, setSettled] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  /** What the user typed per game, seeded from whatever the lookup suggested. */
  const [queries, setQueries] = useState<Record<string, string>>({})
  /** Manual results per game, replacing the automatic candidates once a search runs. */
  const [found, setFound] = useState<Record<string, WorkMatch[]>>({})
  const [searching, setSearching] = useState<string | null>(null)
  /** A search that came back with nothing, so the dialog can say so rather than sit still. */
  const [empty, setEmpty] = useState<Set<string>>(new Set())

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const apply = async (gameId: string, match: WorkMatch): Promise<void> => {
    setBusy(gameId)
    try {
      await onApply(gameId, match)
      setSettled((cur) => new Set(cur).add(gameId))
    } finally {
      setBusy(null)
    }
  }

  const runSearch = async (entry: PendingMatch): Promise<void> => {
    const query = (queries[entry.gameId] ?? entry.suggestion ?? '').trim()
    if (!query) return
    setSearching(entry.gameId)
    setEmpty((cur) => {
      const next = new Set(cur)
      next.delete(entry.gameId)
      return next
    })
    try {
      const results = await window.sakura.searchWorks(query)
      setFound((cur) => ({ ...cur, [entry.gameId]: results }))
      if (results.length === 0) setEmpty((cur) => new Set(cur).add(entry.gameId))
    } finally {
      setSearching(null)
    }
  }

  const skip = (gameId: string): void => setSettled((cur) => new Set(cur).add(gameId))

  const remaining = pending.filter((p) => !settled.has(p.gameId))

  const candidateRow = (entry: PendingMatch, match: WorkMatch): React.JSX.Element => {
    const shown = match.tags.filter(
      (tag) => (showSpoilers || !tag.spoiler) && (showAdult || !isAdultTag(tag))
    )
    const hidden = match.tags.length - shown.length
    return (
      <div className="match-row" key={`${match.source}:${match.workId}`}>
        <div className="match-main">
          <span className="match-title">{match.title}</span>
          <span className="exe-chip">{TAG_SOURCE_LABEL[match.source]}</span>
          {match.score > 0 && (
            <span className="match-score">
              {t('match.score', { n: Math.round(match.score * 100) })}
            </span>
          )}
        </div>
        {/* Both names, because which one the user recognises depends on the game — and on
            whether they know it by its Japanese title or the one it was translated under. */}
        {(match.altTitle || match.zhTitle) && (
          <div className="match-alt">
            {[match.altTitle, match.zhTitle].filter(Boolean).join('　·　')}
          </div>
        )}
        <div className="match-meta">
          {match.released && <span>{t('match.released', { date: match.released })}</span>}
          <span>{t('match.tagCount', { n: match.tags.length })}</span>
          {hidden > 0 && <span className="dim">{t('match.spoilerHidden', { n: hidden })}</span>}
        </div>
        <div className="tag-row match-tags">
          {shown.slice(0, 10).map((tag) => (
            <span className="tag" key={tag.id}>
              {tagLabel(tag, t, lang)}
            </span>
          ))}
        </div>
        <div className="exe-actions">
          <button
            type="button"
            className="btn primary small"
            disabled={busy !== null}
            onClick={() => void apply(entry.gameId, match)}
          >
            {t('match.apply')}
          </button>
        </div>
      </div>
    )
  }

  const section = (entry: PendingMatch): React.JSX.Element => {
    const results = found[entry.gameId] ?? entry.candidates
    return (
      <div className="import-section" key={entry.gameId}>
        <div className="import-section-head">
          <span className="import-section-title">
            {t('common.quoted', { name: entry.gameName })}
          </span>
          <button type="button" className="btn ghost small" onClick={() => skip(entry.gameId)}>
            {t('match.none')}
          </button>
        </div>

        <div className="match-search">
          <input
            className="field"
            value={queries[entry.gameId] ?? entry.suggestion ?? ''}
            placeholder={t('match.searchPlaceholder')}
            onChange={(e) =>
              setQueries((cur) => ({ ...cur, [entry.gameId]: e.target.value }))
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch(entry)
            }}
          />
          <button
            type="button"
            className="btn ghost small"
            disabled={searching !== null}
            onClick={() => void runSearch(entry)}
          >
            {searching === entry.gameId ? t('match.searching') : t('match.search')}
          </button>
        </div>
        <div className="settings-hint" style={{ margin: '0 0 8px' }}>
          {t('match.searchHint')}
        </div>

        {results.length > 0 ? (
          results.map((match) => candidateRow(entry, match))
        ) : (
          <div className="settings-hint" style={{ margin: 0 }}>
            {empty.has(entry.gameId) ? t('match.searchEmpty') : t('match.noCandidates')}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal import-modal">
        <h2>{t('match.title')}</h2>
        <p className="exe-lede">{t('match.intro')}</p>

        <div className="import-list">
          {remaining.map(section)}
          {remaining.length === 0 && <p className="exe-lede">{t('match.allSettled')}</p>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            {remaining.length > 0 ? t('match.skipAll') : t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
