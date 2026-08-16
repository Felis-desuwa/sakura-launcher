import { useEffect, useRef } from 'react'

interface Petal {
  x: number
  y: number
  r: number
  vy: number
  vx: number
  spin: number
  angle: number
  alpha: number
  /** Phase of the flutter that makes a petal turn edge-on as it falls. */
  flip: number
  flipSpeed: number
  /** Horizontal sway phase, so petals do not all drift in step. */
  sway: number
}

interface Props {
  enabled: boolean
  /** Re-read the theme colour when this changes. */
  themeKey: string
}

/**
 * How often the petals are redrawn while the window is not the one being used.
 *
 * A launcher spends most of its life behind the game it launched. `requestAnimationFrame`
 * only throttles itself when the window is *hidden* — minimised, or on another virtual
 * desktop — and a window that is merely unfocused, or fully covered by a fullscreen game,
 * keeps getting sixty frames a second of canvas work for something nobody is looking at.
 *
 * Eight frames a second is enough that glancing back at a partly visible window does not
 * catch the petals frozen, and it is an eighth of the work. It costs nothing in
 * appearance because the motion is integrated against elapsed time rather than counted in
 * frames: at any rate the petals fall at the same speed, they are simply drawn in fewer
 * places along the way.
 */
const BLURRED_FPS = 8

/**
 * The largest step a single frame may integrate, in 60fps frames.
 *
 * Coming back from anything that stalled the loop — a long garbage collection, a window
 * left minimised — the gap since the last draw can be arbitrarily long, and multiplying
 * the fall by it would teleport every petal down the screen at once. Clamping turns that
 * into a slightly short step instead, which nobody can see.
 *
 * It has to stay above `60 / BLURRED_FPS`, or the throttled rate would be clamped by it
 * and the petals would quietly fall slower whenever the window was not in front — the
 * exact thing integrating against elapsed time is here to avoid. A sixth of a second
 * leaves room for the jitter in a timer that is only approximately on schedule.
 */
const MAX_STEP = 10

/** Ambient falling petals. Deliberately faint and pausable — it must never fight the tiles. */
export default function PetalCanvas({ enabled, themeKey }: Props): React.JSX.Element | null {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!enabled) return
    const petalColor =
      getComputedStyle(document.documentElement).getPropertyValue('--petal').trim() || '#ff9ec0'
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let petals: Petal[] = []

    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = canvas.clientWidth * dpr
      canvas.height = canvas.clientHeight * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // Keep the density right when the window is resized.
      const want = petalCount()
      while (petals.length < want) petals.push(spawn())
      if (petals.length > want) petals.length = want
    }

    const spawn = (): Petal => ({
      x: Math.random() * canvas.clientWidth,
      y: -20 - Math.random() * canvas.clientHeight,
      r: 5 + Math.random() * 6,
      vy: 0.25 + Math.random() * 0.55,
      vx: -0.25 + Math.random() * 0.5,
      spin: (-0.5 + Math.random()) * 0.018,
      angle: Math.random() * Math.PI * 2,
      // Faint enough to stay subordinate to the artwork and labels they drift over,
      // but the petal colour sits close to the background: much below this and the
      // effect is invisible on the pale themes.
      alpha: 0.16 + Math.random() * 0.26,
      flip: Math.random() * Math.PI * 2,
      flipSpeed: 0.008 + Math.random() * 0.014,
      sway: Math.random() * Math.PI * 2
    })

    // Scale with the window so a wide desktop is covered as evenly as a narrow one.
    const petalCount = (): number => {
      const area = canvas.clientWidth * canvas.clientHeight
      return Math.max(36, Math.min(120, Math.round(area / 17000)))
    }

    /**
     * A single blossom petal: broad at the tip, tapering to the stem, with the notch
     * that makes a sakura petal recognisable. Drawn in units of `r` around the origin.
     */
    const petalPath = (r: number): void => {
      ctx.beginPath()
      ctx.moveTo(0, r)
      ctx.bezierCurveTo(r * 0.9, r * 0.5, r * 0.8, -r * 0.7, r * 0.28, -r)
      // The notch at the wide end.
      ctx.quadraticCurveTo(0, -r * 0.72, -r * 0.28, -r)
      ctx.bezierCurveTo(-r * 0.8, -r * 0.7, -r * 0.9, r * 0.5, 0, r)
      ctx.closePath()
    }

    resize()
    petals = Array.from({ length: petalCount() }, spawn)

    /*
     * Whether anybody is looking.
     *
     * Tracked with a listener rather than read from `document.hasFocus()` each frame,
     * because reading it per frame is the sort of thing that forces layout work on some
     * builds, and the answer changes a handful of times an hour. Started from the live
     * value so a window that opened unfocused — restored from the tray, say — is throttled
     * from the first frame rather than after the first click somewhere else.
     */
    let focused = document.hasFocus()
    const onFocus = (): void => {
      focused = true
    }
    const onBlur = (): void => {
      focused = false
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)

    /** Timestamp of the last frame actually drawn, so both the step and the skip use it. */
    let last = performance.now()

    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw)

      const elapsed = now - last
      // Unfocused, the loop still runs — it is the cheapest way to notice focus coming
      // back — but almost every frame returns here without touching the canvas.
      if (!focused && elapsed < 1000 / BLURRED_FPS) return
      last = now

      // Motion in 60fps frames' worth of time, so the fall does not slow down when the
      // frames are further apart. `MAX_STEP` covers coming back from a long stall.
      const step = Math.min(elapsed / (1000 / 60), MAX_STEP)

      const w = canvas.clientWidth
      const h = canvas.clientHeight
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = petalColor
      for (const p of petals) {
        p.y += p.vy * step
        p.sway += 0.012 * step
        p.x += (p.vx + Math.sin(p.sway) * 0.4) * step
        p.angle += p.spin * step
        p.flip += p.flipSpeed * step
        if (p.y > h + 24) Object.assign(p, spawn(), { y: -24 })
        // Wrap sideways rather than letting a petal drift off and leave a bare column.
        if (p.x < -24) p.x = w + 24
        else if (p.x > w + 24) p.x = -24

        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(p.angle)
        // Squashing the width as the flutter phase turns is what reads as a petal
        // tumbling through its own plane rather than a flat shape sliding down.
        ctx.scale(Math.max(0.18, Math.abs(Math.cos(p.flip))), 1)
        ctx.globalAlpha = p.alpha
        petalPath(p.r)
        ctx.fill()
        ctx.restore()
      }
    }

    raf = requestAnimationFrame(draw)
    window.addEventListener('resize', resize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [enabled, themeKey])

  if (!enabled) return null
  return <canvas className="petal-canvas" ref={ref} />
}
