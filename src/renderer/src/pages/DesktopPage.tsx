import { useMemo, useState } from 'react'
import type { Game, Group, SortKey, TabKey, Tier } from '../../../shared/types'
import { ARCHIVE_GROUP_ID, SORT_META, TIERS, TIER_META } from '../../../shared/types'
import Artwork from '../components/Artwork'
import ContextMenu, { type MenuItem } from '../components/ContextMenu'
import FolderWindow from '../components/FolderWindow'
import PromptDialog from '../components/PromptDialog'
import Tile from '../components/Tile'

interface Props {
  games: Game[]
  groups: Group[]
  tab: TabKey
  sortKey: SortKey
  tileSize: number
  search: string
  selectedId: string | null
  onSelect: (id: string | null) => void
  onLaunch: (game: Game) => void
  onPatch: (id: string, patch: Partial<Game>) => void
  onUninstall: (game: Game) => void
  onSetCover: (id: string) => void
  onClearCover: (id: string) => void
  onBrowse: (game: Game) => void
  onExtract: (game: Game) => void
  onGroupsChange: (groups: Group[]) => void
  onReorder: (ids: string[]) => void
  onAddGame: () => void
  onAddFolder: () => void
  onRescan: () => void
  onSortChange: (key: SortKey) => void
  onRename: (game: Game) => void
  onBlockedLaunch: () => void
  extractProgress: Record<string, number>
}

type MenuState =
  | { kind: 'game'; x: number; y: number; game: Game }
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
    default:
      return list.sort((a, b) => a.order - b.order)
  }
}

export default function DesktopPage(props: Props): React.JSX.Element {
  const {
    games,
    groups,
    tab,
    sortKey,
    tileSize,
    search,
    selectedId,
    onSelect,
    onLaunch,
    onPatch,
    onUninstall,
    onGroupsChange,
    onReorder,
    extractProgress
  } = props

  const [menu, setMenu] = useState<MenuState>(null)
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropId, setDropId] = useState<string | null>(null)
  const [nudgeId, setNudgeId] = useState<string | null>(null)
  const [groupPrompt, setGroupPrompt] = useState<
    { mode: 'create' } | { mode: 'rename'; group: Group } | null
  >(null)

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return games.filter((g) => {
      if (q && !g.name.toLowerCase().includes(q)) return false
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
  }, [games, tab, search])

  // Groups only structure the "全部" view; the status tabs are already a filter.
  const useGroups = tab === 'all' && !search.trim()

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

  const handleDoubleClick = (game: Game): void => {
    if (launchBlocked) {
      setNudgeId(game.id)
      setTimeout(() => setNudgeId(null), 420)
      props.onBlockedLaunch()
      return
    }
    onLaunch(game)
  }

  const gameMenu = (game: Game): MenuItem[] => {
    const items: MenuItem[] = [
      { label: '想玩', checked: game.wishlist, onClick: () => onPatch(game.id, { wishlist: !game.wishlist }) },
      { label: '在玩', checked: game.playing, onClick: () => onPatch(game.id, { playing: !game.playing }) },
      { label: '玩过', checked: game.played, onClick: () => onPatch(game.id, { played: !game.played }) },
      { type: 'separator' },
      {
        label: '评价为',
        submenu: [
          ...TIERS.map((t: Tier) => ({
            label: TIER_META[t].label,
            checked: game.tier === t,
            onClick: () => onPatch(game.id, { tier: t })
          })),
          { type: 'separator' as const },
          { label: '清除评级', onClick: () => onPatch(game.id, { tier: null }) }
        ]
      },
      { type: 'separator' }
    ]

    if (game.kind === 'archive') {
      items.push({ label: '解压安装', onClick: () => props.onExtract(game) })
    } else {
      items.push({ label: '打开游戏', onClick: () => onLaunch(game) })
    }
    items.push(
      { label: '打开所在文件夹', onClick: () => props.onBrowse(game) },
      { label: '设置封面…', onClick: () => props.onSetCover(game.id) },
      ...(game.coverPath ? [{ label: '清除封面', onClick: () => props.onClearCover(game.id) }] : []),
      { label: '重命名…', onClick: () => props.onRename(game) }
    )

    if (useGroups) {
      const targets = groups.filter((g) => g.id !== game.groupId && g.id !== ARCHIVE_GROUP_ID)
      if (game.groupId) {
        items.push({ label: '移出分组', onClick: () => onPatch(game.id, { groupId: null }) })
      }
      if (targets.length > 0) {
        items.push({
          label: '移动到分组',
          submenu: targets.map((t) => ({
            label: t.name,
            onClick: () => onPatch(game.id, { groupId: t.id })
          }))
        })
      }
    }

    items.push({ type: 'separator' }, { label: '卸载…', danger: true, onClick: () => onUninstall(game) })
    return items
  }

  const blankMenu = (): MenuItem[] => [
    { label: '新建分组', onClick: () => setGroupPrompt({ mode: 'create' }) },
    { type: 'separator' },
    { label: '添加游戏…', onClick: props.onAddGame },
    { label: '添加扫描文件夹…', onClick: props.onAddFolder },
    { label: '重新扫描', onClick: props.onRescan },
    { type: 'separator' },
    {
      label: '排序方式',
      submenu: (Object.keys(SORT_META) as SortKey[]).map((key) => ({
        label: SORT_META[key],
        checked: sortKey === key,
        onClick: () => props.onSortChange(key)
      }))
    }
  ]

  const groupMenu = (group: Group): MenuItem[] => {
    if (group.builtin) {
      return [{ label: '内置分组，无法修改', disabled: true }]
    }
    return [
      { label: '重命名分组…', onClick: () => setGroupPrompt({ mode: 'rename', group }) },
      {
        label: '解散分组',
        danger: true,
        onClick: () => {
          games.filter((g) => g.groupId === group.id).forEach((g) => onPatch(g.id, { groupId: null }))
          onGroupsChange(groups.filter((g) => g.id !== group.id))
        }
      }
    ]
  }

  /** Dropping one tile on another merges them into a new group, iOS-style. */
  const mergeIntoGroup = (sourceId: string, targetId: string): void => {
    const source = games.find((g) => g.id === sourceId)
    const target = games.find((g) => g.id === targetId)
    if (!source || !target || source.id === target.id) return

    if (target.groupId) {
      onPatch(source.id, { groupId: target.groupId })
      return
    }
    const id = `g-${Date.now().toString(36)}`
    onGroupsChange([...groups, { id, name: target.name, order: groups.length }])
    onPatch(target.id, { groupId: id })
    onPatch(source.id, { groupId: id })
    setOpenGroup(id)
  }

  const reorderWithin = (sourceId: string, targetId: string, list: Game[]): void => {
    const ids = list.map((g) => g.id)
    const from = ids.indexOf(sourceId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return
    ids.splice(to, 0, ...ids.splice(from, 1))
    onReorder(ids)
  }

  const renderTile = (game: Game, list: Game[]): React.JSX.Element => (
    <Tile
      key={game.id}
      game={game}
      selected={selectedId === game.id}
      nudging={nudgeId === game.id}
      dragging={dragId === game.id}
      dropTarget={dropId === game.id}
      onClick={() => onSelect(selectedId === game.id ? null : game.id)}
      onDoubleClick={() => handleDoubleClick(game)}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setMenu({ kind: 'game', x: e.clientX, y: e.clientY, game })
      }}
      onDragStart={() => setDragId(game.id)}
      onDragEnd={() => {
        setDragId(null)
        setDropId(null)
      }}
      onDragOver={(e) => {
        e.preventDefault()
        if (dragId && dragId !== game.id) setDropId(game.id)
      }}
      onDragLeave={() => setDropId((cur) => (cur === game.id ? null : cur))}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        const sourceId = dragId
        setDropId(null)
        setDragId(null)
        if (!sourceId || sourceId === game.id) return
        const source = games.find((g) => g.id === sourceId)
        if (!source) return
        // Same container → reorder. Different container → merge into a group.
        if (useGroups && source.groupId === game.groupId) {
          if (sortKey === 'manual') reorderWithin(sourceId, game.id, list)
          else mergeIntoGroup(sourceId, game.id)
        } else if (useGroups) {
          mergeIntoGroup(sourceId, game.id)
        } else if (sortKey === 'manual') {
          reorderWithin(sourceId, game.id, list)
        }
      }}
    />
  )

  return (
    <div
      className="page"
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ kind: 'blank', x: e.clientX, y: e.clientY })
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onSelect(null)
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => {
        // Dropping on empty desktop pulls a tile out of its group.
        if (dragId) onPatch(dragId, { groupId: null })
        setDragId(null)
        setDropId(null)
      }}
    >
      <div className="grid" style={{ ['--tile' as string]: `${tileSize}px` }}>
        {groupsWithMembers.map(({ group, members }) => (
          <GroupTile
            key={group.id}
            group={group}
            members={members}
            open={openGroup === group.id}
            highlighted={dropId === group.id}
            onToggle={() => setOpenGroup(openGroup === group.id ? null : group.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setMenu({ kind: 'group', x: e.clientX, y: e.clientY, group })
            }}
            onDragOver={(e) => {
              e.preventDefault()
              if (dragId) setDropId(group.id)
            }}
            onDragLeave={() => setDropId((cur) => (cur === group.id ? null : cur))}
            onDrop={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (dragId) onPatch(dragId, { groupId: group.id })
              setDragId(null)
              setDropId(null)
            }}
          />
        ))}

        {ungrouped.map((game) => renderTile(game, ungrouped))}

      </div>

      {openGroup &&
        groupsWithMembers
          .filter((g) => g.group.id === openGroup)
          .map(({ group, members }) => (
            <FolderWindow
              key={`win-${group.id}`}
              title={group.name}
              subtitle={`${members.length} 个游戏`}
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
                  解散分组
                </button>
              }
            >
              <div className="grid" style={{ ['--tile' as string]: `${tileSize}px` }}>
                {members.map((game) => renderTile(game, members))}
              </div>
            </FolderWindow>
          ))}

      {ungrouped.length === 0 && groupsWithMembers.length === 0 && (
        <div className="empty" style={{ minHeight: 320 }}>
          <h2>这里还没有游戏</h2>
          <p>
            {tab === 'all'
              ? '右键空白处可以添加游戏或扫描文件夹。'
              : '在「全部」里右键磁贴，把游戏标记到这个清单。'}
          </p>
        </div>
      )}

      {Object.keys(extractProgress).length > 0 && (
        <div style={{ marginTop: 20 }}>
          {Object.entries(extractProgress).map(([id, pct]) => {
            const game = games.find((g) => g.id === id)
            if (!game) return null
            return (
              <div className="bar-row" key={id}>
                <span className="legend-name">解压 {game.name}</span>
                <span className="bar-track">
                  <span className="bar-fill" style={{ width: `${pct}%` }} />
                </span>
                <span>{pct}%</span>
              </div>
            )
          })}
        </div>
      )}

      {groupPrompt && (
        <PromptDialog
          title={groupPrompt.mode === 'create' ? '新建分组' : '重命名分组'}
          description="分组只影响启动器里的排列，不会移动磁盘上的任何文件。"
          initialValue={groupPrompt.mode === 'create' ? '新分组' : groupPrompt.group.name}
          placeholder="分组名称"
          onCancel={() => setGroupPrompt(null)}
          onConfirm={(name) => {
            if (groupPrompt.mode === 'create') {
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
          items={
            menu.kind === 'game'
              ? gameMenu(menu.game)
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
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent) => void
}

function GroupTile({
  group,
  members,
  open,
  highlighted,
  onToggle,
  onContextMenu,
  onDragOver,
  onDragLeave,
  onDrop
}: GroupTileProps): React.JSX.Element {
  const shown = members.slice(0, 4)
  return (
    <button
      type="button"
      className={`tile group-tile${highlighted ? ' drop-target' : ''}${open ? ' selected' : ''}`}
      onDoubleClick={onToggle}
      onContextMenu={onContextMenu}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      title={`${group.name} — 双击打开`}
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
        <span className="tile-size">{members.length} 个游戏</span>
      </span>
    </button>
  )
}
