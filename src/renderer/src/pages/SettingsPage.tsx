import { useEffect, useState } from 'react'
import type { Settings, SortKey, TabKey } from '../../../shared/types'
import { SORT_META, TAB_META, THEMES } from '../../../shared/types'

interface Props {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onRescan: () => void
  onAddFolder: () => void
  onBrowsePath: (dir: string) => void
  onUnignore: (dir: string) => void
}

export default function SettingsPage({
  settings,
  onChange,
  onRescan,
  onAddFolder,
  onBrowsePath,
  onUnignore
}: Props): React.JSX.Element {
  const [has7z, setHas7z] = useState<boolean | null>(null)

  useEffect(() => {
    window.sakura.has7z().then(setHas7z)
  }, [])

  return (
    <div className="page">
      <div className="card" style={{ maxWidth: 760 }}>
        <div className="section-title" style={{ marginTop: 0 }}>扫描文件夹</div>
        {settings.roots.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 10 }}>
            还没有添加任何扫描目录。
          </div>
        )}
        {settings.roots.map((root) => (
          <div className="root-row" key={root}>
            <span style={{ flex: 1 }}>{root}</span>
            <button
              type="button"
              className="btn ghost"
              style={{ padding: '4px 10px', fontSize: 12 }}
              onClick={() => onBrowsePath(root)}
            >
              浏览
            </button>
            <button
              type="button"
              className="btn ghost"
              style={{ padding: '4px 10px', fontSize: 12 }}
              onClick={() => onChange({ roots: settings.roots.filter((r) => r !== root) })}
            >
              移除
            </button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <button type="button" className="btn primary" onClick={onAddFolder}>
            添加文件夹…
          </button>
          <button type="button" className="btn ghost" onClick={onRescan}>
            立即重新扫描
          </button>
        </div>
      </div>

      {settings.ignoredDirs.length > 0 && (
        <div className="card" style={{ maxWidth: 760 }}>
          <div className="section-title" style={{ marginTop: 0 }}>
            已移除的条目
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 12px', lineHeight: 1.6 }}>
            这些路径被你从库里移除过，扫描时会跳过。磁盘上的文件从未被改动。
          </p>
          {settings.ignoredDirs.map((dir) => (
            <div className="root-row" key={dir}>
              <span style={{ flex: 1 }}>{dir}</span>
              <button
                type="button"
                className="btn ghost"
                style={{ padding: '4px 10px', fontSize: 12 }}
                onClick={() => onUnignore(dir)}
              >
                恢复
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ maxWidth: 760 }}>
        <div className="section-title" style={{ marginTop: 0 }}>主题</div>
        <div className="theme-grid">
          {THEMES.map((t) => (
            <button
              type="button"
              key={t.key}
              className={`theme-card${settings.theme === t.key ? ' active' : ''}`}
              onClick={() => onChange({ theme: t.key })}
            >
              <span className="theme-swatch">
                {t.swatch.map((c) => (
                  <span key={c} style={{ background: c }} />
                ))}
              </span>
              <span className="theme-name">
                {t.label}
                {t.note && <em>{t.note}</em>}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="card" style={{ maxWidth: 760 }}>
        <div className="section-title" style={{ marginTop: 0 }}>外观与行为</div>

        <div className="settings-row">
          <label htmlFor="defaultTab">默认启动标签页</label>
          <select
            id="defaultTab"
            className="field"
            value={settings.defaultTab}
            onChange={(e) => onChange({ defaultTab: e.target.value as TabKey })}
          >
            {(Object.keys(TAB_META) as TabKey[]).map((key) => (
              <option key={key} value={key}>
                {TAB_META[key].label}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-row">
          <label htmlFor="sortKey">默认排序</label>
          <select
            id="sortKey"
            className="field"
            value={settings.sortKey}
            onChange={(e) => onChange({ sortKey: e.target.value as SortKey })}
          >
            {(Object.keys(SORT_META) as SortKey[]).map((key) => (
              <option key={key} value={key}>
                {SORT_META[key]}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-row">
          <label htmlFor="tileSize">磁贴尺寸</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              id="tileSize"
              type="range"
              min={130}
              max={280}
              step={10}
              value={settings.tileSize}
              onChange={(e) => onChange({ tileSize: Number(e.target.value) })}
              style={{ flex: 1 }}
            />
            <span style={{ width: 54, fontSize: 12.5, color: 'var(--ink-soft)' }}>
              {settings.tileSize}px
            </span>
          </div>
        </div>

        <div className="settings-row">
          <label htmlFor="petals">花瓣动画</label>
          <button
            id="petals"
            type="button"
            className={`switch${settings.petals ? ' on' : ''}`}
            onClick={() => onChange({ petals: !settings.petals })}
          />
        </div>
      </div>

      <div className="card" style={{ maxWidth: 760 }}>
        <div className="section-title" style={{ marginTop: 0 }}>外部程序</div>

        <div className="settings-row">
          <label>Geek Uninstaller</label>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ flex: 1, fontSize: 12.5, color: 'var(--ink-soft)', wordBreak: 'break-all' }}>
              {settings.geekPath ?? '未指定（没有自带卸载程序的游戏将直接移入回收站）'}
            </span>
            <button
              type="button"
              className="btn ghost"
              onClick={async () => {
                const exe = await window.sakura.pickExePath()
                if (exe) onChange({ geekPath: exe })
              }}
            >
              指定…
            </button>
            {settings.geekPath && (
              <button type="button" className="btn ghost" onClick={() => onChange({ geekPath: null })}>
                清除
              </button>
            )}
          </div>
        </div>

        <div className="settings-row">
          <label>7-Zip</label>
          <span style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>
            {has7z === null ? '检测中…' : has7z ? '已检测到，可解压压缩包条目' : '未检测到，无法解压'}
          </span>
        </div>
      </div>
    </div>
  )
}
