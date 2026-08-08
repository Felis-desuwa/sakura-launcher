import { useEffect, useMemo, useState } from 'react'
import type { Breakdown, DiskInfo, Game } from '../../../shared/types'
import { formatDuration } from '../../../shared/types'
import { formatBytes, formatDate, formatPercent } from '../lib/format'
import SizeDonut, { type Slice } from './SizeDonut'

/**
 * Mode B ramp: one hue, ordered by size, darkest = largest.
 * Validated with the data-viz palette checker (`--ordinal`, light surface):
 * monotone lightness, adjacent ΔL >= 0.06, light end 2.24:1 against the surface.
 * Six steps is the maximum that clears those gates — hence the top-5 + "其他" cap.
 * Re-run the validator before changing any of these values.
 */
const RAMP = ['#5e1a2c', '#85243f', '#a83059', '#c74374', '#ec8fb0']

/**
 * "其他" is an aggregate, not a rank, so it sits outside the ramp in neutral grey.
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
}

export default function DetailDrawer({
  game,
  allGames,
  disks,
  playing,
  onClose,
  onChooseExe
}: Props): React.JSX.Element {
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
        { name: '本游戏', value: selfBytes, color: COLOR_SELF },
        {
          name: '其他游戏',
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
        name: `其他 ${rest.length} 项`,
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
                  {i === 0 ? '根目录' : dir.split('\\').pop()}
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
              isUsage ? `占游戏库 ${formatPercent(selfBytes, libraryBytes)}` : '当前层级'
            }
            onChartClick={() => setMode(isUsage ? 'composition' : 'usage')}
            onSliceClick={(slice) => {
              if (!isUsage && slice.isDir && slice.path) setStack([...stack, slice.path])
            }}
          />
        )}

        <div className="donut-hint">
          {isUsage
            ? '点击饼图 → 查看游戏文件夹内部构成'
            : '点击饼图 → 返回磁盘占用视角 · 点击文件夹切片可下钻'}
        </div>

        {isUsage && disk && (
          <>
            <div className="section-title">{drive} 盘</div>
            <div className="capacity" style={{ height: 16 }}>
              <div
                style={{
                  width: formatPercent(selfBytes, disk.totalBytes),
                  minWidth: 3,
                  background: COLOR_SELF
                }}
                title="本游戏"
              />
              <div
                style={{
                  width: formatPercent(Math.max(0, libraryBytes - selfBytes), disk.totalBytes),
                  background: COLOR_OTHER
                }}
                title="其他游戏"
              />
              <div
                style={{
                  width: formatPercent(
                    Math.max(0, disk.totalBytes - disk.freeBytes - libraryBytes),
                    disk.totalBytes
                  ),
                  background: '#d3cad0'
                }}
                title="其他文件"
              />
              <div style={{ flex: 1, background: COLOR_FREE }} title="可用空间" />
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--ink-soft)', lineHeight: 1.7 }}>
              已用 {formatBytes(disk.totalBytes - disk.freeBytes)} / 共{' '}
              {formatBytes(disk.totalBytes)} · 可用 {formatBytes(disk.freeBytes)}
              <br />
              本游戏占全盘 {formatPercent(selfBytes, disk.totalBytes)}，游戏库共占{' '}
              {formatPercent(libraryBytes, disk.totalBytes)}
            </div>
          </>
        )}

        <div className="section-title">{isUsage ? '游戏库占比' : '全部条目'}</div>
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
            : /* Every entry is listed here, including the ones folded into "其他". */
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
            <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>此文件夹为空</div>
          )}
        </div>

        {isUsage && (
          <>
            <div className="section-title">详情</div>
            <dl className="info-grid">
              {/* Playtime first: it is what someone opens this panel to see. */}
              <dt>游玩时长</dt>
              <dd>
                <b className="stat-strong">
                  {game.playtimeMs > 0 ? formatDuration(game.playtimeMs) : '未记录'}
                </b>
                {playing && <span className="drawer-running">游玩中</span>}
              </dd>
              <dt>最后启动</dt>
              <dd>{formatDate(game.lastLaunchedAt)}</dd>
              <dt>启动次数</dt>
              <dd>{game.launchCount} 次</dd>
              <dt>主程序</dt>
              <dd>
                {game.exe ? game.exe.split('\\').pop() : '（压缩包，未安装）'}
                {game.launchArgs && game.launchArgs.length > 0 && (
                  <span className="drawer-args" title={game.launchArgs.join(' ')}>
                    带参数启动
                  </span>
                )}
                {game.kind === 'installed' && onChooseExe && (
                  <button type="button" className="linkish" onClick={onChooseExe}>
                    更换
                  </button>
                )}
              </dd>
              <dt>体积</dt>
              <dd>{formatBytes(game.sizeBytes)}</dd>
              <dt>安装/修改</dt>
              <dd>{game.mtimeMs ? formatDate(game.mtimeMs) : '未知'}</dd>
            </dl>

            {game.tags.length > 0 && (
              <>
                <div className="section-title">标签</div>
                <div className="tag-row">
                  {game.tags.map((t) => (
                    <span className="tag" key={t}>
                      {t}
                    </span>
                  ))}
                </div>
              </>
            )}

            {game.sessions.length > 0 && (
              <>
                <div className="section-title">游玩记录</div>
                <div className="session-list">
                  {game.sessions.slice(0, 12).map((s) => (
                    <div className="session-row" key={s.startedAt}>
                      <span className="session-date">{formatDate(s.startedAt)}</span>
                      <span className="session-len">{formatDuration(s.ms)}</span>
                    </div>
                  ))}
                  {game.sessions.length > 12 && (
                    <div className="session-more">
                      还有 {game.sessions.length - 12} 条，完整记录在游戏文件夹的
                      <code>sakura-launcher.md</code> 里
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
