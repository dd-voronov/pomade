// Pomade — the recursive file-tree row renderer (T-018 visuals; E-012/E-016/E-018 interactions),
// extracted from FileTree in T-159. Every row's testids, data-* attributes, drag-and-drop wiring,
// and the symlink popover trigger are preserved verbatim; all state and handlers arrive via `ctx`.
//
// E-036 — git marks: a status letter + name tint per changed row, a dot on folders with changes
// inside, gitignored rows dimmed, and GHOST rows for deleted files/folders in their old place
// (merged into the directory's children; never selectable, draggable or a drop target). All of it
// disappears with the tree's "Hide git status".

import type { FileNode } from '@shared/types'
import type { GhostEntry } from '@shared/git-state'

import { Tooltip } from '../../components/Tooltip'
import { useAppSettingsStore } from '../../stores/app-settings-store'
import { useGitStateStore, useGitStateSubscription } from '../git/git-state-store'
import { useGitUiStore } from '../git/git-ui-store'
import { MuteGlyph } from '../notices/notice-glyphs'
import { GIT_LETTER, GitFolderDot, GitLetter, ghostClasses, gitTintClass } from '../git/tree-marks'
import { canDrop } from './filetree-ops'
import { ChevronIcon, FileIcon, FolderIcon, SymlinkGlyph } from './icons'
import styles from './FileTree.module.css'

/** The unwatched-folder mark's tooltip and accessible name. */
const UNWATCHED_HINT = 'Not watched — changes inside show when you expand the folder again'

// The render context shared by the node rows (and extended by TreeSection for root headers).
export interface TreeCtx {
  childrenByPath: Record<string, FileNode[]>
  expanded: Set<string>
  dropTarget: string | null
  selectedPaths: Set<string>
  dragPath: string | null
  selectionCount: number
  onRowClick: (e: React.MouseEvent, node: FileNode) => void
  onRowDoubleClick: (e: React.MouseEvent, node: FileNode) => void
  openMenu: (e: React.MouseEvent, target: FileNode | null) => void
  selectOnly: (node: FileNode) => void
  setDragPath: (path: string | null) => void
  setDropTarget: React.Dispatch<React.SetStateAction<string | null>>
  clearDrag: () => void
  moveTo: (src: string, destDir: string) => Promise<void>
  setSymlinkPop: (v: { rel: string; isDir: boolean; rect: DOMRect } | null) => void
  toggle: (path: string) => void
}

type Row = { ghost: false; node: FileNode } | { ghost: true; entry: GhostEntry }

function rowOrder(a: Row, b: Row): number {
  const ka = a.ghost ? a.entry.kind : a.node.kind
  const kb = b.ghost ? b.entry.kind : b.node.kind
  if (ka !== kb) return ka === 'dir' ? -1 : 1
  return (a.ghost ? a.entry.name : a.node.name).localeCompare(b.ghost ? b.entry.name : b.node.name)
}

export function TreeNodes({ dir, ctx }: { dir: string; ctx: TreeCtx }): React.JSX.Element[] {
  useGitStateSubscription()
  const showGit = useAppSettingsStore((s) => s.showGitStatus)
  const git = useGitStateStore((s) => s.index)
  const openDeleted = useGitUiStore((s) => s.openDeleted)

  const nodes = ctx.childrenByPath[dir] ?? []
  let rows: Row[] = nodes.map((node) => ({ ghost: false, node }))
  if (showGit) {
    const onDisk = new Set(nodes.map((n) => n.name))
    const ghosts = git.ghostsIn(dir).filter((g) => !onDisk.has(g.name))
    if (ghosts.length > 0) rows = [...rows, ...ghosts.map((entry) => ({ ghost: true as const, entry }))].sort(rowOrder)
  }

  return rows.map((row) => (row.ghost ? renderGhost(row.entry) : renderNode(row.node)))

  function renderGhost(g: GhostEntry): React.JSX.Element {
    const isDir = g.kind === 'dir'
    const isOpen = isDir && ctx.expanded.has(g.path)
    return (
      <div key={`ghost:${g.path}`} className={styles.branch}>
        <div
          className={`${styles.row} ${ghostClasses.row}`}
          data-testid={`tree-ghost-${g.path}`}
          data-kind={g.kind}
          data-git-status="D"
          onClick={(e) => {
            e.stopPropagation()
            if (e.detail > 1) return
            if (isDir) ctx.toggle(g.path)
            else openDeleted(g.path)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          <span
            className={`${styles.twisty} ${isOpen ? styles.twistyOpen : ''}`}
            aria-hidden="true"
            data-testid="tree-chevron"
          >
            {isDir && <ChevronIcon />}
          </span>
          <span className={`${styles.icon} ${ghostClasses.icon}`} aria-hidden="true">
            {isDir ? <FolderIcon open={isOpen} /> : <FileIcon name={g.name} />}
          </span>
          <span className={`${styles.rowName} ${ghostClasses.name}`}>{g.name}</span>
          <GitLetter change={{ path: g.path, status: 'deleted' }} path={g.path} />
        </div>
        {isDir && isOpen && (
          <div className={styles.children}>
            <TreeNodes dir={g.path} ctx={ctx} />
          </div>
        )}
      </div>
    )
  }

  function renderNode(node: FileNode): React.JSX.Element {
    const isDir = node.kind === 'dir'
    const isOpen = ctx.expanded.has(node.path)
    const isDropTarget = isDir && ctx.dropTarget === node.path
    const isSelected = ctx.selectedPaths.has(node.path)
    const change = showGit ? git.statusOf(node.path) : null
    const gitIgnored = showGit && !change && git.isIgnored(node.path)
    const dot = showGit && isDir && !change && git.hasChangesInside(node.path)
    return (
      <div key={node.path} className={styles.branch}>
        <div
          className={`${styles.row} ${node.ignored || gitIgnored ? styles.rowIgnored : ''} ${
            isDropTarget ? styles.rowDrop : ''
          } ${isSelected ? styles.rowSelected : ''}`}
          data-testid={`tree-node-${node.path}`}
          data-kind={node.kind}
          data-ignored={node.ignored ? 'true' : undefined}
          data-git-ignored={gitIgnored ? 'true' : undefined}
          data-git-status={change ? GIT_LETTER[change.status] : undefined}
          data-symlink={node.symlink ? 'true' : undefined}
          data-unwatched={node.unwatched ? 'true' : undefined}
          data-selected={isSelected ? 'true' : undefined}
          draggable
          onClick={(e) => ctx.onRowClick(e, node)}
          onDoubleClick={(e) => ctx.onRowDoubleClick(e, node)}
          onContextMenu={(e) => ctx.openMenu(e, node)}
          onDragStart={(e) => {
            e.stopPropagation()
            // E-018 (locked decision 2) — multi-item DRAG is deferred: dragging a row out of a
            // multi-selection drags only THAT row and collapses the selection onto it, so what
            // moves is always what the drag ghost shows.
            if (ctx.selectionCount > 1) ctx.selectOnly(node)
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', node.path)
            ctx.setDragPath(node.path)
          }}
          onDragEnd={ctx.clearDrag}
          onDragOver={
            isDir
              ? (e) => {
                  if (!ctx.dragPath || !canDrop(ctx.dragPath, node.path)) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  if (ctx.dropTarget !== node.path) ctx.setDropTarget(node.path)
                }
              : undefined
          }
          onDragLeave={
            isDir
              ? () => {
                  ctx.setDropTarget((prev) => (prev === node.path ? null : prev))
                }
              : undefined
          }
          onDrop={
            isDir
              ? (e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  const src = ctx.dragPath ?? e.dataTransfer.getData('text/plain')
                  ctx.clearDrag()
                  if (src) void ctx.moveTo(src, node.path)
                }
              : undefined
          }
        >
          <span
            className={`${styles.twisty} ${isOpen ? styles.twistyOpen : ''}`}
            aria-hidden="true"
            data-testid="tree-chevron"
          >
            {isDir && <ChevronIcon />}
          </span>
          <span className={styles.icon} aria-hidden="true">
            {isDir ? <FolderIcon open={isOpen} /> : <FileIcon name={node.name} />}
          </span>
          <span className={`${styles.rowName} ${gitTintClass(change)}`}>{node.name}</span>
          {node.symlink && (
            <Tooltip lines={['Symbolic link — click to see target']}>
              <button
                type="button"
                className={`${styles.symlink} ${node.broken ? styles.symlinkBroken : ''}`}
                data-testid={`tree-symlink-${node.path}`}
                data-broken={node.broken ? 'true' : undefined}
                aria-label="Symbolic link — click to see target"
                onClick={(e) => {
                  e.stopPropagation()
                  ctx.setSymlinkPop({
                    rel: node.path,
                    isDir: node.kind === 'dir',
                    rect: e.currentTarget.getBoundingClientRect()
                  })
                }}
              >
                <SymlinkGlyph />
              </button>
            </Tooltip>
          )}
          {node.unwatched && (
            <Tooltip lines={[UNWATCHED_HINT]}>
              <span
                className={`${styles.unwatched} ${node.symlink ? styles.unwatchedAfterSymlink : ''}`}
                data-testid={`tree-unwatched-${node.path}`}
                role="img"
                aria-label={UNWATCHED_HINT}
              >
                <MuteGlyph />
              </span>
            </Tooltip>
          )}
          {change && <GitLetter change={change} path={node.path} afterSymlink={node.symlink || node.unwatched} />}
          {dot && <GitFolderDot path={node.path} afterSymlink={node.symlink || node.unwatched} />}
        </div>
        {isDir && isOpen && (
          <div className={styles.children}>
            <TreeNodes dir={node.path} ctx={ctx} />
          </div>
        )}
      </div>
    )
  }
}
