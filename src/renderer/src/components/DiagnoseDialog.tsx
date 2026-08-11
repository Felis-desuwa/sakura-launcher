import { useCallback, useEffect, useState } from 'react'
import type {
  Diagnosis,
  DiagnosisCheck,
  DiagnosisSeverity,
  Game,
  LaunchTrouble
} from '../../../shared/types'
import { ENGINE_META } from '../../../shared/types'

interface Props {
  game: Game
  /**
   * The launch this is about, when it followed a specific failure. Decides which crash
   * logs count as fresh.
   */
  since?: number
  /** Set when the dialog was opened by a failed launch rather than by the user. */
  trouble?: LaunchTrouble
  onPickExe: () => void
  onClose: () => void
  toast: (message: string, bad?: boolean) => void
}

const SEVERITY_LABEL: Record<DiagnosisSeverity, string> = {
  blocker: '拦路',
  likely: '很可能',
  note: '参考'
}

/**
 * Why the game did not start.
 *
 * The launcher's oldest promise is that "点了没反应？" should have an answer, and until
 * now it could only say whether a process appeared. This says why one did not: which
 * runtime is missing, whether the executable demands elevation, whether the chosen
 * program was an uninstaller all along, what the engine wrote on its way down.
 *
 * Two rules shape how it reads. Findings lead with the ones that provably block a launch,
 * so a long list still opens with the answer. And when nothing is found it says what it
 * looked at instead of going quiet — "we checked these eight things" is information,
 * a blank panel is not.
 */
export default function DiagnoseDialog({
  game,
  since,
  trouble,
  onPickExe,
  onClose,
  toast
}: Props): React.JSX.Element {
  const [result, setResult] = useState<Diagnosis | null>(null)
  const [running, setRunning] = useState(true)
  const [elevating, setElevating] = useState(false)

  const run = useCallback(async (): Promise<void> => {
    setRunning(true)
    try {
      setResult(await window.sakura.diagnose(game.id, since))
    } finally {
      setRunning(false)
    }
  }, [game.id, since])

  useEffect(() => {
    void run()
  }, [run])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const runElevated = useCallback(async (): Promise<void> => {
    setElevating(true)
    try {
      const res = await window.sakura.launchElevated(game.id)
      if (res.ok) {
        toast(`已以管理员身份启动《${game.name}》`)
        onClose()
      } else {
        toast(res.error ?? '以管理员身份启动失败', true)
      }
    } finally {
      setElevating(false)
    }
  }, [game.id, game.name, onClose, toast])

  const actionFor = (check: DiagnosisCheck): React.JSX.Element | null => {
    switch (check.action) {
      case 'pickExe':
        return (
          <button type="button" className="btn primary small" onClick={onPickExe}>
            更换主程序…
          </button>
        )
      case 'runAsAdmin':
        return (
          <button
            type="button"
            className="btn primary small"
            disabled={elevating}
            onClick={() => void runElevated()}
          >
            {elevating ? '等待授权…' : '以管理员身份启动'}
          </button>
        )
      case 'openLog':
      case 'revealDir':
        return (
          <button
            type="button"
            className="btn ghost small"
            onClick={() => void window.sakura.openPath(check.actionPath ?? game.dir)}
          >
            在资源管理器中显示
          </button>
        )
      default:
        return null
    }
  }

  const lede = (): string => {
    if (trouble === 'earlyexit') {
      return '进程起来过，但几秒之内就没了 —— 这通常意味着它在初始化阶段崩了。'
    }
    if (trouble === 'noshow') {
      return '启动之后一直没有在游戏目录里看到进程。下面是能查到的原因。'
    }
    if (trouble === 'dialog') {
      return '进程还在，但它停在一个报错窗口上 —— 这次不计入游玩时长。'
    }
    return '下面是启动这个游戏时可能会绊住它的东西，全部在本地判定，不联网。'
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal import-modal">
        <div className="step">启动诊断</div>
        <h2 title={game.dir}>《{game.name}》</h2>
        <p className="exe-lede">{lede()}</p>

        {running && <p className="diag-empty">正在检查…</p>}

        {!running && result && (
          <div className="import-list">
            {result.checks.length === 0 && (
              <div className="diag-clean">
                <b>没查出问题。</b>
                <p>
                  下面这些都看过了，都正常。如果游戏确实起不来，多半是引擎自己的问题 ——
                  游戏目录里若有 readme 或说明文件，值得读一眼。
                </p>
                <ul>
                  {result.checked.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            )}

            {result.checks.map((check, i) => (
              <div className={`diag-row ${check.severity}`} key={`${check.code}-${i}`}>
                <div className="diag-head">
                  <span className={`diag-chip ${check.severity}`}>
                    {SEVERITY_LABEL[check.severity]}
                  </span>
                  <b>{check.title}</b>
                </div>
                <p className="diag-detail">{check.detail}</p>
                {check.reasons.length > 0 && (
                  <div className="diag-why">依据：{check.reasons.join(' · ')}</div>
                )}
                {check.excerpt && <pre className="diag-log">{check.excerpt}</pre>}
                <div className="exe-actions">{actionFor(check)}</div>
              </div>
            ))}

            <div className="diag-facts">
              {result.engine && (
                <span title={ENGINE_META[result.engine].note}>
                  引擎：{ENGINE_META[result.engine].label}
                </span>
              )}
              {result.arch && <span>架构：{result.arch}</span>}
              {result.checks.length > 0 && <span>检查了 {result.checked.length} 项</span>}
            </div>
          </div>
        )}

        {!running && !result && <p className="diag-empty">这个条目已经不在库里了。</p>}

        <div className="modal-actions">
          <button type="button" className="btn ghost" disabled={running} onClick={() => void run()}>
            重新检查
          </button>
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
