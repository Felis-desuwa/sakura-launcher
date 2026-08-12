import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ExeChoice, ExeChoices, Game } from '../../../shared/types'
import { formatBytes } from '../lib/format'
import { useT } from '../lib/i18n'

interface Props {
  game: Game
  data: ExeChoices
  onApply: (exePath: string, args: string[]) => Promise<void>
  onDiagnose: () => void
  onClose: () => void
}

/** How the trial run turned out for one candidate. */
type Trial = 'running' | 'alive' | 'dead' | 'busy' | 'failed'

/** When to look for a process after starting one. Games are not always quick. */
const PROBE_DELAYS_MS = [3000, 6000, 10_000]

interface Section {
  key: string
  title: string
  hint: string
  items: ExeChoice[]
  /** Collapsed until asked for — the tools are the long tail, not the answer. */
  folded?: boolean
}

/**
 * Choosing which executable actually starts a game.
 *
 * A folder can hold a dozen of them — engine, patches, two uninstallers, a handful of
 * locale emulators — with nothing in the names to tell them apart. So each one is shown
 * with what it looks like and why the scanner scored it as it did, and can be tried
 * once on the spot: the launcher then goes and looks for a process in the game folder,
 * which turns "did that do anything?" into an answer.
 */
export default function ExeChooserDialog({
  game,
  data,
  onApply,
  onDiagnose,
  onClose
}: Props): React.JSX.Element {
  const t = useT()
  const [trials, setTrials] = useState<Record<string, Trial>>({})
  /** Which folded sections have been opened, by section key. */
  const [opened, setOpened] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [wrapper, setWrapper] = useState('')
  const [payload, setPayload] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const locales = useMemo(() => data.choices.filter((c) => c.kind === 'locale'), [data])
  const startable = useMemo(
    () => data.choices.filter((c) => c.kind !== 'locale' && c.kind !== 'uninstall'),
    [data]
  )

  useEffect(() => {
    if (locales.length > 0 && !wrapper) setWrapper(locales[0].fullPath)
  }, [locales, wrapper])
  useEffect(() => {
    if (startable.length > 0 && !payload) {
      setPayload((startable.find((c) => c.rankable) ?? startable[0]).fullPath)
    }
  }, [startable, payload])

  const sections = useMemo<Section[]>(
    () =>
      [
        {
          key: 'main',
          title: t('exe.sec.main'),
          hint: t('exe.sec.mainHint'),
          items: data.choices.filter(
            (c) => c.rankable && (c.kind === 'main' || c.kind === 'launcher')
          )
        },
        {
          key: 'locale',
          title: t('exe.sec.locale'),
          hint: t('exe.sec.localeHint'),
          items: locales
        },
        {
          key: 'tool',
          title: t('exe.sec.tool'),
          hint: t('exe.sec.toolHint'),
          items: data.choices.filter(
            (c) => c.kind === 'patch' || c.kind === 'tool' || c.kind === 'uninstall'
          ),
          folded: true
        },
        {
          key: 'sub',
          title: t('exe.sec.sub'),
          hint: t('exe.sec.subHint'),
          items: data.choices.filter((c) => c.kind === 'sub'),
          folded: true
        }
      ].filter((s) => s.items.length > 0),
    [data, locales]
  )

  const runTrial = useCallback(
    async (choice: ExeChoice): Promise<void> => {
      setTrials((cur) => ({ ...cur, [choice.fullPath]: 'running' }))

      // Take a baseline first: the game may already be open, and crediting this
      // executable for a process that was there all along would be a lie.
      const before = await window.sakura.probeRunning(game.id)
      if (before === true) {
        setTrials((cur) => ({ ...cur, [choice.fullPath]: 'busy' }))
        return
      }

      const started = await window.sakura.tryExe(game.id, choice.fullPath)
      if (!started.ok) {
        setTrials((cur) => ({ ...cur, [choice.fullPath]: 'failed' }))
        return
      }

      let last = 0
      for (const delay of PROBE_DELAYS_MS) {
        await new Promise((r) => setTimeout(r, delay - last))
        last = delay
        if (await window.sakura.probeRunning(game.id)) {
          setTrials((cur) => ({ ...cur, [choice.fullPath]: 'alive' }))
          return
        }
      }
      setTrials((cur) => ({ ...cur, [choice.fullPath]: 'dead' }))
    },
    [game.id]
  )

  const apply = useCallback(
    async (exePath: string, args: string[]): Promise<void> => {
      setBusy(true)
      try {
        await onApply(exePath, args)
      } finally {
        setBusy(false)
      }
    },
    [onApply]
  )

  const trialNote = (state: Trial | undefined): React.JSX.Element | null => {
    if (!state) return null
    const text: Record<Trial, string> = {
      running: t('exe.trial.running'),
      alive: t('exe.trial.alive'),
      dead: t('exe.trial.dead'),
      busy: t('exe.trial.busy'),
      failed: t('exe.trial.failed')
    }
    return <span className={`exe-trial ${state}`}>{text[state]}</span>
  }

  const row = (choice: ExeChoice): React.JSX.Element => (
    <div className={`exe-row${choice.current ? ' current' : ''}`} key={choice.fullPath}>
      <div className="exe-main">
        <span className="exe-name" title={choice.fullPath}>
          {choice.rel}
        </span>
        <span className={`exe-chip ${choice.kind}`}>{choice.label}</span>
        {choice.current && <span className="exe-chip current">{t('exe.current')}</span>}
        <span className="exe-size">{formatBytes(choice.sizeBytes)}</span>
      </div>
      <div className="exe-why">
        {choice.reasons.length > 0 ? choice.reasons.join(' · ') : t('exe.noFeatures')}
        {trialNote(trials[choice.fullPath])}
      </div>
      <div className="exe-actions">
        {/* A trial that came up empty is the exact moment the question changes from
            "which one?" to "why not?" — so that is where the diagnosis is offered. */}
        {(trials[choice.fullPath] === 'dead' || trials[choice.fullPath] === 'failed') && (
          <button type="button" className="btn ghost small" onClick={onDiagnose}>
            {t('exe.whyNot')}
          </button>
        )}
        <button
          type="button"
          className="btn ghost small"
          disabled={trials[choice.fullPath] === 'running'}
          onClick={() => void runTrial(choice)}
        >
          {t('exe.tryRun')}
        </button>
        <button
          type="button"
          className="btn primary small"
          disabled={busy || choice.current}
          onClick={() => void apply(choice.fullPath, [])}
        >
          {choice.current ? t('exe.isMain') : t('exe.setMain')}
        </button>
      </div>
    </div>
  )

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal import-modal">
        <div className="step">{t('exe.step')}</div>
        <h2 title={data.dir}>《{game.name}》</h2>
        <p className="exe-lede">
          {t('exe.lede')}
          {!data.pinned && t('exe.notPinned')}
        </p>

        <div className="import-list">
          {sections.map((section) => {
            const collapsed = section.folded && !opened.has(section.key)
            return (
              <div className="import-section" key={section.key}>
                <div className="import-section-head">
                  <b>
                    {section.title} ({section.items.length})
                  </b>
                  <span>{section.hint}</span>
                </div>
                {collapsed ? (
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => setOpened((cur) => new Set(cur).add(section.key))}
                  >
                    {t('exe.expandN', { n: section.items.length })}
                  </button>
                ) : (
                  section.items.map(row)
                )}
              </div>
            )
          })}

          {locales.length > 0 && startable.length > 0 && (
            <div className="import-section">
              <div className="import-section-head">
                <b>{t('exe.combo')}</b>
                <span>{t('exe.comboHint')}</span>
              </div>
              <div className="exe-combo">
                <span>{t('exe.comboUse')}</span>
                <select value={wrapper} onChange={(e) => setWrapper(e.target.value)}>
                  {locales.map((c) => (
                    <option key={c.fullPath} value={c.fullPath}>
                      {c.rel}
                    </option>
                  ))}
                </select>
                <span>{t('exe.comboStart')}</span>
                <select value={payload} onChange={(e) => setPayload(e.target.value)}>
                  {startable.map((c) => (
                    <option key={c.fullPath} value={c.fullPath}>
                      {c.rel}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn primary small"
                  disabled={busy || !wrapper || !payload}
                  onClick={() => void apply(wrapper, [payload])}
                >
                  {t('exe.setMain')}
                </button>
              </div>
              <p className="exe-combo-note">
                {t('exe.comboNote')}
              </p>
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
