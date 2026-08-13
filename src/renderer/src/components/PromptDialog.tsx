import { useEffect, useRef, useState } from 'react'
import { useT } from '../lib/i18n'

interface Props {
  title: string
  description?: React.ReactNode
  initialValue?: string
  placeholder?: string
  confirmLabel?: string
  /** Extra action rendered on the left, e.g. "restore the original name". */
  onConfirm: (value: string) => void
  onCancel: () => void
}

/**
 * In-app replacement for window.prompt — the Chromium dialog looks nothing like the
 * rest of the app and breaks the illusion of a single surface.
 */
export default function PromptDialog({
  title,
  description,
  initialValue = '',
  placeholder,
  confirmLabel,
  onConfirm,
  onCancel
}: Props): React.JSX.Element {
  const t = useT()
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const submit = (): void => {
    if (value.trim()) onConfirm(value.trim())
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" style={{ width: 'min(480px, 92vw)' }}>
        <h2 style={{ marginBottom: 10 }}>{title}</h2>
        {description && (
          <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', lineHeight: 1.75, marginBottom: 14 }}>
            {description}
          </div>
        )}
        <input
          ref={inputRef}
          className="field"
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={!value.trim()} onClick={submit}>
            {confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
