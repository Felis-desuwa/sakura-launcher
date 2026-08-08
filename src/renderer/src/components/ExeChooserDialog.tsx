import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ExeChoice, ExeChoices, Game } from '../../../shared/types'
import { formatBytes } from '../lib/format'

interface Props {
  game: Game
  data: ExeChoices
  onApply: (exePath: string, args: string[]) => Promise<void>
  onClose: () => void
}

/** How the trial run turned out for one candidate. */
type Trial = 'running' | 'alive' | 'dead' | 'busy' | 'failed'

/** When to look for a process after starting one. Games are not always quick. */
const PROBE_DELAYS_MS = [3000, 6000, 10_000]

interface Section {
  key: string
  title: string
  hint: string
  items: ExeChoice[]
  /** Collapsed until asked for — the tools are the long tail, not the answer. */
  folded?: boolean
}

/**
 * Choosing which executable actually starts a game.
 *
 * A folder can hold a dozen of them — engine, patches, two uninstallers, a handful of
 * locale emulators — with nothing in the names to tell them apart. So each one is shown
 * with what it looks like and why the scanner scored it as it did, and can be tried
 * once on the spot: the launcher then goes and looks for a process in the game folder,
 * which turns "did that do anything?" into an answer.
 */
export default function ExeChooserDialog({
  game,
  data,
  onApply,
  onClose
}: Props): React.JSX.Element {
  const [trials, setTrials] = useState<Record<string, Trial>>({})
  const [openTools, setOpenTools] = useState(false)
  const [busy, setBusy] = useState(false)
  const [wrapper, setWrapper] = useState('')
  const [payload, setPayload] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const locales = useMemo(() => data.choices.filter((c) => c.kind === 'locale'), [data])
  const startable = useMemo(
    () => data.choices.filter((c) => c.kind !== 'locale' && c.kind !== 'uninstall'),
    [data]
  )

  useEffect(() => {
    if (locales.length > 0 && !wrapper) setWrapper(locales[0].fullPath)
  }, [locales, wrapper])
  useEffect(() => {
    if (startable.length > 0 && !payload) {
      setPayload((startable.find((c) => c.rankable) ?? startable[0]).fullPath)
    }
  }, [startable, payload])

  const sections = useMemo<Section[]>(
    () =>
      [
        {
          key: 'main',
          title: '推荐',
          hint: '扫描判定为可以直接启动的程序，按可能性排序',
          items: data.choices.filter(
            (c) => c.rankable && (c.kind === 'main' || c.kind === 'launcher')
          )
        },
        {
          key: 'locale',
          title: '区域模拟器',
          hint: '日文游戏常常要通过它才能正常显示 —— 见下方的组合启动',
          items: locales
        },
        {
          key: 'tool',
          title: '工具 · 补丁 · 卸载',
          hint: '一般不是启动游戏用的，判断错了就在这里选',
          items: data.choices.filter(
            (c) => c.kind === 'patch' || c.kind === 'tool' || c.kind === 'uninstall'
          ),
          folded: true
        },
        {
          key: 'sub',
          title: '子目录里的程序',
          hint: '游戏本体偶尔真的在下一层',
          items: data.choices.filter((c) => c.kind === 'sub'),
          folded: true
        }
      ].filter((s) => s.items.length > 0),
    [data, locales]
  )

  const runTrial = useCallback(
    async (choice: ExeChoice): Promise<void> => {
      setTrials((cur) => ({ ...cur, [choice.fullPath]: 'running' }))

      // Take a baseline first: the game may already be open, and crediting this
      // executable for a process that was there all along would be a lie.
      const before = await window.sakura.probeRunning(game.id)
      if (before === true) {
        setTrials((cur) => ({ ...cur, [choice.fullPath]: 'busy' }))
        return
      }

      const started = await window.sakura.tryExe(game.id, choice.fullPath)
      if (!started.ok) {
        setTrials((cur) => ({ ...cur, [choice.fullPath]: 'failed' }))
        return
      }

      let last = 0
      for (const delay of PROBE_DELAYS_MS) {
        await new Promise((r) => setTimeout(r, delay - last))
        last = delay
        if (await window.sakura.probeRunning(game.id)) {
          setTrials((cur) => ({ ...cur, [choice.fullPath]: 'alive' }))
          return
        }
      }
      setTrials((cur) => ({ ...cur, [choice.fullPath]: 'dead' }))
    },
    [game.id]
  )

  const apply = useCallback(
    async (exePath: string, args: string[]): Promise<void> => {
      setBusy(true)
      try {
        await onApply(exePath, args)
      } finally {
        setBusy(false)
      }
    },
    [onApply]
  )

  const trialNote = (state: Trial | undefined): React.JSX.Element | null => {
    if (!state) return null
    const text: Record<Trial, string> = {
      running: '⏳ 已启动，正在看有没有进程…',
      alive: '✓ 跑起来了 —— 游戏目录里有进程在运行',
      dead: '✗ 十秒内没有检测到进程，多半不是这个',
      busy: '· 这个游戏本来就开着，测不出来；先关掉再试',
      failed: '✗ 没能启动'
    }
    return <span className={`exe-trial ${state}`}>{text[state]}</span>
  }

  const row = (choice: ExeChoice): React.JSX.Element => (
    <div className={`exe-row${choice.current ? ' current' : ''}`} key={choice.fullPath}>
      <div className="exe-main">
        <span className="exe-name" title={choice.fullPath}>
          {choice.rel}
        </span>
        <span className={`exe-chip ${choice.kind}`}>{choice.label}</span>
        {choice.current && <span className="exe-chip current">当前</span>}
        <span className="exe-size">{formatBytes(choice.sizeBytes)}</span>
      </div>
      <div className="exe-why">
        {choice.reasons.length > 0 ? choice.reasons.join(' · ') : '没有可说的特征'}
        {trialNote(trials[choice.fullPath])}
      </div>
      <div className="exe-actions">
        <button
          type="button"
          className="btn ghost small"
          disabled={trials[choice.fullPath] === 'running'}
          onClick={() => void runTrial(choice)}
        >
          试运行
        </button>
        <button
          type="button"
          className="btn primary small"
          disabled={busy || choice.current}
          onClick={() => void apply(choice.fullPath, [])}
        >
          {choice.current ? '已是主程序' : '设为主程序'}
        </button>
      </div>
    </div>
  )

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal import-modal">
        <div className="step">更换主程序</div>
        <h2 title={data.dir}>《{game.name}》</h2>
        <p className="exe-lede">
          双击磁贴时运行的就是这里选中的程序。拿不准的话先「试运行」——
          启动器会去看游戏目录里有没有进程真的跑起来。
          {!data.pinned && '（当前这个是扫描自动挑的，还没有人工确认过。）'}
        </p>

        <div className="import-list">
          {sections.map((section) => {
            const collapsed = section.folded && !openTools
            return (
              <div className="import-section" key={section.key}>
                <div className="import-section-head">
                  <b>
                    {section.title} ({section.items.length})
                  </b>
                  <span>{section.hint}</span>
                </div>
                {collapsed ? (
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => setOpenTools(true)}
                  >
                    展开这 {section.items.length} 项
                  </button>
                ) : (
                  section.items.map(row)
                )}
              </div>
            )
          })}

          {locales.length > 0 && startable.length > 0 && (
            <div className="import-section">
              <div className="import-section-head">
                <b>组合启动</b>
                <span>用区域模拟器带起游戏本体，双击磁贴时就是这一串</span>
              </div>
              <div className="exe-combo">
                <span>用</span>
                <select value={wrapper} onChange={(e) => setWrapper(e.target.value)}>
                  {locales.map((c) => (
                    <option key={c.fullPath} value={c.fullPath}>
                      {c.rel}
                    </option>
                  ))}
                </select>
                <span>启动</span>
                <select value={payload} onChange={(e) => setPayload(e.target.value)}>
                  {startable.map((c) => (
                    <option key={c.fullPath} value={c.fullPath}>
                      {c.rel}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn primary small"
                  disabled={busy || !wrapper || !payload}
                  onClick={() => void apply(wrapper, [payload])}
                >
                  设为主程序
                </button>
              </div>
              <p className="exe-combo-note">
                模拟器接收参数的写法各不相同。设好之后建议双击磁贴验一次 ——
                没反应就回到这里换一种组合。
              </p>
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
