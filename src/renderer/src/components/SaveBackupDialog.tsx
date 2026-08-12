import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SaveBackupJob, SaveBackupResult, SaveCandidate, SavePlan } from '../../../shared/types'
import { formatBytes } from '../lib/format'
import { useT } from '../lib/i18n'

interface Props {
  plans: SavePlan[]
  onClose: () => void
  onToast: (message: string, error?: boolean) => void
}

interface PerGame {
  /** Absolute paths of the ticked candidates. */
  picked: Set<string>
  /** Paths the user pointed at during this sitting, so they can be shown at once. */
  extra: SaveCandidate[]
}

/**
 * Copying a game's saves somewhere safe.
 *
 * Two things this dialog has to say plainly, because both are unusual.
 *
 * **Nothing here writes to a game.** Saves are copied out; the folder is not touched.
 * That is why there is no confirmation ritual — the worst a wrong tick can do is fill a
 * backup folder with something that was not a save.
 *
 * **There is no restore.** Putting a save back means overwriting the one on disk, and
 * that is the only thing this program could do that cannot be undone. So the backup
 * leaves a note recording where every item came from, and going back is done by hand.
 *
 * The rest of the layout follows from detection being a search rather than a fact. What
 * was found inside the game, or exactly where its engine writes, is ticked. What was
 * found by matching a folder name somewhere else is shown with the reason and left
 * unticked. And because no search of this kind is complete, adding a location by hand is
 * always on screen — including when exactly one candidate was found, which is the case
 * where a confident-looking wrong answer would otherwise go unquestioned.
 */
export default function SaveBackupDialog({ plans, onClose, onToast }: Props): React.JSX.Element {
  const t = useT()
  const usable = useMemo(() => plans.filter((p) => !p.blocked), [plans])
  const blocked = useMemo(() => plans.filter((p) => p.blocked), [plans])

  const [destRoot, setDestRoot] = useState('')
  const [remember, setRemember] = useState(false)
  const [per, setPer] = useState<Record<string, PerGame>>({})
  const [expanded, setExpanded] = useState<string | null>(
    usable.length === 1 ? usable[0].gameId : null
  )
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ gameId: string; percent: number; index: number }>()
  const [results, setResults] = useState<SaveBackupResult[] | null>(null)
  const [freeBytes, setFreeBytes] = useState<number | null>(null)

  useEffect(() => {
    const next: Record<string, PerGame> = {}
    for (const plan of usable) {
      next[plan.gameId] = {
        picked: new Set(plan.candidates.filter((c) => c.checked).map((c) => c.path)),
        extra: []
      }
    }
    setPer(next)
  }, [usable])

  useEffect(() => {
    void window.sakura.backupDir().then((dir) => setDestRoot((cur) => cur || dir))
  }, [])

  useEffect(() => {
    if (!destRoot) return
    void window.sakura.shareFreeSpace(destRoot).then(setFreeBytes)
  }, [destRoot])

  useEffect(() => {
    const offProgress = window.sakura.onSaveBackupProgress((p) => setProgress(p))
    const offDone = window.sakura.onSaveBackupDone((r) => {
      setRunning(false)
      setResults(r)
      const ok = r.filter((x) => x.ok).length
      const failed = r.filter((x) => !x.ok && !x.skipped).length
      if (failed === 0 && ok > 0) onToast(t('saves.backedUpN', { n: ok }))
      else if (ok > 0) onToast(t('saves.partial', { ok, bad: failed }), true)
      else if (failed > 0) onToast(t('saves.allFailed'), true)
    })
    return () => {
      offProgress()
      offDone()
    }
  }, [onToast, t])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !running) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, running])

  const rowsFor = useCallback(
    (plan: SavePlan): SaveCandidate[] => [
      ...plan.candidates,
      ...(per[plan.gameId]?.extra ?? []).filter(
        (e) => !plan.candidates.some((c) => c.path.toLowerCase() === e.path.toLowerCase())
      )
    ],
    [per]
  )

  const toggle = (gameId: string, filePath: string): void => {
    setPer((cur) => {
      const picked = new Set(cur[gameId].picked)
      if (picked.has(filePath)) picked.delete(filePath)
      else picked.add(filePath)
      return { ...cur, [gameId]: { ...cur[gameId], picked } }
    })
  }

  /**
   * Add a location the search did not find.
   *
   * The main process records the choice on the game as it hands the path back, so the
   * next backup of this game proposes it without the user having to go looking again.
   */
  const addOwn = async (plan: SavePlan, kind: 'file' | 'dir'): Promise<void> => {
    const picked = await window.sakura.pickSaveSource(plan.gameId, kind)
    if (!picked) return
    setPer((cur) => {
      const state = cur[plan.gameId]
      const already =
        state.extra.some((e) => e.path.toLowerCase() === picked.toLowerCase()) ||
        plan.candidates.some((c) => c.path.toLowerCase() === picked.toLowerCase())
      const nextPicked = new Set(state.picked)
      nextPicked.add(picked)
      if (already) return { ...cur, [plan.gameId]: { ...state, picked: nextPicked } }
      const row: SaveCandidate = {
        path: picked,
        label: picked,
        isDir: kind === 'dir',
        sizeBytes: 0,
        fileCount: 0,
        newestMs: 0,
        root: 'game',
        confidence: 'strong',
        reason: t('whySave.addedByHand'),
        checked: true,
        byHand: true
      }
      return {
        ...cur,
        [plan.gameId]: { ...state, picked: nextPicked, extra: [...state.extra, row] }
      }
    })
  }

  const totals = useMemo(() => {
    let bytes = 0
    let files = 0
    for (const plan of usable) {
      const state = per[plan.gameId]
      if (!state) continue
      for (const row of rowsFor(plan)) {
        if (!state.picked.has(row.path)) continue
        bytes += row.sizeBytes
        files += row.fileCount
      }
    }
    return { bytes, files }
  }, [usable, per, rowsFor])

  const anyPicked = useMemo(
    () => usable.some((p) => (per[p.gameId]?.picked.size ?? 0) > 0),
    [usable, per]
  )
  const tight = freeBytes !== null && totals.bytes > freeBytes

  const start = async (): Promise<void> => {
    const jobs: SaveBackupJob[] = usable
      .map((plan) => ({ gameId: plan.gameId, include: [...(per[plan.gameId]?.picked ?? [])] }))
      .filter((j) => j.include.length > 0)
    if (remember) void window.sakura.updateSettings({ backupDir: destRoot })
    setResults(null)
    setRunning(true)
    const started = await window.sakura.startSaveBackup(jobs, destRoot)
    if (!started.ok) {
      setRunning(false)
      onToast(started.error ?? t('saves.cantStart'), true)
    }
  }

  const row = (plan: SavePlan, item: SaveCandidate): React.JSX.Element => {
    const state = per[plan.gameId]
    return (
      <label className="share-row" key={item.path}>
        <input
          type="checkbox"
          checked={state?.picked.has(item.path) ?? false}
          onChange={() => toggle(plan.gameId, item.path)}
        />
        <span className="share-rel" title={item.path}>
          {item.isDir ? '📁 ' : ''}
          {item.label}
        </span>
        <span className="share-why">
          {item.reason}
          {item.prepacked && <b className="share-warn"> {t('saves.prepacked')}</b>}
          {item.oversized && <b className="share-warn"> {t('saves.oversized')}</b>}
        </span>
        <span className="share-size">
          {item.byHand && item.fileCount === 0
            ? ''
            : item.fileCount === 0
              ? t('saves.empty')
              : formatBytes(item.sizeBytes)}
        </span>
      </label>
    )
  }

  const sections = (plan: SavePlan): React.JSX.Element => {
    const all = rowsFor(plan)
    const strong = all.filter((c) => c.confidence === 'strong')
    const weak = all.filter((c) => c.confidence === 'weak')
    return (
      <div className="share-sections">
        {plan.baselineMs === null && (
          <p className="saves-note">{t('saves.baselineNote', { name: plan.gameName })}</p>
        )}

        {strong.length > 0 && (
          <div className="import-section">
            <div className="import-section-head">
              <b>{t('saves.strongHead', { n: strong.length })}</b>
              <span>{t('saves.strongHint')}</span>
            </div>
            {strong.map((item) => row(plan, item))}
          </div>
        )}

        {weak.length > 0 && (
          <div className="import-section">
            <div className="import-section-head">
              <b>{t('saves.weakHead', { n: weak.length })}</b>
              <span>{t('saves.weakHint')}</span>
            </div>
            {weak.map((item) => row(plan, item))}
          </div>
        )}

        {all.length === 0 && <p className="share-empty">{t('saves.nothingFound')}</p>}

        {/* Always on screen, including when exactly one location was found: a search
            that cannot be complete must not look complete. */}
        <div className="share-add">
          <span>{t('saves.addYourOwn')}</span>
          <button type="button" className="btn ghost small" onClick={() => void addOwn(plan, 'file')}>
            {t('saves.addFile')}
          </button>
          <button type="button" className="btn ghost small" onClick={() => void addOwn(plan, 'dir')}>
            {t('saves.addFolder')}
          </button>
        </div>
      </div>
    )
  }

  if (results) {
    const ok = results.filter((r) => r.ok)
    return (
      <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal">
          <div className="step">{t('saves.step')}</div>
          <h2>{ok.length > 0 ? t('saves.doneTitle') : t('saves.noneTitle')}</h2>
          <div className="import-list">
            {results.map((r) => {
              const plan = plans.find((p) => p.gameId === r.gameId)
              return (
                <div className="share-result" key={r.gameId}>
                  <span className="share-rel">{plan?.gameName ?? r.gameId}</span>
                  {r.ok ? (
                    <>
                      <span className="share-why" title={r.dest}>
                        {t('saves.result', {
                          files: r.files ?? 0,
                          size: formatBytes(r.bytes ?? 0)
                        })}
                        {r.unreadable ? t('saves.unreadable', { n: r.unreadable }) : ''}
                      </span>
                      <button
                        type="button"
                        className="btn ghost small"
                        onClick={() => void window.sakura.openPath(r.dest!)}
                      >
                        {t('saves.openLocation')}
                      </button>
                    </>
                  ) : (
                    <span className="share-why error">
                      {r.skipped ? t('saves.cancelled') : r.error}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
          <p className="share-note">{t('saves.untouched')}</p>
          <p className="saves-note">{t('saves.noRestore')}</p>
          <div className="modal-actions">
            <button type="button" className="btn primary" onClick={onClose}>
              {t('saves.gotIt')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}
    >
      <div className="modal import-modal">
        <div className="step">{t('saves.step')}</div>
        <h2>{usable.length > 1 ? t('saves.titleN', { n: usable.length }) : t('saves.title')}</h2>
        <p className="share-lede">{t('saves.lede')}</p>

        {blocked.length > 0 && (
          <div className="share-blocked">
            {blocked.map((b) => (
              <div key={b.gameId}>
                {t('saves.blocked', { name: b.gameName, reason: b.blocked ?? '' })}
              </div>
            ))}
          </div>
        )}

        {running ? (
          <>
            <p className="bulk-progress-label">
              {t('saves.progress', { i: progress?.index ?? 1, n: usable.length })}
              {plans.find((p) => p.gameId === progress?.gameId)?.gameName ?? ''}
            </p>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${progress?.percent ?? 0}%` }} />
            </div>
          </>
        ) : (
          <div className="import-list">
            {usable.map((plan) => (
              <div className="share-game" key={plan.gameId}>
                <div className="share-game-head">
                  <span className="share-rel saves-name">{plan.gameName}</span>
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => setExpanded(expanded === plan.gameId ? null : plan.gameId)}
                  >
                    {expanded === plan.gameId
                      ? t('saves.collapse')
                      : t('saves.selectedN', { n: per[plan.gameId]?.picked.size ?? 0 })}
                  </button>
                </div>
                {expanded === plan.gameId && sections(plan)}
              </div>
            ))}
          </div>
        )}

        {!running && (
          <div className="share-options">
            <label>
              <span>{t('saves.saveTo')}</span>
              <input
                className="field"
                value={destRoot}
                onChange={(e) => setDestRoot(e.target.value)}
                spellCheck={false}
              />
              <button
                type="button"
                className="btn ghost small"
                onClick={async () => {
                  const picked = await window.sakura.pickBackupDir()
                  if (picked) setDestRoot(picked)
                }}
              >
                {t('saves.browse')}
              </button>
            </label>

            <label className="share-check">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span>{t('saves.remember')}</span>
            </label>

            <div className="share-estimate">
              {t('saves.estimate', {
                size: formatBytes(totals.bytes),
                files: totals.files
              })}
              {freeBytes !== null && t('saves.freeSpace', { size: formatBytes(freeBytes) })}
            </div>
            {tight && (
              <div className="share-blocked">
                {t('saves.notEnoughSpace', {
                  needed: formatBytes(totals.bytes),
                  free: formatBytes(freeBytes ?? 0)
                })}
              </div>
            )}
            <p className="saves-note">{t('saves.noRestore')}</p>
          </div>
        )}

        <div className="modal-actions">
          {running ? (
            <button
              type="button"
              className="btn ghost"
              onClick={() => void window.sakura.cancelSaveBackup()}
            >
              {t('saves.cancelBackup')}
            </button>
          ) : (
            <>
              <button type="button" className="btn ghost" onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!anyPicked || !destRoot}
                onClick={() => void start()}
              >
                {t('saves.start')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
