import { useCallback, useEffect, useState } from 'react'
import type { MessageKey } from '../../../shared/i18n'
import type {
  Diagnosis,
  DiagnosisCheck,
  DiagnosisSeverity,
  Game,
  LaunchTrouble,
  RepairId,
  RepairOffer,
  RepairRecord
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
  const [offers, setOffers] = useState<RepairOffer[]>([])
  const [made, setMade] = useState<RepairRecord[]>([])
  /** Which repair is running, so two cannot be started at once. */
  const [busy, setBusy] = useState<RepairId | null>(null)

  const run = useCallback(async (): Promise<void> => {
    setRunning(true)
    try {
      setResult(await window.sakura.diagnose(game.id, since))
      // Asked separately and after, so a repair layer that throws cannot take the
      // diagnosis down with it — the findings are worth having on their own.
      // `trouble` goes over too. Some offers are only honest about a game that actually
      // failed — a locale emulator recommended for a working Chinese translation is the
      // one change that would break it.
      setOffers(await window.sakura.repairOffers(game.id, since, trouble))
      setMade(await window.sakura.repairsMade(game.id))
    } finally {
      setRunning(false)
    }
  }, [game.id, since, trouble])

  const doRepair = useCallback(
    async (id: RepairId): Promise<void> => {
      setBusy(id)
      try {
        const res = await window.sakura.applyRepair(game.id, id)
        toast(res.message, !res.ok)
        // Re-read rather than patching state locally: the whole point of a repair is that
        // the machine is now different, and the only honest way to say what is left is to
        // look again.
        if (res.ok) await run()
      } finally {
        setBusy(null)
      }
    },
    [game.id, run, toast]
  )

  const doUndo = useCallback(
    async (record: RepairRecord): Promise<void> => {
      setBusy(record.id)
      try {
        const res = await window.sakura.undoRepair(record)
        toast(res.message, !res.ok)
        if (res.ok) await run()
      } finally {
        setBusy(null)
      }
    },
    [run, toast]
  )

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

            {/* Below the findings, never above them. A repair is an answer to something
                the list above established, and putting a button first would invite
                pressing it before reading what it is for. */}
            {offers.length > 0 && (
              <>
                <div className="section-title">{t('repair.section')}</div>
                {offers.map((offer) => (
                  <div className="diag-row likely" key={offer.id}>
                    <div className="diag-head">
                      <b>{offer.title}</b>
                      {offer.needsAdmin && (
                        <span className="diag-chip note">{t('repair.needsAdmin')}</span>
                      )}
                    </div>
                    <p className="diag-detail">{offer.detail}</p>
                    {offer.reasons.length > 0 && (
                      <div className="diag-why">
                        {t('diag.becauseOf', { reasons: offer.reasons.join(' · ') })}
                      </div>
                    )}
                    {/* What it will change, listed before it can be pressed. This is the
                        thing that makes declining possible, so it is never summarised. */}
                    {offer.changes.length > 0 && (
                      <div className="diag-why">
                        {t('repair.changes')}
                        <ul style={{ margin: '4px 0 0 18px' }}>
                          {offer.changes.map((c) => (
                            <li key={c}>{c}</li>
                          ))}
                        </ul>
                        {!offer.undoable && <div>{t('repair.notUndoable')}</div>}
                      </div>
                    )}
                    {offer.command && <pre className="diag-log">{offer.command}</pre>}
                    <div className="exe-actions">
                      {offer.kind === 'act' ? (
                        <button
                          type="button"
                          className="btn primary small"
                          disabled={busy !== null}
                          onClick={() => void doRepair(offer.id)}
                        >
                          {busy === offer.id ? t('repair.applying') : t('repair.apply')}
                        </button>
                      ) : offer.command ? (
                        <button
                          type="button"
                          className="btn ghost small"
                          onClick={() => {
                            void navigator.clipboard.writeText(offer.command ?? '')
                            toast(t('repair.copied'))
                          }}
                        >
                          {t('repair.copyCommand')}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* Anything already done, with the way back. A repair whose undo is not on
                screen is a repair the user has to remember they made. */}
            {made.length > 0 && (
              <>
                <div className="section-title">{t('repair.doneSection')}</div>
                {made.map((record) => (
                  <div className="diag-row note" key={`${record.id}-${record.at}`}>
                    <div className="diag-head">
                      <b>{record.summary}</b>
                    </div>
                    <div className="exe-actions">
                      <button
                        type="button"
                        className="btn ghost small"
                        disabled={busy !== null}
                        onClick={() => void doUndo(record)}
                      >
                        {t('repair.undo')}
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}

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
