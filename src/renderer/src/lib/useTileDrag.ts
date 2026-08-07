import { useCallback, useEffect, useRef, useState } from 'react'
import { createDragProxy, type DragProxy } from './dragProxy'

export type DropHint = 'before' | 'after' | 'into'

export type DropTarget =
  | { kind: 'tile'; id: string; hint: DropHint }
  | { kind: 'group'; id: string }

/**
 * Pointer-driven tile dragging, the way a phone home screen does it.
 *
 * Native HTML5 drag-and-drop cannot produce this: its drag image is a static bitmap the
 * browser snapshots at `dragstart`, so the tile can neither grow as it is picked up nor
 * glide into place when released, and there is no pointer position left to animate from
 * once the drop fires. Owning the gesture ourselves costs this file and buys all three.
 *
 * The hook reports *where the drop would land*; the page turns that into a projected
 * order and renders it, which is what makes the other tiles step aside.
 */

/** Movement before a press becomes a drag. Below it the press is still a click. */
const DRAG_THRESHOLD_PX = 6

/** Distance from the scroller's edge at which dragging starts scrolling the page. */
const EDGE_ZONE_PX = 90
const EDGE_MAX_SPEED = 18

/*
 * Deciding between "put it between these two" and "merge these two".
 *
 * A single pair of thresholds cannot do this. Hold the pointer near one of them and
 * every stray pixel flips the verdict; each flip reshuffles the grid and starts a fresh
 * 280ms animation over the top of the one still running, so the tiles appear to
 * convulse. Three things keep the decision still:
 *
 *   - the band you must enter to merge is narrower than the band you must leave to stop
 *     merging, so hovering on the line settles into one answer and stays there;
 *   - the same on either side of the midpoint, for the before/after choice;
 *   - and merging additionally has to be meant: the pointer has to rest in the middle
 *     for a moment, so sweeping across a tile on the way somewhere else never merges.
 */
const MERGE_ENTER = [0.42, 0.58]
const MERGE_LEAVE = [0.28, 0.72]
const MERGE_DWELL_MS = 260
const SIDE_HYSTERESIS = 0.06

/** Which half of the tile the pointer is in, biased towards keeping its current answer. */
function sideFor(ratio: number, previous: DropHint | null): DropHint {
  if (previous === 'before' && ratio < 0.5 + SIDE_HYSTERESIS) return 'before'
  if (previous === 'after' && ratio > 0.5 - SIDE_HYSTERESIS) return 'after'
  return ratio < 0.5 ? 'before' : 'after'
}

/**
 * Where a drop in the gaps between tiles belongs.
 *
 * The gaps are part of the grid, not of any tile, yet they are exactly where one aims
 * when placing something *between* two tiles. Resolving them to the nearest slot is
 * what keeps such a drop from falling through to "no target" and going to the end.
 */
function nearestSlot(grid: HTMLElement, x: number, y: number, exclude: Set<string>): DropTarget | null {
  const items = [...grid.querySelectorAll<HTMLElement>(':scope > .tile[data-game-id]')]
    .map((el) => ({ id: el.dataset.gameId as string, rect: el.getBoundingClientRect() }))
    .filter((i) => !exclude.has(i.id))
  if (items.length === 0) return null

  // Pick the row whose vertical centre is closest, then the slot within that row.
  let row = items[0]
  let best = Infinity
  for (const item of items) {
    const dy = Math.abs(item.rect.top + item.rect.height / 2 - y)
    if (dy < best) {
      best = dy
      row = item
    }
  }
  const sameRow = items.filter((i) => Math.abs(i.rect.top - row.rect.top) < 4)
  for (const item of sameRow) {
    if (x < item.rect.left + item.rect.width / 2) return { kind: 'tile', id: item.id, hint: 'before' }
  }
  return { kind: 'tile', id: sameRow[sameRow.length - 1].id, hint: 'after' }
}

function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind !== b.kind) return false
  if (a.kind === 'group' || b.kind === 'group') return a.id === b.id
  return a.id === b.id && a.hint === b.hint
}

interface Options {
  /** The scrolling container, for edge auto-scroll. */
  scrollRef: React.RefObject<HTMLElement | null>
  selectedIds: string[]
  /** Whether dropping `sourceId` on `targetId` may merge them into a group. */
  canGroup: (sourceId: string, targetId: string) => boolean
  /** Commit the drop. Runs before the settle animation, so the layout is already final. */
  onDrop: (ids: string[], target: DropTarget | null) => void
}

export interface TileDrag {
  /** Tiles currently lifted out of the grid — rendered as holes. */
  dragIds: string[]
  /** Where the drop would land right now. */
  target: DropTarget | null
  /**
   * The last slot the tiles were asked to open up for, which is what the grid should be
   * laid out around. It deliberately outlives a hover over a tile or a group: those
   * decide what a release would *do*, but they should not make the grid rearrange
   * itself, and null until the first one so lifting a tile disturbs nothing.
   */
  insertion: DropTarget | null
  /** Begin tracking a press. Call from a tile's `onPointerDown`. */
  start: (e: React.PointerEvent, gameId: string) => void
  /**
   * True for the click that a just-finished drag is about to produce.
   *
   * Releasing over the tile the drag started on still counts as a click as far as the
   * browser is concerned, and acting on it would open the detail panel every time a
   * tile is nudged back to roughly where it began. Cleared on the next press.
   */
  didDrag: () => boolean
}

export function useTileDrag({ scrollRef, selectedIds, canGroup, onDrop }: Options): TileDrag {
  const [dragIds, setDragIds] = useState<string[]>([])
  const [target, setTarget] = useState<DropTarget | null>(null)
  const [insertion, setInsertion] = useState<DropTarget | null>(null)

  /** A press that has not moved far enough to be a drag yet. */
  const press = useRef<{ ids: string[]; startX: number; startY: number; grid: HTMLElement } | null>(
    null
  )
  const drag = useRef<{
    ids: string[]
    exclude: Set<string>
    grid: HTMLElement
    proxy: DragProxy
    x: number
    y: number
    dirty: boolean
    /** Tile the pointer is currently over, and the verdict it last gave. */
    hoverId: string | null
    hoverHint: DropHint | null
    /** When the pointer entered the merge band of `hoverId`; 0 while outside it. */
    coreSince: number
  } | null>(null)
  const targetRef = useRef<DropTarget | null>(null)
  const insertionRef = useRef<DropTarget | null>(null)
  const loop = useRef<number | null>(null)
  const dragged = useRef(false)

  // Read through refs so the window listeners never need re-binding mid-gesture.
  const latest = useRef({ canGroup, onDrop, selectedIds })
  latest.current = { canGroup, onDrop, selectedIds }

  const setTargetIfChanged = (next: DropTarget | null): void => {
    // The projected layout follows the last *insertion* rather than the live target, so
    // that hovering a tile to merge — or a group to join — leaves the grid exactly as it
    // was instead of closing the hole and reopening it the moment the pointer drifts.
    if (
      next !== null &&
      next.kind === 'tile' &&
      next.hint !== 'into' &&
      !sameTarget(insertionRef.current, next)
    ) {
      insertionRef.current = next
      setInsertion(next)
    }
    if (sameTarget(targetRef.current, next)) return
    targetRef.current = next
    setTarget(next)
  }

  const hitTest = useCallback((x: number, y: number): void => {
    const state = drag.current
    if (!state) return

    const under = document.elementFromPoint(x, y)
    // Tiles being dragged are hidden, so they are never returned here and cannot
    // become their own drop target.
    const tile = under?.closest<HTMLElement>('.tile[data-game-id]')
    if (tile) {
      const id = tile.dataset.gameId as string
      if (!state.exclude.has(id)) {
        const rect = tile.getBoundingClientRect()
        const ratio = (x - rect.left) / rect.width
        const now = performance.now()

        if (state.hoverId !== id) {
          state.hoverId = id
          state.hoverHint = null
          state.coreSince = 0
        }

        if (latest.current.canGroup(state.ids[0], id)) {
          const merging = state.hoverHint === 'into'
          // Wider to leave than to enter, so resting on the line settles on one answer.
          const band = merging ? MERGE_LEAVE : MERGE_ENTER
          if (ratio >= band[0] && ratio <= band[1]) {
            if (state.coreSince === 0) state.coreSince = now
            if (merging || now - state.coreSince >= MERGE_DWELL_MS) {
              state.hoverHint = 'into'
              setTargetIfChanged({ kind: 'tile', id, hint: 'into' })
            }
            /*
             * Otherwise hold everything exactly as it stands, and let the clock run.
             *
             * Claiming a slot here would be self-defeating: opening a gap in front of
             * this tile pushes it out from under the pointer, some neighbour slides into
             * its place, and the dwell restarts against a different tile — forever. That
             * is what made a tile held over another one thrash. Freezing the layout for
             * the moment it takes to decide is also what lets a merge be *aimed*: the
             * grid stops moving the instant the pointer settles on a tile.
             */
            return
          }
          state.coreSince = 0
        }

        // Leaving a merge starts the side judgement fresh — 'into' is not a side, so it
        // cannot bias which one we fall back to.
        const hint = sideFor(ratio, state.hoverHint === 'into' ? null : state.hoverHint)
        state.hoverHint = hint
        setTargetIfChanged({ kind: 'tile', id, hint })
        return
      }
    }

    state.hoverId = null
    state.hoverHint = null
    state.coreSince = 0

    const groupTile = under?.closest<HTMLElement>('.group-tile[data-group-id]')
    if (groupTile) {
      setTargetIfChanged({ kind: 'group', id: groupTile.dataset.groupId as string })
      return
    }

    // Anywhere else — a gap, or the empty page below the tiles — resolves to the
    // nearest slot of whichever grid the pointer is over, falling back to the one the
    // drag started in so a drop past the last row still lands somewhere sensible.
    const grid = under?.closest<HTMLElement>('.grid') ?? state.grid
    setTargetIfChanged(nearestSlot(grid, x, y, state.exclude))
  }, [])

  /** One rAF loop drives both edge scrolling and re-testing the target under it. */
  const tick = useCallback((): void => {
    const state = drag.current
    if (!state) {
      loop.current = null
      return
    }

    const scroller = scrollRef.current
    let scrolled = false
    if (scroller) {
      const box = scroller.getBoundingClientRect()
      const fromTop = state.y - box.top
      const fromBottom = box.bottom - state.y
      let delta = 0
      if (fromTop < EDGE_ZONE_PX) delta = -EDGE_MAX_SPEED * (1 - Math.max(0, fromTop) / EDGE_ZONE_PX)
      else if (fromBottom < EDGE_ZONE_PX)
        delta = EDGE_MAX_SPEED * (1 - Math.max(0, fromBottom) / EDGE_ZONE_PX)
      if (delta !== 0) {
        const before = scroller.scrollTop
        scroller.scrollTop += delta
        scrolled = scroller.scrollTop !== before
      }
    }

    // Scrolling moves the tiles under a stationary pointer, so the target has to be
    // recomputed even when nothing was moved by hand. A pending merge dwell needs the
    // same treatment for the opposite reason: holding perfectly still is exactly the
    // gesture it is waiting for, and nothing else would wake it up.
    const dwelling = state.coreSince !== 0 && state.hoverHint !== 'into'
    if (state.dirty || scrolled || dwelling) {
      state.dirty = false
      hitTest(state.x, state.y)
    }
    loop.current = requestAnimationFrame(tick)
  }, [hitTest, scrollRef])

  const cleanup = useCallback((): void => {
    press.current = null
    if (loop.current !== null) {
      cancelAnimationFrame(loop.current)
      loop.current = null
    }
    document.body.classList.remove('tiles-dragging')
  }, [])

  const finishDrag = useCallback(
    async (commit: boolean): Promise<void> => {
      const state = drag.current
      if (!state) return
      drag.current = null
      dragged.current = true
      cleanup()

      const landing = commit ? targetRef.current : null
      // Commit first: the projected order is already on screen, so applying it moves
      // nothing, and it leaves the hole sitting exactly where the tile must land.
      if (commit) latest.current.onDrop(state.ids, landing)

      const merging =
        landing !== null && (landing.kind === 'group' || landing.hint === 'into')

      try {
        if (merging) {
          const el = document.querySelector<HTMLElement>(
            landing.kind === 'group'
              ? `.group-tile[data-group-id="${CSS.escape(landing.id)}"]`
              : `.tile[data-game-id="${CSS.escape(landing.id)}"]`
          )
          if (el) await state.proxy.absorbInto(el.getBoundingClientRect())
        } else {
          // The hole: the dragged tile is still rendered, just invisible, and by now it
          // sits where the drop put it. Hidden elements still report a layout box.
          const hole = document.querySelector<HTMLElement>(
            `.tile[data-game-id="${CSS.escape(state.ids[0])}"]`
          )
          if (hole) await state.proxy.settleInto(hole.getBoundingClientRect())
        }
      } finally {
        state.proxy.destroy()
        targetRef.current = null
        insertionRef.current = null
        setTarget(null)
        setInsertion(null)
        setDragIds([])
      }
    },
    [cleanup]
  )

  const begin = useCallback(
    (x: number, y: number): void => {
      const pending = press.current
      if (!pending) return
      press.current = null

      const grid = pending.grid
      const nodes = pending.ids
        .map((id) => grid.querySelector<HTMLElement>(`.tile[data-game-id="${CSS.escape(id)}"]`))
        .filter((el): el is HTMLElement => el !== null)
      if (nodes.length === 0) return

      const rect = nodes[0].getBoundingClientRect()
      const proxy = createDragProxy({
        sources: nodes,
        grabX: pending.startX - rect.left,
        grabY: pending.startY - rect.top
      })
      proxy.moveTo(x, y)

      drag.current = {
        ids: pending.ids,
        exclude: new Set(pending.ids),
        grid,
        proxy,
        x,
        y,
        dirty: true,
        hoverId: null,
        hoverHint: null,
        coreSince: 0
      }
      document.body.classList.add('tiles-dragging')
      setDragIds(pending.ids)
      if (loop.current === null) loop.current = requestAnimationFrame(tick)
    },
    [tick]
  )

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const state = drag.current
      if (state) {
        state.x = e.clientX
        state.y = e.clientY
        state.dirty = true
        state.proxy.moveTo(e.clientX, e.clientY)
        // Stop the press from turning into a text selection or a native image drag.
        e.preventDefault()
        return
      }
      const pending = press.current
      if (!pending) return
      const dx = e.clientX - pending.startX
      const dy = e.clientY - pending.startY
      if (Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) begin(e.clientX, e.clientY)
    }

    const onUp = (): void => {
      if (drag.current) void finishDrag(true)
      else cleanup()
    }

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && drag.current) void finishDrag(false)
    }

    // Capture phase, so the flag is already clear by the time the tile's own handler
    // runs — otherwise a press anywhere but on a tile would leave it set and swallow
    // the following click.
    const onDown = (): void => {
      dragged.current = false
    }

    window.addEventListener('pointerdown', onDown, { capture: true })
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, { capture: true })
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('keydown', onKey)
    }
  }, [begin, cleanup, finishDrag])

  const start = useCallback((e: React.PointerEvent, gameId: string): void => {
    if (e.button !== 0 || drag.current) return
    const grid = (e.currentTarget as HTMLElement).closest<HTMLElement>('.grid')
    if (!grid) return
    // Grabbing a tile inside the selection takes the whole selection along.
    const { selectedIds: ids } = latest.current
    press.current = {
      ids: ids.includes(gameId) && ids.length > 1 ? ids : [gameId],
      startX: e.clientX,
      startY: e.clientY,
      grid
    }
  }, [])

  const didDrag = useCallback(() => dragged.current, [])

  return { dragIds, target, insertion, start, didDrag }
}
