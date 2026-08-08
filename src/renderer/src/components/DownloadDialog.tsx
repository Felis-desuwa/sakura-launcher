import { useEffect, useState } from 'react'
import type { Settings } from '../../../shared/types'
import { DOWNLOADERS, downloadDirFor } from '../../../shared/types'

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
        <div className="step">下载新游戏</div>
        <h2>粘贴下载链接</h2>

        <textarea
          className="field download-urls"
          autoFocus
          spellCheck={false}
          placeholder={'一行一条链接，可以一次贴多条\nhttps://example.com/game.7z.001'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        <div className="download-row">
          <span className="download-label">保存到</span>
          <span className="download-value" title={dir ?? ''}>
            {dir ?? '尚未设置下载目录'}
          </span>
          <button
            type="button"
            className="btn ghost small"
            onClick={async () => {
              const picked = await window.sakura.pickDownloadDir()
              if (picked) setDir(picked)
            }}
          >
            更改…
          </button>
        </div>

        <div className="download-row">
          <span className="download-label">下载器</span>
          <span className="download-value">{meta?.label ?? settings.downloader}</span>
          <button type="button" className="btn ghost small" onClick={onOpenSettings}>
            设置…
          </button>
        </div>

        <p className="download-note">
          {meta?.note}
          {!meta?.controlsDir && ' 保存位置由它自己决定，上面选的目录只用来判断下载是否完成。'}
          {meta && !meta.reports && ' 下完之后会自动解压并加入游戏库。'}
        </p>

        {needsPath && (
          <p className="download-warn">
            还没有指定 {meta?.label} 的可执行文件，先去设置里填好才能开始。
          </p>
        )}

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={urls.length === 0 || !dir || needsPath || busy}
            onClick={() => void start()}
          >
            {busy ? '正在唤起下载器…' : urls.length > 1 ? `开始下载 ${urls.length} 条` : '开始下载'}
          </button>
        </div>
      </div>
    </div>
  )
}
