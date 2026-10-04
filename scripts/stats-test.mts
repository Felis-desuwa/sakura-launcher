import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  calendarWeeks,
  completeSince,
  currentStreak,
  dailyTotals,
  heatLevel,
  HEAT_BANDS_MS,
  longestStreak,
  nextDay,
  playedBetween,
  playedOn,
  splitByDay,
  startOfDay,
  startOfMonth,
  startOfWeek,
  topGames,
  type StatGame
} from '../src/shared/play-stats.ts'

/**
 * Play statistics: which day a minute belongs to, and what the page may claim.
 *
 * Every date here is built with the local `Date` constructor, never from an epoch number,
 * so the suite means the same thing in any time zone — including the ones whose clocks
 * change, which is what the daylight-saving cases at the bottom are for.
 */

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function eq<T>(name: string, got: T, want: T): void {
  check(name, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

function deepEq(name: string, got: unknown, want: unknown): void {
  check(
    name,
    JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`
  )
}

const H = 3_600_000
const M = 60_000

/** A local moment. Months are 1-based here, unlike Date's, to keep the cases readable. */
function at(y: number, mo: number, d: number, h = 0, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi).getTime()
}

function game(id: string, sessions: [number, number][], playtimeMs?: number): StatGame {
  return {
    id,
    name: id,
    playtimeMs: playtimeMs ?? sessions.reduce((s, [, ms]) => s + ms, 0),
    sessions: sessions.map(([startedAt, ms]) => ({ startedAt, ms }))
  }
}

/* ---------------------------- days ---------------------------- */

console.log('\n-- splitting a session along the days it covered --')

deepEq('a session inside one day stays whole', splitByDay({ startedAt: at(2026, 10, 4, 20), ms: 2 * H }), [
  { day: at(2026, 10, 4), ms: 2 * H }
])
// The case the whole module is shaped around: three hours from eleven at night is one
// hour on one day and two on the next, not three on the evening it started.
deepEq('across midnight it is split at midnight', splitByDay({ startedAt: at(2026, 10, 4, 23), ms: 3 * H }), [
  { day: at(2026, 10, 4), ms: 1 * H },
  { day: at(2026, 10, 5), ms: 2 * H }
])
eq(
  'a thirty-hour session touches three days',
  splitByDay({ startedAt: at(2026, 10, 4, 22), ms: 30 * H }).length,
  3
)
eq(
  '...and loses nothing on the way',
  splitByDay({ startedAt: at(2026, 10, 4, 22), ms: 30 * H }).reduce((s, p) => s + p.ms, 0),
  30 * H
)
deepEq('ending exactly at midnight does not leak into the next day', splitByDay({ startedAt: at(2026, 10, 4, 23), ms: 1 * H }), [
  { day: at(2026, 10, 4), ms: 1 * H }
])
deepEq('a zero-length session covers nothing', splitByDay({ startedAt: at(2026, 10, 4), ms: 0 }), [])
deepEq('a negative one covers nothing', splitByDay({ startedAt: at(2026, 10, 4), ms: -5 }), [])
deepEq('a malformed one covers nothing', splitByDay({ startedAt: NaN, ms: H }), [])

console.log('\n-- weeks and months --')

// Monday-first. A Sunday belongs to the week that began the Monday before it.
eq('a Wednesday belongs to that Monday', startOfWeek(at(2026, 10, 7, 15)), at(2026, 10, 5))
eq('a Monday is its own week start', startOfWeek(at(2026, 10, 5, 9)), at(2026, 10, 5))
eq('a Sunday belongs to the Monday before it', startOfWeek(at(2026, 10, 11, 22)), at(2026, 10, 5))
eq('a month starts on the first', startOfMonth(at(2026, 10, 17, 3)), at(2026, 10, 1))

/* ---------------------------- totals ---------------------------- */

console.log('\n-- totals --')

const two = [
  game('a', [[at(2026, 10, 4, 20), 2 * H]]),
  game('b', [
    [at(2026, 10, 4, 21), 30 * M],
    [at(2026, 10, 3, 23), 2 * H]
  ])
]
const daily = dailyTotals(two)
eq('two games on one day add up', daily.get(at(2026, 10, 4)), 2 * H + 30 * M + 1 * H)
eq('the day before gets only its own hour', daily.get(at(2026, 10, 3)), 1 * H)

// "This week" must not include Sunday-night hours of a session that merely ended Monday.
const straddle = [game('s', [[at(2026, 10, 4, 22), 4 * H]])] // Sun 22:00 -> Mon 02:00
eq('a window takes only the part of a session inside it', playedBetween(straddle, at(2026, 10, 5), at(2026, 10, 12)), 2 * H)
eq('...and the part before it goes to the window before', playedBetween(straddle, at(2026, 9, 28), at(2026, 10, 5)), 2 * H)
eq('a window with nothing in it is zero', playedBetween(straddle, at(2026, 1, 1), at(2026, 1, 2)), 0)

/* ---------------------------- rankings ---------------------------- */

console.log('\n-- rankings --')

// All-time reads playtimeMs, which is never trimmed — sessions are capped and would
// understate exactly the games that were played most.
const ranked = [
  game('trimmed', [[at(2026, 10, 1, 20), 1 * H]], 300 * H),
  game('recent', [[at(2026, 10, 2, 20), 5 * H]]),
  game('never', [], 0)
]
deepEq(
  'all-time ranking reads the untrimmed total',
  topGames(ranked, 10).map((g) => g.id),
  ['trimmed', 'recent']
)
deepEq(
  'a windowed ranking reads only what fell inside it',
  topGames(ranked, 10, { from: at(2026, 10, 1), to: at(2026, 11, 1) }).map((g) => g.id),
  ['recent', 'trimmed']
)
check('a game that played nothing is not ranked', !topGames(ranked, 10).some((g) => g.id === 'never'))
eq('the limit is respected', topGames(ranked, 1).length, 1)
deepEq(
  'ties go by name, so the order does not shuffle between renders',
  topGames([game('乙', [[at(2026, 10, 4), H]]), game('甲', [[at(2026, 10, 5), H]])], 10).map((g) => g.id),
  ['甲', '乙']
)
deepEq(
  'what one day was spent on',
  playedOn(two, at(2026, 10, 4)).map((g) => [g.id, g.ms]),
  [
    ['a', 2 * H],
    ['b', 30 * M + 1 * H]
  ]
)

/* ---------------------------- completeness ---------------------------- */

console.log('\n-- what the record can honestly claim --')

const capped = game(
  'busy',
  Array.from({ length: 5 }, (_, i) => [at(2026, 10, 10 + i, 20), H] as [number, number])
)
eq('no game at the cap: the record is complete', completeSince([capped], 50), null)
// At the cap the oldest kept session's own day may have lost earlier sessions, so the
// record is whole only from the day after it.
eq('a game at the cap: complete from the day after its oldest session', completeSince([capped], 5), at(2026, 10, 11))
const later = game(
  'later',
  Array.from({ length: 5 }, (_, i) => [at(2026, 10, 20 + i, 20), H] as [number, number])
)
eq('two capped games: the later horizon wins', completeSince([capped, later], 5), at(2026, 10, 21))

/* ---------------------------- streaks ---------------------------- */

console.log('\n-- streaks --')

const streaky = dailyTotals([
  game('x', [
    [at(2026, 10, 2, 20), H],
    [at(2026, 10, 3, 20), H],
    [at(2026, 10, 4, 20), H],
    [at(2026, 9, 20, 20), H]
  ])
])
eq('three days running, ending today', currentStreak(streaky, at(2026, 10, 4, 23)), 3)
// Mornings would otherwise always read zero.
eq('nothing yet today still counts from yesterday', currentStreak(streaky, at(2026, 10, 5, 8)), 3)
eq('a missed day ends it', currentStreak(streaky, at(2026, 10, 6, 8)), 0)
eq('an empty record has no streak', currentStreak(new Map(), at(2026, 10, 4)), 0)
eq('the longest run is found anywhere in the record', longestStreak(streaky), 3)
eq('an empty record has no longest run', longestStreak(new Map()), 0)

/* ---------------------------- the calendar ---------------------------- */

console.log('\n-- the calendar grid --')

const now = at(2026, 10, 7, 15) // a Wednesday
const grid = calendarWeeks(now, 26)
eq('one column per week', grid.length, 26)
check('seven rows in every column', grid.every((c) => c.length === 7))
eq('every column starts on a Monday', grid.every((c) => c[0] !== null && new Date(c[0]).getDay() === 1), true)
eq('the last column is this week', grid[25][0], startOfWeek(now))
eq('today is in it', grid[25][2], startOfDay(now))
deepEq('days that have not happened are left empty', grid[25].slice(3), [null, null, null, null])
check(
  'the columns follow one another with no gap',
  grid.every((c, i) => i === 0 || nextDay(grid[i - 1][6] ?? 0) === c[0])
)

console.log('\n-- how dark a square is --')

eq('nothing played is blank', heatLevel(0), 0)
eq('a few minutes is the palest', heatLevel(5 * M), 1)
eq('just under the first band', heatLevel(HEAT_BANDS_MS[0] - 1), 1)
eq('at the first band', heatLevel(HEAT_BANDS_MS[0]), 2)
eq('at the second band', heatLevel(HEAT_BANDS_MS[1]), 3)
eq('at the third band and beyond', heatLevel(12 * H), 4)
eq('a malformed total is blank', heatLevel(NaN), 0)

/* ---------------------------- clocks that change ---------------------------- */

console.log('\n-- daylight saving --')

// Where the clocks go back, that day is twenty-five hours long. Advancing by a fixed
// twenty-four lands an hour short of midnight and then misfiles a whole evening. These pass
// trivially in a zone without daylight saving and mean something in one with it.
const fallBack = at(2026, 11, 1)
eq('the day after the clocks go back is still a local midnight', nextDay(fallBack), at(2026, 11, 2))
eq('...and so is the day after they go forward', nextDay(at(2026, 3, 8)), at(2026, 3, 9))
const overnight = splitByDay({ startedAt: at(2026, 10, 31, 23), ms: 4 * H })
eq('a session across the change splits at the real midnight', overnight[0].day, at(2026, 10, 31))
eq('...and loses no time', overnight.reduce((s, p) => s + p.ms, 0), 4 * H)

/* ---------------------------- the module ---------------------------- */

console.log('\n-- module hygiene --')

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf-8'))
check('the harness is registered in package.json', pkg.scripts['stats-test'] === 'node scripts/stats-test.mts')
const source = fs.readFileSync(path.join(here, '..', 'src', 'shared', 'play-stats.ts'), 'utf-8')
// The renderer bundles it and node runs it directly; only a file that imports nothing
// can be both without an extension argument between them.
check('the module imports nothing at all', !/^\s*import\s/m.test(source))

/* -------------------------------------------------------------------------- */
console.log(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) process.exit(1)
