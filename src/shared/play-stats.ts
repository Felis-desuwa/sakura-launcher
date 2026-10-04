/**
 * Play statistics, worked out from the sessions each game already records.
 *
 * Imports nothing, on purpose: the renderer bundles this file and `scripts/stats-test.mts`
 * loads it straight into node, and only a file that names nothing else can be both.
 *
 * Two facts about the input decide most of what follows.
 *
 * 1. **A session belongs to the days it actually covered, not the day it began.** A game
 *    started at eleven at night and played until two is an hour on one day and two on the
 *    next. Crediting all three hours to the evening it started leaves an empty square on
 *    the calendar for a day that was largely spent playing.
 * 2. **History is capped, and the cap is reported rather than hidden.** Each game keeps its
 *    most recent `MAX_SESSIONS` sessions, so for anything played heavily the record runs
 *    out before the chart does. `completeSince` says from which day every game's record is
 *    whole; before it the figures are a floor, and the page says so instead of drawing a
 *    quiet month as though nothing had been played. The all-time total has no such limit —
 *    it is `playtimeMs`, which accumulates and is never trimmed.
 *
 * Days are **local** days throughout, and a day is advanced by the calendar rather than by
 * adding twenty-four hours, which is wrong twice a year wherever the clocks change.
 */

export interface StatSession {
  startedAt: number
  ms: number
}

export interface StatGame {
  id: string
  name: string
  playtimeMs: number
  sessions: StatSession[]
}

/** Local midnight at or before `ms`. */
export function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** The local midnight after the day that starts at `dayStart`. */
export function nextDay(dayStart: number): number {
  const d = new Date(dayStart)
  d.setDate(d.getDate() + 1)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** The local midnight before `dayStart`. */
export function prevDay(dayStart: number): number {
  const d = new Date(dayStart)
  d.setDate(d.getDate() - 1)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Monday of the week containing `ms`. A Chinese calendar starts its week on Monday. */
export function startOfWeek(ms: number): number {
  const d = new Date(startOfDay(ms))
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}

export function startOfMonth(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

/** A session cut along the local days it covered. Anything malformed covers nothing. */
export function splitByDay(session: StatSession): { day: number; ms: number }[] {
  const { startedAt, ms } = session
  if (!Number.isFinite(startedAt) || !Number.isFinite(ms) || ms <= 0) return []
  const end = startedAt + ms
  const out: { day: number; ms: number }[] = []
  let cursor = startedAt
  while (cursor < end) {
    const day = startOfDay(cursor)
    const boundary = Math.min(end, nextDay(day))
    out.push({ day, ms: boundary - cursor })
    cursor = boundary
  }
  return out
}

/** Milliseconds played on each local day, across the whole library, keyed by day start. */
export function dailyTotals(games: StatGame[]): Map<number, number> {
  const totals = new Map<number, number>()
  for (const game of games) {
    for (const session of game.sessions) {
      for (const part of splitByDay(session)) {
        totals.set(part.day, (totals.get(part.day) ?? 0) + part.ms)
      }
    }
  }
  return totals
}

/** How much of one session fell inside `[from, to)`. */
function overlap(session: StatSession, from: number, to: number): number {
  if (!Number.isFinite(session.startedAt) || !Number.isFinite(session.ms) || session.ms <= 0) {
    return 0
  }
  const start = Math.max(session.startedAt, from)
  const end = Math.min(session.startedAt + session.ms, to)
  return end > start ? end - start : 0
}

/**
 * Time played inside `[from, to)`.
 *
 * A session straddling either edge counts only for the part inside it, for the same reason
 * sessions are split by day: "this week" should not include the Sunday-night hours of a
 * session that merely ended on Monday.
 */
export function playedBetween(games: StatGame[], from: number, to: number): number {
  let total = 0
  for (const game of games) {
    for (const session of game.sessions) total += overlap(session, from, to)
  }
  return total
}

export interface RankedGame {
  id: string
  name: string
  ms: number
}

/**
 * The most played games.
 *
 * With no window the ranking is all-time and read from `playtimeMs`, which is never trimmed;
 * with one it is read from the sessions inside it. Games that played nothing are left out —
 * a chart of zeros is not a ranking. Ties go by name so the order is stable between renders.
 */
export function topGames(
  games: StatGame[],
  limit: number,
  window?: { from: number; to: number }
): RankedGame[] {
  const rows: RankedGame[] = []
  for (const game of games) {
    const ms = window
      ? game.sessions.reduce((sum, s) => sum + overlap(s, window.from, window.to), 0)
      : game.playtimeMs
    if (ms > 0) rows.push({ id: game.id, name: game.name, ms })
  }
  rows.sort((a, b) => b.ms - a.ms || a.name.localeCompare(b.name, 'zh-CN'))
  return rows.slice(0, Math.max(0, limit))
}

/**
 * The first day from which every game's history is whole, or null when no game has hit
 * the cap and the record is complete all the way back.
 *
 * A game at the cap has dropped its oldest sessions, and the ones it dropped started before
 * the oldest one it kept — possibly earlier on that same day. So that day is not whole
 * either, and completeness begins the day after it.
 */
export function completeSince(games: StatGame[], cap: number): number | null {
  let horizon: number | null = null
  for (const game of games) {
    if (game.sessions.length < cap) continue
    let oldest = Infinity
    for (const s of game.sessions) if (s.startedAt < oldest) oldest = s.startedAt
    if (!Number.isFinite(oldest)) continue
    const whole = nextDay(startOfDay(oldest))
    if (horizon === null || whole > horizon) horizon = whole
  }
  return horizon
}

/**
 * Consecutive days with any play, ending today.
 *
 * Counting starts from yesterday when nothing has been played yet today. A streak is not
 * broken at midnight by the fact that the evening's session has not happened yet, and a
 * number that read zero every morning would mean nothing.
 */
export function currentStreak(daily: Map<number, number>, now: number): number {
  let day = startOfDay(now)
  if (!((daily.get(day) ?? 0) > 0)) day = prevDay(day)
  let streak = 0
  while ((daily.get(day) ?? 0) > 0) {
    streak++
    day = prevDay(day)
  }
  return streak
}

/** The longest run of consecutive days with play anywhere in the record. */
export function longestStreak(daily: Map<number, number>): number {
  const days = [...daily.entries()]
    .filter(([, ms]) => ms > 0)
    .map(([day]) => day)
    .sort((a, b) => a - b)
  let best = 0
  let run = 0
  let previous: number | null = null
  for (const day of days) {
    run = previous !== null && nextDay(previous) === day ? run + 1 : 1
    if (run > best) best = run
    previous = day
  }
  return best
}

/**
 * The calendar grid: `weeks` columns ending with the current week, each a Monday-to-Sunday
 * list of day starts. Days that have not happened yet are null, so the grid stays a
 * rectangle without inventing squares for the future.
 */
export function calendarWeeks(now: number, weeks: number): (number | null)[][] {
  const today = startOfDay(now)
  let monday = startOfWeek(now)
  for (let i = 1; i < weeks; i++) {
    for (let d = 0; d < 7; d++) monday = prevDay(monday)
  }
  const grid: (number | null)[][] = []
  let day = monday
  for (let w = 0; w < weeks; w++) {
    const column: (number | null)[] = []
    for (let d = 0; d < 7; d++) {
      column.push(day <= today ? day : null)
      day = nextDay(day)
    }
    grid.push(column)
  }
  return grid
}

/**
 * How dark a day's square is, 0 to 4.
 *
 * **Fixed thresholds, not a share of the busiest day.** Scaled to the maximum, one
 * twelve-hour weekend would turn every ordinary evening pale, and the same evening would
 * change colour depending on what else is on screen. Fixed bands mean a square always says
 * the same thing, which is also what lets the legend name them.
 */
export const HEAT_BANDS_MS = [30 * 60_000, 90 * 60_000, 180 * 60_000] as const

export function heatLevel(ms: number): 0 | 1 | 2 | 3 | 4 {
  if (!(ms > 0)) return 0
  if (ms < HEAT_BANDS_MS[0]) return 1
  if (ms < HEAT_BANDS_MS[1]) return 2
  if (ms < HEAT_BANDS_MS[2]) return 3
  return 4
}

/** What one day was spent on, longest first. */
export function playedOn(games: StatGame[], day: number): RankedGame[] {
  return topGames(games, Number.MAX_SAFE_INTEGER, { from: day, to: nextDay(day) })
}
