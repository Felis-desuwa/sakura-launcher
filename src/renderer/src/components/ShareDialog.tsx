import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ShareCategory,
  ShareFormat,
  ShareJob,
  ShareOptions,
  SharePlan,
  ShareResult
} from '../../../shared/types'
import { SHARE_CATEGORY_META, SHARE_FORMATS } from '../../../shared/types'
import { formatBytes } from '../lib/format'

interface Props {
  plans: SharePlan[]
  onClose: () => void
  onToast: (message: string, error?: boolean) => void
}

/** Categories in the order they are shown; `config` last because it is the risky one. */
const ORDER: ShareCategory[] = ['launcher', 'save', 'noise', 'config']

interface PerGame {
  name: string
  /** Absolute paths of the ticked candidates. */
  excluded: Set<string>
  /** Extra paths the user added by hand. */
  extra: { path: string; rel: string }[]
}

/**
 * Packing a game up to send to someone.
 *
 * The whole dialog is built around one fact: the game folder is never written to.
 * Personal data is kept *out of the archive*, not removed from disk, so there is nothing
 * here to undo and no reason for a confirmation ritual — the worst a wrong tick can do
 * is produce an archive worth deleting.
 *
 * What it does need is the user's eyes on the exclusion list, because the rules can be
 * wrong in a way that is expensive: a `.dat` file is a save in one engine and the entire
 * game in another, and an archive missing the latter is not discovered until someone
 * else tries to run it.
 */
export default function ShareDialog({ plans, onClose, onToast }: Props): React.JSX.Element {
  const shareable = useMemo(() => plans.filter((p) => !p.blocked), [plans])
  const blocked = useMemo(() => plans.filter((p) => p.blocked), [plans])

  const [format, setFormat] = useState<ShareFormat>('7z')
  const [password, setPassword] = useState('')
  const [encryptNames, setEncryptNames] = useState(true)
  const [outDir, setOutDir] = useState(shareable[0]?.suggestedDir ?? '')
  const [overwrite, setOverwrite] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(
    shareable.length === 1 ? shareable[0].gameId : null
  )
  const [per, setPer] = useState<Record<string, PerGame>>({})

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ gameId: string; percent: number; index: number }>()
  const [results, setResults] = useState<ShareResult[] | null>(null)
  const [freeBytes, setFreeBytes] = useState<number | null>(null)

  useEffect(() => {
    const next: Record<string, PerGame> = {}
    for (const plan of shareable) {
      next[plan.gameId] = {
        name: plan.suggestedName,
        excluded: new Set(plan.candidates.filter((c) => c.checked).map((c) => c.path)),
        extra: []
      }
    }
    setPer(next)
  }, [shareable])

  useEffect(() => {
    if (!outDir) return
    void window.sakura.shareFreeSpace(outDir).then(setFreeBytes)
  }, [outDir])

  useEffect(() => {
    const offProgress = window.sakura.onShareProgress((p) => setProgress(p))
    const offDone = window.sakura.onShareDone((r) => {
      setRunning(false)
      setResults(r)
      const ok = r.filter((x) => x.ok).length
      const failed = r.filter((x) => !x.ok && !x.skipped).length
      if (failed === 0 && ok > 0) onToast(`已打包 ${ok} 个游戏`)
      else if (ok > 0) onToast(`${ok} 个成功，${failed} 个失败`, true)
      else if (failed > 0) onToast('打包失败', true)
    })
    return () => {
      offProgress()
      offDone()
    }
  }, [onToast])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !running) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, running])

  const patch = useCallback((gameId: string, change: Partial<PerGame>): void => {
    setPer((cur) => ({ ...cur, [gameId]: { ...cur[gameId], ...change } }))
  }, [])

  const toggle = (gameId: string, filePath: string): void => {
    setPer((cur) => {
      const next = new Set(cur[gameId].excluded)
      if (next.has(filePath)) next.delete(filePath)
      else next.add(filePath)
      return { ...cur, [gameId]: { ...cur[gameId], excluded: next } }
    })
  }

  const addExtra = async (plan: SharePlan, kind: 'file' | 'dir'): Promise<void> => {
    const picked = await window.sakura.pickInside(plan.dir, kind)
    if (!picked) return
    const rel = picked.slice(plan.dir.length + 1) || picked
    setPer((cur) => {
      const state = cur[plan.gameId]
      if (state.extra.some((e) => e.path === picked)) return cur
      const excluded = new Set(state.excluded)
      excluded.add(picked)
      return {
        ...cur,
        [plan.gameId]: { ...state, excluded, extra: [...state.extra, { path: picked, rel }] }
      }
    })
  }

  /** Bytes that will actually be written, near enough to warn on: folder minus exclusions. */
  const plannedBytes = useMemo(
    () =>
      shareable.reduce((sum, plan) => {
        const state = per[plan.gameId]
        if (!state) return sum + plan.sizeBytes
        const skipped = plan.candidates
          .filter((c) => state.excluded.has(c.path))
          .reduce((n, c) => n + c.sizeBytes, 0)
        return sum + Math.max(0, plan.sizeBytes - skipped)
      }, 0),
    [shareable, per]
  )

  const nameProblem = useMemo(() => {
    const names = shareable.map((p) => per[p.gameId]?.name?.trim() ?? '')
    if (names.some((n) => n.length === 0)) return '压缩包名称不能为空'
    if (new Set(names).size !== names.length) return '有两个压缩包重名，它们会互相覆盖'
    return null
  }, [shareable, per])

  const tight = freeBytes !== null && plannedBytes > freeBytes

  const start = async (): Promise<void> => {
    const jobs: ShareJob[] = shareable.map((plan) => ({
      gameId: plan.gameId,
      name: per[plan.gameId].name.trim(),
      outDir,
      exclude: [...per[plan.gameId].excluded]
    }))
    const options: ShareOptions = { format, password, encryptNames, overwrite }
    setResults(null)
    setRunning(true)
    const started = await window.sakura.shareStart(jobs, options)
    if (!started.ok) {
      setRunning(false)
      onToast(started.error ?? '无法开始打包', true)
    }
  }

  const sections = (plan: SharePlan): React.JSX.Element => {
    const state = per[plan.gameId]
    if (!state) return <></>
    return (
      <div className="share-sections">
        {ORDER.map((category) => {
          const items = plan.candidates.filter((c) => c.category === category)
          if (items.length === 0) return null
          const meta = SHARE_CATEGORY_META[category]
          return (
            <div className="import-section" key={category}>
              <div className="import-section-head">
                <b>
                  {meta.title} ({items.length})
                </b>
                <span>{meta.hint}</span>
              </div>
              {items.map((item) => (
                <label className="share-row" key={item.path}>
                  <input
                    type="checkbox"
                    checked={state.excluded.has(item.path)}
                    onChange={() => toggle(plan.gameId, item.path)}
                  />
                  <span className="share-rel" title={item.path}>
                    {item.isDir ? '📁 ' : ''}
                    {item.rel}
                  </span>
                  <span className="share-why">
                    {item.reason}
                    {item.oversized && (
                      <b className="share-warn">
                        {' '}
                        · 占了整个游戏的一大块，多半是被误判的游戏数据
                      </b>
                    )}
                  </span>
                  <span className="share-size">{formatBytes(item.sizeBytes)}</span>
                </label>
              ))}
            </div>
          )
        })}

        {state.extra.length > 0 && (
          <div className="import-section">
            <div className="import-section-head">
              <b>你自己加的 ({state.extra.length})</b>
              <span>手动指定的排除项</span>
            </div>
            {state.extra.map((e) => (
              <label className="share-row" key={e.path}>
                <input
                  type="checkbox"
                  checked={state.excluded.has(e.path)}
                  onChange={() => toggle(plan.gameId, e.path)}
                />
                <span className="share-rel" title={e.path}>
                  {e.rel}
                </span>
                <span className="share-why">手动添加</span>
              </label>
            ))}
          </div>
        )}

        {plan.candidates.length === 0 && state.extra.length === 0 && (
          <p className="share-empty">这个文件夹里没有找到存档或个人痕迹，可以直接打包。</p>
        )}

        <div className="share-add">
          <span>规则没找到的，自己加：</span>
          <button type="button" className="btn ghost small" onClick={() => void addExtra(plan, 'file')}>
            添加文件…
          </button>
          <button type="button" className="btn ghost small" onClick={() => void addExtra(plan, 'dir')}>
            添加文件夹…
          </button>
        </div>
      </div>
    )
  }

  if (results) {
    const ok = results.filter((r) => r.ok)
    return (
      <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal">
          <div className="step">分享</div>
          <h2>{ok.length > 0 ? '打包完成' : '没有打包成功'}</h2>
          <div className="import-list">
            {results.map((r) => {
              const plan = plans.find((p) => p.gameId === r.gameId)
              return (
                <div className="share-result" key={r.gameId}>
                  <span className="share-rel">{plan?.gameName ?? r.gameId}</span>
                  {r.ok ? (
                    <>
                      <span className="share-why" title={r.file}>
                        {r.file}
                      </span>
                      <button
                        type="button"
                        className="btn ghost small"
                        onClick={() => void window.sakura.openPath(r.file!)}
                      >
                        打开位置
                      </button>
                    </>
                  ) : (
                    <span className="share-why error">{r.skipped ? '已取消' : r.error}</span>
                  )}
                </div>
              )
            })}
          </div>
          <p className="share-note">你的游戏文件夹没有被改动过 —— 排除只影响压缩包内容。</p>
          <div className="modal-actions">
            <button type="button" className="btn primary" onClick={onClose}>
              知道了
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}
    >
      <div className="modal import-modal">
        <div className="step">分享</div>
        <h2>
          打包 {shareable.length} 个游戏
          {shareable.length > 1 && <span className="share-sub">每个游戏一个压缩包</span>}
        </h2>
        <p className="share-lede">
          勾中的内容<b>不会</b>被打进压缩包。你的游戏文件夹分毫不动 ——
          存档还在原处，这里只决定发出去的那一份里有什么。
        </p>

        {blocked.length > 0 && (
          <div className="share-blocked">
            {blocked.map((b) => (
              <div key={b.gameId}>
                《{b.gameName}》不能分享：{b.blocked}
              </div>
            ))}
          </div>
        )}

        {running ? (
          <>
            <p className="bulk-progress-label">
              正在打包第 {progress?.index ?? 1} / {shareable.length} 个 ·{' '}
              {plans.find((p) => p.gameId === progress?.gameId)?.gameName ?? ''}
            </p>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${progress?.percent ?? 0}%` }} />
            </div>
            <p className="share-note">大文件夹会压很久。中途取消不会留下半个压缩包。</p>
          </>
        ) : (
          <div className="import-list">
            {shareable.map((plan) => (
              <div className="share-game" key={plan.gameId}>
                <div className="share-game-head">
                  <input
                    className="field share-name"
                    value={per[plan.gameId]?.name ?? ''}
                    onChange={(e) => patch(plan.gameId, { name: e.target.value })}
                    spellCheck={false}
                  />
                  <span className="share-ext">{format === 'zip' ? '.zip' : '.7z'}</span>
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() =>
                      setExpanded(expanded === plan.gameId ? null : plan.gameId)
                    }
                  >
                    {expanded === plan.gameId
                      ? '收起'
                      : `排除 ${per[plan.gameId]?.excluded.size ?? 0} 项`}
                  </button>
                </div>
                {expanded === plan.gameId && sections(plan)}
              </div>
            ))}
          </div>
        )}

        {!running && (
          <div className="share-options">
            <label>
              <span>格式</span>
              <select value={format} onChange={(e) => setFormat(e.target.value as ShareFormat)}>
                {SHARE_FORMATS.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
              <em>{SHARE_FORMATS.find((f) => f.key === format)?.note}</em>
            </label>

            <label>
              <span>密码</span>
              <input
                className="field"
                type="password"
                value={password}
                placeholder="留空则不加密"
                autoComplete="new-password"
                onChange={(e) => setPassword(e.target.value)}
              />
              <em>
                {format === '7z'
                  ? '压缩期间密码会短暂出现在进程列表里 —— 7-Zip 没有别的传法'
                  : 'zip 用 AES-256 加密内容，但文件名对方不用密码也看得到'}
              </em>
            </label>

            {format === '7z' && password && (
              <label className="share-check">
                <input
                  type="checkbox"
                  checked={encryptNames}
                  onChange={(e) => setEncryptNames(e.target.checked)}
                />
                <span>连文件名一起加密（不输密码连里面有什么都看不到）</span>
              </label>
            )}

            <label>
              <span>存放到</span>
              <input className="field" value={outDir} onChange={(e) => setOutDir(e.target.value)} />
              <button
                type="button"
                className="btn ghost small"
                onClick={async () => {
                  const picked = await window.sakura.pickFolder()
                  if (picked) setOutDir(picked)
                }}
              >
                浏览…
              </button>
            </label>

            <label className="share-check">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
              />
              <span>覆盖同名的压缩包</span>
            </label>

            <div className="share-estimate">
              预计写入约 <b>{formatBytes(plannedBytes)}</b>（压缩前）
              {freeBytes !== null && <> · 目标磁盘可用 {formatBytes(freeBytes)}</>}
            </div>
            {tight && (
              <div className="share-blocked">
                目标磁盘剩余空间可能不够 —— 未压缩就要 {formatBytes(plannedBytes)}，
                而那个盘只剩 {formatBytes(freeBytes ?? 0)}。
              </div>
            )}
            {nameProblem && <div className="share-blocked">{nameProblem}</div>}
          </div>
        )}

        <div className="modal-actions">
          {running ? (
            <button
              type="button"
              className="btn ghost"
              onClick={() => void window.sakura.shareCancel()}
            >
              取消打包
            </button>
          ) : (
            <>
              <button type="button" className="btn ghost" onClick={onClose}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={shareable.length === 0 || !outDir || nameProblem !== null}
                onClick={() => void start()}
              >
                开始打包
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
