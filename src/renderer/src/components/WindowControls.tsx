import { useEffect, useState } from 'react'
import { useT } from '../lib/i18n'

/**
 * Minimise, maximise and close — drawn here because the window has no frame.
 *
 * Windows' own title bar is a white slab that ignores the theme, which on a cherry-blossom
 * (or midnight, or matcha) window is the one part of the screen that belongs to a different
 * program. Three dots in the theme's own colours cost the Win11 snap-layouts flyout, which
 * only the real caption buttons can raise; every other window gesture survives, because the
 * bar itself is a drag region and Windows handles dragging, snapping and double-click from
 * that alone.
 *
 * The glyphs appear on hover. At rest these read as decoration, which is the point — a
 * shelf of games should not have three pieces of system chrome shouting at the top of it.
 * Close keeps a colour of its own so the destructive one is never a guess.
 */
export default function WindowControls(): React.JSX.Element {
  const t = useT()
  const [maximized, setMaximized] = useState(false)

  // The window reaches maximised by more routes than this button: Win+↑, a drag to the top
  // edge, a double-click on the bar. So the state is asked for once and then pushed.
  useEffect(() => {
    void window.sakura.isWindowMaximized().then(setMaximized)
    return window.sakura.onMaximizeChange(setMaximized)
  }, [])

  return (
    <div className="wctl">
      <button
        type="button"
        className="wctl-btn min"
        title={t('win.minimize')}
        aria-label={t('win.minimize')}
        onClick={() => void window.sakura.minimizeWindow()}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.5 5h7" />
        </svg>
      </button>

      <button
        type="button"
        className="wctl-btn max"
        title={t(maximized ? 'win.restore' : 'win.maximize')}
        aria-label={t(maximized ? 'win.restore' : 'win.maximize')}
        onClick={() => void window.sakura.toggleMaximizeWindow()}
      >
        {maximized ? (
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2.2 3.4V1.9h5.9v5.9H6.6" />
            <rect x="1.6" y="3.4" width="5" height="5" rx="0.7" />
          </svg>
        ) : (
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1.9" y="1.9" width="6.2" height="6.2" rx="0.9" />
          </svg>
        )}
      </button>

      <button
        type="button"
        className="wctl-btn close"
        title={t('win.close')}
        aria-label={t('win.close')}
        onClick={() => void window.sakura.closeWindow()}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2.4 2.4l5.2 5.2M7.6 2.4L2.4 7.6" />
        </svg>
      </button>
    </div>
  )
}
