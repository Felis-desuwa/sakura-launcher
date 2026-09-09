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
 * The largest step a single frame may integrate, in 60fps frames.
 *
 * Coming back from anything that stalled the loop — a long garbage collection, a window
 * left minimised, a machine that slept — the gap since the last draw can be arbitrarily
 * long, and multiplying the fall by it would teleport every petal down the screen at
 * once. Clamping turns that into a slightly short step instead, which nobody can see.
 */
const MAX_STEP = 10

/*
 * There is deliberately no throttle for an unfocused window, and the version that had one
 * is why this note exists.
 *
 * The reasoning behind it was that a launcher spends its life behind the game it launched,
 * so an unfocused window is one nobody is looking at, and eight frames a second would do.
 * The premise is wrong: **unfocused and unwatched are not the same state.** This window
 * sits beside a browser, or on the second screen, in plain view, for most of its life —
 * and eight frames a second of slow drifting motion does not read as economical, it reads
 * as broken. It was reported as exactly that.
 *
 * The state actually worth saving work in is *hidden* — minimised, on another virtual
 * desktop, or fully covered — and that one costs nothing to handle, because Chromium stops
 * calling `requestAnimationFrame` at all for a page it considers hidden, occlusion
 * included, so long as `backgroundThrottling` is left on (it is: nothing here sets it).
 * The loop simply stops, and the elapsed-time integration below is what lets it resume
 * without the petals jumping.
 */

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

    // Fills to the right density for the window it finds, so this is the whole of the
    // initial population as well as the response to a resize.
    resize()

    /** Timestamp of the last frame drawn, which is what the step is measured against. */
    let last = performance.now()

    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw)

      const elapsed = now - last
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
    }
  }, [enabled, themeKey])

  if (!enabled) return null
  return <canvas className="petal-canvas" ref={ref} />
}
