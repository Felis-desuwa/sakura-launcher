import { useEffect, useState } from 'react'
import type { UninstallResult } from '../../../preload/index'
import type { Game } from '../../../shared/types'
import { formatBytes } from '../lib/format'

interface Props {
  games: Game[]
  onDone: (results: UninstallResult[]) => void
  onCancel: () => void
}

/**
 * Uninstalling several games at once.
 *
 * The single-game ritual — type the name, hold the button for two and a half seconds —
 * is deliberate friction that works because it happens once. Repeating it per game
 * would only teach the user to rush through it. Instead the whole list is laid out with
 * what it frees, and confirmation is typing how many are about to go: a number you can
 * only get right by having read the list.
 */
export default function BulkUninstallDialog({
  games,
  onDone,
  onCancel
}: Props): React.JSX.Element {
  const [typed, setTyped] = useState('')
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(0)
  const [current, setCurrent] = useState('')

  const totalBytes = games.reduce((sum, g) => sum + (g.sizeBytes ?? 0), 0)
  const confirmed = typed.trim() === String(games.length)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !running) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, running])

  const run = async (): Promise<void> => {
    setRunning(true)
    const results: UninstallResult[] = []
    for (const game of games) {
      setCurrent(game.name)
      results.push(await window.sakura.performUninstall(game.id))
      setDone((n) => n + 1)
    }
    onDone(results)
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="step">批量卸载</div>
        <h2>即将卸载 {games.length} 个游戏</h2>

        {running ? (
          <>
            <p className="bulk-progress-label">
              正在处理《{current}》 · {done} / {games.length}
            </p>
            <div className="bar-track">
              <div
                className="bar-fill"
                style={{ width: `${Math.round((done / games.length) * 100)}%` }}
              />
            </div>
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, color: 'var(--ink-soft)', lineHeight: 1.7, margin: '10px 0 0' }}>
              将按顺序对每个游戏执行卸载：有自带卸载程序的运行它，否则交给 Geek，
              再否则移入回收站。合计可释放 <b>{formatBytes(totalBytes)}</b>。
            </p>

            <div className="bulk-list">
              {games.map((g) => (
                <div className="bulk-row" key={g.id}>
                  <span className="bulk-name">{g.name}</span>
                  <span className="bulk-size">{formatBytes(g.sizeBytes)}</span>
                </div>
              ))}
            </div>

            <label className="bulk-confirm">
              <span>
                确认请输入本次卸载的数量 <b>{games.length}</b>：
              </span>
              <input
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={String(games.length)}
                className={typed && !confirmed ? 'wrong' : ''}
              />
            </label>
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onCancel} disabled={running}>
            取消
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={!confirmed || running}
            onClick={() => void run()}
          >
            {running ? '卸载中…' : `卸载这 ${games.length} 个游戏`}
          </button>
        </div>
      </div>
    </div>
  )
}
