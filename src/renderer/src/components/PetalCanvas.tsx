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

/** Ambient falling petals. Deliberately faint and pausable — it must never fight the tiles. */
export default function PetalCanvas({ enabled }: { enabled: boolean }): React.JSX.Element | null {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!enabled) return
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
    }

    const spawn = (): Petal => ({
      x: Math.random() * canvas.clientWidth,
      y: -20 - Math.random() * canvas.clientHeight,
      r: 4 + Math.random() * 5,
      vy: 0.25 + Math.random() * 0.5,
      vx: -0.25 + Math.random() * 0.5,
      spin: (-0.5 + Math.random()) * 0.02,
      angle: Math.random() * Math.PI * 2,
      alpha: 0.18 + Math.random() * 0.22
    })

    resize()
    petals = Array.from({ length: 26 }, spawn)

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
        ctx.fillStyle = '#ff9ec0'
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
  }, [enabled])

  if (!enabled) return null
  return <canvas className="petal-canvas" ref={ref} />
}
