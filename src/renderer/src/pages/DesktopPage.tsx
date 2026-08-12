import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  DownloadStatus,
  Game,
  Group,
  PendingDownload,
  SortKey,
  TabKey
} from '../../../shared/types'
import { ARCHIVE_GROUP_ID, SORT_KEYS, visibleTags } from '../../../shared/types'
import type { MessageKey } from '../../../shared/i18n'
import { useT } from '../lib/i18n'
import Artwork from '../components/Artwork'
import ContextMenu, { type MenuItem } from '../components/ContextMenu'
import FolderWindow from '../components/FolderWindow'
import PromptDialog from '../components/PromptDialog'
import Tile from '../components/Tile'
import { formatBytes } from '../lib/format'
import { useFlip } from '../lib/useFlip'
import { useTileDrag, type DropTarget } from '../lib/useTileDrag'

interface Props {
  games: Game[]
  groups: Group[]
  tab: TabKey
  sortKey: SortKey
  tileSize: number
  search: string
  /** Auto-tag ids currently narrowing the grid. Every one of them has to match. */
  activeTags: string[]
  /** Whether spoiler tags count — a hidden tag must not be able to filter on the sly. */
  showSpoilers: boolean
  /** Whether explicit tags count. A hidden tag must not be able to filter on the sly. */
  showAdult: boolean
  selectedIds: string[]
  playingIds: string[]
  /**
   * Accepts an updater as well as a plain list. Toggling has to build on the latest
   * selection: two clicks landing in the same render would otherwise both read the
   * same stale array, and the second would discard the first.
   */
  onSelectionChange: (ids: string[] | ((current: string[]) => string[])) => void
  onLaunch: (game: Game) => void
  onPatch: (id: string, patch: Partial<Game>) => void
  onUninstall: (games: Game[]) => void
  onRemoveTile: (games: Game[]) => void
  onSetCover: (id: string) => void
  onClearCover: (id: string) => void
  onBrowse: (game: Game) => void
  /** Open the picker for which executable actually starts this game. */
  onChooseExe: (game: Game) => void
  onDiagnose: (game: Game) => void
  onExtract: (game: Game) => void
  /** Pack these up to send to someone. Never writes to the game folders. */
  onShare: (games: Game[]) => void
  /** Copy these games' saves out. Also read-only as far as the game folders go. */
  onBackupSaves: (games: Game[]) => void
  onGroupsChange: (groups: Group[]) => void
  onReorder: (ids: string[]) => void
  onAddGame: () => void
  onAddFolder: () => void
  onRescan: () => void
  onSortChange: (key: SortKey) => void
  onRename: (game: Game) => void
  onEditTags: (game: Game) => void
  /** Work these games' automatic tags out again. One game, or a whole selection. */
  onRetag: (games: Game[]) => void
  /**
   * Fetch cover art for these games from the catalogue each is matched to.
   *
   * `scope` travels with it because the two are not the same act: a selection leaves a
   * hand-picked cover alone, while one game chosen from its own menu replaces it.
   */
  onFetchCovers: (games: Game[], scope: 'single' | 'bulk') => void
  /** Whether the catalogue is switched on at all — no menu entry offers what is refused. */
  onlineTags: boolean
  /** Whether image downloads are allowed on top of that. */
  onlineCovers: boolean
  /** Open the match dialog for this one game, search box and all. */
  onMatchWork: (game: Game) => void
  onBlockedLaunch: () => void
  extractProgress: Record<string, number>
  downloads: PendingDownload[]
  onCancelDownload: (id: string) => void
  onClearDownloads: () => void
}

const DOWNLOAD_LABELS: Record<DownloadStatus, MessageKey> = {
  downloading: 'dl.downloading',
  extracting: 'dl.extracting',
  importing: 'dl.importing',
  done: 'dl.done',
  failed: 'dl.failed'
}

type MenuState =
  | { kind: 'game'; x: number; y: number; game: Game }
  | { kind: 'bulk'; x: number; y: number; targets: Game[] }
  | { kind: 'blank'; x: number; y: number }
  | { kind: 'group'; x: number; y: number; group: Group }
  | null

function sortGames(games: Game[], key: SortKey): Game[] {
  const list = [...games]
  const byName = (a: Game, b: Game): number => a.name.localeCompare(b.name, 'zh-CN')
  switch (key) {
    case 'name':
      return list.sort(byName)
    // Sizes arrive asynchronously; fall back to name so the order stays stable
    // instead of shuffling as each background measurement lands.
    case 'size':
      return list.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) || byName(a, b))
    case 'mtime':
      return list.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0) || byName(a, b))
    case 'recent':
      return list.sort((a, b) => (b.lastLaunchedAt ?? 0) - (a.lastLaunchedAt ?? 0) || byName(a, b))
    case 'playtime':
      return list.sort((a, b) => b.playtimeMs - a.playtimeMs || byName(a, b))
    default:
      return list.sort((a, b) => a.order - b.order)
  }
}

export default function DesktopPage(props: Props): React.JSX.Element {
  const t = useT()
  const {
    games,
    groups,
    tab,
    sortKey,
    tileSize,
    search,
    activeTags,
    showSpoilers,
    showAdult,
    selectedIds,
    playingIds,
    onSelectionChange,
    onLaunch,
    onPatch,
    onUninstall,
    onGroupsChange,
    onReorder,
    extractProgress,
    downloads,
    onCancelDownload,
    onClearDownloads
  } = props

  const [menu, setMenu] = useState<MenuState>(null)
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  const [nudgeId, setNudgeId] = useState<string | null>(null)
  const [groupPrompt, setGroupPrompt] = useState<
    { mode: 'create' } | { mode: 'rename'; group: Group } | null
  >(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  /** Where a shift-click range starts from. */
  const anchorRef = useRef<string | null>(null)

  const selection = useMemo(() => new Set(selectedIds), [selectedIds])
  const playing = useMemo(() => new Set(playingIds), [playingIds])
  const selectedGames = useMemo(
    () => games.filter((g) => selection.has(g.id)),
    [games, selection]
  )

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return games.filter((g) => {
      // Tags are searchable too, which is most of what makes them worth keeping — and the
      // automatic ones alongside them, since the tag bar deliberately leaves out anything
      // only one game carries and search is where those have to remain findable.
      if (
        q &&
        !g.name.toLowerCase().includes(q) &&
        !g.tags.some((t) => t.toLowerCase().includes(q)) &&
        !visibleTags(g, showSpoilers, showAdult).some(
          (t) => t.id.toLowerCase().includes(q) || (t.label ?? '').toLowerCase().includes(q)
        )
      )
        return false
      // Several selected tags narrow rather than widen: picking KiriKiri and 有汉化 means
      // both, which is what a person reaching for a second filter is asking for.
      if (activeTags.length > 0) {
        const own = new Set(visibleTags(g, showSpoilers, showAdult).map((t) => t.id))
        if (!activeTags.every((id) => own.has(id))) return false
      }
      switch (tab) {
        case 'wishlist':
          return g.wishlist
        case 'playing':
          return g.playing
        case 'played':
          return g.played
        default:
          return true
      }
    })
  }, [games, tab, search, activeTags, showSpoilers, showAdult])

  // Groups only structure the All view; the status tabs are already a filter, and so is
  // a tag — a group half of whose members were filtered out is a lie about what is in it.
  const useGroups = tab === 'all' && !search.trim() && activeTags.length === 0

  const ungrouped = useMemo(
    () => sortGames(useGroups ? visible.filter((g) => !g.groupId) : visible, sortKey),
    [visible, useGroups, sortKey]
  )

  const groupsWithMembers = useMemo(() => {
    if (!useGroups) return []
    return groups
      .map((group) => ({
        group,
        members: sortGames(
          visible.filter((g) => g.groupId === group.id),
          sortKey
        )
      }))
      .filter((g) => g.members.length > 0)
      .sort((a, b) => a.group.order - b.group.order)
  }, [groups, visible, useGroups, sortKey])

  const launchBlocked = tab === 'wishlist'

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && selectedIds.length > 0) onSelectionChange([])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedIds.length, onSelectionChange])

  /*
   * A bare onClick would fire on the first half of a double-click and open the detail
   * panel, which is enough to keep the second click from ever landing as a dblclick.
   * So the single-click action waits out the double-click window and is cancelled if
   * a second click arrives.
   */
  const clickTimer = useRef<number | null>(null)
  /** The game a still-pending plain click belongs to, so it can be settled early. */
  const pendingClick = useRef<Game | null>(null)

  useEffect(() => {
    return () => {
      if (clickTimer.current !== null) window.clearTimeout(clickTimer.current)
    }
  }, [])

  /** Order tiles the way they are laid out, so a shift-range matches what is on screen. */
  const flatOrder = useMemo(() => {
    const rows: Game[] = [...ungrouped]
    for (const { members } of groupsWithMembers) rows.push(...members)
    return rows.map((g) => g.id)
  }, [ungrouped, groupsWithMembers])

  const applyClick = (game: Game, mods: { toggle: boolean; range: boolean }): void => {
    if (mods.toggle) {
      anchorRef.current = game.id
      onSelectionChange((cur) =>
        cur.includes(game.id) ? cur.filter((id) => id !== game.id) : [...cur, game.id]
      )
      return
    }

    if (mods.range && anchorRef.current) {
      const from = flatOrder.indexOf(anchorRef.current)
      const to = flatOrder.indexOf(game.id)
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from]
        onSelectionChange(flatOrder.slice(lo, hi + 1))
        return
      }
    }

    anchorRef.current = game.id
    // Clicking the one already selected closes the detail panel again.
    onSelectionChange((cur) => (cur.length === 1 && cur[0] === game.id ? [] : [game.id]))
  }

  const handleSingleClick = (game: Game, e: React.MouseEvent): void => {
    // The click a finished drag leaves behind is not a click the user made.
    if (drag.didDrag()) return
    const toggle = e.ctrlKey || e.metaKey
    const range = e.shiftKey
    // A modified click edits the selection and can never begin a launch, so it applies
    // at once instead of waiting out the double-click window. Any plain click still
    // waiting out that window is settled first: it resolves to "select only this one",
    // so left to land afterwards it would wipe the selection just built — and simply
    // dropping it would lose the tile the user picked before reaching for Ctrl.
    if (toggle || range) {
      flushPendingClick()
      applyClick(game, { toggle, range })
      return
    }
    if (clickTimer.current !== null) return // second click of a pair; dblclick takes over
    pendingClick.current = game
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null
      pendingClick.current = null
      applyClick(game, { toggle: false, range: false })
    }, 240)
  }

  /** Drop a pending plain click unapplied — a double-click or a right-click supersedes it. */
  const cancelPendingClick = (): void => {
    if (clickTimer.current === null) return
    window.clearTimeout(clickTimer.current)
    clickTimer.current = null
    pendingClick.current = null
  }

  /** Apply a pending plain click now rather than waiting out the double-click window. */
  const flushPendingClick = (): void => {
    const game = pendingClick.current
    cancelPendingClick()
    if (game) applyClick(game, { toggle: false, range: false })
  }

  const handleDoubleClick = (game: Game): void => {
    if (launchBlocked) {
      setNudgeId(game.id)
      setTimeout(() => setNudgeId(null), 420)
      props.onBlockedLaunch()
      return
    }
    onLaunch(game)
  }

  /**
   * Star ratings, available wherever a tile is.
   *
   * This is the personal score and it is the only ranking the right-click menu carries.
   * Tiers are a separate system with a page of its own, where the comparison between
   * games is what the ordering means — mixing the two into one menu made them read as
   * two names for the same thing, and gating stars behind the Played tab meant the score
   * could not be given at the moment anyone actually wanted to give it.
   */
  const ratingSubmenu = (targets: Game[]): MenuItem => {
    const current = targets.length === 1 ? targets[0].rating : null
    return {
      label: t('menu.rating'),
      submenu: [
        // Left open: the tick moves to the row you picked, which is the only confirmation
        // a rating gets, and changing your mind by one star is the common second click.
        ...[1, 2, 3, 4, 5].map((n) => ({
          label: '★'.repeat(n) + '☆'.repeat(5 - n),
          checked: current === n,
          keepOpen: true,
          onClick: () => targets.forEach((g) => onPatch(g.id, { rating: n }))
        })),
        { type: 'separator' as const },
        {
          label: t('menu.clearRating'),
          keepOpen: true,
          onClick: () => targets.forEach((g) => onPatch(g.id, { rating: null }))
        }
      ]
    }
  }

  /** Put every target into a brand-new group. */
  const groupTargets = (targets: Game[], name: string): void => {
    const id = `g-${Date.now().toString(36)}`
    onGroupsChange([...groups, { id, name, order: groups.length }])
    targets.forEach((g) => onPatch(g.id, { groupId: id }))
    setOpenGroup(id)
  }

  const gameMenu = (game: Game): MenuItem[] => {
    const items: MenuItem[] = []

    // An archive has exactly one thing worth doing to it, so that goes at the top where
    // a menu is read from rather than buried among entries that only matter once the
    // game is actually installed.
    if (game.kind === 'archive') {
      items.push({ label: t('menu.extract'), onClick: () => props.onExtract(game) }, { type: 'separator' })
    }

    // Wishlist / playing / played describe a relationship with a game that can be played. An
    // archive is a file waiting to be unpacked, so none of the three can be true of it
    // yet — and rating it would be judging something nobody has seen.
    if (game.kind === 'installed') {
      // All three stay open. They are one decision often taken in two clicks — finishing a
      // game is 玩过 on and 在玩 off — and because 想玩 excludes the other two, leaving the
      // menu up is also where you see that rule happen instead of guessing at it.
      items.push(
        { label: t('tab.wishlist'), checked: game.wishlist, keepOpen: true, onClick: () => onPatch(game.id, { wishlist: !game.wishlist }) },
        { label: t('tab.playing'), checked: game.playing, keepOpen: true, onClick: () => onPatch(game.id, { playing: !game.playing }) },
        { label: t('tab.played'), checked: game.played, keepOpen: true, onClick: () => onPatch(game.id, { played: !game.played }) },
        { type: 'separator' },
        ratingSubmenu([game]),
        { type: 'separator' }
      )
    }

    if (game.kind !== 'archive') {
      items.push(
        { label: t('menu.play'), onClick: () => onLaunch(game) },
        { label: t('menu.chooseExe'), onClick: () => props.onChooseExe(game) },
        // Sits next to the executable picker on purpose: they are the two answers to
        // the same question, and the picker is where a diagnosis usually sends you.
        {
          label: t('menu.diagnose'),
          disabled: game.missing,
          onClick: () => props.onDiagnose(game)
        }
      )
    }
    items.push(
      { label: t('menu.browse'), onClick: () => props.onBrowse(game) },
      { label: t('menu.setCover'), onClick: () => props.onSetCover(game.id) },
      ...(game.coverPath ? [{ label: t('menu.clearCover'), onClick: () => props.onClearCover(game.id) }] : []),
      { label: t('menu.rename'), onClick: () => props.onRename(game) },
      { label: t('menu.editTags'), onClick: () => props.onEditTags(game) },
      ...(props.onlineTags
        ? [
            { label: t('tags.computeOne'), onClick: () => props.onRetag([game]) },
            // Single game, so this one replaces a cover the user set: choosing this game
            // out of its own menu is not ambiguous about which cover is meant.
            ...(props.onlineCovers
              ? [{ label: t('menu.fetchCover'), onClick: () => props.onFetchCovers([game], 'single') }]
              : [])
          ]
        : []),
      { label: t('menu.matchWork'), onClick: () => props.onMatchWork(game) }
    )

    // Archives are already a file you can send; a missing folder has nothing to pack.
    if (game.kind !== 'archive') {
      items.push(
        {
          label: t('menu.share'),
          disabled: game.missing,
          onClick: () => props.onShare([game])
        },
        // An archive has never been played, so it has no saves to copy anywhere.
        {
          label: t('menu.backupSaves'),
          disabled: game.missing,
          onClick: () => props.onBackupSaves([game])
        }
      )
    }

    if (useGroups) {
      const targets = groups.filter((g) => g.id !== game.groupId && g.id !== ARCHIVE_GROUP_ID)
      if (game.groupId) {
        items.push({ label: t('menu.leaveGroup'), onClick: () => onPatch(game.id, { groupId: null }) })
      }
      if (targets.length > 0) {
        items.push({
          label: t('menu.moveToGroup'),
          submenu: targets.map((t) => ({
            label: t.name,
            onClick: () => onPatch(game.id, { groupId: t.id })
          }))
        })
      }
    }

    items.push(
      { type: 'separator' },
      { label: t('menu.removeTile'), onClick: () => props.onRemoveTile([game]) },
      { label: t('menu.uninstall'), danger: true, onClick: () => onUninstall([game]) }
    )
    return items
  }

  /**
   * The menu for a multi-tile selection. Status entries set rather than toggle: with a
   * mixed selection there is no state to flip, and "mark all of these as playing" is the
   * intent anyway.
   */
  const bulkMenu = (targets: Game[]): MenuItem[] => {
    const installed = targets.filter((g) => g.kind === 'installed')
    const archives = targets.filter((g) => g.kind === 'archive')
    const items: MenuItem[] = [
      { label: t('menu.selectedN', { n: targets.length }), disabled: true },
      { type: 'separator' }
    ]

    if (archives.length > 0) {
      items.push(
        { label: t('menu.extractN', { n: archives.length }), onClick: () => archives.forEach(props.onExtract) },
        { type: 'separator' }
      )
    }

    // Status and score only ever apply to the installed part of the selection; the
    // archives in it are not games yet.
    if (installed.length > 0) {
      items.push(
        { label: t('menu.markWishlist'), keepOpen: true, onClick: () => installed.forEach((g) => onPatch(g.id, { wishlist: true })) },
        { label: t('menu.markPlaying'), keepOpen: true, onClick: () => installed.forEach((g) => onPatch(g.id, { playing: true })) },
        { label: t('menu.markPlayed'), keepOpen: true, onClick: () => installed.forEach((g) => onPatch(g.id, { played: true })) },
        { type: 'separator' },
        ratingSubmenu(installed),
        { type: 'separator' }
      )
    }

    // Catalogue work over a selection. Both entries carry the count, because each one is
    // a run of paced network requests and the number is how long it will take.
    if (props.onlineTags && targets.length > 0) {
      items.push({ label: t('menu.fetchTagsN', { n: targets.length }), onClick: () => props.onRetag(targets) })
      if (props.onlineCovers) {
        items.push({
          label: t('menu.fetchCoverN', { n: targets.length }),
          onClick: () => props.onFetchCovers(targets, 'bulk')
        })
      }
      items.push({ type: 'separator' })
    }

    // One archive per game, so the count is worth saying out loud.
    const shareable = installed.filter((g) => !g.missing)
    if (shareable.length > 0) {
      items.push(
        { label: t('menu.shareN', { n: shareable.length }), onClick: () => props.onShare(shareable) },
        {
          label: t('menu.backupSavesN', { n: shareable.length }),
          onClick: () => props.onBackupSaves(shareable)
        },
        { type: 'separator' }
      )
    }

    if (useGroups) {
      items.push({
        label: t('menu.newGroupWith'),
        onClick: () => setGroupPrompt({ mode: 'create' })
      })
      const groupTargetList = groups.filter((g) => g.id !== ARCHIVE_GROUP_ID)
      if (groupTargetList.length > 0) {
        items.push({
          label: t('menu.moveToGroup'),
          submenu: groupTargetList.map((t) => ({
            label: t.name,
            onClick: () => targets.forEach((g) => onPatch(g.id, { groupId: t.id }))
          }))
        })
      }
      if (targets.some((g) => g.groupId)) {
        items.push({
          label: t('menu.leaveGroup'),
          onClick: () => targets.forEach((g) => onPatch(g.id, { groupId: null }))
        })
      }
      items.push({ type: 'separator' })
    }

    items.push(
      { label: t('menu.removeTileN', { n: targets.length }), onClick: () => props.onRemoveTile(targets) },
      { label: t('menu.uninstallN', { n: targets.length }), danger: true, onClick: () => onUninstall(targets) }
    )
    return items
  }

  const blankMenu = (): MenuItem[] => [
    { label: t('menu.newGroup'), onClick: () => setGroupPrompt({ mode: 'create' }) },
    { type: 'separator' },
    { label: t('menu.addGame'), onClick: props.onAddGame },
    { label: t('menu.addFolder'), onClick: props.onAddFolder },
    { label: t('top.refresh'), onClick: props.onRescan },
    { type: 'separator' },
    {
      label: t('top.sortTitle'),
      // Also left open: the grid rearranges behind the menu, so trying an order and
      // immediately trying another is the natural way to use this.
      submenu: SORT_KEYS.map((key) => ({
        label: t(`sort.${key}` as MessageKey),
        checked: sortKey === key,
        keepOpen: true,
        onClick: () => props.onSortChange(key)
      }))
    }
  ]

  const groupMenu = (group: Group): MenuItem[] => {
    if (group.builtin) {
      return [{ label: t('menu.builtinGroup'), disabled: true }]
    }
    return [
      { label: t('menu.renameGroup'), onClick: () => setGroupPrompt({ mode: 'rename', group }) },
      {
        label: t('menu.dissolveGroup'),
        danger: true,
        onClick: () => {
          games.filter((g) => g.groupId === group.id).forEach((g) => onPatch(g.id, { groupId: null }))
          onGroupsChange(groups.filter((g) => g.id !== group.id))
        }
      }
    ]
  }

  /** Dropping one tile on another merges them into a new group, iOS-style. */
  const mergeIntoGroup = (sourceIds: string[], targetId: string): void => {
    const sources = games.filter((g) => sourceIds.includes(g.id) && g.id !== targetId)
    const target = games.find((g) => g.id === targetId)
    if (sources.length === 0 || !target) return

    if (target.groupId) {
      sources.forEach((s) => onPatch(s.id, { groupId: target.groupId }))
      return
    }
    const id = `g-${Date.now().toString(36)}`
    onGroupsChange([...groups, { id, name: target.name, order: groups.length }])
    onPatch(target.id, { groupId: id })
    sources.forEach((s) => onPatch(s.id, { groupId: id }))
    setOpenGroup(id)
  }

  /**
   * Move every dragged tile to sit immediately before or after `targetId` within `list`,
   * keeping the order they appear in on screen.
   */
  const reorderWithin = (
    sourceIds: string[],
    targetId: string,
    list: Game[],
    position: 'before' | 'after'
  ): void => {
    const moving = list.filter((g) => sourceIds.includes(g.id)).map((g) => g.id)
    if (moving.length === 0) return
    const ids = list.map((g) => g.id).filter((id) => !moving.includes(id))
    let to = ids.indexOf(targetId)
    if (to < 0) return // dropped onto one of the tiles being dragged
    if (position === 'after') to += 1
    ids.splice(to, 0, ...moving)
    onReorder(ids)
  }

  /** Apply the drop the pointer landed on. Runs before the tile animates into place. */
  const commitDrop = (sourceIds: string[], landing: DropTarget | null): void => {
    if (sourceIds.length === 0 || landing === null) return

    if (landing.kind === 'group') {
      sourceIds.forEach((id) => onPatch(id, { groupId: landing.id }))
      return
    }
    if (sourceIds.includes(landing.id)) return

    const target = games.find((g) => g.id === landing.id)
    if (!target) return

    if (landing.hint === 'into') {
      if (useGroups) mergeIntoGroup(sourceIds, landing.id)
      return
    }

    // The list the target belongs to is the one being reordered — the main flow, or
    // the members of an open group.
    const list = target.groupId
      ? (groupsWithMembers.find((g) => g.group.id === target.groupId)?.members ?? ungrouped)
      : ungrouped

    if (useGroups) {
      // Dragging tiles out of their group into the main flow, or between groups.
      for (const id of sourceIds) {
        const source = games.find((g) => g.id === id)
        if (source && source.groupId !== target.groupId) onPatch(id, { groupId: target.groupId })
      }
    }
    // Every other ordering is computed, so an explicit drop means the user wants manual
    // order. The visible list is the base, so nothing appears to jump.
    if (sortKey !== 'manual') props.onSortChange('manual')
    reorderWithin(sourceIds, landing.id, list, landing.hint)
  }

  const drag = useTileDrag({
    scrollRef: pageRef,
    selectedIds,
    // Merging only applies between siblings in the grouped view.
    canGroup: (sourceId, targetId) => {
      if (!useGroups) return false
      const source = games.find((g) => g.id === sourceId)
      const target = games.find((g) => g.id === targetId)
      return !!source && !!target && source.groupId === target.groupId
    },
    onDrop: commitDrop
  })

  const dragging = useMemo(() => new Set(drag.dragIds), [drag.dragIds])

  /**
   * The order the grid would be in if the tile were dropped right now.
   *
   * Rendering this rather than the stored order is the whole trick behind tiles making
   * room: the dragged tile is pulled out and reinserted at the landing slot, which
   * pushes the tile it lands in front of — and everything after it — one cell along.
   * The FLIP pass then plays that shift as a slide instead of a jump, and the cell the
   * dragged tile now occupies, drawn as a hole, is the gap opening up.
   */
  const project = (list: Game[]): Game[] => {
    if (drag.dragIds.length === 0) return list
    // Nothing has been aimed at yet — the tile has only just been lifted, and the grid
    // should sit still until the pointer asks for room somewhere.
    const landing = drag.insertion
    if (landing === null || landing.kind === 'group') return list

    // Lifted tiles leave the list they were in, so the ranks close behind them.
    const rest = list.filter((g) => !dragging.has(g.id))
    const at = rest.findIndex((g) => g.id === landing.id)
    if (at < 0) return rest // the slot belongs to some other container

    // Keep the tiles in the order they appear on screen. Dragged in from another
    // container they are not in this list yet, so fall back to the grab order.
    const here = list.filter((g) => dragging.has(g.id))
    const moving =
      here.length > 0
        ? here
        : drag.dragIds.map((id) => games.find((g) => g.id === id)).filter((g): g is Game => !!g)

    const index = landing.hint === 'after' ? at + 1 : at
    return [...rest.slice(0, index), ...moving, ...rest.slice(index)]
  }

  const mainList = project(ungrouped)
  const openMembers = openGroup
    ? project(groupsWithMembers.find((g) => g.group.id === openGroup)?.members ?? [])
    : []

  /*
   * Replay every layout change as motion. The key is the rendered order itself, so any
   * reshuffle animates — a drag stepping tiles aside, but equally a sort change or a
   * game leaving the tab it was filtered into.
   */
  const layoutKey = mainList.map((g) => g.id).join(',')
  useFlip(gridRef, `${groupsWithMembers.length}:${layoutKey}`)
  useFlip(drawerRef, openMembers.map((g) => g.id).join(','))

  const renderTile = (game: Game): React.JSX.Element => (
    <Tile
      key={game.id}
      game={game}
      selected={selection.has(game.id)}
      playing={playing.has(game.id)}
      nudging={nudgeId === game.id}
      hole={dragging.has(game.id)}
      merging={
        drag.target?.kind === 'tile' &&
        drag.target.id === game.id &&
        drag.target.hint === 'into'
      }
      onPointerDown={(e) => drag.start(e, game.id)}
      onClick={(e) => handleSingleClick(game, e)}
      onDoubleClick={() => {
        cancelPendingClick()
        handleDoubleClick(game)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        cancelPendingClick()
        if (selection.has(game.id) && selectedGames.length > 1) {
          setMenu({ kind: 'bulk', x: e.clientX, y: e.clientY, targets: selectedGames })
          return
        }
        // Right-clicking outside the selection replaces it, the way file managers do.
        onSelectionChange([game.id])
        anchorRef.current = game.id
        setMenu({ kind: 'game', x: e.clientX, y: e.clientY, game })
      }}
    />
  )

  const selectionBytes = selectedGames.reduce((sum, g) => sum + (g.sizeBytes ?? 0), 0)

  return (
    <div
      className="page"
      ref={pageRef}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ kind: 'blank', x: e.clientX, y: e.clientY })
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onSelectionChange([])
      }}
    >

      <div className="grid" ref={gridRef} style={{ ['--tile' as string]: `${tileSize}px` }}>
        {groupsWithMembers.map(({ group, members }) => (
          <GroupTile
            key={group.id}
            group={group}
            members={members}
            open={openGroup === group.id}
            highlighted={drag.target?.kind === 'group' && drag.target.id === group.id}
            onToggle={() => setOpenGroup(openGroup === group.id ? null : group.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setMenu({ kind: 'group', x: e.clientX, y: e.clientY, group })
            }}
          />
        ))}

        {mainList.map((game) => renderTile(game))}
      </div>

      {openGroup &&
        groupsWithMembers
          .filter((g) => g.group.id === openGroup)
          .map(({ group, members }) => (
            <FolderWindow
              key={`win-${group.id}`}
              title={group.name}
              subtitle={t('desk.gamesInGroup', { n: members.length })}
              onClose={() => setOpenGroup(null)}
              actions={
                <button
                  type="button"
                  className="btn ghost"
                  style={{ padding: '5px 12px', fontSize: 12 }}
                  onClick={() => {
                    members.forEach((m) => onPatch(m.id, { groupId: null }))
                    onGroupsChange(groups.filter((g) => g.id !== group.id))
                    setOpenGroup(null)
                  }}
                  disabled={group.builtin}
                >
                  {t('menu.dissolveGroup')}
                </button>
              }
            >
              <div
                className="grid"
                ref={drawerRef}
                style={{ ['--tile' as string]: `${tileSize}px` }}
              >
                {openMembers.map((game) => renderTile(game))}
              </div>
            </FolderWindow>
          ))}

      {ungrouped.length === 0 && groupsWithMembers.length === 0 && (
        <div className="empty" style={{ minHeight: 320 }}>
          <h2>{t('desk.empty')}</h2>
          <p>
            {tab === 'all'
              ? t('desk.emptyAll')
              : t('desk.emptyTab')}
          </p>
        </div>
      )}

      {downloads.length > 0 && (
        <div className="download-strip">
          <div className="download-strip-head">
            <b>{t('desk.downloads')}</b>
            {downloads.some((d) => d.status === 'done' || d.status === 'failed') && (
              <button type="button" className="btn ghost small" onClick={onClearDownloads}>
                {t('desk.clearDone')}
              </button>
            )}
          </div>
          {downloads.map((d) => (
            <div className="bar-row" key={d.id}>
              <span className="legend-name" title={d.url}>
                {d.url.split('/').pop() || d.url}
              </span>
              <span className="bar-track">
                <span
                  className={`bar-fill${d.status === 'failed' ? ' failed' : ''}`}
                  // Nothing to show a proportion of when the downloader does not report
                  // one, so the track stays empty rather than inventing a position.
                  style={{ width: `${d.percent ?? (d.status === 'done' ? 100 : 0)}%` }}
                />
              </span>
              <span className="download-state" title={d.message ?? ''}>
                {t(DOWNLOAD_LABELS[d.status])}
                {d.percent !== null && d.status !== 'done' ? ` ${d.percent}%` : ''}
              </span>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => onCancelDownload(d.id)}
              >
                {d.status === 'downloading' || d.status === 'extracting'
                  ? t('desk.cancel')
                  : t('desk.remove')}
              </button>
            </div>
          ))}
          {downloads.map(
            (d) =>
              d.message && (
                <div className="download-message" key={`m-${d.id}`}>
                  {d.message}
                </div>
              )
          )}
        </div>
      )}

      {Object.keys(extractProgress).length > 0 && (
        <div style={{ marginTop: 20 }}>
          {Object.entries(extractProgress).map(([id, pct]) => {
            const game = games.find((g) => g.id === id)
            if (!game) return null
            return (
              <div className="bar-row" key={id}>
                <span className="legend-name">{t('desk.extracting', { name: game.name })}</span>
                <span className="bar-track">
                  <span className="bar-fill" style={{ width: `${pct}%` }} />
                </span>
                <span>{pct}%</span>
              </div>
            )
          })}
        </div>
      )}

      {selectedGames.length > 1 && (
        <div className="selection-bar">
          <span className="selection-count">{t('desk.selectedCount', { n: selectedGames.length })}</span>
          <span className="selection-size">{t('desk.selectedSize', { size: formatBytes(selectionBytes) })}</span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="btn ghost small"
            onClick={() => onSelectionChange(flatOrder)}
          >
            {t('desk.selectAll')}
          </button>
          <button
            type="button"
            className="btn ghost small"
            onClick={(e) =>
              setMenu({ kind: 'bulk', x: e.clientX, y: e.clientY - 8, targets: selectedGames })
            }
          >
            {t('desk.bulkActions')}
          </button>
          <button type="button" className="btn ghost small" onClick={() => onSelectionChange([])}>
            {t('desk.clearSelection')}
          </button>
        </div>
      )}

      {groupPrompt && (
        <PromptDialog
          title={t(groupPrompt.mode === 'create' ? 'menu.newGroup' : 'group.renameTitle')}
          description={t('group.promptNote')}
          initialValue={groupPrompt.mode === 'create' ? t('group.defaultName') : groupPrompt.group.name}
          placeholder={t('group.namePlaceholder')}
          onCancel={() => setGroupPrompt(null)}
          onConfirm={(name) => {
            if (groupPrompt.mode === 'create') {
              // Created from a multi-selection, the new group takes those games with it.
              if (selectedGames.length > 1) groupTargets(selectedGames, name)
              else
                onGroupsChange([
                  ...groups,
                  { id: `g-${Date.now().toString(36)}`, name, order: groups.length }
                ])
            } else {
              onGroupsChange(
                groups.map((g) => (g.id === groupPrompt.group.id ? { ...g, name } : g))
              )
            }
            setGroupPrompt(null)
          }}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          /*
           * Rebuilt from the live list on every render, not from what was captured when
           * the menu opened. `keepOpen` entries are the reason: an item that stays up
           * after setting a value has to show the value it just set, and `menu.game` is a
           * snapshot that stopped being true the moment it was clicked. A game that has
           * gone from the library in the meantime falls back to the snapshot rather than
           * emptying the menu under the pointer.
           */
          items={
            menu.kind === 'game'
              ? gameMenu(games.find((g) => g.id === menu.game.id) ?? menu.game)
              : menu.kind === 'bulk'
                ? bulkMenu(menu.targets.map((t) => games.find((g) => g.id === t.id) ?? t))
                : menu.kind === 'group'
                  ? groupMenu(menu.group)
                  : blankMenu()
          }
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

interface GroupTileProps {
  group: Group
  members: Game[]
  open: boolean
  highlighted: boolean
  onToggle: () => void
  onContextMenu: (e: React.MouseEvent) => void
}

function GroupTile({
  group,
  members,
  open,
  highlighted,
  onToggle,
  onContextMenu
}: GroupTileProps): React.JSX.Element {
  const t = useT()
  const shown = members.slice(0, 4)
  return (
    <button
      type="button"
      className={`tile group-tile${highlighted ? ' drop-target' : ''}${open ? ' selected' : ''}`}
      // The drag hook hit-tests against these attributes rather than listening for
      // dragover, so a group can take a drop without any handlers of its own.
      data-group-id={group.id}
      data-flip-id={`group-${group.id}`}
      onDoubleClick={onToggle}
      onContextMenu={onContextMenu}
      title={t('group.tileTitle', { name: group.name })}
    >
      <span className="group-count-chip">{members.length}</span>
      <span className="folder">
        <span className="folder-back" />
        <span className="folder-items">
          {shown.map((g) => (
            <span key={g.id}>
              <Artwork game={g} />
            </span>
          ))}
          {Array.from({ length: 4 - shown.length }, (_, i) => (
            <span className="empty-slot" key={`pad-${i}`} />
          ))}
        </span>
        <span className="folder-front" />
      </span>
      <span className="tile-label">
        <span className="tile-name">{group.name}</span>
        <span className="tile-size">{t('desk.gamesInGroup', { n: members.length })}</span>
      </span>
    </button>
  )
}
