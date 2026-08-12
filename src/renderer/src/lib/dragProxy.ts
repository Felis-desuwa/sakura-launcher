/**
 * The tile that follows the pointer while dragging.
 *
 * It is built and driven straight through the DOM rather than as a React component:
 * it has to move every frame, and routing that through state would re-render the whole
 * grid sixty times a second for something no other component needs to know about.
 *
 * The visual is a real clone of the tile that was grabbed, so whatever the tile shows —
 * artwork, tier badge, stars, playtime — comes along without being reimplemented here.
 */

const LIFT_MS = 180
const SETTLE_MS = 260
const SETTLE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'

/** How far the tiles behind the leader peek out when several are dragged at once. */
const STACK_OFFSET = 7

export interface DragProxy {
  /** Point the proxy at a new pointer position. Cheap enough to call every frame. */
  moveTo(x: number, y: number): void
  /** Glide into `rect` and resolve once it is there. */
  settleInto(rect: DOMRect): Promise<void>
  /** Shrink into the centre of `rect` and fade — the merge-into-group ending. */
  absorbInto(rect: DOMRect): Promise<void>
  destroy(): void
}

interface Options {
  /** The tile elements being dragged, leader first. */
  sources: HTMLElement[]
  /** Where in the leader the pointer grabbed it, so the tile does not jump to centre. */
  grabX: number
  grabY: number
}

export function createDragProxy({ sources, grabX, grabY }: Options): DragProxy {
  const lead = sources[0]
  const rect = lead.getBoundingClientRect()

  const root = document.createElement('div')
  root.className = 'drag-proxy'
  root.style.width = `${rect.width}px`
  root.style.height = `${rect.height}px`

  // Deeper tiles first so the leader ends up painted on top.
  const stacked = sources.slice(1, 3).reverse()
  stacked.forEach((source, i) => {
    const layer = source.cloneNode(true) as HTMLElement
    layer.classList.add('drag-proxy-layer')
    layer.removeAttribute('data-game-id')
    layer.removeAttribute('data-flip-id')
    const depth = stacked.length - i
    layer.style.transform = `translate(${depth * STACK_OFFSET}px, ${depth * STACK_OFFSET}px) rotate(${depth * 2.5}deg)`
    root.appendChild(layer)
  })

  const clone = lead.cloneNode(true) as HTMLElement
  clone.classList.add('drag-proxy-lead')
  clone.classList.remove('dragging', 'drop-target', 'drop-before', 'drop-after')
  clone.removeAttribute('data-game-id')
  clone.removeAttribute('data-flip-id')
  // The grid gave the tile its size; free-standing it would collapse to its content.
  clone.style.width = `${rect.width}px`
  clone.style.height = `${rect.height}px`
  clone.style.transform = ''
  root.appendChild(clone)

  if (sources.length > 1) {
    const badge = document.createElement('span')
    badge.className = 'drag-proxy-count'
    badge.textContent = String(sources.length)
    root.appendChild(badge)
  }

  document.body.appendChild(root)

  let x = rect.left + grabX
  let y = rect.top + grabY
  let frame: number | null = null
  let lifted = false
  let dead = false

  const paint = (): void => {
    frame = null
    root.style.transform = `translate(${x - grabX}px, ${y - grabY}px)`
  }
  paint()

  // Let the initial position paint before the lift transition starts, or the tile
  // animates in from the top-left corner of the window instead of growing in place.
  requestAnimationFrame(() => {
    if (dead) return
    root.style.transition = `scale ${LIFT_MS}ms ease-out, rotate ${LIFT_MS}ms ease-out, filter ${LIFT_MS}ms ease-out`
    root.classList.add('lifted')
    lifted = true
  })

  const finish = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      window.setTimeout(resolve, ms)
    })

  return {
    moveTo(nextX, nextY) {
      x = nextX
      y = nextY
      if (frame === null) frame = requestAnimationFrame(paint)
    },

    async settleInto(target) {
      if (frame !== null) {
        cancelAnimationFrame(frame)
        frame = null
      }
      if (lifted) root.classList.remove('lifted')
      root.style.transition = `transform ${SETTLE_MS}ms ${SETTLE_EASING}, scale ${SETTLE_MS}ms ${SETTLE_EASING}, rotate ${SETTLE_MS}ms ${SETTLE_EASING}, filter ${SETTLE_MS}ms ${SETTLE_EASING}`
      root.style.transform = `translate(${target.left}px, ${target.top}px)`
      await finish(SETTLE_MS)
    },

    async absorbInto(target) {
      if (frame !== null) {
        cancelAnimationFrame(frame)
        frame = null
      }
      if (lifted) root.classList.remove('lifted')
      // Aim the tile's centre at the target's centre, then shrink it away.
      const cx = target.left + target.width / 2 - rect.width / 2
      const cy = target.top + target.height / 2 - rect.height / 2
      root.style.transition = `transform ${SETTLE_MS}ms ${SETTLE_EASING}, scale ${SETTLE_MS}ms ${SETTLE_EASING}, opacity ${SETTLE_MS}ms ease-in`
      root.style.transform = `translate(${cx}px, ${cy}px)`
      root.style.scale = '0.25'
      root.style.opacity = '0'
      await finish(SETTLE_MS)
    },

    destroy() {
      dead = true
      if (frame !== null) cancelAnimationFrame(frame)
      root.remove()
    }
  }
}
