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

    const draw = (): void => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = petalColor
      for (const p of petals) {
        p.y += p.vy
        p.sway += 0.012
        p.x += p.vx + Math.sin(p.sway) * 0.4
        p.angle += p.spin
        p.flip += p.flipSpeed
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
      raf = requestAnimationFrame(draw)
    }

    draw()
    window.addEventListener('resize', resize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [enabled, themeKey])

  if (!enabled) return null
  return <canvas className="petal-canvas" ref={ref} />
}
