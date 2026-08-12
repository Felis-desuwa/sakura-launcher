import { useEffect, useMemo, useRef, useState } from 'react'
import type { MessageKey } from '../../../shared/i18n'
import type { Game } from '../../../shared/types'
import type { UninstallPlan, UninstallResult } from '../../../preload/index'
import { formatBytes, formatDate } from '../lib/format'
import { matchesFlower, randomFlower, type Flower } from '../lib/flowers'
import { buildMirror } from '../lib/shatter'
import { useLang, useT } from '../lib/i18n'
import Artwork from './Artwork'

const HOLD_MS = 2500
/** Few enough to be petals rather than confetti. */
const PETAL_COUNT = 10
/** How much of the hold goes to cracking before the first piece may come away. */
const CRACK_PHASE = 0.26

interface Props {
  game: Game
  onCancel: () => void
  onDone: (result: UninstallResult) => void
}

const METHOD_TEXT: Record<UninstallPlan['method'], MessageKey> = {
  uninstaller: 'ritual.method.uninstaller',
  geek: 'ritual.method.geek',
  trash: 'ritual.method.trash'
}

/** Five petals in a ring — what the drawn flower looks like, before it comes apart. */
function Blossom({ flower }: { flower: Flower }): React.JSX.Element {
  return (
    <span className="blossom-mark" aria-hidden="true">
      {[0, 72, 144, 216, 288].map((deg) => (
        <span
          key={deg}
          style={{
            background: `linear-gradient(165deg, ${flower.petal[0]}, ${flower.petal[1]})`,
            borderRadius: flower.shape,
            transform: `rotate(${deg}deg) translateY(-11px)`
          }}
        />
      ))}
      <em />
    </span>
  )
}

export default function UninstallRitual({ game, onCancel, onDone }: Props): React.JSX.Element {
  const t = useT()
  const lang = useLang()
  const [step, setStep] = useState(1)
  const [plan, setPlan] = useState<UninstallPlan | null>(null)
  const [typed, setTyped] = useState('')
  const [shake, setShake] = useState(false)
  const [progress, setProgress] = useState(0)
  const [busy, setBusy] = useState(false)

  const holdStart = useRef<number | null>(null)
  const rafId = useRef<number | null>(null)

  // Drawn once per ritual: the same flower has to be on offer in step 2 and falling in
  // step 3, and stepping back and forth must not reroll it into an easier one.
  const flower = useMemo(randomFlower, [])
  const mirror = useMemo(() => buildMirror(CRACK_PHASE), [])
  const ok = matchesFlower(typed, flower.en)

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
    // Releasing early aborts and restores — nothing is destroyed until the ring closes,
    // and the shards snap back together to say so.
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

  // Drawn rather than computed from the index. Strides coprime with the range spread
  // values *evenly*, which is the one thing scattered petals must not be — an even
  // spread reads as a pattern however the numbers were arrived at.
  const petals = useMemo(
    () =>
      Array.from({ length: PETAL_COUNT }, () => ({
        left: 26 + Math.random() * 48,
        delay: CRACK_PHASE * 0.7 + Math.random() * 0.44,
        drift: (Math.random() - 0.5) * 76,
        spin: 150 + Math.random() * 330,
        top: 18 + Math.random() * 54,
        fall: 185 + Math.random() * 95,
        scale: 0.72 + Math.random() * 0.56
      })),
    []
  )

  const circumference = 2 * Math.PI * 66

  /*
   * The crack overlay is painted on the frame, not on the pieces, so it cannot follow
   * them anywhere — left up, it hangs in the air over the gaps like a drawing of a
   * break that already happened. It therefore lives exactly as long as the surface is
   * whole: it spreads while nothing has moved, and is gone within a couple of frames of
   * the first piece letting go. From that moment the seams are drawn by the fragments
   * themselves (see `.breaking .shard`), which do travel with them.
   */
  const crackOpacity =
    progress < CRACK_PHASE
      ? progress / CRACK_PHASE
      : Math.max(0, 1 - (progress - CRACK_PHASE) / 0.06)
  // A shudder while it is still holding together, gone once it is not.
  const tremble = progress > 0 && progress < CRACK_PHASE ? Math.sin(progress * 260) * progress * 8 : 0

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="modal">
        {step === 1 && (
          <>
            <div className="step">{t('ritual.step1')}</div>
            <h2>{t('ritual.step1.title', { name: game.name })}</h2>
            <div style={{ display: 'flex', gap: 18, marginTop: 18 }}>
              <div style={{ position: 'relative', width: 120, height: 120, flex: 'none' }}>
                <div className="petal-preview">
                  <Artwork game={game} />
                </div>
              </div>
              <dl className="info-grid" style={{ flex: 1, margin: 0 }}>
                <dt>{t('ritual.location')}</dt>
                <dd>{game.dir}</dd>
                <dt>{t('ritual.mainProgram')}</dt>
                <dd>{game.exe ? game.exe.split('\\').pop() : t('ritual.isArchive')}</dd>
                <dt>{t('ritual.lastLaunched')}</dt>
                <dd>{formatDate(game.lastLaunchedAt)}</dd>
                <dt>{t('ritual.method')}</dt>
                <dd>{plan ? t(METHOD_TEXT[plan.method]) : t('ritual.detecting')}</dd>
              </dl>
            </div>
            <div className="reclaim">
              {t('ritual.reclaim', { size: formatBytes(plan?.sizeBytes ?? game.sizeBytes) })}
            </div>
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={onCancel}>
                {t('common.cancel')}
              </button>
              <button type="button" className="btn primary" onClick={() => setStep(2)}>
                {t('ritual.continue')}
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="step">{t('ritual.step2')}</div>
            <h2>{t('ritual.step2.title')}</h2>
            <div className="flower-card">
              <Blossom flower={flower} />
              <div>
                <div className="flower-en">{flower.en}</div>
                <div className="flower-cn">
                  {flower.name} · <i>{flower.latin}</i>
                </div>
                <div className="flower-meaning">{t('ritual.meaning', { meaning: flower.meaning[lang] })}</div>
              </div>
            </div>
            <p className="ritual-target">
              {t('ritual.aboutTo', { name: game.name })}
            </p>
            <input
              className={`field${shake ? ' shake' : ''}`}
              value={typed}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              placeholder={t('ritual.typeHere')}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                if (ok) setStep(3)
                else {
                  setShake(true)
                  setTimeout(() => setShake(false), 400)
                }
              }}
            />
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={onCancel}>
                {t('common.cancel')}
              </button>
              <button type="button" className="btn primary" disabled={!ok} onClick={() => setStep(3)}>
                {t('ritual.continue')}
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div className="step">{t('ritual.step3')}</div>
            <h2>{t('ritual.step3.title')}</h2>
            <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '8px 0 4px', lineHeight: 1.6 }}>
              {t('ritual.letGo')}
            </p>

            <div className="shatter-stage">
              <div
                // No piece can move before the crack phase is over, so the tile keeps its
                // rounded corners for as long as it is still whole — it squares up only
                // under cover of the first fragments coming away.
                className={`shatter-frame${progress >= CRACK_PHASE ? ' breaking' : ''}`}
                style={{ transform: `translateX(${tremble}px)` }}
              >
                {mirror.fragments.map((piece, i) => {
                  const t = progress <= piece.start ? 0 : (progress - piece.start) / (1 - piece.start)
                  // Two motions, because a piece of glass does two things: it is pushed
                  // off the surface — mostly linear, so the seams open the moment it
                  // lets go — and then it falls, which accelerates.
                  const slide = 0.3 * t + 0.7 * t * t
                  const drop = t * t
                  return (
                    <span
                      key={i}
                      className="shard"
                      style={{
                        clipPath: piece.clip,
                        transform: `translate(${piece.dx * piece.dist * slide}px, ${
                          piece.dy * piece.dist * 0.75 * slide + piece.fall * drop
                        }px) rotate(${piece.rot * slide}deg)`,
                        opacity: 1 - drop * 0.95
                      }}
                    >
                      <Artwork game={game} />
                    </span>
                  )
                })}

                <svg className="crack" viewBox="0 0 100 100" style={{ opacity: crackOpacity }}>
                  {mirror.cracks.map((points, i) => (
                    <polyline key={i} points={points} />
                  ))}
                </svg>

                <div
                  className="shatter-bloom"
                  style={{ opacity: Math.max(0, progress - 0.72) * 1.6 }}
                />
              </div>

              {petals.map((p, i) => {
                if (progress <= p.delay) return null
                const t = progress - p.delay
                return (
                  <span
                    key={i}
                    className="ritual-petal"
                    style={{
                      left: `${p.left}%`,
                      width: flower.size[0],
                      height: flower.size[1],
                      borderRadius: flower.shape,
                      background: `linear-gradient(165deg, ${flower.petal[0]}, ${flower.petal[1]})`,
                      transform: `translate(${p.drift * t}px, ${p.top + t * p.fall}px) rotate(${
                        t * p.spin
                      }deg) scale(${p.scale})`,
                      opacity: Math.max(0, 1 - t * 1.35)
                    }}
                  />
                )
              })}
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
                  <circle className="hold-plate" cx={75} cy={75} r={66} />
                  <circle className="hold-track" cx={75} cy={75} r={66} />
                  <circle
                    className="hold-fill"
                    cx={75}
                    cy={75}
                    r={66}
                    strokeDasharray={circumference}
                    strokeDashoffset={circumference * (1 - progress)}
                    transform="rotate(-90 75 75)"
                  />
                </svg>
                <span className="hold-label">
                  {busy ? t('ritual.uninstalling') : progress > 0 ? t('ritual.keepHolding') : t('ritual.hold')}
                </span>
              </button>
              {/* Outside the ring: at 150px across, this line wrapped onto itself over
                  the moving stroke and could not be read at the one moment it matters. */}
              <p className="hold-method">{plan ? t(METHOD_TEXT[plan.method]) : t('ritual.detecting')}</p>
            </div>

            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
                {t('common.cancel')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
