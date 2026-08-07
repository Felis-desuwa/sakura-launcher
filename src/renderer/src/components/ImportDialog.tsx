import { useEffect, useMemo, useState } from 'react'
import type { ImportCandidate, ImportPreview } from '../../../preload/index'
import { formatBytes } from '../lib/format'

interface Props {
  preview: ImportPreview
  /** `accept` becomes games; `reject` is remembered so later scans stop offering it. */
  onConfirm: (accept: string[], reject: string[]) => void
  onCancel: () => void
}

interface Section {
  key: string
  title: string
  hint: string
  items: ImportCandidate[]
}

/**
 * Vet a folder before it joins the library.
 *
 * The scanner's judgement is shown rather than applied silently: what it took, what it
 * passed over and why. Ticking a box now is far less work than noticing weeks later
 * that a game never appeared, with nothing to explain it.
 */
export default function ImportDialog({ preview, onConfirm, onCancel }: Props): React.JSX.Element {
  const sections = useMemo<Section[]>(
    () =>
      [
        {
          key: 'games',
          title: '识别为游戏',
          hint: '扫描时判定为游戏的文件夹',
          items: preview.games
        },
        {
          key: 'rejected',
          title: '疑似非游戏',
          hint: '有可执行文件但没通过检查 —— 判断错了就勾上',
          items: preview.rejected
        },
        {
          key: 'archives',
          title: '压缩包 · 未安装',
          hint: '还没解压的安装包，导入后可以右键解压',
          items: preview.archives
        }
      ].filter((s) => s.items.length > 0),
    [preview]
  )

  // Accepted and archived entries start ticked; the ones the scanner turned down do not.
  const [checked, setChecked] = useState<Set<string>>(new Set())
  useEffect(() => {
    setChecked(new Set([...preview.games, ...preview.archives].map((c) => c.dir)))
  }, [preview])

  const all = useMemo(
    () => [...preview.games, ...preview.rejected, ...preview.archives],
    [preview]
  )

  const totalBytes = all
    .filter((c) => checked.has(c.dir))
    .reduce((sum, c) => sum + (c.sizeBytes ?? 0), 0)

  const toggle = (dir: string): void =>
    setChecked((cur) => {
      const next = new Set(cur)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })

  const selectAll = (): void => setChecked(new Set(all.map((c) => c.dir)))
  const invert = (): void =>
    setChecked(new Set(all.filter((c) => !checked.has(c.dir)).map((c) => c.dir)))

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="modal import-modal">
        <div className="step">导入文件夹</div>
        <h2 title={preview.folder}>{preview.folder}</h2>

        <div className="import-toolbar">
          <span className="import-summary">
            已选 {checked.size} / {all.length} 项
            {totalBytes > 0 && ` · 合计 ${formatBytes(totalBytes)}`}
          </span>
          <button type="button" className="btn ghost small" onClick={selectAll}>
            全选
          </button>
          <button type="button" className="btn ghost small" onClick={invert}>
            反选
          </button>
        </div>

        <div className="import-list">
          {sections.map((section) => (
            <div className="import-section" key={section.key}>
              <div className="import-section-head">
                <b>
                  {section.title} ({section.items.length})
                </b>
                <span>{section.hint}</span>
              </div>
              {section.items.map((item) => (
                <label className="import-row" key={item.dir}>
                  <input
                    type="checkbox"
                    checked={checked.has(item.dir)}
                    onChange={() => toggle(item.dir)}
                  />
                  <span className="import-name" title={item.dir}>
                    {item.name}
                  </span>
                  <span className="import-note">
                    {item.reason ??
                      (item.volumes && item.volumes.length > 1
                        ? `${item.volumes.length} 个分卷`
                        : item.exe.split('\\').pop() ?? '')}
                  </span>
                  <span className="import-size">
                    {item.sizeBytes === null ? '' : formatBytes(item.sizeBytes)}
                  </span>
                </label>
              ))}
            </div>
          ))}
        </div>

        <p className="import-foot">
          没有勾选的条目会被记住，之后重新扫描不会再冒出来；随时可以在
          「设置 → 已移除的条目」里恢复。这个文件夹会加入扫描列表，每次启动自动检查新游戏。
        </p>

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() =>
              onConfirm(
                all.filter((c) => checked.has(c.dir)).map((c) => c.dir),
                all.filter((c) => !checked.has(c.dir)).map((c) => c.dir)
              )
            }
          >
            导入 {checked.size} 项
          </button>
        </div>
      </div>
    </div>
  )
}
