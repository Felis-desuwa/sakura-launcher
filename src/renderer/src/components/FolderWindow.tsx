import { useEffect } from 'react'

interface Props {
  title: string
  subtitle?: string
  glyph?: string
  canGoBack?: boolean
  onBack?: () => void
  onClose: () => void
  actions?: React.ReactNode
  children: React.ReactNode
}

/**
 * In-app window chrome shared by the group view and the file browser.
 * Deliberately not the OS shell: handing off to Explorer drops the user out of the
 * launcher's look entirely, which reads as a seam rather than a feature.
 */
export default function FolderWindow({
  title,
  subtitle,
  glyph = '📁',
  canGoBack,
  onBack,
  onClose,
  actions,
  children
}: Props): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Backspace' && canGoBack && onBack) onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onBack, canGoBack])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="window">
        <div className="window-bar">
          <button
            type="button"
            className="iconbtn"
            onClick={onBack}
            disabled={!canGoBack}
            title="返回上一级 (Backspace)"
          >
            ←
          </button>
          <div className="window-title">
            <span>{glyph}</span>
            <span>{title}</span>
            {subtitle && <span className="path">{subtitle}</span>}
          </div>
          <span style={{ flex: 1 }} />
          {actions}
          <button type="button" className="iconbtn" onClick={onClose} title="关闭 (Esc)">
            ✕
          </button>
        </div>
        <div className="window-body">{children}</div>
      </div>
    </div>
  )
}
