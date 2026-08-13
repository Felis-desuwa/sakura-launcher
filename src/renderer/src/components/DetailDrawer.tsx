import { useEffect, useMemo, useState } from 'react'
import type { Breakdown, DiskInfo, Game } from '../../../shared/types'
import {
  formatDuration,
  SUMMARY_SOURCE_LABEL,
  TAG_SOURCE_LABEL,
  tagLabel,
  tagReason,
  visibleTags
} from '../../../shared/types'
import { formatBytes, formatDate, formatPercent } from '../lib/format'
import { useLang, useT } from '../lib/i18n'
import SizeDonut, { type Slice } from './SizeDonut'

/**
 * Mode B ramp: one hue, ordered by size, darkest = largest.
 * Validated with the data-viz palette checker (`--ordinal`, light surface):
 * monotone lightness, adjacent ΔL >= 0.06, light end 2.24:1 against the surface.
 * Six steps is the maximum that clears those gates — hence the top-5 plus "other" cap.
 * Re-run the validator before changing any of these values.
 */
const RAMP = ['#5e1a2c', '#85243f', '#a83059', '#c74374', '#ec8fb0']

/**
 * "Other" is an aggregate, not a rank, so it sits outside the ramp in neutral grey.
 * Giving it a ramp step would claim a position in the ordering it does not hold —
 * the tail commonly outweighs the largest single item.
 */
const COLOR_REST = '#b9adb3'
const MAX_SLICES = RAMP.length + 1

/** Mode A is an emphasis read — one subject against context — not a categorical one. */
const COLOR_SELF = '#e75480'
const COLOR_OTHER = '#b9adb3'
const COLOR_FREE = '#e8e2e5'

type Mode = 'usage' | 'composition'

interface Props {
  game: Game
  allGames: Game[]
  disks: DiskInfo[]
  playing: boolean
  onClose: () => void
  /** Open the picker for which executable actually starts this game. */
  onChooseExe?: () => void
  /** VNDB marks tags that give the plot away; this says whether the user wants to see them. */
  showSpoilers: boolean
  showAdult: boolean
  /** Strike an automatic tag out, or put every struck-out one back. */
  onTagHidden: (gameId: string, tagId: string, hidden: boolean) => Promise<void>
}

export default function DetailDrawer({
  game,
  allGames,
  disks,
  playing,
  onClose,
  onChooseExe,
  showSpoilers,
  showAdult,
  onTagHidden
}: Props): React.JSX.Element {
  const t = useT()
  const lang = useLang()

  const autoTags = useMemo(
    () => visibleTags(game, showSpoilers, showAdult),
    [game, showSpoilers, showAdult]
  )
  /** Kept apart so the drawer can say how many are being withheld rather than just fewer. */
  const adultHidden = useMemo(
    () => visibleTags(game, showSpoilers).length - autoTags.length,
    [game, showSpoilers, autoTags.length]
  )
  const hideTag = (tagId: string): Promise<void> => onTagHidden(game.id, tagId, true)
  const restoreTags = async (): Promise<void> => {
    for (const tagId of game.hiddenTags ?? []) await onTagHidden(game.id, tagId, false)
  }
  const [mode, setMode] = useState<Mode>('usage')
  const [stack, setStack] = useState<string[]>([game.dir])
  const [data, setData] = useState<Breakdown | null>(null)
  const [loading, setLoading] = useState(false)

  // Selecting a different game resets the drawer to the default view.
  useEffect(() => {
    setMode('usage')
    setStack([game.dir])
    setData(null)
  }, [game.id, game.dir])

  const currentDir = stack[stack.length - 1]

  useEffect(() => {
    if (mode !== 'composition') return
    let cancelled = false
    setLoading(true)
    window.sakura.breakdown(currentDir).then((result) => {
      if (cancelled) return
      setData(result)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [mode, currentDir])

  const drive = game.dir.slice(0, 3).toUpperCase()
  const disk = disks.find((d) => d.drive.toUpperCase().startsWith(drive[0]))

  const selfBytes = game.sizeBytes ?? 0
  const libraryBytes = useMemo(
    () => allGames.reduce((sum, g) => sum + (g.sizeBytes ?? 0), 0),
    [allGames]
  )

  /**
   * Measured against the library rather than the whole volume.
   * On a multi-terabyte drive a single game is a fraction of a percent, so a
   * disk-wide pie renders it as an invisible sliver; the drive facts are shown as a
   * capacity bar underneath instead, where the numbers stay legible.
   */
  const usageSlices = useMemo<Slice[]>(
    () =>
      [
        { name: t('drawer.thisGame'), value: selfBytes, color: COLOR_SELF },
        {
          name: t('drawer.otherGames'),
          value: Math.max(0, libraryBytes - selfBytes),
          color: COLOR_OTHER
        }
      ].filter((s) => s.value > 0),
    [selfBytes, libraryBytes]
  )

  const compositionSlices = useMemo<Slice[]>(() => {
    if (!data) return []
    const top = data.entries.slice(0, MAX_SLICES - 1)
    const rest = data.entries.slice(MAX_SLICES - 1)
    const slices: Slice[] = top.map((e, i) => ({
      name: e.name,
      value: e.sizeBytes,
      color: RAMP[i],
      path: e.path,
      isDir: e.isDir
    }))
    if (rest.length > 0) {
      slices.push({
        name: t('drawer.otherN', { n: rest.length }),
        value: rest.reduce((sum, e) => sum + e.sizeBytes, 0),
        color: COLOR_REST
      })
    }
    return slices.filter((s) => s.value > 0)
  }, [data])

  const isUsage = mode === 'usage'
  const slices = isUsage ? usageSlices : compositionSlices
  const total = isUsage ? libraryBytes : data?.totalBytes ?? 0

  return (
    <aside className="drawer">
      <div className="drawer-head">
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <div className="drawer-title">{game.name}</div>
            <div className="drawer-sub">{game.dir}</div>
          </div>
          <button type="button" className="btn ghost" style={{ padding: '4px 10px' }} onClick={onClose}>
            ✕
          </button>
        </div>
      </div>

      <div className="drawer-body">
        {mode === 'composition' && stack.length > 1 && (
          <div className="crumbs">
            {stack.map((dir, i) => (
              <span key={dir} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {i > 0 && <span>/</span>}
                <button type="button" onClick={() => setStack(stack.slice(0, i + 1))}>
                  {i === 0 ? t('drawer.root') : dir.split('\\').pop()}
                </button>
              </span>
            ))}
          </div>
        )}

        {loading && !isUsage ? (
          <div className="skeleton" style={{ width: 240, height: 240, borderRadius: '50%', margin: '0 auto' }} />
        ) : (
          <SizeDonut
            slices={slices}
            centerValue={formatBytes(isUsage ? game.sizeBytes : data?.totalBytes ?? 0)}
            centerLabel={
              isUsage
                ? t('drawer.shareOfLibrary', { pct: formatPercent(selfBytes, libraryBytes) })
                : t('drawer.thisLevel')
            }
            onChartClick={() => setMode(isUsage ? 'composition' : 'usage')}
            onSliceClick={(slice) => {
              if (!isUsage && slice.isDir && slice.path) setStack([...stack, slice.path])
            }}
          />
        )}

        <div className="donut-hint">
          {isUsage
            ? t('drawer.hintToInner')
            : t('drawer.hintToUsage')}
        </div>

        {isUsage && disk && (
          <>
            <div className="section-title">{t('drawer.drive', { drive })}</div>
            <div className="capacity" style={{ height: 16 }}>
              <div
                style={{
                  width: formatPercent(selfBytes, disk.totalBytes),
                  minWidth: 3,
                  background: COLOR_SELF
                }}
                title={t('drawer.thisGame')}
              />
              <div
                style={{
                  width: formatPercent(Math.max(0, libraryBytes - selfBytes), disk.totalBytes),
                  background: COLOR_OTHER
                }}
                title={t('drawer.otherGames')}
              />
              <div
                style={{
                  width: formatPercent(
                    Math.max(0, disk.totalBytes - disk.freeBytes - libraryBytes),
                    disk.totalBytes
                  ),
                  background: '#d3cad0'
                }}
                title={t('drawer.otherFiles')}
              />
              <div style={{ flex: 1, background: COLOR_FREE }} title={t('drawer.freeSpace')} />
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--ink-soft)', lineHeight: 1.7 }}>
              {t('drawer.diskUsage', {
                used: formatBytes(disk.totalBytes - disk.freeBytes),
                total: formatBytes(disk.totalBytes),
                free: formatBytes(disk.freeBytes)
              })}
              <br />
              {t('drawer.diskShare', {
                game: formatPercent(selfBytes, disk.totalBytes),
                library: formatPercent(libraryBytes, disk.totalBytes)
              })}
            </div>
          </>
        )}

        <div className="section-title">{isUsage ? t('drawer.libraryShare') : t('drawer.allEntries')}</div>
        <div className="legend">
          {isUsage
            ? slices.map((s) => (
                <div className="legend-row" key={s.name} role="listitem">
                  <span className="legend-swatch" style={{ background: s.color }} />
                  <span className="legend-name">{s.name}</span>
                  <span className="legend-size">{formatBytes(s.value)}</span>
                  <span className="legend-pct">{formatPercent(s.value, total)}</span>
                </div>
              ))
            : /* Every entry is listed here, including the ones folded into "other". */
              (data?.entries ?? []).map((e, i) => (
                <button
                  type="button"
                  className="legend-row"
                  key={e.path}
                  onClick={() => e.isDir && setStack([...stack, e.path])}
                  style={{ cursor: e.isDir ? 'pointer' : 'default' }}
                >
                  <span
                    className="legend-swatch"
                    style={{ background: i < RAMP.length ? RAMP[i] : COLOR_REST }}
                  />
                  <span className="legend-name">
                    {e.isDir ? '📁 ' : ''}
                    {e.name}
                  </span>
                  <span className="legend-size">{formatBytes(e.sizeBytes)}</span>
                  <span className="legend-pct">{formatPercent(e.sizeBytes, total)}</span>
                </button>
              ))}
          {!isUsage && data && data.entries.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{t('drawer.emptyFolder')}</div>
          )}
        </div>

        {isUsage && (
          <>
            <div className="section-title">{t('drawer.details')}</div>
            <dl className="info-grid">
              {/* Playtime first: it is what someone opens this panel to see. */}
              <dt>{t('drawer.playtime')}</dt>
              <dd>
                <b className="stat-strong">
                  {game.playtimeMs > 0 ? formatDuration(game.playtimeMs, lang) : t('drawer.notRecorded')}
                </b>
                {playing && <span className="drawer-running">{t('drawer.running')}</span>}
              </dd>
              <dt>{t('drawer.lastLaunched')}</dt>
              <dd>{formatDate(game.lastLaunchedAt)}</dd>
              <dt>{t('drawer.launchCount')}</dt>
              <dd>{t('drawer.timesN', { n: game.launchCount })}</dd>
              <dt>{t('drawer.mainProgram')}</dt>
              <dd>
                {game.exe ? game.exe.split('\\').pop() : t('drawer.archiveNotInstalled')}
                {game.launchArgs && game.launchArgs.length > 0 && (
                  <span className="drawer-args" title={game.launchArgs.join(' ')}>
                    {t('drawer.withArgs')}
                  </span>
                )}
                {game.kind === 'installed' && onChooseExe && (
                  <button type="button" className="linkish" onClick={onChooseExe}>
                    {t('drawer.change')}
                  </button>
                )}
              </dd>
              <dt>{t('drawer.size')}</dt>
              <dd>{formatBytes(game.sizeBytes)}</dd>
              <dt>{t('drawer.installed')}</dt>
              <dd>{game.mtimeMs ? formatDate(game.mtimeMs) : t('drawer.unknown')}</dd>
            </dl>

            {game.tags.length > 0 && (
              <>
                <div className="section-title">{t('drawer.tags')}</div>
                <div className="tag-row">
                  {game.tags.map((t) => (
                    <span className="tag" key={t}>
                      {t}
                    </span>
                  ))}
                </div>
              </>
            )}

            {autoTags.length > 0 && (
              <>
                <div className="section-title">{t('tags.autoTitle')}</div>
                {game.work && (
                  <p className="drawer-note">
                    {t('tags.fromWork', {
                      source: TAG_SOURCE_LABEL[game.work.source],
                      title: game.work.title
                    })}
                  </p>
                )}
                <div className="tag-row">
                  {autoTags.map((tag) => (
                    /* The reason on hover, and one click to strike it out. A tag the user
                       cannot argue with is one they stop believing altogether. */
                    <span className="tag auto" key={tag.id} title={tagReason(tag, t)}>
                      {tagLabel(tag, t, lang)}
                      <button
                        type="button"
                        className="tag-hide"
                        title={t('tags.hide')}
                        onClick={() => void hideTag(tag.id)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                {/* Said out loud rather than left as a shorter list. A count that is simply
                    smaller than it should be reads as the lookup having failed. */}
                {adultHidden > 0 && (
                  <p className="drawer-note dim">{t('tags.adultHidden', { n: adultHidden })}</p>
                )}
                {(game.hiddenTags?.length ?? 0) > 0 && (
                  <p className="drawer-note">
                    {t('tags.hidden', { n: game.hiddenTags?.length ?? 0 })}
                    <button type="button" className="linklike" onClick={() => void restoreTags()}>
                      {t('tags.restore')}
                    </button>
                  </p>
                )}
              </>
            )}

            {game.sessions.length > 0 && (
              <>
                <div className="section-title">{t('drawer.sessions')}</div>
                <div className="session-list">
                  {game.sessions.slice(0, 12).map((s) => (
                    <div className="session-row" key={s.startedAt}>
                      <span className="session-date">{formatDate(s.startedAt)}</span>
                      <span className="session-len">{formatDuration(s.ms, lang)}</span>
                    </div>
                  ))}
                  {game.sessions.length > 12 && (
                    <div className="session-more">
                      {t('drawer.moreSessions', { n: game.sessions.length - 12 })}
                    </div>
                  )}
                </div>
              </>
            )}

            {/* Last, and deliberately so: this is the only thing in the drawer somebody
                else wrote, and everything above it is a fact about the folder. Not put
                behind the adult switch the cover is behind — a cover is painted on the
                shelf where anyone walking past sees it, while this is a paragraph at the
                bottom of a panel opened for one game on purpose. */}
            {game.summary && (
              <>
                <div className="section-title">{t('drawer.summary')}</div>
                <div className="drawer-summary">
                  {game.summary.split(/\n{2,}/).map((para, i) => (
                    <p key={i}>{para}</p>
                  ))}
                </div>
                <p className="drawer-note dim">
                  {t(game.summaryTranslated ? 'summary.fromTranslated' : 'summary.from', {
                    source: SUMMARY_SOURCE_LABEL[game.summaryFrom ?? 'bangumi']
                  })}
                </p>
              </>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
