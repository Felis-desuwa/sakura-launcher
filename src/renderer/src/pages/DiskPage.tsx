import { useEffect, useMemo, useState } from 'react'
import type { DiskInfo, Game, RedundantArchive } from '../../../shared/types'
import ConfirmDialog from '../components/ConfirmDialog'
import { formatBytes, formatPercent } from '../lib/format'

interface Props {
  games: Game[]
  onToast: (message: string, error?: boolean) => void
  onRescan: () => void
}

export default function DiskPage({ games, onToast, onRescan }: Props): React.JSX.Element {
  const [disks, setDisks] = useState<DiskInfo[]>([])
  const [redundant, setRedundant] = useState<RedundantArchive[] | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    window.sakura.diskInfo().then(setDisks)
    window.sakura.redundantArchives().then((list) => {
      setRedundant(list)
      setChecked(new Set(list.map((r) => r.volumes[0])))
    })
  }, [])

  const installed = games.filter((g) => g.kind === 'installed')
  const totalSize = installed.reduce((sum, g) => sum + (g.sizeBytes ?? 0), 0)
  const top = useMemo(
    () => [...installed].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0)).slice(0, 10),
    [installed]
  )
  const maxSize = top[0]?.sizeBytes ?? 1

  const selectedBytes = (redundant ?? [])
    .filter((r) => checked.has(r.volumes[0]))
    .reduce((sum, r) => sum + r.sizeBytes, 0)

  const cleanUp = async (): Promise<void> => {
    const targets = (redundant ?? []).filter((r) => checked.has(r.volumes[0]))
    if (targets.length === 0) return
    setConfirming(false)
    setBusy(true)
    const volumes = targets.flatMap((r) => r.volumes)
    const result = await window.sakura.trashArchives(volumes)
    setBusy(false)
    if (result.ok) {
      onToast(`已回收 ${formatBytes(selectedBytes)}，压缩包在回收站中`)
      const list = await window.sakura.redundantArchives()
      setRedundant(list)
      setChecked(new Set(list.map((r) => r.volumes[0])))
      onRescan()
    } else {
      onToast(result.error ?? '清理失败', true)
    }
  }

  return (
    <div className="page">
      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>磁盘容量</div>
        {disks.length === 0 && <div style={{ fontSize: 13, color: 'var(--ink-soft)' }}>暂无数据</div>}
        {disks.map((d) => {
          const used = d.totalBytes - d.freeBytes
          return (
            <div key={d.drive} style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <b>{d.drive}</b>
                <span style={{ color: 'var(--ink-soft)' }}>
                  已用 {formatBytes(used)} / 共 {formatBytes(d.totalBytes)} · 可用{' '}
                  {formatBytes(d.freeBytes)}
                </span>
              </div>
              <div className="capacity">
                <div
                  style={{
                    width: formatPercent(used, d.totalBytes),
                    background: 'var(--accent)'
                  }}
                />
                <div style={{ flex: 1, background: 'rgba(231,84,128,0.12)' }} />
              </div>
            </div>
          )
        })}
      </div>

      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>游戏库</div>
        <div style={{ display: 'flex', gap: 34, marginBottom: 12 }}>
          <Stat label="已安装游戏" value={String(installed.length)} />
          <Stat label="压缩包条目" value={String(games.length - installed.length)} />
          <Stat label="占用总计" value={formatBytes(totalSize)} />
        </div>
        <div className="section-title">体积 Top 10</div>
        {top.map((g) => (
          <div className="bar-row" key={g.id}>
            <span className="legend-name" title={g.name}>
              {g.name}
            </span>
            <span className="bar-track">
              <span
                className="bar-fill"
                style={{ width: `${((g.sizeBytes ?? 0) / maxSize) * 100}%` }}
              />
            </span>
            <span className="legend-size">{formatBytes(g.sizeBytes)}</span>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>
          冗余安装包
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 12px', lineHeight: 1.6 }}>
          下列压缩包都已确认存在对应的解压文件夹，删掉不影响游戏运行。会移入回收站，可恢复。
        </p>

        {redundant === null && <div className="skeleton" style={{ height: 80 }} />}

        {redundant && redundant.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--ink-soft)' }}>没有发现冗余压缩包。</div>
        )}

        {redundant && redundant.length > 0 && (
          <>
            {redundant.map((r) => (
              <label className="redundant-row" key={r.volumes[0]}>
                <input
                  type="checkbox"
                  checked={checked.has(r.volumes[0])}
                  onChange={(e) => {
                    const next = new Set(checked)
                    if (e.target.checked) next.add(r.volumes[0])
                    else next.delete(r.volumes[0])
                    setChecked(next)
                  }}
                />
                <span className="legend-name" title={`已解压到：${r.extractedDir}`}>
                  {r.name}
                  {r.volumes.length > 1 && (
                    <span style={{ color: 'var(--ink-soft)' }}> · {r.volumes.length} 个分卷</span>
                  )}
                </span>
                <span className="legend-size">{formatBytes(r.sizeBytes)}</span>
              </label>
            ))}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                marginTop: 16,
                paddingTop: 14,
                borderTop: '1px solid rgba(231,84,128,0.14)'
              }}
            >
              <span style={{ fontSize: 13 }}>
                已选 <b style={{ color: 'var(--accent)' }}>{formatBytes(selectedBytes)}</b>
              </span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                className="btn danger"
                disabled={busy || selectedBytes === 0}
                onClick={() => setConfirming(true)}
              >
                {busy ? '清理中…' : '移入回收站'}
              </button>
            </div>
          </>
        )}
      </div>

      {confirming && (
        <ConfirmDialog
          title="清理冗余安装包"
          danger
          confirmLabel="移入回收站"
          body={
            <>
              将把 <b>{(redundant ?? []).filter((r) => checked.has(r.volumes[0])).length}</b> 个压缩包
              （共 <b>{formatBytes(selectedBytes)}</b>）移入回收站。
              它们都已确认存在解压副本，删掉不影响游戏运行，之后也可从回收站恢复。
            </>
          }
          onCancel={() => setConfirming(false)}
          onConfirm={() => void cleanUp()}
        />
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 21, fontWeight: 700, color: 'var(--accent)' }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{label}</div>
    </div>
  )
}
