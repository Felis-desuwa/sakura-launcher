import { useEffect, useMemo, useRef, useState } from 'react'
import type { Game } from '../../../shared/types'
import { formatDuration, formatDurationShort, MAX_SESSIONS } from '../../../shared/types'
import {
  calendarWeeks,
  completeSince,
  currentStreak,
  dailyTotals,
  heatLevel,
  longestStreak,
  nextDay,
  playedBetween,
  playedOn,
  startOfDay,
  startOfMonth,
  startOfWeek,
  topGames,
  type RankedGame
} from '../../../shared/play-stats'
import { useLang, useT } from '../lib/i18n'

interface Props {
  games: Game[]
}

/**
 * A year of columns. Six months was tried first and left two thirds of the card empty on an
 * ordinary window; a year fills it, and is what anybody who has seen a calendar like this
 * expects. Older days are more often incomplete under the session cap, which is exactly what
 * the partial marking is for.
 */
const WEEKS = 52

/** Columns that must separate a label from the next one, or the two overprint each other. */
const LABEL_GAP = 4

/**
 * How much was played, and when.
 *
 * Built entirely from what the play-time tracker already records; nothing new is measured
 * here. Two choices shape what it shows, and both are about not overstating:
 *
 * - **A day is chosen by tapping it, not by hovering.** A tooltip is the obvious way to say
 *   what a square means, and it is invisible under a finger, which is how this program is
 *   often driven. The breakdown sits below the calendar instead.
 * - **Where the record is incomplete, it says so.** Each game keeps only its most recent
 *   sessions, so for a heavily played game the calendar runs out before the chart does.
 *   Those days are dimmed and named, rather than drawn as a quiet stretch of the year.
 */
export default function StatsPage({ games }: Props): React.JSX.Element {
  const t = useT()
  const lang = useLang()
  const locale = lang === 'en' ? 'en-US' : 'zh-CN'
  // Taken once per render of the page. A clock that ticked inside one render could put
  // "today" in two different places.
  const now = Date.now()

  const stats = useMemo(() => {
    const daily = dailyTotals(games)
    const grid = calendarWeeks(now, WEEKS)
    const first = grid[0][0] ?? startOfDay(now)
    const today = startOfDay(now)
    const end = nextDay(today)
    let daysPlayed = 0
    let lastPlayed: number | null = null
    for (const [day, ms] of daily) {
      if (ms <= 0 || day < first || day > today) continue
      daysPlayed++
      if (lastPlayed === null || day > lastPlayed) lastPlayed = day
    }
    return {
      daily,
      grid,
      first,
      today,
      lastPlayed,
      daysPlayed,
      horizon: completeSince(games, MAX_SESSIONS),
      todayMs: playedBetween(games, today, end),
      weekMs: playedBetween(games, startOfWeek(now), end),
      monthMs: playedBetween(games, startOfMonth(now), end),
      allMs: games.reduce((sum, g) => sum + Math.max(0, g.playtimeMs), 0),
      streak: currentStreak(daily, now),
      longest: longestStreak(daily),
      monthTop: topGames(games, 5, { from: startOfMonth(now), to: end }),
      allTop: topGames(games, 10)
    }
    // `now` is deliberately left out: the page recomputes when the games change, which
    // is when anything it shows can have changed.
  }, [games])

  const [chosen, setChosen] = useState<number | null>(null)
  const selected = chosen ?? stats.lastPlayed ?? stats.today

  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Open on the recent end. Where the calendar is wider than its card — a narrow window,
    // and always in touch mode, where the squares are larger — it would otherwise open on
    // the week a year ago, and the part anybody came to look at would be off-screen.
    const el = scroller.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [stats.grid.length])

  const dayLabel = (day: number): string =>
    new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', weekday: 'short' }).format(
      new Date(day)
    )
  const monthLabel = (day: number): string =>
    new Intl.DateTimeFormat(locale, { month: 'short' }).format(new Date(day))
  const weekdayLabel = (day: number): string =>
    new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(new Date(day))
  const days = (n: number): string => (n === 1 ? t('stats.oneDay') : t('stats.days', { n }))

  // A month is named on the column holding its first day. The opening column is named as
  // well, unless a real month starts within a few columns of it: on a year-long chart that
  // opening month is usually the same one that closes it, and the two labels would sit
  // printed over the next one.
  const monthLabels = stats.grid.map((column) => {
    const first = column.find((day) => day !== null && new Date(day).getDate() === 1)
    return first ? monthLabel(first) : ''
  })
  const firstNamed = monthLabels.findIndex((label) => label !== '')
  const opening = stats.grid[0][0]
  if (opening !== null && (firstNamed === -1 || firstNamed >= LABEL_GAP)) {
    monthLabels[0] = monthLabel(opening)
  }

  if (stats.allMs <= 0 && stats.daily.size === 0) {
    return (
      <div className="page">
        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>
            {t('stats.empty.title')}
          </div>
          <p className="stats-note">{t('stats.empty.detail')}</p>
        </div>
      </div>
    )
  }

  const partialBefore =
    stats.horizon !== null && stats.horizon > stats.first ? stats.horizon : null
  const dayGames = playedOn(games, selected)

  return (
    <div className="page">
      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>
          {t('stats.playtime')}
        </div>
        <div className="stats-row">
          <Stat label={t('stats.today')} value={short(stats.todayMs, lang)} />
          <Stat label={t('stats.week')} value={short(stats.weekMs, lang)} />
          <Stat label={t('stats.month')} value={short(stats.monthMs, lang)} />
          <Stat label={t('stats.all')} value={short(stats.allMs, lang)} />
        </div>
        <div className="stats-row">
          <Stat label={t('stats.streak')} value={days(stats.streak)} />
          <Stat label={t('stats.longest')} value={days(stats.longest)} />
          <Stat label={t('stats.daysPlayed')} value={days(stats.daysPlayed)} />
        </div>
      </div>

      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>
          {t('stats.calendar')}
        </div>
        <div className="heat-scroll" ref={scroller}>
          <div className="heat" style={{ ['--heat-weeks' as string]: WEEKS }}>
            <div className="heat-months">
              {monthLabels.map((label, i) => (
                <span key={i}>{label}</span>
              ))}
            </div>
            <div className="heat-body">
              <div className="heat-weekdays">
                {/* Read off the oldest column, which is always entirely in the past and so
                    has a real day in every row. Every other row is labelled, as a calendar
                    of this density is. */}
                {stats.grid[0].map((day, i) => (
                  <span key={i}>{i % 2 === 0 && day !== null ? weekdayLabel(day) : ''}</span>
                ))}
              </div>
              <div className="heat-grid">
                {stats.grid.flatMap((column, w) =>
                  column.map((day, d) => {
                    if (day === null) return <span key={`${w}-${d}`} className="heat-cell empty" />
                    const ms = stats.daily.get(day) ?? 0
                    const level = heatLevel(ms)
                    const partial = partialBefore !== null && day < partialBefore
                    return (
                      <button
                        type="button"
                        key={`${w}-${d}`}
                        className={`heat-cell${day === selected ? ' selected' : ''}${partial ? ' partial' : ''}`}
                        data-level={level}
                        aria-label={t('stats.cellLabel', {
                          date: dayLabel(day),
                          time: ms > 0 ? formatDuration(ms, lang) : t('stats.dayNone')
                        })}
                        onClick={() => setChosen(day)}
                      />
                    )
                  })
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="heat-legend">
          <span>{t('stats.less')}</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span key={level} className="heat-cell" data-level={level} />
          ))}
          <span>{t('stats.more')}</span>
          <span className="heat-bands">{t('stats.bands')}</span>
        </div>

        {partialBefore !== null && (
          <p className="stats-note">
            {t('stats.partial', { date: dayLabel(partialBefore), n: MAX_SESSIONS })}
          </p>
        )}

        <div className="stats-day">
          <b>{dayLabel(selected)}</b>
          {dayGames.length === 0 ? (
            <span className="stats-quiet">{t('stats.dayNone')}</span>
          ) : (
            <ul>
              {dayGames.map((g) => (
                <li key={g.id}>
                  <span className="legend-name" title={g.name}>
                    {g.name}
                  </span>
                  <span className="legend-size">{formatDuration(g.ms, lang)}</span>
                </li>
              ))}
            </ul>
          )}
          {chosen === null && <span className="stats-quiet">{t('stats.dayHint')}</span>}
        </div>
      </div>

      <div className="card stats-tops">
        <div>
          <div className="section-title" style={{ marginTop: 0 }}>
            {t('stats.monthTop')}
          </div>
          {stats.monthTop.length === 0 ? (
            <p className="stats-note">{t('stats.monthNone')}</p>
          ) : (
            <Bars rows={stats.monthTop} lang={lang} />
          )}
        </div>
        <div>
          <div className="section-title" style={{ marginTop: 0 }}>
            {t('stats.allTop')}
          </div>
          <Bars rows={stats.allTop} lang={lang} />
        </div>
      </div>
    </div>
  )
}

/** The headline figure. An empty string for nothing reads as missing, so zero is spelled out. */
function short(ms: number, lang: 'zh' | 'en'): string {
  return ms > 0 ? formatDurationShort(ms, lang) : lang === 'en' ? '0' : '0 分'
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 21, fontWeight: 700, color: 'var(--accent)' }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{label}</div>
    </div>
  )
}

function Bars({ rows, lang }: { rows: RankedGame[]; lang: 'zh' | 'en' }): React.JSX.Element {
  const max = rows[0]?.ms ?? 1
  return (
    <>
      {rows.map((g) => (
        <div className="bar-row" key={g.id}>
          <span className="legend-name" title={g.name}>
            {g.name}
          </span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(g.ms / max) * 100}%` }} />
          </span>
          <span className="legend-size">{formatDurationShort(g.ms, lang)}</span>
        </div>
      ))}
    </>
  )
}
