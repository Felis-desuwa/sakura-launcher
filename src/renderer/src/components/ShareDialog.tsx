import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ShareCategory,
  ShareFormat,
  ShareJob,
  ShareOptions,
  SharePlan,
  ShareResult
} from '../../../shared/types'
import { SHARE_FORMATS } from '../../../shared/types'
import type { MessageKey } from '../../../shared/i18n'
import { formatBytes } from '../lib/format'
import { useT } from '../lib/i18n'

interface Props {
  plans: SharePlan[]
  onClose: () => void
  onToast: (message: string, error?: boolean) => void
}

/** Categories in the order they are shown; `config` last because it is the risky one. */
const ORDER: ShareCategory[] = ['launcher', 'save', 'noise', 'config']

interface PerGame {
  name: string
  /** Absolute paths of the ticked candidates. */
  excluded: Set<string>
  /** Extra paths the user added by hand. */
  extra: { path: string; rel: string }[]
}

/**
 * Packing a game up to send to someone.
 *
 * The whole dialog is built around one fact: the game folder is never written to.
 * Personal data is kept *out of the archive*, not removed from disk, so there is nothing
 * here to undo and no reason for a confirmation ritual — the worst a wrong tick can do
 * is produce an archive worth deleting.
 *
 * What it does need is the user's eyes on the exclusion list, because the rules can be
 * wrong in a way that is expensive: a `.dat` file is a save in one engine and the entire
 * game in another, and an archive missing the latter is not discovered until someone
 * else tries to run it.
 */
export default function ShareDialog({ plans, onClose, onToast }: Props): React.JSX.Element {
  const t = useT()
  const shareable = useMemo(() => plans.filter((p) => !p.blocked), [plans])
  const blocked = useMemo(() => plans.filter((p) => p.blocked), [plans])

  const [format, setFormat] = useState<ShareFormat>('7z')
  const [password, setPassword] = useState('')
  const [encryptNames, setEncryptNames] = useState(true)
  const [outDir, setOutDir] = useState(shareable[0]?.suggestedDir ?? '')
  const [overwrite, setOverwrite] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(
    shareable.length === 1 ? shareable[0].gameId : null
  )
  const [per, setPer] = useState<Record<string, PerGame>>({})

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ gameId: string; percent: number; index: number }>()
  const [results, setResults] = useState<ShareResult[] | null>(null)
  const [freeBytes, setFreeBytes] = useState<number | null>(null)

  useEffect(() => {
    const next: Record<string, PerGame> = {}
    for (const plan of shareable) {
      next[plan.gameId] = {
        name: plan.suggestedName,
        excluded: new Set(plan.candidates.filter((c) => c.checked).map((c) => c.path)),
        extra: []
      }
    }
    setPer(next)
  }, [shareable])

  useEffect(() => {
    if (!outDir) return
    void window.sakura.shareFreeSpace(outDir).then(setFreeBytes)
  }, [outDir])

  useEffect(() => {
    const offProgress = window.sakura.onShareProgress((p) => setProgress(p))
    const offDone = window.sakura.onShareDone((r) => {
      setRunning(false)
      setResults(r)
      const ok = r.filter((x) => x.ok).length
      const failed = r.filter((x) => !x.ok && !x.skipped).length
      if (failed === 0 && ok > 0) onToast(t('share.packedN', { n: ok }))
      else if (ok > 0) onToast(t('share.partial', { ok, bad: failed }), true)
      else if (failed > 0) onToast(t('share.allFailed'), true)
    })
    return () => {
      offProgress()
      offDone()
    }
  }, [onToast])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !running) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, running])

  const patch = useCallback((gameId: string, change: Partial<PerGame>): void => {
    setPer((cur) => ({ ...cur, [gameId]: { ...cur[gameId], ...change } }))
  }, [])

  const toggle = (gameId: string, filePath: string): void => {
    setPer((cur) => {
      const next = new Set(cur[gameId].excluded)
      if (next.has(filePath)) next.delete(filePath)
      else next.add(filePath)
      return { ...cur, [gameId]: { ...cur[gameId], excluded: next } }
    })
  }

  const addExtra = async (plan: SharePlan, kind: 'file' | 'dir'): Promise<void> => {
    const picked = await window.sakura.pickInside(plan.dir, kind)
    if (!picked) return
    const rel = picked.slice(plan.dir.length + 1) || picked
    setPer((cur) => {
      const state = cur[plan.gameId]
      if (state.extra.some((e) => e.path === picked)) return cur
      const excluded = new Set(state.excluded)
      excluded.add(picked)
      return {
        ...cur,
        [plan.gameId]: { ...state, excluded, extra: [...state.extra, { path: picked, rel }] }
      }
    })
  }

  /** Bytes that will actually be written, near enough to warn on: folder minus exclusions. */
  const plannedBytes = useMemo(
    () =>
      shareable.reduce((sum, plan) => {
        const state = per[plan.gameId]
        if (!state) return sum + plan.sizeBytes
        const skipped = plan.candidates
          .filter((c) => state.excluded.has(c.path))
          .reduce((n, c) => n + c.sizeBytes, 0)
        return sum + Math.max(0, plan.sizeBytes - skipped)
      }, 0),
    [shareable, per]
  )

  const nameProblem = useMemo(() => {
    const names = shareable.map((p) => per[p.gameId]?.name?.trim() ?? '')
    if (names.some((n) => n.length === 0)) return t('share.nameEmpty')
    if (new Set(names).size !== names.length) return t('share.nameClash')
    return null
  }, [shareable, per])

  const tight = freeBytes !== null && plannedBytes > freeBytes

  const start = async (): Promise<void> => {
    const jobs: ShareJob[] = shareable.map((plan) => ({
      gameId: plan.gameId,
      name: per[plan.gameId].name.trim(),
      outDir,
      exclude: [...per[plan.gameId].excluded]
    }))
    const options: ShareOptions = { format, password, encryptNames, overwrite }
    setResults(null)
    setRunning(true)
    const started = await window.sakura.shareStart(jobs, options)
    if (!started.ok) {
      setRunning(false)
      onToast(started.error ?? t('share.cantStart'), true)
    }
  }

  const sections = (plan: SharePlan): React.JSX.Element => {
    const state = per[plan.gameId]
    if (!state) return <></>
    return (
      <div className="share-sections">
        {ORDER.map((category) => {
          const items = plan.candidates.filter((c) => c.category === category)
          if (items.length === 0) return null
          return (
            <div className="import-section" key={category}>
              <div className="import-section-head">
                <b>
                  {t(`share.cat.${category}` as MessageKey)} ({items.length})
                </b>
                <span>{t(`share.cat.${category}.hint` as MessageKey)}</span>
              </div>
              {items.map((item) => (
                <label className="share-row" key={item.path}>
                  <input
                    type="checkbox"
                    checked={state.excluded.has(item.path)}
                    onChange={() => toggle(plan.gameId, item.path)}
                  />
                  <span className="share-rel" title={item.path}>
                    {item.isDir ? '📁 ' : ''}
                    {item.rel}
                  </span>
                  <span className="share-why">
                    {item.reason}
                    {item.oversized && (
                      <b className="share-warn">
                        {' '}
                        {t('share.oversized')}
                      </b>
                    )}
                  </span>
                  <span className="share-size">{formatBytes(item.sizeBytes)}</span>
                </label>
              ))}
            </div>
          )
        })}

        {state.extra.length > 0 && (
          <div className="import-section">
            <div className="import-section-head">
              <b>{t('share.yourOwn', { n: state.extra.length })}</b>
              <span>{t('share.yourOwnHint')}</span>
            </div>
            {state.extra.map((e) => (
              <label className="share-row" key={e.path}>
                <input
                  type="checkbox"
                  checked={state.excluded.has(e.path)}
                  onChange={() => toggle(plan.gameId, e.path)}
                />
                <span className="share-rel" title={e.path}>
                  {e.rel}
                </span>
                <span className="share-why">{t('share.addedByHand')}</span>
              </label>
            ))}
          </div>
        )}

        {plan.candidates.length === 0 && state.extra.length === 0 && (
          <p className="share-empty">{t('share.nothingFound')}</p>
        )}

        <div className="share-add">
          <span>{t('share.addYourOwn')}</span>
          <button type="button" className="btn ghost small" onClick={() => void addExtra(plan, 'file')}>
            {t('share.addFile')}
          </button>
          <button type="button" className="btn ghost small" onClick={() => void addExtra(plan, 'dir')}>
            {t('share.addFolder')}
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
          <div className="step">{t('share.step')}</div>
          <h2>{ok.length > 0 ? t('share.doneTitle') : t('share.noneTitle')}</h2>
          <div className="import-list">
            {results.map((r) => {
              const plan = plans.find((p) => p.gameId === r.gameId)
              return (
                <div className="share-result" key={r.gameId}>
                  <span className="share-rel">{plan?.gameName ?? r.gameId}</span>
                  {r.ok ? (
                    <>
                      <span className="share-why" title={r.file}>
                        {r.file}
                      </span>
                      <button
                        type="button"
                        className="btn ghost small"
                        onClick={() => void window.sakura.openPath(r.file!)}
                      >
                        {t('share.openLocation')}
                      </button>
                    </>
                  ) : (
                    <span className="share-why error">{r.skipped ? t('share.cancelled') : r.error}</span>
                  )}
                </div>
              )
            })}
          </div>
          <p className="share-note">{t('share.untouched')}</p>
          <div className="modal-actions">
            <button type="button" className="btn primary" onClick={onClose}>
              {t('share.gotIt')}
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
        <div className="step">{t('share.step')}</div>
        <h2>
          {t('share.packN', { n: shareable.length })}
          {shareable.length > 1 && <span className="share-sub">{t('share.onePerGame')}</span>}
        </h2>
        <p className="share-lede">
          {t('share.lede')}
        </p>

        {blocked.length > 0 && (
          <div className="share-blocked">
            {blocked.map((b) => (
              <div key={b.gameId}>
                {t('share.blocked', { name: b.gameName, reason: b.blocked ?? '' })}
              </div>
            ))}
          </div>
        )}

        {running ? (
          <>
            <p className="bulk-progress-label">
              {t('share.progress', { i: progress?.index ?? 1, n: shareable.length })}
              {plans.find((p) => p.gameId === progress?.gameId)?.gameName ?? ''}
            </p>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${progress?.percent ?? 0}%` }} />
            </div>
            <p className="share-note">{t('share.slowNote')}</p>
          </>
        ) : (
          <div className="import-list">
            {shareable.map((plan) => (
              <div className="share-game" key={plan.gameId}>
                <div className="share-game-head">
                  <input
                    className="field share-name"
                    value={per[plan.gameId]?.name ?? ''}
                    onChange={(e) => patch(plan.gameId, { name: e.target.value })}
                    spellCheck={false}
                  />
                  <span className="share-ext">{format === 'zip' ? '.zip' : '.7z'}</span>
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() =>
                      setExpanded(expanded === plan.gameId ? null : plan.gameId)
                    }
                  >
                    {expanded === plan.gameId
                      ? t('share.collapse')
                      : t('share.excludedN', { n: per[plan.gameId]?.excluded.size ?? 0 })}
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
              <span>{t('share.format')}</span>
              <select value={format} onChange={(e) => setFormat(e.target.value as ShareFormat)}>
                {SHARE_FORMATS.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
              <em>{t(`share.format.${format}.note` as MessageKey)}</em>
            </label>

            <label>
              <span>{t('share.password')}</span>
              <input
                className="field"
                type="password"
                value={password}
                placeholder={t('share.passwordPlaceholder')}
                autoComplete="new-password"
                onChange={(e) => setPassword(e.target.value)}
              />
              <em>
                {format === '7z'
                  ? t('share.password7zNote')
                  : t('share.passwordZipNote')}
              </em>
            </label>

            {format === '7z' && password && (
              <label className="share-check">
                <input
                  type="checkbox"
                  checked={encryptNames}
                  onChange={(e) => setEncryptNames(e.target.checked)}
                />
                <span>{t('share.encryptNames')}</span>
              </label>
            )}

            <label>
              <span>{t('share.saveTo')}</span>
              <input className="field" value={outDir} onChange={(e) => setOutDir(e.target.value)} />
              <button
                type="button"
                className="btn ghost small"
                onClick={async () => {
                  const picked = await window.sakura.pickFolder()
                  if (picked) setOutDir(picked)
                }}
              >
                {t('share.browse')}
              </button>
            </label>

            <label className="share-check">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
              />
              <span>{t('share.overwrite')}</span>
            </label>

            <div className="share-estimate">
              {t('share.estimate', { size: formatBytes(plannedBytes) })}
              {freeBytes !== null && t('share.freeSpace', { size: formatBytes(freeBytes) })}
            </div>
            {tight && (
              <div className="share-blocked">
                {t('share.notEnoughSpace', {
                  needed: formatBytes(plannedBytes),
                  free: formatBytes(freeBytes ?? 0)
                })}
              </div>
            )}
            {nameProblem && <div className="share-blocked">{nameProblem}</div>}
          </div>
        )}

        <div className="modal-actions">
          {running ? (
            <button
              type="button"
              className="btn ghost"
              onClick={() => void window.sakura.shareCancel()}
            >
              {t('share.cancelPacking')}
            </button>
          ) : (
            <>
              <button type="button" className="btn ghost" onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={shareable.length === 0 || !outDir || nameProblem !== null}
                onClick={() => void start()}
              >
                {t('share.start')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
