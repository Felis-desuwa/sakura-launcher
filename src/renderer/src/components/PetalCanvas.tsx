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
      r: 4 + Math.random() * 5,
      vy: 0.25 + Math.random() * 0.5,
      vx: -0.25 + Math.random() * 0.5,
      spin: (-0.5 + Math.random()) * 0.02,
      angle: Math.random() * Math.PI * 2,
      // Kept faint: these now drift over the tiles, so they must stay clearly
      // subordinate to the artwork and labels underneath.
      alpha: 0.1 + Math.random() * 0.18
    })

    // Scale with the window so a wide desktop is covered as evenly as a narrow one.
    const petalCount = (): number => {
      const area = canvas.clientWidth * canvas.clientHeight
      return Math.max(28, Math.min(80, Math.round(area / 26000)))
    }

    resize()
    petals = Array.from({ length: petalCount() }, spawn)

    const draw = (): void => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      ctx.clearRect(0, 0, w, h)
      for (const p of petals) {
        p.y += p.vy
        p.x += p.vx + Math.sin(p.y / 90) * 0.25
        p.angle += p.spin
        if (p.y > h + 20) Object.assign(p, spawn(), { y: -20 })

        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(p.angle)
        ctx.globalAlpha = p.alpha
        ctx.fillStyle = petalColor
        ctx.beginPath()
        ctx.ellipse(0, 0, p.r, p.r * 0.62, 0, 0, Math.PI * 2)
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
