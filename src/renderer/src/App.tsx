import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ImportPreview, LaunchTroubleEvent } from '../../preload/index'
import type { Lang } from '../../shared/i18n'
import type {
  DiskInfo,
  ExeChoices,
  Game,
  Group,
  LaunchTrouble,
  PendingDownload,
  PendingMatch,
  Settings,
  SavePlan,
  SharePlan,
  SortKey,
  TabKey,
  WorkMatch
} from '../../shared/types'
import { DEFAULT_SETTINGS, normalizeStatus, toggleTagFilter } from '../../shared/types'
import { makeT, type MessageKey } from '../../shared/i18n'
import { setShowAdultArt } from './components/Artwork'
import BulkUninstallDialog from './components/BulkUninstallDialog'
import ConfirmDialog from './components/ConfirmDialog'
import DetailDrawer from './components/DetailDrawer'
import DiagnoseDialog from './components/DiagnoseDialog'
import ExeChooserDialog from './components/ExeChooserDialog'
import ImportDialog from './components/ImportDialog'
import PromptDialog from './components/PromptDialog'
import SaveBackupDialog from './components/SaveBackupDialog'
import ShareDialog from './components/ShareDialog'
import PetalCanvas from './components/PetalCanvas'
import DownloadDialog from './components/DownloadDialog'
import TopBar, { type PageKey } from './components/TopBar'
import UninstallRitual from './components/UninstallRitual'
import { dragHasFiles, pathsFromDrop } from './lib/fileDrop'
import { formatBytes } from './lib/format'
import { LangProvider } from './lib/i18n'
import DesktopPage from './pages/DesktopPage'
import DiskPage from './pages/DiskPage'
import MatchDialog from './components/MatchDialog'
import TagBar from './components/TagBar'
import SettingsPage from './pages/SettingsPage'
import TierPage from './pages/TierPage'

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
  /**
   * Auto tags currently filtering the grid. Deliberately not a setting: a filter is
   * where you are right now, not how you like the program set up, and coming back
   * tomorrow to a library that is still hiding four fifths of itself is a bug report.
   */
  const [activeTags, setActiveTags] = useState<string[]>([])
  /** Set while a tagging pass runs, so the settings page can show it moving. */
  const [tagProgress, setTagProgress] = useState<{ done: number; total: number; name: string } | null>(
    null
  )
  /** Title matches the launcher would not settle on its own. */
  const [pendingMatches, setPendingMatches] = useState<PendingMatch[] | null>(null)
  /** How many games a pass would look up. Kept in step with the library, not guessed. */
  const [pendingTagCount, setPendingTagCount] = useState(0)
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
  /** Games whose saves are being copied out, with where each one's saves appear to be. */
  const [backingUp, setBackingUp] = useState<SavePlan[] | null>(null)
  const [importing, setImporting] = useState<ImportPreview | null>(null)
  const [leftover, setLeftover] = useState<{ game: Game; bytes: number } | null>(null)
  const [extractProgress, setExtractProgress] = useState<Record<string, number>>({})
  const [downloads, setDownloads] = useState<PendingDownload[]>([])
  const [downloadOpen, setDownloadOpen] = useState(false)
  const [fileOver, setFileOver] = useState(false)
  /** Nested dragenter/dragleave pairs, so crossing a child does not clear the overlay. */
  const dragDepth = useRef(0)

  const toastSeq = useRef(0)

  /**
   * App sits outside its own LangProvider, so it builds a translator directly rather
   * than through the hook. Everything below it uses `useT`.
   *
   * Backed by a ref rather than by render state, because the callbacks below outrun the
   * render. The startup scan runs in the same tick as the `setSettings` that loads the
   * language, so a translator memoised on `settings.language` is still the default one
   * when the scan's toast is written — an English library greeted by a Chinese message.
   * The ref is assigned the moment the settings arrive, so anything that fires afterwards
   * speaks the right language whether React has re-rendered or not.
   */
  const langRef = useRef<Lang>(settings.language)
  langRef.current = settings.language

  // Set during render, before any child renders, so the first paint after the switch is
  // flipped already has it right. See the note in `Artwork.tsx` for why this is not a prop.
  setShowAdultArt(settings.adultTags)
  const tr = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) =>
      makeT(langRef.current)(key, vars),
    []
  )

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
    langRef.current = snap.settings.language
    setGames(snap.games)
    setGroups(snap.groups)
    setSettings(snap.settings)
    window.sakura.diskInfo().then(setDisks)
  }, [])

  // Initial load, then an automatic scan when the library is already configured.
  useEffect(() => {
    void (async () => {
      const snap = await window.sakura.snapshot()
      // Before any state update: the scan below runs in this same tick.
      langRef.current = snap.settings.language
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
      toast(
        ok
          ? tr('toast.extractOk')
          : tr('toast.extractFailed', { error: error ?? tr('common.unknownError') }),
        !ok
      )
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
          const notes: string[] = [tr('toast.refreshed', { n: installed })]
          if (outcome.sidecars && outcome.sidecars.imported > 0) {
            notes.push(tr('toast.sidecarsRead', { n: outcome.sidecars.imported }))
          }
          toast(notes.join('，'))
        }
        // Worth saying out loud: an unmounted drive would otherwise look like the
        // library quietly shrank.
        if (outcome.missing > 0) {
          toast(tr('toast.missing', { n: outcome.missing }), true)
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
    // Same reason as above: a toast written immediately after a language change must
    // already be in the new language.
    if (patch.language) langRef.current = patch.language
    setSettings((cur) => ({ ...cur, ...patch }))
    void window.sakura.updateSettings(patch)
  }, [])

  /**
   * Look games up — tags, cover and description together.
   *
   * Only ever from a menu entry or the settings button, and only when the user has
   * switched the catalogue on. One lookup per game, paced: a large library takes minutes,
   * which is why there is a progress line and a way to stop.
   *
   * `null` means the games nobody has asked about yet, which is what the library-wide
   * button runs.
   */
  const computeTags = useCallback(
    async (ids: string[] | null, scope: 'single' | 'bulk' = 'bulk'): Promise<void> => {
      if (ids && ids.length === 0) return
      setTagProgress({ done: 0, total: ids?.length ?? 0, name: '' })
      try {
        const result = await window.sakura.computeTags(ids, scope)
        if (result.busy || result.off) return
        await refresh()
        const looked = result.looked ?? 0
        const matched = result.matched ?? 0
        if (result.offline) toast(tr('tags.offline'), true)
        else {
          // One sentence, assembled from what actually happened. Saying only how many
          // were matched leaves the covers and the blurbs looking like they failed, and
          // a count that ignores what it deliberately left alone looks like a fault too.
          let line = result.cancelled
            ? tr('tags.stopped', { looked, matched })
            : tr('tags.done', { looked, matched })
          if ((result.covers ?? 0) > 0) line += tr('tags.andCovers', { n: result.covers ?? 0 })
          if ((result.summaries ?? 0) > 0)
            line += tr('tags.andSummaries', { n: result.summaries ?? 0 })
          if ((result.keptUser ?? 0) > 0)
            line += tr('covers.keptUser', { n: result.keptUser ?? 0 })
          toast(line)
        }
        if (result.pending && result.pending.length > 0) setPendingMatches(result.pending)
      } finally {
        setTagProgress(null)
      }
    },
    [refresh, toast, tr]
  )

  useEffect(() => window.sakura.onTagProgress(setTagProgress), [])


  // Recount whenever the library changes: adding games, or matching some, both move it.
  useEffect(() => {
    void window.sakura.pendingTagCount().then(setPendingTagCount)
  }, [games])

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
          if (settings.roots.includes(folder)) toast(tr('toast.nothingNew'))
          else toast(tr('toast.nothingToAdd'))
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
   * something onto Playing and it is imported already marked as such, which is the whole
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
        else failed.push(result.error ?? tr('toast.addFailed', { path: filePath }))
      }

      if (added.length > 0) await refresh()

      const suffix =
        intoTab === 'all' ? '' : tr('toast.markedAs', { tab: tr(`tab.${intoTab}` as MessageKey) })
      if (added.length === 0) {
        // Nothing landed, so this is a failure however it is worded — most often the
        // same game dragged in twice.
        toast(
          failed.length === 1
            ? failed[0]
            : tr('toast.allFailed', { n: failed.length, first: failed[0] }),
          true
        )
        return
      }

      const headline =
        added.length === 1
          ? tr('toast.addedOne', { name: added[0], suffix })
          : tr('toast.addedMany', { n: added.length, suffix })
      toast(
        failed.length === 0
          ? headline
          : tr('toast.someFailed', { headline, n: failed.length, first: failed[0] })
      )
    },
    [refresh, toast]
  )

  const chooseExe = useCallback(
    async (game: Game): Promise<void> => {
      const data = await window.sakura.exeCandidates(game.id)
      if (!data || data.choices.length === 0) {
        toast(tr('toast.noExeHere'), true)
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
        toast(tr('toast.need7z'), true)
        return
      }
      const plans = await window.sakura.sharePlan(list.map((g) => g.id))
      if (plans.length === 0) return
      setSharing(plans)
    },
    [toast]
  )

  /**
   * Open the save backup dialog for a selection.
   *
   * Fetched before the dialog opens, like the share plan, and for a stronger reason: this
   * one walks AppData as well as the game folders, so a dialog that painted first would
   * sit visibly empty while the search ran.
   */
  const backupSaves = useCallback(async (list: Game[]): Promise<void> => {
    const plans = await window.sakura.savePlan(list.map((g) => g.id))
    if (plans.length === 0) return
    setBackingUp(plans)
  }, [])

  const addGame = useCallback(async (): Promise<void> => {
    const game = await window.sakura.pickExe()
    if (!game) return
    await refresh()
    toast(tr('toast.added', { name: game.name }))
  }, [refresh, toast])

  const launch = useCallback(
    async (game: Game): Promise<void> => {
      if (game.kind === 'archive') {
        toast(tr('toast.archiveNotInstalled'), true)
        return
      }
      const result = await window.sakura.launch(game.id)
      if (result.ok) {
        toast(tr('toast.launching', { name: game.name }))
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
        toast(result.error ?? tr('toast.launchFailed'), true)
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
    <LangProvider lang={settings.language}>
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
              ? tr('toast.dropUnreadable', { n: unreadable })
              : tr('toast.dropNothing'),
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
            <b>{tr('drop.release')}</b>
            <span>
              {page === 'desktop' && tab !== 'all'
                ? tr('drop.intoTab', { tab: tr(`tab.${tab}` as MessageKey) })
                : tr('drop.intoAll')}
            </span>
            <em>{tr('drop.hint')}</em>
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

      {page === 'desktop' && !needsOnboarding && (
        <TagBar
          games={games}
          active={activeTags}
          showSpoilers={settings.spoilerTags}
          showAdult={settings.adultTags}
          onToggle={(id) => setActiveTags((cur) => toggleTagFilter(cur, id))}
          onClear={() => setActiveTags([])}
        />
      )}

      <div className="app-body">
        {needsOnboarding ? (
          <div className="page">
            <div className="empty">
              <div style={{ fontSize: 54 }}>🌸</div>
              <h2>{tr('onboard.title')}</h2>
              <p>
                {tr('onboard.detail')}
              </p>
              <button type="button" className="btn primary" onClick={() => void addFolder()}>
                {tr('onboard.pick')}
              </button>
              <button type="button" className="btn ghost" onClick={() => void addGame()}>
                {tr('onboard.single')}
              </button>
              <p style={{ marginTop: 4, fontSize: 12.5, opacity: 0.8 }}>
                {tr('onboard.drop')}
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
            activeTags={activeTags}
            showSpoilers={settings.spoilerTags}
            showAdult={settings.adultTags}
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
            onBackupSaves={(list) => void backupSaves(list)}
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
              toast(tr('toast.wishlistNoLaunch'))
            }
            onRename={setRenaming}
            onFetchWork={(targets, scope) => void computeTags(targets.map((g) => g.id), scope)}
            onlineTags={settings.onlineTags}
            // Straight into the dialog with the search box, no lookup first. This is the
            // route for a folder nothing could ever match on its own.
            onMatchWork={(game) =>
              setPendingMatches([
                {
                  gameId: game.id,
                  gameName: game.name,
                  candidates: [],
                  suggestion: game.work?.title ?? game.name
                }
              ])
            }
          />
        ) : page === 'tier' ? (
          <TierPage
            games={games}
            onPatch={patchGame}
            onClearAll={() => {
              for (const g of games) {
                if (g.tier !== null) patchGame(g.id, { tier: null, tierOrder: 0 })
              }
              toast(tr('toast.tiersCleared'))
            }}
          />
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
              toast(tr('toast.restored'))
            }}
            onForgetIgnored={async (dir) => {
              setSettings(await window.sakura.clearIgnored([dir]))
              toast(tr('toast.forgotten'))
            }}
            onClearIgnored={() => setClearingIgnored(true)}
            onComputeTags={() => void computeTags(null)}
            onRedoTags={() =>
              void computeTags(games.filter((g) => g.kind === 'installed').map((g) => g.id))
            }
            onCancelTags={() => void window.sakura.cancelTags()}
            tagProgress={tagProgress}
            pendingCount={pendingTagCount}
            gameCount={games.length}
          />
        )}

        {page === 'desktop' && selected && (
          <DetailDrawer
            game={selected}
            allGames={games}
            disks={disks}
            playing={playing.includes(selected.id)}
            showSpoilers={settings.spoilerTags}
            showAdult={settings.adultTags}
            onTagHidden={async (gameId, tagId, hidden) => {
              const updated = await window.sakura.setTagHidden(gameId, tagId, hidden)
              if (updated) setGames((cur) => cur.map((g) => (g.id === gameId ? updated : g)))
            }}
            onChooseExe={() => void chooseExe(selected)}
            onClose={() => setSelectedIds([])}
          />
        )}
      </div>

      {pendingMatches && (
        <MatchDialog
          pending={pendingMatches}
          showSpoilers={settings.spoilerTags}
          showAdult={settings.adultTags}
          onApply={async (gameId, match: WorkMatch) => {
            const updated = await window.sakura.applyMatch(gameId, match)
            if (updated) setGames((cur) => cur.map((g) => (g.id === gameId ? updated : g)))
          }}
          onClose={() => setPendingMatches(null)}
        />
      )}

      {renaming && (
        <PromptDialog
          title={tr('rename.title', { name: renaming.name })}
          initialValue={renaming.name}
          placeholder={tr('rename.placeholder')}
          description={
            <>
              {tr('rename.note')}
            </>
          }
          onCancel={() => setRenaming(null)}
          onConfirm={async (name) => {
            const target = renaming
            setRenaming(null)
            const result = await window.sakura.rename(target.id, name)
            if (!result.ok) {
              toast(result.error ?? tr('toast.renameFailed'), true)
              return
            }
            setGames((cur) => cur.map((g) => (g.id === target.id ? { ...g, name } : g)))
            toast(
              result.sidecar
                ? tr('toast.renamedWithSidecar')
                : tr('toast.renamedNoSidecar', {
                    detail: result.error ? `: ${result.error}` : ''
                  }),
              !result.sidecar
            )
          }}
        />
      )}

      {tagging && (
        <PromptDialog
          title={tr('tags.title', { name: tagging.name })}
          initialValue={tagging.tags.join(', ')}
          placeholder={tr('tags.placeholder')}
          confirmLabel={tr('tags.save')}
          description={
            <>
              {tr('tags.note')}
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
              ? tr('remove.titleOne', { name: removing[0].name })
              : tr('remove.titleMany', { n: removing.length })
          }
          confirmLabel={
            removing.length === 1
              ? tr('remove.confirmOne')
              : tr('remove.confirmMany', { n: removing.length })
          }
          body={
            <>
              {tr('remove.detail', {
                what: tr(removing.length === 1 ? 'remove.thisTile' : 'remove.theseTiles')
              })}
              {removing.length > 1 && (
                <ul style={{ margin: '10px 0 0', paddingLeft: 20, lineHeight: 1.8, fontSize: 13 }}>
                  {removing.slice(0, 8).map((g) => (
                    <li key={g.id}>{g.name}</li>
                  ))}
                  {removing.length > 8 && <li>{tr('remove.andMore', { n: removing.length })}</li>}
                </ul>
              )}
              <br />
              {tr('remove.pathNote', {
                what: tr(removing.length === 1 ? 'remove.thisPath' : 'remove.thesePaths')
              })}
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
            if (failed > 0) toast(tr('toast.removeFailed', { n: failed }), true)
            else if (targets.length === 1) toast(tr('toast.removedOne', { name: targets[0].name }))
            else toast(tr('toast.removedMany', { n: targets.length }))
          }}
        />
      )}

      {trouble && (
        <div className={`trouble-card ${trouble.trouble}`}>
          <div className="trouble-text">
            <b>
              {trouble.trouble === 'dialog'
                ? tr('trouble.dialogTitle', { name: trouble.name })
                : tr('trouble.noshowTitle', { name: trouble.name })}
            </b>
            <span>
              {trouble.trouble === 'earlyexit'
                ? tr('trouble.earlyexit')
                : trouble.trouble === 'dialog'
                  ? tr('trouble.dialog')
                  : tr('trouble.noshow')}
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
            {tr('trouble.view')}
          </button>
          <button
            type="button"
            className="btn ghost small"
            onClick={() => {
              void window.sakura.cancelLaunchWatch(trouble.id)
              setTrouble(null)
            }}
          >
            {tr('trouble.dismiss')}
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
              toast(result.error ?? tr('toast.setExeFailed'), true)
              return
            }
            const updated = result.game
            setGames((cur) => cur.map((g) => (g.id === updated.id ? updated : g)))
            // Keep the dialog open on the refreshed data: after a combination launch the
            // obvious next move is to try it, and closing would hide the row to try.
            const data = await window.sakura.exeCandidates(updated.id)
            setChoosingExe(data ? { game: updated, data } : null)
            const name = exePath.split('\\').pop() ?? exePath
            toast(
              args.length > 0
                ? tr('toast.exeSetWithArgs', { name })
                : tr('toast.exeSet', { name })
            )
          }}
        />
      )}

      {sharing && (
        <ShareDialog plans={sharing} onClose={() => setSharing(null)} onToast={toast} />
      )}

      {backingUp && (
        <SaveBackupDialog
          plans={backingUp}
          onClose={() => setBackingUp(null)}
          onToast={toast}
        />
      )}

      {clearingIgnored && (
        <ConfirmDialog
          title={tr('clearIgnored.title', { n: settings.ignoredDirs.length })}
          confirmLabel={tr('clearIgnored.confirm')}
          body={
            <>
              {tr('clearIgnored.detail')}
              <br />
              <br />
              {tr('clearIgnored.detail2')}
            </>
          }
          onCancel={() => setClearingIgnored(false)}
          onConfirm={async () => {
            const count = settings.ignoredDirs.length
            setClearingIgnored(false)
            setSettings(await window.sakura.clearIgnored())
            toast(tr('toast.ignoredCleared', { n: count }))
          }}
        />
      )}

      {removingRoot !== null && (
        <ConfirmDialog
          title={tr('dropRoot.title')}
          confirmLabel={tr('dropRoot.confirm')}
          body={(() => {
            const prefix = removingRoot.toLowerCase()
            const affected = games.filter(
              (g) => g.dir.toLowerCase() === prefix || g.dir.toLowerCase().startsWith(prefix + '\\')
            )
            return (
              <>
                {tr('dropRoot.willRemove', { path: removingRoot })}
                {affected.length > 0 ? (
                  <>
                    {tr('dropRoot.affected', { n: affected.length })}
                  </>
                ) : (
                  tr('dropRoot.none')
                )}
                <br />
                <br />
                <b>{tr('dropRoot.safe')}</b>
                {affected.length > 0 && (
                  <>
                    {tr('dropRoot.sidecarNote')}
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
                ? tr('toast.rootRemovedWith', { n: result.removed })
                : tr('toast.rootRemoved')
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
                ? tr('toast.downloadPartial', { ok, bad: errors.length, first: errors[0] })
                : tr('toast.downloadStarted', { n: ok })
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
                  ? tr('toast.imported', { n: outcome.added })
                  : tr('toast.nothingImported')
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
          title={tr('leftover.title')}
          danger
          confirmLabel={tr('leftover.confirm')}
          cancelLabel={tr('leftover.cancel')}
          body={
            <>
              {tr('leftover.detail', { size: formatBytes(leftover.bytes) })}
            </>
          }
          onCancel={() => setLeftover(null)}
          onConfirm={async () => {
            const target = leftover.game
            setLeftover(null)
            const cleanup = await window.sakura.trashLeftovers(target.id)
            toast(
              cleanup.ok
                ? tr('toast.leftoverTrashed')
                : cleanup.error ?? tr('toast.cleanupFailed'),
              !cleanup.ok
            )
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
              toast(result.error ?? tr('toast.uninstallFailed'), true)
              return
            }
            if (result.leftoverBytes && result.leftoverBytes > 0) {
              setLeftover({ game: target, bytes: result.leftoverBytes })
            } else {
              toast(
                result.method === 'trash'
                  ? tr('toast.trashed', { name: target.name })
                  : tr('toast.uninstalled', { name: target.name })
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
            if (failed.length === 0) toast(tr('toast.uninstalledMany', { n: results.length }))
            else
              toast(
                tr('toast.uninstalledPartial', {
                  ok: results.length - failed.length,
                  bad: failed.length
                }),
                true
              )
          }}
        />
      )}

      {groupPrompt && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="step">{tr('group.step')}</div>
            <h2>{tr('group.title', { n: groupPrompt.candidates.length })}</h2>
            <p style={{ fontSize: 13, color: 'var(--ink-soft)', lineHeight: 1.7, margin: '10px 0 0' }}>
              {tr('group.detail')}
            </p>
            <ul style={{ fontSize: 13, margin: '14px 0 0', paddingLeft: 20, lineHeight: 1.8 }}>
              {groupPrompt.candidates.slice(0, 8).map((c) => (
                <li key={c.parent}>
                  {c.name}{' '}
                  <span style={{ color: 'var(--ink-soft)' }}>
                    {tr('group.count', { n: c.dirs.length })}
                  </span>
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
                {tr('group.decline')}
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
                  toast(tr('toast.groupsMade', { n: newGroups.length }))
                }}
              >
                {tr('group.accept')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="toasts">
        {toasts.map((item) => (
          <div className={`toast${item.error ? ' error' : ''}`} key={item.id}>
            {item.message}
          </div>
        ))}
      </div>
    </div>
    </LangProvider>
  )
}
