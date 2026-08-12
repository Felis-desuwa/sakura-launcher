import { useEffect, useMemo, useState } from 'react'
import type { DiskInfo, Game, RedundantArchive } from '../../../shared/types'
import ConfirmDialog from '../components/ConfirmDialog'
import { formatBytes, formatPercent } from '../lib/format'
import { useT } from '../lib/i18n'

interface Props {
  games: Game[]
  onToast: (message: string, error?: boolean) => void
  onRescan: () => void
}

export default function DiskPage({ games, onToast, onRescan }: Props): React.JSX.Element {
  const t = useT()
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
      onToast(t('disk.recycled', { size: formatBytes(selectedBytes) }))
      const list = await window.sakura.redundantArchives()
      setRedundant(list)
      setChecked(new Set(list.map((r) => r.volumes[0])))
      onRescan()
    } else {
      onToast(result.error ?? t('toast.cleanupFailed'), true)
    }
  }

  return (
    <div className="page">
      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>{t('disk.capacity')}</div>
        {disks.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--ink-soft)' }}>{t('disk.noData')}</div>
        )}
        {disks.map((d) => {
          const used = d.totalBytes - d.freeBytes
          return (
            <div key={d.drive} style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <b>{d.drive}</b>
                <span style={{ color: 'var(--ink-soft)' }}>
                  {t('disk.used', {
                    used: formatBytes(used),
                    total: formatBytes(d.totalBytes),
                    free: formatBytes(d.freeBytes)
                  })}
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
        <div className="section-title" style={{ marginTop: 0 }}>{t('disk.library')}</div>
        <div style={{ display: 'flex', gap: 34, marginBottom: 12 }}>
          <Stat label={t('disk.installedGames')} value={String(installed.length)} />
          <Stat label={t('disk.archiveEntries')} value={String(games.length - installed.length)} />
          <Stat label={t('disk.totalSize')} value={formatBytes(totalSize)} />
        </div>
        <div className="section-title">{t('disk.top10')}</div>
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
          {t('disk.redundant')}
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 12px', lineHeight: 1.6 }}>
          {t('disk.redundantNote')}
        </p>

        {redundant === null && <div className="skeleton" style={{ height: 80 }} />}

        {redundant && redundant.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--ink-soft)' }}>{t('disk.noRedundant')}</div>
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
                <span className="legend-name" title={t('disk.extractedTo', { dir: r.extractedDir })}>
                  {r.name}
                  {r.volumes.length > 1 && (
                    <span style={{ color: 'var(--ink-soft)' }}>
                      {t('disk.volumes', { n: r.volumes.length })}
                    </span>
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
                {t('disk.selectedSize', { size: formatBytes(selectedBytes) })}
              </span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                className="btn danger"
                disabled={busy || selectedBytes === 0}
                onClick={() => setConfirming(true)}
              >
                {busy ? t('disk.cleaning') : t('disk.toRecycle')}
              </button>
            </div>
          </>
        )}
      </div>

      {confirming && (
        <ConfirmDialog
          title={t('disk.confirmTitle')}
          danger
          confirmLabel={t('disk.toRecycle')}
          body={
            <>
              {t('disk.confirmDetail', {
                n: (redundant ?? []).filter((r) => checked.has(r.volumes[0])).length,
                size: formatBytes(selectedBytes)
              })}
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
