import { useEffect } from 'react'
import { useT } from '../lib/i18n'

interface Props {
  title: string
  body?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** In-app replacement for window.confirm, styled like the rest of the app. */
export default function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger,
  onConfirm,
  onCancel
}: Props): React.JSX.Element {
  const t = useT()
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" style={{ width: 'min(500px, 92vw)' }}>
        <h2 style={{ marginBottom: 10 }}>{title}</h2>
        {body && (
          <div style={{ fontSize: 13, color: 'var(--ink-soft)', lineHeight: 1.75 }}>{body}</div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            {cancelLabel ?? t('common.cancel')}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'danger' : 'primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
