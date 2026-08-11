import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ImportPreview, LaunchTroubleEvent } from '../../preload/index'
import type {
  DiskInfo,
  ExeChoices,
  Game,
  Group,
  LaunchTrouble,
  PendingDownload,
  Settings,
  SharePlan,
  SortKey,
  TabKey
} from '../../shared/types'
import { DEFAULT_SETTINGS, normalizeStatus, TAB_META } from '../../shared/types'
import BulkUninstallDialog from './components/BulkUninstallDialog'
import ConfirmDialog from './components/ConfirmDialog'
import DetailDrawer from './components/DetailDrawer'
import DiagnoseDialog from './components/DiagnoseDialog'
import ExeChooserDialog from './components/ExeChooserDialog'
import ImportDialog from './components/ImportDialog'
import PromptDialog from './components/PromptDialog'
import ShareDialog from './components/ShareDialog'
import PetalCanvas from './components/PetalCanvas'
import DownloadDialog from './components/DownloadDialog'
import TopBar, { type PageKey } from './components/TopBar'
import UninstallRitual from './components/UninstallRitual'
import { dragHasFiles, pathsFromDrop } from './lib/fileDrop'
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
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [scanning, setScanning] = useState(false)
  /** Games with a live play session, so tiles can show they are running. */
  const [playing, setPlaying] = useState<string[]>([])

  const [disks, setDisks] = useState<DiskInfo[]>([])
  const [toasts, setToasts] = useState<Toast[]>([])
  const [uninstallTargets, setUninstallTargets] = useState<Game[]>([])
  const [groupPrompt, setGroupPrompt] = useState<GroupPrompt | null>(null)
  const [renaming, setRenaming] = useState<Game | null>(null)
  const [tagging, setTagging] = useState<Game | null>(null)
  const [removing, setRemoving] = useState<Game[]>([])
  /** Scan folder awaiting confirmation to be dropped, with its games. */
  const [removingRoot, setRemovingRoot] = useState<string | null>(null)
  const [clearingIgnored, setClearingIgnored] = useState(false)
  /** Game whose executable is being chosen, together with what was found in its folder. */
  const [choosingExe, setChoosingExe] = useState<{ game: Game; data: ExeChoices } | null>(null)
  /** Game being examined for why it would not start. */
  const [diagnosing, setDiagnosing] = useState<{
    game: Game
    since?: number
    trouble?: LaunchTrouble
  } | null>(null)
  /**
   * A launch that produced nothing, waiting to be acknowledged.
   *
   * Held as a dismissible card rather than opened as a dialog: the game may simply be
   * slow, and stealing the screen from someone who is watching a splash would be worse
   * than the silence this replaces.
   */
  const [trouble, setTrouble] = useState<LaunchTroubleEvent | null>(null)
  /** Games being packed up to send, with what the scan proposes leaving out. */
  const [sharing, setSharing] = useState<SharePlan[] | null>(null)
  const [importing, setImporting] = useState<ImportPreview | null>(null)
  const [leftover, setLeftover] = useState<{ game: Game; bytes: number } | null>(null)
  const [extractProgress, setExtractProgress] = useState<Record<string, number>>({})
  const [downloads, setDownloads] = useState<PendingDownload[]>([])
  const [downloadOpen, setDownloadOpen] = useState(false)
  const [fileOver, setFileOver] = useState(false)
  /** Nested dragenter/dragleave pairs, so crossing a child does not clear the overlay. */
  const dragDepth = useRef(0)

  const toastSeq = useRef(0)

  const toast = useCallback((message: string, error = false): void => {
    const id = ++toastSeq.current
    setToasts((cur) => [...cur, { id, message, error }])
    setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), 4200)
  }, [])

  // Themes are a custom-property swap on the root element.
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

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
      // The shelf is about to paint, so the splash has done its job. Sent after the
      // state is set rather than after the scan below: the library being *there* is
      // what the user is waiting for, not it being fully up to date.
      // Two frames deep: the first one is where React commits the shelf, the second is
      // after it has actually been painted.
      requestAnimationFrame(() => requestAnimationFrame(() => window.sakura.ready()))
      window.sakura.diskInfo().then(setDisks)
      window.sakura.activeSessions().then(setPlaying)
      // Quiet startup refresh: brings existing entries up to date (names, folders that
      // moved away) without reconciling the sidecar files. That costs a disk round-trip
      // per game and belongs behind a button, not between launching the app and seeing
      // the library. Taking in games that were not there before is never automatic.
      if (snap.settings.roots.length > 0) void runScan(false, false)
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
      toast(ok ? '解压完成，已加入游戏库' : `解压失败：${error ?? '未知错误'}`, !ok)
    })
    const offTrouble = window.sakura.onLaunchTrouble((payload) => setTrouble(payload))
    const offDb = window.sakura.onDbChanged(() => void refresh())
    const offPlaytime = window.sakura.onPlaytime(({ id, playtimeMs, playing: running }) => {
      setGames((cur) => cur.map((g) => (g.id === id ? { ...g, playtimeMs } : g)))
      setPlaying((cur) =>
        running ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter((x) => x !== id)
      )
    })
    return () => {
      offSize()
      offProgress()
      offDone()
      offDb()
      offPlaytime()
      offTrouble()
    }
  }, [refresh, toast])

  // A game that turns up late clears its own alarm — the card is about silence, and
  // there is no longer any.
  useEffect(() => {
    if (trouble && playing.includes(trouble.id)) setTrouble(null)
  }, [playing, trouble])

  const runScan = useCallback(
    async (announce = true, sync = true): Promise<void> => {
      setScanning(true)
      try {
        const outcome = await window.sakura.scan(sync)
        setGames(outcome.games)
        if (announce) {
          const installed = outcome.games.filter((g) => g.kind === 'installed').length
          const notes: string[] = [`已刷新，库里共 ${installed} 个游戏`]
          if (outcome.sidecars && outcome.sidecars.imported > 0) {
            notes.push(`${outcome.sidecars.imported} 个说明文件被手动改过，已读回`)
          }
          toast(notes.join('，'))
        }
        // Worth saying out loud: an unmounted drive would otherwise look like the
        // library quietly shrank.
        if (outcome.missing > 0) {
          toast(`有 ${outcome.missing} 个条目这次没找到，已保留其评级与记录`, true)
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

  /**
   * Adding a folder goes through a preview first. Vetting what comes in is much less
   * work than picking non-games back out of the library afterwards.
   */
  const previewInto = useCallback(
    async (folder: string): Promise<void> => {
      setScanning(true)
      try {
        const preview = await window.sakura.previewFolder(folder)
        const total = preview.games.length + preview.rejected.length + preview.archives.length
        if (total === 0) {
          if (settings.roots.includes(folder)) toast('这个文件夹里没有可以新增的内容')
          else toast('这个文件夹里没有找到可以添加的内容')
          return
        }
        setImporting(preview)
      } finally {
        setScanning(false)
      }
    },
    [settings.roots, toast]
  )

  const addFolder = useCallback(async (): Promise<void> => {
    const folder = await window.sakura.pickFolder()
    if (!folder) return
    await previewInto(folder)
  }, [previewInto])

  useEffect(() => {
    void window.sakura.listDownloads().then(setDownloads)
    // The main process owns download state — it keeps running while this window is
    // closed — so the renderer only ever mirrors what it is told.
    return window.sakura.onDownloads((list) => {
      setDownloads(list)
      // A finished import means new tiles; pull them in without waiting for a scan.
      if (list.some((d) => d.status === 'done')) void refresh()
    })
  }, [refresh])

  /**
   * Files dragged in from Explorer. The tab they land on is the classification: drop
   * something on 在玩 and it is imported already marked as such, which is the whole
   * point of aiming at a particular tab rather than at the window.
   */
  const importDropped = useCallback(
    async (paths: string[], intoTab: TabKey): Promise<void> => {
      const patch: Partial<Game> =
        intoTab === 'wishlist'
          ? { wishlist: true }
          : intoTab === 'playing'
            ? { playing: true }
            : intoTab === 'played'
              ? { played: true }
              : {}

      const added: string[] = []
      const failed: string[] = []
      for (const filePath of paths) {
        const result = await window.sakura.importPath(filePath, patch)
        if (result.ok && result.game) added.push(result.game.name)
        else failed.push(result.error ?? `${filePath} 加入失败`)
      }

      if (added.length > 0) await refresh()

      const suffix = intoTab === 'all' ? '' : `，已标记为「${TAB_META[intoTab].label}」`
      if (added.length === 0) {
        // Nothing landed, so this is a failure however it is worded — most often the
        // same game dragged in twice.
        toast(failed.length === 1 ? failed[0] : `${failed.length} 个都没能加入：${failed[0]}`, true)
        return
      }

      const headline =
        added.length === 1 ? `已加入《${added[0]}》${suffix}` : `已加入 ${added.length} 个游戏${suffix}`
      toast(failed.length === 0 ? headline : `${headline}；${failed.length} 个未加入：${failed[0]}`)
    },
    [refresh, toast]
  )

  const chooseExe = useCallback(
    async (game: Game): Promise<void> => {
      const data = await window.sakura.exeCandidates(game.id)
      if (!data || data.choices.length === 0) {
        toast('这个文件夹里没有找到可执行文件', true)
        return
      }
      setChoosingExe({ game, data })
    },
    [toast]
  )

  const diagnose = useCallback(
    (game: Game, since?: number, trouble?: LaunchTrouble): void => {
      setTrouble(null)
      setDiagnosing({ game, since, trouble })
    },
    []
  )

  /**
   * Open the share dialog for a selection.
   *
   * The plan is fetched before the dialog opens because it involves walking every game
   * folder — a dialog that appears and then fills itself in reads as slower than one
   * that takes a moment and arrives complete.
   */
  const share = useCallback(
    async (list: Game[]): Promise<void> => {
      if (!(await window.sakura.has7z())) {
        toast('分享需要 7-Zip，请先安装', true)
        return
      }
      const plans = await window.sakura.sharePlan(list.map((g) => g.id))
      if (plans.length === 0) return
      setSharing(plans)
    },
    [toast]
  )

  const addGame = useCallback(async (): Promise<void> => {
    const game = await window.sakura.pickExe()
    if (!game) return
    await refresh()
    toast(`已添加《${game.name}》`)
  }, [refresh, toast])

  const launch = useCallback(
    async (game: Game): Promise<void> => {
      if (game.kind === 'archive') {
        toast('这是未安装的压缩包 —— 右键选择「一键解压」先装上', true)
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
        // The main process confirms this over playtime:changed, but showing it now
        // keeps the tile from looking inert while the game loads.
        setPlaying((cur) => (cur.includes(game.id) ? cur : [...cur, game.id]))
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

  /** The detail drawer only makes sense for exactly one game. */
  const selected = useMemo(
    () => (selectedIds.length === 1 ? games.find((g) => g.id === selectedIds[0]) ?? null : null),
    [games, selectedIds]
  )

  const needsOnboarding = loaded && settings.roots.length === 0 && games.length === 0

  return (
    <div
      className="app"
      /*
       * The whole window takes dropped files, not just the grid. Aiming at a tab is how
       * the drop is classified, but a drop that lands on the top bar or in the margin is
       * still plainly meant for the library, and refusing it teaches nothing.
       *
       * dragenter is cancelled as well as dragover: an element that cancels only the
       * latter is not a valid drop target, and Chromium then discards the drop without a
       * word — which is exactly what "nothing happens" looks like.
       */
      onDragEnter={(e) => {
        if (!dragHasFiles(e)) return
        e.preventDefault()
        dragDepth.current += 1
        setFileOver(true)
      }}
      onDragOver={(e) => {
        if (!dragHasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        if (!dragHasFiles(e)) return
        // Crossing between children fires leave-then-enter; only the outermost leave
        // means the drag has actually left the window.
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setFileOver(false)
      }}
      onDrop={(e) => {
        if (!dragHasFiles(e)) return
        e.preventDefault()
        dragDepth.current = 0
        setFileOver(false)
        const { paths, unreadable } = pathsFromDrop(e)
        if (paths.length === 0) {
          toast(
            unreadable > 0
              ? `读不到拖入文件的路径（${unreadable} 个），请改用「添加游戏」按钮`
              : '没有拖入任何文件',
            true
          )
          return
        }
        void importDropped(paths, page === 'desktop' ? tab : 'all')
      }}
    >
      <PetalCanvas enabled={settings.petals} themeKey={settings.theme} />

      {fileOver && (
        <div className="file-drop-overlay">
          <div className="file-drop-card">
            <span className="file-drop-icon">❀</span>
            <b>松手加入游戏库</b>
            <span>
              {page === 'desktop' && tab !== 'all'
                ? `加入并标记为「${TAB_META[tab].label}」`
                : '直接加入「全部」'}
            </span>
            <em>支持 .exe 与桌面快捷方式</em>
          </div>
        </div>
      )}

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
        onDownload={() => setDownloadOpen(true)}
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
              <p style={{ marginTop: 4, fontSize: 12.5, opacity: 0.8 }}>
                也可以直接把游戏的 exe 或桌面快捷方式拖进这个窗口。
              </p>
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
            selectedIds={selectedIds}
            playingIds={playing}
            extractProgress={extractProgress}
            downloads={downloads}
            onCancelDownload={(id) => void window.sakura.cancelDownload(id)}
            onClearDownloads={() => void window.sakura.clearFinishedDownloads()}
            onSelectionChange={setSelectedIds}
            onLaunch={(g) => void launch(g)}
            onPatch={patchGame}
            onUninstall={setUninstallTargets}
            onRemoveTile={setRemoving}
            onEditTags={setTagging}
            onSetCover={async (id) => {
              const updated = await window.sakura.setCover(id)
              if (updated) setGames((cur) => cur.map((g) => (g.id === id ? updated : g)))
            }}
            onClearCover={async (id) => {
              const updated = await window.sakura.clearCover(id)
              if (updated) setGames((cur) => cur.map((g) => (g.id === id ? updated : g)))
            }}
            onChooseExe={(game) => void chooseExe(game)}
            onDiagnose={(game) => diagnose(game)}
            // Straight to Explorer. A game entry points at its main executable and an
            // archive at a volume file, and either way this opens the folder holding it
            // with the file already selected.
            onBrowse={(game) => void window.sakura.reveal(game.id)}
            onExtract={(game) => void window.sakura.extract(game.id)}
            onShare={(list) => void share(list)}
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
          <TierPage
            games={games}
            onPatch={patchGame}
            onClearAll={() => {
              for (const g of games) {
                if (g.tier !== null) patchGame(g.id, { tier: null, tierOrder: 0 })
              }
              toast('已清除全部评级')
            }}
          />
        ) : page === 'wishlist' ? (
          <WishlistPage games={games} onPatch={patchGame} />
        ) : page === 'disk' ? (
          <DiskPage games={games} onToast={toast} onRescan={() => void runScan(false, false)} />
        ) : (
          <SettingsPage
            settings={settings}
            onChange={updateSettings}
            onRescanFolder={(folder) => void previewInto(folder)}
            onRemoveRoot={(folder) => setRemovingRoot(folder)}
            onAddFolder={() => void addFolder()}
            onBrowsePath={(dir) => void window.sakura.openPath(dir)}
            onUnignore={async (dir) => {
              const next = await window.sakura.unignore(dir)
              setSettings(next)
              await refresh()
              toast('已恢复该条目，重新扫描完成')
            }}
            onForgetIgnored={async (dir) => {
              setSettings(await window.sakura.clearIgnored([dir]))
              toast('已从名单里清除，下次重新扫描该文件夹时会重新问你')
            }}
            onClearIgnored={() => setClearingIgnored(true)}
          />
        )}

        {page === 'desktop' && selected && (
          <DetailDrawer
            game={selected}
            allGames={games}
            disks={disks}
            playing={playing.includes(selected.id)}
            onChooseExe={() => void chooseExe(selected)}
            onClose={() => setSelectedIds([])}
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
              新名字会写进游戏文件夹里的 <code>sakura-launcher.md</code>，
              <b>不会改动文件夹名，也不影响游戏启动</b>
              —— 很多游戏按路径找资源，直接改文件夹名会让它们打不开。
              那个文件里还记着这个游戏的状态、评分、标签和游玩时长，删掉它就全部恢复默认。
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

      {tagging && (
        <PromptDialog
          title={`《${tagging.name}》的标签`}
          initialValue={tagging.tags.join(', ')}
          placeholder="用逗号分隔，例如：战棋, 已打汉化补丁"
          confirmLabel="保存"
          description={
            <>
              标签会一起写进游戏文件夹里的 <code>sakura-launcher.md</code>，
              在顶部搜索框里输入标签也能筛选出对应的游戏。
            </>
          }
          onCancel={() => setTagging(null)}
          onConfirm={async (value) => {
            const target = tagging
            setTagging(null)
            const tags = [
              ...new Set(
                value
                  .split(/[,，、]/)
                  .map((t) => t.trim())
                  .filter(Boolean)
              )
            ]
            setGames((cur) => cur.map((g) => (g.id === target.id ? { ...g, tags } : g)))
            await window.sakura.setTags(target.id, tags)
          }}
        />
      )}

      {removing.length > 0 && (
        <ConfirmDialog
          title={
            removing.length === 1
              ? `把《${removing[0].name}》从库中移除？`
              : `把选中的 ${removing.length} 个条目从库中移除？`
          }
          confirmLabel={removing.length === 1 ? '移除磁贴' : `移除 ${removing.length} 个磁贴`}
          body={
            <>
              只是把{removing.length === 1 ? '这个磁贴' : '这些磁贴'}从启动器里拿掉，
              <b>不会删除磁盘上的任何文件</b> —— 用来清掉误扫进来的非游戏内容。
              {removing.length > 1 && (
                <ul style={{ margin: '10px 0 0', paddingLeft: 20, lineHeight: 1.8, fontSize: 13 }}>
                  {removing.slice(0, 8).map((g) => (
                    <li key={g.id}>{g.name}</li>
                  ))}
                  {removing.length > 8 && <li>…等共 {removing.length} 个</li>}
                </ul>
              )}
              <br />
              这{removing.length === 1 ? '个路径' : '些路径'}会被记住，之后重新扫描也不会再加回来。
              想恢复的话，到「设置 → 已移除的条目」里点一下即可。
            </>
          }
          onCancel={() => setRemoving([])}
          onConfirm={async () => {
            const targets = removing
            setRemoving([])
            let failed = 0
            for (const target of targets) {
              const result = await window.sakura.removeTile(target.id)
              if (!result.ok) failed++
            }
            setSelectedIds([])
            await refresh()
            if (failed > 0) toast(`${failed} 个条目移除失败`, true)
            else if (targets.length === 1) toast(`已移除《${targets[0].name}》，磁盘上的文件未改动`)
            else toast(`已移除 ${targets.length} 个条目，磁盘上的文件未改动`)
          }}
        />
      )}

      {trouble && (
        <div className={`trouble-card ${trouble.trouble}`}>
          <div className="trouble-text">
            <b>
              {trouble.trouble === 'dialog'
                ? `《${trouble.name}》停在一个报错窗口上`
                : `《${trouble.name}》好像没起来`}
            </b>
            <span>
              {trouble.trouble === 'earlyexit'
                ? '进程出现过，几秒之内就没了'
                : trouble.trouble === 'dialog'
                  ? '引擎弹了报错框，这次不计入游玩时长'
                  : '启动之后一直没有检测到进程'}
            </span>
          </div>
          <button
            type="button"
            className="btn primary small"
            onClick={() => {
              const game = games.find((g) => g.id === trouble.id)
              if (game) diagnose(game, trouble.startedAt, trouble.trouble)
            }}
          >
            查看诊断
          </button>
          <button
            type="button"
            className="btn ghost small"
            onClick={() => {
              void window.sakura.cancelLaunchWatch(trouble.id)
              setTrouble(null)
            }}
          >
            知道了
          </button>
        </div>
      )}

      {diagnosing && (
        <DiagnoseDialog
          game={diagnosing.game}
          since={diagnosing.since}
          trouble={diagnosing.trouble}
          toast={toast}
          onClose={() => setDiagnosing(null)}
          onPickExe={() => {
            const target = diagnosing.game
            setDiagnosing(null)
            void chooseExe(target)
          }}
        />
      )}

      {choosingExe && (
        <ExeChooserDialog
          game={choosingExe.game}
          data={choosingExe.data}
          onClose={() => setChoosingExe(null)}
          onDiagnose={() => {
            const target = choosingExe.game
            setChoosingExe(null)
            diagnose(target)
          }}
          onApply={async (exePath, args) => {
            const target = choosingExe.game
            const result = await window.sakura.setExe(target.id, exePath, args)
            if (!result.ok || !result.game) {
              toast(result.error ?? '设置失败', true)
              return
            }
            const updated = result.game
            setGames((cur) => cur.map((g) => (g.id === updated.id ? updated : g)))
            // Keep the dialog open on the refreshed data: after a combination launch the
            // obvious next move is to try it, and closing would hide the row to try.
            const data = await window.sakura.exeCandidates(updated.id)
            setChoosingExe(data ? { game: updated, data } : null)
            const name = exePath.split('\\').pop()
            toast(
              args.length > 0
                ? `主程序已设为 ${name}，并带上参数启动`
                : `主程序已设为 ${name}`
            )
          }}
        />
      )}

      {sharing && (
        <ShareDialog plans={sharing} onClose={() => setSharing(null)} onToast={toast} />
      )}

      {clearingIgnored && (
        <ConfirmDialog
          title={`清除全部 ${settings.ignoredDirs.length} 条移除记录？`}
          confirmLabel="全部清除"
          body={
            <>
              这些路径会不再被扫描跳过，但<b>不会立刻回到库里</b> ——
              下次对它们所在的文件夹点「重新扫描并添加」时，会重新出现在勾选列表里。
              <br />
              <br />
              磁盘上的文件不受影响，它们原来的封面、评分与游玩记录也仍然留着，
              重新加回来时会一并恢复。
            </>
          }
          onCancel={() => setClearingIgnored(false)}
          onConfirm={async () => {
            const count = settings.ignoredDirs.length
            setClearingIgnored(false)
            setSettings(await window.sakura.clearIgnored())
            toast(`已清除 ${count} 条移除记录`)
          }}
        />
      )}

      {removingRoot !== null && (
        <ConfirmDialog
          title={`不再扫描这个文件夹？`}
          confirmLabel="移除文件夹"
          body={(() => {
            const prefix = removingRoot.toLowerCase()
            const affected = games.filter(
              (g) => g.dir.toLowerCase() === prefix || g.dir.toLowerCase().startsWith(prefix + '\\')
            )
            return (
              <>
                <code>{removingRoot}</code> 会从扫描列表里去掉，
                {affected.length > 0 ? (
                  <>
                    库里来自它的 <b>{affected.length}</b> 个条目也会一起消失 ——
                    否则它们会一直留在主页上，而这个文件夹早已不在列表里了。
                  </>
                ) : (
                  '库里目前没有来自它的条目。'
                )}
                <br />
                <br />
                <b>磁盘上的文件不会被改动。</b>
                {affected.length > 0 && (
                  <>
                    每个游戏的评分、评级、标签和游玩时长会先写进它自己文件夹里的
                    <code>sakura-launcher.md</code>，之后重新加回这个文件夹就能一并恢复。
                  </>
                )}
              </>
            )
          })()}
          onCancel={() => setRemovingRoot(null)}
          onConfirm={async () => {
            const folder = removingRoot
            setRemovingRoot(null)
            const result = await window.sakura.removeRoot(folder)
            setGames(result.games)
            setSettings(result.settings)
            setSelectedIds([])
            toast(
              result.removed > 0
                ? `已移除该文件夹及其 ${result.removed} 个条目，磁盘文件未改动`
                : '已从扫描列表移除该文件夹'
            )
            window.sakura.diskInfo().then(setDisks)
          }}
        />
      )}

      {downloadOpen && (
        <DownloadDialog
          settings={settings}
          onOpenSettings={() => {
            setDownloadOpen(false)
            setPage('settings')
          }}
          onClose={() => setDownloadOpen(false)}
          onStart={async (urls, dir) => {
            const errors: string[] = []
            for (const url of urls) {
              const result = await window.sakura.startDownload(url, dir)
              if (!result.ok) errors.push(result.error ?? url)
            }
            if (errors.length === urls.length) {
              toast(errors[0], true)
              return
            }
            setDownloadOpen(false)
            const ok = urls.length - errors.length
            toast(
              errors.length > 0
                ? `已开始 ${ok} 条，${errors.length} 条失败：${errors[0]}`
                : `已交给下载器，共 ${ok} 条。下载完成后会自动解压并加入库`
            )
          }}
        />
      )}

      {importing && (
        <ImportDialog
          preview={importing}
          onCancel={() => setImporting(null)}
          onConfirm={async (accept, reject) => {
            const folder = importing.folder
            setImporting(null)
            setScanning(true)
            try {
              const outcome = await window.sakura.commitImport(folder, accept, reject)
              setGames(outcome.games)
              const snap = await window.sakura.snapshot()
              setSettings(snap.settings)
              toast(
                outcome.added > 0
                  ? `已导入 ${outcome.added} 个条目`
                  : '没有新增条目，扫描列表已更新'
              )
              if (outcome.groupCandidates.length > 0) {
                setGroupPrompt({ candidates: outcome.groupCandidates })
              }
            } finally {
              setScanning(false)
              window.sakura.diskInfo().then(setDisks)
            }
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

      {uninstallTargets.length === 1 && (
        <UninstallRitual
          game={uninstallTargets[0]}
          onCancel={() => setUninstallTargets([])}
          onDone={async (result) => {
            const target = uninstallTargets[0]
            setUninstallTargets([])
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
            setSelectedIds([])
            await refresh()
          }}
        />
      )}

      {uninstallTargets.length > 1 && (
        <BulkUninstallDialog
          games={uninstallTargets}
          onCancel={() => setUninstallTargets([])}
          onDone={async (results) => {
            setUninstallTargets([])
            const failed = results.filter((r) => !r.ok)
            setSelectedIds([])
            await refresh()
            if (failed.length === 0) toast(`已卸载 ${results.length} 个游戏`)
            else toast(`${results.length - failed.length} 个已卸载，${failed.length} 个失败`, true)
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
