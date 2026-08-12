import { useEffect, useState } from 'react'
import type { MessageKey } from '../../../shared/i18n'
import type { Settings } from '../../../shared/types'
import { DOWNLOADERS, downloadDirFor } from '../../../shared/types'
import { useT } from '../lib/i18n'

interface Props {
  settings: Settings
  /** Resolves to the number of links accepted. */
  onStart: (urls: string[], dir: string) => Promise<void>
  onOpenSettings: () => void
  onClose: () => void
}

/**
 * Paste links, confirm where they land, hand them to the configured downloader.
 *
 * The destination is shown rather than assumed: the default follows the first library
 * folder, and getting it wrong means the finished download never reaches the library.
 */
export default function DownloadDialog({
  settings,
  onStart,
  onOpenSettings,
  onClose
}: Props): React.JSX.Element {
  const t = useT()
  const [text, setText] = useState('')
  const [dir, setDir] = useState<string | null>(downloadDirFor(settings))
  const [busy, setBusy] = useState(false)

  const meta = DOWNLOADERS.find((d) => d.key === settings.downloader)
  const needsPath =
    settings.downloaderPath === null && (settings.downloader === 'aria2' || settings.downloader === 'custom')

  const urls = text
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const start = async (): Promise<void> => {
    if (urls.length === 0 || !dir || busy) return
    setBusy(true)
    try {
      await onStart(urls, dir)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div className="modal download-modal">
        <div className="step">{t('top.download')}</div>
        <h2>{t('download.paste')}</h2>

        <textarea
          className="field download-urls"
          autoFocus
          spellCheck={false}
          placeholder={t('download.placeholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        <div className="download-row">
          <span className="download-label">{t('download.saveTo')}</span>
          <span className="download-value" title={dir ?? ''}>
            {dir ?? t('download.noDir')}
          </span>
          <button
            type="button"
            className="btn ghost small"
            onClick={async () => {
              const picked = await window.sakura.pickDownloadDir()
              if (picked) setDir(picked)
            }}
          >
            {t('download.change')}
          </button>
        </div>

        <div className="download-row">
          <span className="download-label">{t('download.downloader')}</span>
          <span className="download-value">{meta ? t(`downloader.${meta.key}` as MessageKey) : settings.downloader}</span>
          <button type="button" className="btn ghost small" onClick={onOpenSettings}>
            {t('download.openSettings')}
          </button>
        </div>

        <p className="download-note">
          {meta ? t(`downloader.${meta.key}.note` as MessageKey) : ''}
          {!meta?.controlsDir && ' ' + t('download.noDirControl')}
          {meta && !meta.reports && ' ' + t('download.autoImport')}
        </p>

        {needsPath && (
          <p className="download-warn">
            {t('download.needPath', { name: meta ? t(`downloader.${meta.key}` as MessageKey) : '' })}
          </p>
        )}

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={urls.length === 0 || !dir || needsPath || busy}
            onClick={() => void start()}
          >
            {busy
              ? t('download.starting')
              : urls.length > 1
                ? t('download.startN', { n: urls.length })
                : t('download.start')}
          </button>
        </div>
      </div>
    </div>
  )
}
