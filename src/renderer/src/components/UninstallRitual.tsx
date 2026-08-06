import { useEffect, useMemo, useRef, useState } from 'react'
import type { Game } from '../../../shared/types'
import type { UninstallPlan, UninstallResult } from '../../../preload/index'
import { formatBytes, formatDate } from '../lib/format'
import Artwork from './Artwork'

const HOLD_MS = 2500
const PETAL_COUNT = 14

interface Props {
  game: Game
  onCancel: () => void
  onDone: (result: UninstallResult) => void
}

const METHOD_TEXT: Record<UninstallPlan['method'], string> = {
  uninstaller: '将运行该游戏自带的卸载程序',
  geek: '将调用 Geek Uninstaller 卸载',
  trash: '将把整个文件夹移入回收站（可从回收站恢复）'
}

/** Type this many leading characters of the name to move past step 2. */
function requiredPrefix(name: string): string {
  const chars = [...name]
  return chars.length <= 4 ? name : chars.slice(0, 4).join('')
}

export default function UninstallRitual({ game, onCancel, onDone }: Props): React.JSX.Element {
  const [step, setStep] = useState(1)
  const [plan, setPlan] = useState<UninstallPlan | null>(null)
  const [typed, setTyped] = useState('')
  const [shake, setShake] = useState(false)
  const [progress, setProgress] = useState(0)
  const [busy, setBusy] = useState(false)

  const holdStart = useRef<number | null>(null)
  const rafId = useRef<number | null>(null)

  const target = useMemo(() => requiredPrefix(game.name), [game.name])

  useEffect(() => {
    window.sakura.planUninstall(game.id).then(setPlan)
  }, [game.id])

  // Esc aborts at any point in the ritual.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, busy])

  const stopHold = (): void => {
    holdStart.current = null
    if (rafId.current !== null) cancelAnimationFrame(rafId.current)
    rafId.current = null
    // Releasing early aborts and restores — nothing is destroyed until the ring closes.
    setProgress(0)
  }

  const tick = (): void => {
    if (holdStart.current === null) return
    const elapsed = Date.now() - holdStart.current
    const pct = Math.min(1, elapsed / HOLD_MS)
    setProgress(pct)
    if (pct >= 1) {
      holdStart.current = null
      rafId.current = null
      void commit()
      return
    }
    rafId.current = requestAnimationFrame(tick)
  }

  const startHold = (): void => {
    if (busy) return
    holdStart.current = Date.now()
    rafId.current = requestAnimationFrame(tick)
  }

  const commit = async (): Promise<void> => {
    setBusy(true)
    const result = await window.sakura.performUninstall(game.id)
    onDone(result)
  }

  useEffect(() => {
    return () => {
      if (rafId.current !== null) cancelAnimationFrame(rafId.current)
    }
  }, [])

  const petals = useMemo(
    () =>
      Array.from({ length: PETAL_COUNT }, (_, i) => ({
        left: 6 + (i * 83) % 100,
        delay: i / PETAL_COUNT,
        drift: ((i * 37) % 40) - 20
      })),
    []
  )

  const circumference = 2 * Math.PI * 66

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="modal">
        {step === 1 && (
          <>
            <div className="step">第一步 · 确认对象</div>
            <h2>要卸载《{game.name}》吗？</h2>
            <div style={{ display: 'flex', gap: 18, marginTop: 18 }}>
              <div style={{ position: 'relative', width: 120, height: 120, flex: 'none' }}>
                <div className="petal-preview">
                  <Artwork game={game} />
                </div>
              </div>
              <dl className="info-grid" style={{ flex: 1, margin: 0 }}>
                <dt>位置</dt>
                <dd>{game.dir}</dd>
                <dt>主程序</dt>
                <dd>{game.exe ? game.exe.split('\\').pop() : '（压缩包）'}</dd>
                <dt>最后启动</dt>
                <dd>{formatDate(game.lastLaunchedAt)}</dd>
                <dt>方式</dt>
                <dd>{plan ? METHOD_TEXT[plan.method] : '检测中…'}</dd>
              </dl>
            </div>
            <div className="reclaim">
              此操作将回收 <b>{formatBytes(plan?.sizeBytes ?? game.sizeBytes)}</b> 磁盘空间
            </div>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={onCancel}>
                取消
              </button>
              <button type="button" className="btn primary" onClick={() => setStep(2)}>
                继续
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="step">第二步 · 手抄花名</div>
            <h2>请输入「{target}」以确认</h2>
            <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '8px 0 16px', lineHeight: 1.6 }}>
              输入游戏名的前几个字符，确认你要删的正是这一个。
            </p>
            <input
              className={`field${shake ? ' shake' : ''}`}
              value={typed}
              autoFocus
              spellCheck={false}
              placeholder={target}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                if (typed.trim() === target) setStep(3)
                else {
                  setShake(true)
                  setTimeout(() => setShake(false), 400)
                }
              }}
            />
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={onCancel}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={typed.trim() !== target}
                onClick={() => setStep(3)}
              >
                继续
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div className="step">第三步 · 长按落樱</div>
            <h2>按住不放，直到花瓣落尽</h2>
            <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '8px 0 4px', lineHeight: 1.6 }}>
              中途松手即中止，一切照旧。
            </p>

            <div className="petal-preview" style={{ marginTop: 16 }}>
              <Artwork game={game} />
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: '#fff',
                  opacity: progress * 0.55,
                  pointerEvents: 'none'
                }}
              />
              {petals.map((p, i) =>
                progress > p.delay ? (
                  <span
                    key={i}
                    className="falling-petal"
                    style={{
                      left: `${p.left}%`,
                      top: 0,
                      transform: `translate(${p.drift * (progress - p.delay)}px, ${
                        (progress - p.delay) * 190
                      }px) rotate(${(progress - p.delay) * 420}deg)`,
                      opacity: Math.max(0, 1 - (progress - p.delay) * 1.5)
                    }}
                  />
                ) : null
              )}
            </div>

            <div className="hold-wrap">
              <button
                type="button"
                className="hold-btn"
                onPointerDown={startHold}
                onPointerUp={stopHold}
                onPointerLeave={stopHold}
                onPointerCancel={stopHold}
              >
                <svg width={150} height={150}>
                  <circle cx={75} cy={75} r={66} fill="rgba(255,255,255,0.7)" />
                  <circle
                    cx={75}
                    cy={75}
                    r={66}
                    fill="none"
                    stroke="rgba(231,84,128,0.18)"
                    strokeWidth={8}
                  />
                  <circle
                    cx={75}
                    cy={75}
                    r={66}
                    fill="none"
                    stroke="#e75480"
                    strokeWidth={8}
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={circumference * (1 - progress)}
                    transform="rotate(-90 75 75)"
                  />
                </svg>
                <span className="hold-label">
                  {busy ? '正在卸载…' : progress > 0 ? '继续按住' : '按住 2.5 秒'}
                  <small>{plan ? METHOD_TEXT[plan.method] : ''}</small>
                </span>
              </button>
            </div>

            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
                取消
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
