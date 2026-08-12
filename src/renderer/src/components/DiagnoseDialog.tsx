import { useCallback, useEffect, useState } from 'react'
import type { MessageKey } from '../../../shared/i18n'
import type {
  Diagnosis,
  DiagnosisCheck,
  DiagnosisSeverity,
  Game,
  LaunchTrouble
} from '../../../shared/types'
import { ENGINE_LABEL } from '../../../shared/types'
import { useT } from '../lib/i18n'

interface Props {
  game: Game
  /**
   * The launch this is about, when it followed a specific failure. Decides which crash
   * logs count as fresh.
   */
  since?: number
  /** Set when the dialog was opened by a failed launch rather than by the user. */
  trouble?: LaunchTrouble
  onPickExe: () => void
  onClose: () => void
  toast: (message: string, bad?: boolean) => void
}

const SEVERITY_KEY: Record<DiagnosisSeverity, MessageKey> = {
  blocker: 'diag.sev.blocker',
  likely: 'diag.sev.likely',
  note: 'diag.sev.note'
}

/**
 * Why the game did not start.
 *
 * The launcher's oldest promise is that a double-click that does nothing should have an
 * answer, and until now it could only say whether a process appeared. This says why one
 * did not: which runtime is missing, whether the executable demands elevation, whether
 * the chosen program was an uninstaller all along, what the engine wrote on its way down.
 *
 * Two rules shape how it reads. Findings lead with the ones that provably block a launch,
 * so a long list still opens with the answer. And when nothing is found it says what it
 * looked at instead of going quiet — "we checked these eight things" is information,
 * a blank panel is not.
 */
export default function DiagnoseDialog({
  game,
  since,
  trouble,
  onPickExe,
  onClose,
  toast
}: Props): React.JSX.Element {
  const t = useT()
  const [result, setResult] = useState<Diagnosis | null>(null)
  const [running, setRunning] = useState(true)
  const [elevating, setElevating] = useState(false)

  const run = useCallback(async (): Promise<void> => {
    setRunning(true)
    try {
      setResult(await window.sakura.diagnose(game.id, since))
    } finally {
      setRunning(false)
    }
  }, [game.id, since])

  useEffect(() => {
    void run()
  }, [run])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const runElevated = useCallback(async (): Promise<void> => {
    setElevating(true)
    try {
      const res = await window.sakura.launchElevated(game.id)
      if (res.ok) {
        toast(t('diag.elevated.ok', { name: game.name }))
        onClose()
      } else {
        toast(res.error ?? t('diag.elevated.failed'), true)
      }
    } finally {
      setElevating(false)
    }
  }, [game.id, game.name, onClose, t, toast])

  const actionFor = (check: DiagnosisCheck): React.JSX.Element | null => {
    switch (check.action) {
      case 'pickExe':
        return (
          <button type="button" className="btn primary small" onClick={onPickExe}>
            {t('menu.chooseExe')}
          </button>
        )
      case 'runAsAdmin':
        return (
          <button
            type="button"
            className="btn primary small"
            disabled={elevating}
            onClick={() => void runElevated()}
          >
            {elevating ? t('diag.elevating') : t('diag.runAsAdmin')}
          </button>
        )
      case 'openLog':
      case 'revealDir':
        return (
          <button
            type="button"
            className="btn ghost small"
            onClick={() => void window.sakura.openPath(check.actionPath ?? game.dir)}
          >
            {t('common.showInExplorer')}
          </button>
        )
      default:
        return null
    }
  }

  const lede = (): string => {
    if (trouble === 'earlyexit') return t('diag.lede.earlyexit')
    if (trouble === 'noshow') return t('diag.lede.noshow')
    if (trouble === 'dialog') return t('diag.lede.dialog')
    return t('diag.lede.manual')
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal import-modal">
        <div className="step">{t('diag.step')}</div>
        <h2 title={game.dir}>{t('common.quoted', { name: game.name })}</h2>
        <p className="exe-lede">{lede()}</p>

        {running && <p className="diag-empty">{t('diag.running')}</p>}

        {!running && result && (
          <div className="import-list">
            {result.checks.length === 0 && (
              <div className="diag-clean">
                <b>{t('diag.clean.title')}</b>
                <p>{t('diag.clean.detail')}</p>
                <ul>
                  {result.checked.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            )}

            {result.checks.map((check, i) => (
              <div className={`diag-row ${check.severity}`} key={`${check.code}-${i}`}>
                <div className="diag-head">
                  <span className={`diag-chip ${check.severity}`}>
                    {t(SEVERITY_KEY[check.severity])}
                  </span>
                  <b>{check.title}</b>
                </div>
                <p className="diag-detail">{check.detail}</p>
                {check.reasons.length > 0 && (
                  <div className="diag-why">
                    {t('diag.becauseOf', { reasons: check.reasons.join(' · ') })}
                  </div>
                )}
                {check.excerpt && <pre className="diag-log">{check.excerpt}</pre>}
                <div className="exe-actions">{actionFor(check)}</div>
              </div>
            ))}

            <div className="diag-facts">
              {result.engine && (
                <span title={t(`engine.${result.engine}.note` as MessageKey)}>
                  {t('diag.fact.engine', { engine: ENGINE_LABEL[result.engine] })}
                </span>
              )}
              {result.arch && <span>{t('diag.fact.arch', { arch: result.arch })}</span>}
              {result.checks.length > 0 && (
                <span>{t('diag.fact.checked', { n: result.checked.length })}</span>
              )}
            </div>
          </div>
        )}

        {!running && !result && <p className="diag-empty">{t('diag.gone')}</p>}

        <div className="modal-actions">
          <button type="button" className="btn ghost" disabled={running} onClick={() => void run()}>
            {t('diag.recheck')}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
