import { useLayoutEffect, useRef } from 'react'

/**
 * Animate grid children between layouts (the "FLIP" technique).
 *
 * React re-renders the tiles in their new order instantly; without this they would
 * simply teleport. So on every commit we measure where each tile ended up, compare it
 * with where it was, and — for anything that moved — first translate it back to its old
 * position with transitions off, then release it in the next frame. The browser plays
 * the trip from old to new, which is what reads as the tiles making room.
 *
 * The overshoot on the easing is deliberate: iOS settles its icons with a spring, and a
 * pure ease-out feels noticeably deader beside it.
 */
const MOVE_EASING = 'cubic-bezier(0.34, 1.56, 0.64, 1)'
const MOVE_MS = 280

/** Below this a "move" is layout noise — subpixel reflow, a scrollbar appearing. */
const MIN_DELTA_PX = 1

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * How far a still-running transition has already carried this element.
 *
 * Dragging re-orders the grid far faster than 280ms, so most of these animations are
 * interrupted by the next one. The interrupted element is somewhere between its old and
 * new slot, and that offset lives entirely in its current transform — ignore it and the
 * tile snaps back to where the last animation began before setting off again.
 */
function currentOffset(node: HTMLElement): { x: number; y: number } {
  const value = getComputedStyle(node).transform
  if (!value || value === 'none') return { x: 0, y: 0 }
  try {
    const m = new DOMMatrixReadOnly(value)
    return { x: m.m41, y: m.m42 }
  } catch {
    return { x: 0, y: 0 }
  }
}

/**
 * @param containerRef element whose `[data-flip-id]` descendants are animated
 * @param key changes whenever the layout should be re-measured and animated
 */
export function useFlip(containerRef: React.RefObject<HTMLElement | null>, key: string): void {
  /** Pure layout positions — measured with any transform cleared. */
  const previous = useRef<Map<string, DOMRect>>(new Map())
  const raf = useRef<number | null>(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    const nodes = [...container.querySelectorAll<HTMLElement>('[data-flip-id]')]
    const before = previous.current
    const animate = before.size > 0 && !prefersReducedMotion()

    // Where each element visually is right now, before anything is disturbed.
    const offsets = animate ? nodes.map((node) => currentOffset(node)) : []

    // Strip transforms so the rects below describe the layout itself, not the
    // animation currently painted on top of it.
    for (const node of nodes) {
      node.style.transition = 'none'
      node.style.transform = ''
    }

    const current = new Map<string, DOMRect>()
    for (const node of nodes) {
      current.set(node.dataset.flipId as string, node.getBoundingClientRect())
    }
    previous.current = current
    if (!animate) return

    const moved: { node: HTMLElement; dx: number; dy: number }[] = []
    nodes.forEach((node, i) => {
      const id = node.dataset.flipId as string
      const old = before.get(id)
      if (!old) return // newly mounted: let it appear in place rather than fly in
      const now = current.get(id) as DOMRect
      const dx = old.left + offsets[i].x - now.left
      const dy = old.top + offsets[i].y - now.top
      if (Math.abs(dx) < MIN_DELTA_PX && Math.abs(dy) < MIN_DELTA_PX) return
      moved.push({ node, dx, dy })
    })
    if (moved.length === 0) return

    // Invert: hold everything at its old position, with no transition to animate that.
    for (const { node, dx, dy } of moved) {
      node.style.transform = `translate(${dx}px, ${dy}px)`
    }

    if (raf.current !== null) cancelAnimationFrame(raf.current)
    // Two frames: the first lets the inverted position paint, the second starts the
    // transition from it. Done in one, the browser coalesces both writes and nothing
    // animates at all.
    raf.current = requestAnimationFrame(() => {
      raf.current = requestAnimationFrame(() => {
        for (const { node } of moved) {
          node.style.transition = `transform ${MOVE_MS}ms ${MOVE_EASING}`
          node.style.transform = ''
        }
      })
    })
  }, [containerRef, key])

  useLayoutEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current)
    },
    []
  )
}
