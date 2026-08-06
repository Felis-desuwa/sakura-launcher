import { useCallback, useEffect, useState } from 'react'
import type { ListedEntry } from '../../../preload/index'
import { formatBytes, formatDate } from '../lib/format'
import FolderWindow from './FolderWindow'

interface Props {
  rootDir: string
  title: string
  onClose: () => void
  onToast: (message: string, error?: boolean) => void
}

const GLYPHS: Record<string, string> = {
  '.exe': '⚙️',
  '.bat': '⚙️',
  '.cmd': '⚙️',
  '.txt': '📄',
  '.md': '📄',
  '.ini': '📄',
  '.json': '📄',
  '.log': '📄',
  '.jpg': '🖼️',
  '.jpeg': '🖼️',
  '.png': '🖼️',
  '.bmp': '🖼️',
  '.webp': '🖼️',
  '.gif': '🖼️',
  '.mp3': '🎵',
  '.ogg': '🎵',
  '.wav': '🎵',
  '.mp4': '🎬',
  '.avi': '🎬',
  '.wmv': '🎬',
  '.zip': '🗜️',
  '.7z': '🗜️',
  '.rar': '🗜️',
  '.dll': '🧩'
}

function glyphFor(entry: ListedEntry): string {
  if (entry.isDir) return '📁'
  return GLYPHS[entry.ext] ?? '📄'
}

/** A file browser rendered inside the app, so opening a folder never leaves the launcher. */
export default function FileBrowser({
  rootDir,
  title,
  onClose,
  onToast
}: Props): React.JSX.Element {
  const [stack, setStack] = useState<string[]>([rootDir])
  const [entries, setEntries] = useState<ListedEntry[]>([])
  const [parent, setParent] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const current = stack[stack.length - 1]

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setSelected(null)
    window.sakura.listDir(current).then((result) => {
      if (cancelled) return
      setEntries(result.entries)
      setParent(result.parent)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [current])

  const open = useCallback(
    async (entry: ListedEntry): Promise<void> => {
      if (entry.isDir) {
        setStack((cur) => [...cur, entry.path])
        return
      }
      if (/\.(exe|bat|cmd)$/i.test(entry.name)) {
        const result = await window.sakura.runExe(entry.path)
        onToast(result.ok ? `正在运行 ${entry.name}` : result.error ?? '启动失败', !result.ok)
      }
    },
    [onToast]
  )

  const goBack = (): void => {
    if (stack.length > 1) {
      setStack((cur) => cur.slice(0, -1))
    } else if (parent) {
      // Stepping above the folder we opened at is allowed, one level at a time.
      setStack([parent])
    }
  }

  const dirCount = entries.filter((e) => e.isDir).length
  const fileBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0)

  return (
    <FolderWindow
      title={title}
      subtitle={current}
      canGoBack={stack.length > 1 || !!parent}
      onBack={goBack}
      onClose={onClose}
      actions={
        <span style={{ fontSize: 11.5, color: 'var(--ink-soft)', marginRight: 6 }}>
          {dirCount} 个文件夹 · {entries.length - dirCount} 个文件 · {formatBytes(fileBytes)}
        </span>
      }
    >
      <div className="file-head">
        <span />
        <span>名称</span>
        <span>大小</span>
        <span>修改时间</span>
      </div>

      {loading ? (
        <div className="skeleton" style={{ height: 200 }} />
      ) : entries.length === 0 ? (
        <div className="empty" style={{ minHeight: 200 }}>
          <p>这个文件夹是空的</p>
        </div>
      ) : (
        entries.map((entry) => (
          <button
            type="button"
            key={entry.path}
            className={`file-row${selected === entry.path ? ' selected' : ''}`}
            onClick={() => setSelected(entry.path)}
            onDoubleClick={() => void open(entry)}
            title={entry.path}
          >
            <span className="file-glyph">{glyphFor(entry)}</span>
            <span className="file-name">{entry.name}</span>
            <span className="file-meta">{entry.isDir ? '—' : formatBytes(entry.sizeBytes)}</span>
            <span className="file-meta">{formatDate(entry.mtimeMs)}</span>
          </button>
        ))
      )}

      <p style={{ fontSize: 11.5, color: 'var(--ink-soft)', marginTop: 16 }}>
        双击文件夹进入下一级，双击 .exe 直接运行。Backspace 返回上一级，Esc 关闭。
      </p>
    </FolderWindow>
  )
}
