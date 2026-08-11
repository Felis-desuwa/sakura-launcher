import { useEffect, useState } from 'react'
import type { DownloaderKey, Settings, SortKey, TabKey } from '../../../shared/types'
import { DOWNLOADERS, POLL_CHOICES, SORT_META, TAB_META, THEMES } from '../../../shared/types'

interface Props {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  /** Re-run the import preview for one folder, so new games in it can be picked up. */
  onRescanFolder: (folder: string) => void
  /** Drop a folder and everything the library took from it. */
  onRemoveRoot: (folder: string) => void
  onAddFolder: () => void
  onBrowsePath: (dir: string) => void
  /** Put a removed entry back into the library. */
  onUnignore: (dir: string) => void
  /** Drop one path from the removed list without adding it back. */
  onForgetIgnored: (dir: string) => void
  onClearIgnored: () => void
}

export default function SettingsPage({
  settings,
  onChange,
  onRescanFolder,
  onRemoveRoot,
  onAddFolder,
  onBrowsePath,
  onUnignore,
  onForgetIgnored,
  onClearIgnored
}: Props): React.JSX.Element {
  const [has7z, setHas7z] = useState<boolean | null>(null)
  /** undefined while the probe is still running, so "not found" is not shown too early. */
  const [detected, setDetected] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    window.sakura.has7z().then(setHas7z)
  }, [])

  useEffect(() => {
    setDetected(undefined)
    void window.sakura.detectDownloader(settings.downloader).then(setDetected)
  }, [settings.downloader])

  const current = DOWNLOADERS.find((d) => d.key === settings.downloader)

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
              title="重新查看这个文件夹里有什么，和添加文件夹一样先让你勾选"
              onClick={() => onRescanFolder(root)}
            >
              重新扫描并添加
            </button>
            <button
              type="button"
              className="btn ghost"
              style={{ padding: '4px 10px', fontSize: 12 }}
              onClick={() => onRemoveRoot(root)}
            >
              移除
            </button>
          </div>
        ))}
        <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '12px 0 0', lineHeight: 1.6 }}>
          顶部的「刷新」只同步已有条目 —— 名称、体积、说明文件、是否还在原处。
          往文件夹里新放了游戏，就在这里点「重新扫描并添加」，会像添加文件夹一样列出可添加的内容让你勾选。
        </p>
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <button type="button" className="btn primary" onClick={onAddFolder}>
            导入文件夹…
          </button>
        </div>
      </div>

      {settings.ignoredDirs.length > 0 && (
        <div className="card" style={{ maxWidth: 760 }}>
          <div
            className="section-title"
            style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 10 }}
          >
            <span style={{ flex: 1 }}>已移除的条目（{settings.ignoredDirs.length}）</span>
            <button
              type="button"
              className="btn ghost"
              style={{ padding: '4px 10px', fontSize: 12 }}
              onClick={onClearIgnored}
            >
              全部清除
            </button>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 12px', lineHeight: 1.6 }}>
            这些路径被你从库里移除过，扫描时会跳过。磁盘上的文件从未被改动。
            <br />
            「恢复」把条目直接加回库里；「清除」只是把它从这份名单里删掉 ——
            不会立刻加回来，但下次「重新扫描并添加」会重新问你。
            两种做法都会带回它原来的封面与评分。
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
              <button
                type="button"
                className="btn ghost"
                style={{ padding: '4px 10px', fontSize: 12 }}
                title="从这份名单里删掉，不加回库"
                onClick={() => onForgetIgnored(dir)}
              >
                清除
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

        <div className="settings-row">
          <label htmlFor="poll">
            游玩时长检查间隔
            <span className="settings-hint">
              游戏运行期间，每隔这么久确认一次它还开着。间隔越长越省电，
              但记录到的时长最多会短这么多。
            </span>
          </label>
          <select
            id="poll"
            value={settings.playtimePollSeconds}
            onChange={(e) => onChange({ playtimePollSeconds: Number(e.target.value) })}
          >
            {POLL_CHOICES.map((s) => (
              <option key={s} value={s}>
                {s} 秒
              </option>
            ))}
          </select>
        </div>

        <div className="settings-row">
          <label htmlFor="diagnose">
            启动没反应时提示
            <span className="settings-hint">
              双击之后十几秒都没有进程跑起来，就在角落里给一张卡片，点开能看到具体原因 ——
              缺哪个运行库、是不是要管理员权限、是不是主程序选错了。关掉之后
              仍然可以随时右键「启动诊断…」。
            </span>
          </label>
          <button
            id="diagnose"
            type="button"
            className={`switch${settings.diagnoseOnLaunch ? ' on' : ''}`}
            onClick={() => onChange({ diagnoseOnLaunch: !settings.diagnoseOnLaunch })}
          />
        </div>
      </div>

      <div className="card" style={{ maxWidth: 760 }}>
        <div className="section-title" style={{ marginTop: 0 }}>下载</div>

        <div className="settings-row">
          <label>
            默认下载目录
            <span className="settings-hint">
              不指定时跟随第一个扫描文件夹。下载完成后会在这里解压并加入游戏库。
            </span>
          </label>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ flex: 1, fontSize: 12.5, color: 'var(--ink-soft)', wordBreak: 'break-all' }}>
              {settings.downloadDir ?? (settings.roots[0] ?? '还没有可用目录，请先添加扫描文件夹')}
              {settings.downloadDir === null && settings.roots[0] && '（跟随扫描文件夹）'}
            </span>
            <button
              type="button"
              className="btn ghost"
              onClick={async () => {
                const dir = await window.sakura.pickDownloadDir()
                if (dir) onChange({ downloadDir: dir })
              }}
            >
              指定…
            </button>
            {settings.downloadDir && (
              <button type="button" className="btn ghost" onClick={() => onChange({ downloadDir: null })}>
                恢复默认
              </button>
            )}
          </div>
        </div>

        <div className="settings-row">
          <label htmlFor="downloader">下载器</label>
          <select
            id="downloader"
            className="field"
            value={settings.downloader}
            onChange={(e) => onChange({ downloader: e.target.value as DownloaderKey })}
          >
            {DOWNLOADERS.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
              </option>
            ))}
          </select>
        </div>

        <p className="settings-note">{current?.note}</p>

        {settings.downloader !== 'system' && (
          <div className="settings-row">
            <label>下载器程序</label>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ flex: 1, fontSize: 12.5, color: 'var(--ink-soft)', wordBreak: 'break-all' }}>
                {settings.downloaderPath ??
                  (settings.downloader === 'idm'
                    ? detected === undefined
                      ? '正在探测…'
                      : (detected ?? '未指定，也没有探测到 IDM')
                    : '未指定')}
                {settings.downloaderPath === null && detected && '（自动探测）'}
              </span>
              <button
                type="button"
                className="btn ghost"
                onClick={async () => {
                  const exe = await window.sakura.pickExePath()
                  if (exe) onChange({ downloaderPath: exe })
                }}
              >
                指定…
              </button>
              {settings.downloaderPath && (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => onChange({ downloaderPath: null })}
                >
                  清除
                </button>
              )}
            </div>
          </div>
        )}

        {settings.downloader === 'custom' && (
          <div className="settings-row">
            <label htmlFor="dlargs">
              参数模板
              <span className="settings-hint">
                按空格分成一个个参数后再替换占位符，所以链接里的空格或引号不会被当成新的参数。
              </span>
            </label>
            <input
              id="dlargs"
              className="field"
              spellCheck={false}
              value={settings.downloaderArgs}
              placeholder="{url} -o {dir}"
              onChange={(e) => onChange({ downloaderArgs: e.target.value })}
            />
          </div>
        )}

        <div className="settings-row">
          <label htmlFor="trashArchive">
            解压后把压缩包移入回收站
            <span className="settings-hint">
              关闭时压缩包保留在库里的「待安装」分组，磁盘页可以随时批量清理。
            </span>
          </label>
          <button
            id="trashArchive"
            type="button"
            className={`switch${settings.trashArchiveAfterExtract ? ' on' : ''}`}
            onClick={() => onChange({ trashArchiveAfterExtract: !settings.trashArchiveAfterExtract })}
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
