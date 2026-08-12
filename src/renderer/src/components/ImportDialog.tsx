import { useEffect, useMemo, useState } from 'react'
import type { ImportCandidate, ImportPreview } from '../../../preload/index'
import { formatBytes } from '../lib/format'
import { useT } from '../lib/i18n'

interface Props {
  preview: ImportPreview
  /** `accept` becomes games; `reject` is remembered so later scans stop offering it. */
  onConfirm: (accept: string[], reject: string[]) => void
  onCancel: () => void
}

interface Section {
  key: string
  title: string
  hint: string
  items: ImportCandidate[]
}

/**
 * Vet a folder before it joins the library.
 *
 * The scanner's judgement is shown rather than applied silently: what it took, what it
 * passed over and why. Ticking a box now is far less work than noticing weeks later
 * that a game never appeared, with nothing to explain it.
 */
export default function ImportDialog({ preview, onConfirm, onCancel }: Props): React.JSX.Element {
  const t = useT()
  const sections = useMemo<Section[]>(
    () =>
      [
        {
          key: 'games',
          title: t('import.sec.games'),
          hint: t('import.sec.gamesHint'),
          items: preview.games
        },
        {
          key: 'rejected',
          title: t('import.sec.maybe'),
          hint: t('import.sec.maybeHint'),
          items: preview.rejected
        },
        {
          key: 'archives',
          title: t('import.sec.archive'),
          hint: t('import.sec.archiveHint'),
          items: preview.archives
        }
      ].filter((s) => s.items.length > 0),
    [preview]
  )

  // Accepted and archived entries start ticked; the ones the scanner turned down do not.
  const [checked, setChecked] = useState<Set<string>>(new Set())
  useEffect(() => {
    setChecked(new Set([...preview.games, ...preview.archives].map((c) => c.dir)))
  }, [preview])

  const all = useMemo(
    () => [...preview.games, ...preview.rejected, ...preview.archives],
    [preview]
  )

  const totalBytes = all
    .filter((c) => checked.has(c.dir))
    .reduce((sum, c) => sum + (c.sizeBytes ?? 0), 0)

  const toggle = (dir: string): void =>
    setChecked((cur) => {
      const next = new Set(cur)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })

  const selectAll = (): void => setChecked(new Set(all.map((c) => c.dir)))
  const invert = (): void =>
    setChecked(new Set(all.filter((c) => !checked.has(c.dir)).map((c) => c.dir)))

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="modal import-modal">
        <div className="step">{t('import.step')}</div>
        <h2 title={preview.folder}>{preview.folder}</h2>

        <div className="import-toolbar">
          <span className="import-summary">
            {t('import.selected', { n: checked.size, total: all.length })}
            {totalBytes > 0 && t('import.totalBytes', { size: formatBytes(totalBytes) })}
          </span>
          <button type="button" className="btn ghost small" onClick={selectAll}>
            {t('import.selectAll')}
          </button>
          <button type="button" className="btn ghost small" onClick={invert}>
            {t('import.invert')}
          </button>
        </div>

        <div className="import-list">
          {sections.map((section) => (
            <div className="import-section" key={section.key}>
              <div className="import-section-head">
                <b>
                  {section.title} ({section.items.length})
                </b>
                <span>{section.hint}</span>
              </div>
              {section.items.map((item) => (
                <label className="import-row" key={item.dir}>
                  <input
                    type="checkbox"
                    checked={checked.has(item.dir)}
                    onChange={() => toggle(item.dir)}
                  />
                  <span className="import-name" title={item.dir}>
                    {item.name}
                  </span>
                  <span className="import-note">
                    {item.reason ??
                      (item.volumes && item.volumes.length > 1
                        ? t('import.volumes', { n: item.volumes.length })
                        : item.exe.split('\\').pop() ?? '')}
                  </span>
                  <span className="import-size">
                    {item.sizeBytes === null ? '' : formatBytes(item.sizeBytes)}
                  </span>
                </label>
              ))}
            </div>
          ))}
        </div>

        <p className="import-foot">
          {t('import.note')}
        </p>

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() =>
              onConfirm(
                all.filter((c) => checked.has(c.dir)).map((c) => c.dir),
                all.filter((c) => !checked.has(c.dir)).map((c) => c.dir)
              )
            }
          >
            {t('import.confirm', { n: checked.size })}
          </button>
        </div>
      </div>
    </div>
  )
}
