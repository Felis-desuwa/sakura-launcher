import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DiskInfo, Game, Group, Settings, SortKey, TabKey } from '../../shared/types'
import { DEFAULT_SETTINGS, normalizeStatus } from '../../shared/types'
import ConfirmDialog from './components/ConfirmDialog'
import DetailDrawer from './components/DetailDrawer'
import FileBrowser from './components/FileBrowser'
import PromptDialog from './components/PromptDialog'
import PetalCanvas from './components/PetalCanvas'
import TopBar, { type PageKey } from './components/TopBar'
import UninstallRitual from './components/UninstallRitual'
import { formatBytes } from './lib/format'
import DesktopPage from './pages/DesktopPage'
import DiskPage from './pages/DiskPage'
import SettingsPage from './pages/SettingsPage'
import TierPage from './pages/TierPage'
import WishlistPage from './pages/WishlistPage'

interface Toast {
  id: number
  message: string
  error?: boolean
}

interface GroupPrompt {
  candidates: { parent: string; name: string; dirs: string[] }[]
}

export default function App(): React.JSX.Element {
  const [games, setGames] = useState<Game[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)

  const [page, setPage] = useState<PageKey>('desktop')
  const [tab, setTab] = useState<TabKey>('all')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)

  const [disks, setDisks] = useState<DiskInfo[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  const [uninstallTarget, setUninstallTarget] = useState<Game | null>(null)
  const [groupPrompt, setGroupPrompt] = useState<GroupPrompt | null>(null)
  const [browsing, setBrowsing] = useState<{ dir: string; title: string } | null>(null)
  const [renaming, setRenaming] = useState<Game | null>(null)
  const [removing, setRemoving] = useState<Game | null>(null)
  const [leftover, setLeftover] = useState<{ game: Game; bytes: number } | null>(null)
  const [extractProgress, setExtractProgress] = useState<Record<string, number>>({})

  const toastSeq = useRef(0)

  const toast = useCallback((message: string, error = false): void => {
    const id = ++toastSeq.current
    setToasts((cur) => [...cur, { id, message, error }])
    setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), 4200)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    const snap = await window.sakura.snapshot()
    setGames(snap.games)
    setGroups(snap.groups)
    setSettings(snap.settings)
    window.sakura.diskInfo().then(setDisks)
  }, [])

  // Initial load, then an automatic scan when the library is already configured.
  useEffect(() => {
    void (async () => {
      const snap = await window.sakura.snapshot()
      setGames(snap.games)
      setGroups(snap.groups)
      setSettings(snap.settings)
      setTab(snap.settings.defaultTab)
      setLoaded(true)
      window.sakura.diskInfo().then(setDisks)
      if (snap.settings.roots.length > 0) void runScan(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const offSize = window.sakura.onSize(({ id, sizeBytes }) => {
      setGames((cur) => cur.map((g) => (g.id === id ? { ...g, sizeBytes } : g)))
    })
    const offProgress = window.sakura.onArchiveProgress(({ id, percent }) => {
      setExtractProgress((cur) => ({ ...cur, [id]: percent }))
    })
    const offDone = window.sakura.onArchiveDone(({ id, ok, error }) => {
      setExtractProgress((cur) => {
        const next = { ...cur }
        delete next[id]
        return next
      })
      toast(ok ? '解压完成，已重新扫描' : `解压失败：${error ?? '未知错误'}`, !ok)
    })
    const offDb = window.sakura.onDbChanged(() => void refresh())
    return () => {
      offSize()
      offProgress()
      offDone()
      offDb()
    }
  }, [refresh, toast])

  const runScan = useCallback(
    async (announce = true): Promise<void> => {
      setScanning(true)
      try {
        const outcome = await window.sakura.scan()
        setGames(outcome.games)
        if (announce) {
          const installed = outcome.games.filter((g) => g.kind === 'installed').length
          toast(`扫描完成，找到 ${installed} 个游戏`)
        }
        if (outcome.groupCandidates.length > 0) {
          setGroupPrompt({ candidates: outcome.groupCandidates })
        }
      } finally {
        setScanning(false)
        window.sakura.diskInfo().then(setDisks)
      }
    },
    [toast]
  )

  const patchGame = useCallback((id: string, patch: Partial<Game>): void => {
    // Update locally first so toggles and drags feel instant, applying the same
    // status rules the main process will, so the two never disagree.
    setGames((cur) =>
      cur.map((g) => (g.id === id ? { ...g, ...normalizeStatus(g, patch) } : g))
    )
    void window.sakura.updateGame(id, patch)
  }, [])

  const updateSettings = useCallback((patch: Partial<Settings>): void => {
    setSettings((cur) => ({ ...cur, ...patch }))
    void window.sakura.updateSettings(patch)
  }, [])

  const addFolder = useCallback(async (): Promise<void> => {
    const folder = await window.sakura.pickFolder()
    if (!folder) return
    if (settings.roots.includes(folder)) {
      toast('该文件夹已在扫描列表中')
      return
    }
    const roots = [...settings.roots, folder]
    setSettings((cur) => ({ ...cur, roots }))
    await window.sakura.updateSettings({ roots, onboarded: true })
    await runScan()
  }, [settings.roots, runScan, toast])

  const addGame = useCallback(async (): Promise<void> => {
    const game = await window.sakura.pickExe()
    if (!game) return
    await refresh()
    toast(`已添加《${game.name}》`)
  }, [refresh, toast])

  const launch = useCallback(
    async (game: Game): Promise<void> => {
      if (game.kind === 'archive') {
        toast('这是未安装的压缩包，请先右键解压安装', true)
        return
      }
      const result = await window.sakura.launch(game.id)
      if (result.ok) {
        toast(`正在启动《${game.name}》`)
        setGames((cur) =>
          cur.map((g) =>
            g.id === game.id
              ? { ...g, lastLaunchedAt: Date.now(), launchCount: g.launchCount + 1 }
              : g
          )
        )
      } else {
        toast(result.error ?? '启动失败', true)
      }
    },
    [toast]
  )

  const counts = useMemo<Record<TabKey, number>>(
    () => ({
      all: games.length,
      wishlist: games.filter((g) => g.wishlist).length,
      playing: games.filter((g) => g.playing).length,
      played: games.filter((g) => g.played).length
    }),
    [games]
  )

  const selected = useMemo(
    () => games.find((g) => g.id === selectedId) ?? null,
    [games, selectedId]
  )

  const needsOnboarding = loaded && settings.roots.length === 0 && games.length === 0

  return (
    <div className="app">
      <PetalCanvas enabled={settings.petals} />

      <TopBar
        page={page}
        tab={tab}
        counts={counts}
        search={search}
        scanning={scanning}
        onPage={setPage}
        onTab={setTab}
        onSearch={setSearch}
        onRescan={() => void runScan()}
        sortKey={settings.sortKey}
        onSortChange={(key) => updateSettings({ sortKey: key })}
      />

      <div className="app-body">
        {needsOnboarding ? (
          <div className="page">
            <div className="empty">
              <div style={{ fontSize: 54 }}>🌸</div>
              <h2>还没有游戏库</h2>
              <p>
                选择一个存放游戏的文件夹，Sakura 会自动扫描其中的游戏，
                提取每个游戏的图标，并统计它们占用的磁盘空间。
                扫描目录只保存在本机，不会上传到任何地方。
              </p>
              <button type="button" className="btn primary" onClick={() => void addFolder()}>
                选择文件夹开始扫描
              </button>
              <button type="button" className="btn ghost" onClick={() => void addGame()}>
                或者手动添加单个游戏
              </button>
            </div>
          </div>
        ) : page === 'desktop' ? (
          <DesktopPage
            games={games}
            groups={groups}
            tab={tab}
            sortKey={settings.sortKey}
            tileSize={settings.tileSize}
            search={search}
            selectedId={selectedId}
            extractProgress={extractProgress}
            onSelect={setSelectedId}
            onLaunch={(g) => void launch(g)}
            onPatch={patchGame}
            onUninstall={setUninstallTarget}
            onRemoveTile={setRemoving}
            onSetCover={async (id) => {
              const updated = await window.sakura.setCover(id)
              if (updated) setGames((cur) => cur.map((g) => (g.id === id ? updated : g)))
            }}
            onClearCover={async (id) => {
              const updated = await window.sakura.clearCover(id)
              if (updated) setGames((cur) => cur.map((g) => (g.id === id ? updated : g)))
            }}
            onBrowse={(game) =>
              setBrowsing({
                // Archive entries point at a volume file, so browse its containing folder.
                dir:
                  game.kind === 'archive' ? game.dir.replace(/\\[^\\]+$/, '') : game.dir,
                title: game.name
              })
            }
            onExtract={(game) => void window.sakura.extract(game.id)}
            onGroupsChange={(next) => {
              setGroups(next)
              void window.sakura.setGroups(next)
            }}
            onReorder={(ids) => {
              setGames((cur) => {
                const rank = new Map(ids.map((id, i) => [id, i]))
                return cur.map((g) => (rank.has(g.id) ? { ...g, order: rank.get(g.id)! } : g))
              })
              void window.sakura.reorder(ids)
            }}
            onAddGame={() => void addGame()}
            onAddFolder={() => void addFolder()}
            onRescan={() => void runScan()}
            onSortChange={(key: SortKey) => updateSettings({ sortKey: key })}
            onBlockedLaunch={() =>
              toast('「想玩」清单只作规划，去「全部」或「在玩」里启动')
            }
            onRename={setRenaming}
          />
        ) : page === 'tier' ? (
          <TierPage games={games} onPatch={patchGame} />
        ) : page === 'wishlist' ? (
          <WishlistPage games={games} onPatch={patchGame} />
        ) : page === 'disk' ? (
          <DiskPage games={games} onToast={toast} onRescan={() => void runScan(false)} />
        ) : (
          <SettingsPage
            settings={settings}
            onChange={updateSettings}
            onRescan={() => void runScan()}
            onAddFolder={() => void addFolder()}
            onBrowsePath={(dir) => setBrowsing({ dir, title: dir.split('\\').pop() || dir })}
            onUnignore={async (dir) => {
              const next = await window.sakura.unignore(dir)
              setSettings(next)
              await refresh()
              toast('已恢复该条目，重新扫描完成')
            }}
          />
        )}

        {page === 'desktop' && selected && (
          <DetailDrawer
            game={selected}
            allGames={games}
            disks={disks}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>

      {renaming && (
        <PromptDialog
          title={`重命名《${renaming.name}》`}
          initialValue={renaming.name}
          placeholder="游戏名称"
          description={
            <>
              新名字会写进游戏文件夹里的 <code>sakura-launcher.txt</code>，
              <b>不会改动文件夹名，也不影响游戏启动</b>
              —— 很多游戏按路径找资源，直接改文件夹名会让它们打不开。
              删掉那个文件就会恢复成文件夹名。
            </>
          }
          extraAction={{
            label: '恢复原名',
            onClick: async () => {
              const target = renaming
              setRenaming(null)
              await window.sakura.resetName(target.id)
              await refresh()
              toast('已恢复为文件夹名')
            }
          }}
          onCancel={() => setRenaming(null)}
          onConfirm={async (name) => {
            const target = renaming
            setRenaming(null)
            const result = await window.sakura.rename(target.id, name)
            if (!result.ok) {
              toast(result.error ?? '重命名失败', true)
              return
            }
            setGames((cur) => cur.map((g) => (g.id === target.id ? { ...g, name } : g)))
            toast(
              result.sidecar
                ? '已重命名，说明文件已写入游戏文件夹'
                : `已重命名（无法写入游戏文件夹，仅保存在启动器内${result.error ? '：' + result.error : ''}）`,
              !result.sidecar
            )
          }}
        />
      )}

      {removing && (
        <ConfirmDialog
          title={`把《${removing.name}》从库中移除？`}
          confirmLabel="移除磁贴"
          body={
            <>
              只是把这个磁贴从启动器里拿掉，<b>不会删除磁盘上的任何文件</b>
              —— 用来清掉误扫进来的非游戏内容。
              <br />
              <br />
              这个路径会被记住，之后重新扫描也不会再加回来。想恢复的话，
              到「设置 → 已移除的条目」里点一下即可。
            </>
          }
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            const target = removing
            setRemoving(null)
            const result = await window.sakura.removeTile(target.id)
            if (!result.ok) {
              toast(result.error ?? '移除失败', true)
              return
            }
            if (selectedId === target.id) setSelectedId(null)
            await refresh()
            toast(`已移除《${target.name}》，磁盘上的文件未改动`)
          }}
        />
      )}

      {leftover && (
        <ConfirmDialog
          title="卸载程序已结束"
          danger
          confirmLabel="移入回收站"
          cancelLabel="保留"
          body={
            <>
              目录里还剩 <b>{formatBytes(leftover.bytes)}</b>，通常是存档或卸载程序没清干净的残留。
              是否把剩余文件也移入回收站？
            </>
          }
          onCancel={() => setLeftover(null)}
          onConfirm={async () => {
            const target = leftover.game
            setLeftover(null)
            const cleanup = await window.sakura.trashLeftovers(target.id)
            toast(cleanup.ok ? '残留文件已移入回收站' : cleanup.error ?? '清理失败', !cleanup.ok)
            await refresh()
          }}
        />
      )}

      {browsing && (
        <FileBrowser
          rootDir={browsing.dir}
          title={browsing.title}
          onClose={() => setBrowsing(null)}
          onToast={toast}
        />
      )}

      {uninstallTarget && (
        <UninstallRitual
          game={uninstallTarget}
          onCancel={() => setUninstallTarget(null)}
          onDone={async (result) => {
            const target = uninstallTarget
            setUninstallTarget(null)
            if (!result.ok) {
              toast(result.error ?? '卸载失败', true)
              return
            }
            if (result.leftoverBytes && result.leftoverBytes > 0) {
              setLeftover({ game: target, bytes: result.leftoverBytes })
            } else {
              toast(
                result.method === 'trash'
                  ? `《${target.name}》已移入回收站，可从回收站恢复`
                  : `《${target.name}》已卸载`
              )
            }
            setSelectedId(null)
            await refresh()
          }}
        />
      )}

      {groupPrompt && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="step">扫描完成</div>
            <h2>发现 {groupPrompt.candidates.length} 个可分组的文件夹</h2>
            <p style={{ fontSize: 13, color: 'var(--ink-soft)', lineHeight: 1.7, margin: '10px 0 0' }}>
              这些文件夹下各有多个游戏。要按文件夹名自动建好分组吗？
              分组只影响启动器里的排列，<b>不会移动磁盘上的任何文件</b>，之后也能随时拖出或解散。
            </p>
            <ul style={{ fontSize: 13, margin: '14px 0 0', paddingLeft: 20, lineHeight: 1.8 }}>
              {groupPrompt.candidates.slice(0, 8).map((c) => (
                <li key={c.parent}>
                  {c.name} <span style={{ color: 'var(--ink-soft)' }}>（{c.dirs.length} 个）</span>
                </li>
              ))}
            </ul>
            <div className="modal-actions">
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  updateSettings({
                    groupingPrompted: [
                      ...settings.groupingPrompted,
                      ...groupPrompt.candidates.map((c) => c.parent)
                    ]
                  })
                  setGroupPrompt(null)
                }}
              >
                不用，保持平铺
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={async () => {
                  const newGroups: Group[] = []
                  let order = groups.length
                  for (const c of groupPrompt.candidates) {
                    const id = `g-${order}-${Date.now().toString(36)}`
                    newGroups.push({ id, name: c.name, order: order++ })
                    for (const dir of c.dirs) {
                      const game = games.find((g) => g.dir === dir)
                      if (game) patchGame(game.id, { groupId: id })
                    }
                  }
                  const merged = [...groups, ...newGroups]
                  setGroups(merged)
                  await window.sakura.setGroups(merged)
                  updateSettings({
                    groupingPrompted: [
                      ...settings.groupingPrompted,
                      ...groupPrompt.candidates.map((c) => c.parent)
                    ]
                  })
                  setGroupPrompt(null)
                  toast(`已建立 ${newGroups.length} 个分组`)
                }}
              >
                自动建组
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div className={`toast${t.error ? ' error' : ''}`} key={t.id}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  )
}
