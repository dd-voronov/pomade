// Pomade — one root section of the file tree (E-026 / T-135 / T-144), extracted in T-159. A
// collapsible header line (scope diamond + path/name label + home chip + missing ⚠ + ⋯ kebab) and,
// when open and present, its children. The pinned project root is first with the "home" chip and no
// Rename/Unmount; a mount adds a scope-coloured diamond, an inline rename, and its own commands
// menu. Every data-testid, data-* attribute, and drop-zone behaviour is preserved verbatim.

import { classifyScope } from '@shared/paths'

import { ScopeMark } from '../../components/ScopeMark'
import { Tooltip } from '../../components/Tooltip'
import { InlineRenameInput } from '../../components/InlineRenameInput'
import { canDrop, scopeLine, splitRootLabel, tildeDisplay, type RootDesc } from './filetree-ops'
import { KebabIcon } from './icons'
import { TreeNodes, type TreeCtx } from './TreeNodes'
import styles from './FileTree.module.css'

export interface TreeSectionCtx extends TreeCtx {
  collapsedSet: Set<string>
  missingRoots: Set<string>
  rootRename: { id: string; value: string } | null
  flashRootId: string | null
  rootDrop: boolean
  rootPath: string
  /** E-047 — the project's in-scope folders (the scope classifier's second input). */
  scopeFolders: readonly string[]
  wsRoot: string | null
  activeProjectId: string
  setRootCollapsed: (projectId: string, rootId: string, collapsed: boolean) => void
  openMountMenu: (e: React.MouseEvent, root: RootDesc) => void
  setRootDrop: (v: boolean) => void
  setRootRename: (v: { id: string; value: string } | null) => void
  commitRootRename: () => void
  cancelRootRename: () => void
  openRootKebab: (e: React.MouseEvent, root: RootDesc) => void
}

export function TreeSection({ root, ctx }: { root: RootDesc; ctx: TreeSectionCtx }): React.JSX.Element {
  const isProject = root.kind === 'project'
  const rootCollapsed = ctx.collapsedSet.has(root.id)
  const missing = ctx.missingRoots.has(root.path)
  const scope = classifyScope(root.path, ctx.rootPath, ctx.scopeFolders)
  // An outside root's stored path is already absolute; show it home-relative (`~/…`). A
  // within-workspace root keeps its ws-relative label and gets wsRoot prepended for the abs form.
  const isOutside = root.path.startsWith('/')
  const absPath = isOutside
    ? root.path
    : root.path
      ? `${ctx.wsRoot ?? ''}/${root.path}`
      : ctx.wsRoot ?? ''
  // T-144 — a mount with a custom name shows the name (no dimmed parent prefix); everything else
  // shows the path label as before. The real path still rides on `absPath` (tooltip + Copy path).
  const hasCustomName = root.kind === 'mount' && !!root.name
  const { parent, leaf } = hasCustomName
    ? { parent: '', leaf: root.name as string }
    : splitRootLabel(isOutside ? tildeDisplay(root.path, window.pomade.env.home ?? undefined) : root.path)
  const isRenaming = ctx.rootRename?.id === root.id
  const isDrop = isProject ? ctx.rootDrop : ctx.dropTarget === root.path
  const headerClass = [
    styles.rootRow,
    isDrop ? styles.rowDrop : '',
    missing ? styles.rootMissing : '',
    ctx.flashRootId === root.id ? styles.rootFlash : ''
  ]
    .filter(Boolean)
    .join(' ')

  const onHeaderDragOver = (e: React.DragEvent): void => {
    const dest = root.path
    if (!ctx.dragPath || !canDrop(ctx.dragPath, dest)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (isProject) {
      if (!ctx.rootDrop) ctx.setRootDrop(true)
    } else if (ctx.dropTarget !== dest) ctx.setDropTarget(dest)
  }
  const onHeaderDragLeave = (): void => {
    if (isProject) ctx.setRootDrop(false)
    else ctx.setDropTarget((prev) => (prev === root.path ? null : prev))
  }
  const onHeaderDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const src = ctx.dragPath ?? e.dataTransfer.getData('text/plain')
    ctx.clearDrag()
    if (src) void ctx.moveTo(src, root.path)
  }

  return (
    <div className={styles.rootSection} key={root.id} data-root-section={root.id}>
      <div
        className={headerClass}
        data-testid={isProject ? 'filetree-root' : `tree-root-${root.id}`}
        data-root-id={root.id}
        data-root-path={root.path}
        data-missing={missing ? 'true' : undefined}
        title={absPath}
        onClick={() => ctx.setRootCollapsed(ctx.activeProjectId, root.id, !rootCollapsed)}
        onContextMenu={isProject ? (e) => ctx.openMenu(e, null) : (e) => ctx.openMountMenu(e, root)}
        onDragOver={onHeaderDragOver}
        onDragLeave={onHeaderDragLeave}
        onDrop={onHeaderDrop}
      >
        {/* E-026 (T-135) — collapse toggle is a DIAMOND (not a chevron): visually distinct from
            folder twisties, color-coded by scope (accent = home/in-project, orange =
            outside-project, red = outside-workspace), always visible. Hollow = collapsed, solid =
            expanded. Scope now lives here; the ⚠ triangle is problem-only (missing route). */}
        <span
          className={`${styles.rootDiamond} ${rootCollapsed ? '' : styles.rootDiamondSolid}`}
          data-scope={scope}
          data-collapsed={rootCollapsed ? 'true' : 'false'}
          aria-hidden="true"
          data-testid={`tree-root-diamond-${root.id}`}
        />
        {isRenaming ? (
          <InlineRenameInput
            className={styles.rootRenameInput}
            testId={`tree-root-rename-input-${root.id}`}
            value={ctx.rootRename!.value}
            placeholder={splitRootLabel(root.path).leaf}
            onChange={(value) => ctx.setRootRename({ id: root.id, value })}
            onCommit={ctx.commitRootRename}
            onCancel={ctx.cancelRootRename}
          />
        ) : (
          <span className={styles.rootPath} title={absPath} data-testid={`tree-root-label-${root.id}`}>
            {parent && <span className={styles.rootPathParent}>{parent}</span>}
            <span className={styles.rootPathLeaf}>{leaf}</span>
          </span>
        )}
        {isProject && (
          <span className={styles.homeChip} data-testid="tree-root-home-chip">
            home
          </span>
        )}
        {/* Problem-only, ALWAYS red: a missing route shows the ⚠ with a two-line design-system
            tooltip (scope, then existence). A healthy root shows NO triangle — scope is the
            diamond's job. */}
        {missing && (
          <ScopeMark
            tone="danger"
            lines={[root.inScope ? 'In project scope' : scopeLine(scope), "Path doesn't exist"]}
            testId={`tree-root-missing-${root.id}`}
          />
        )}
        {/* T-144 — the per-root actions now live in a ⋯ kebab (Copy path / Reveal / Rename /
            Unmount), built on the shared clamped menu so it never renders off-screen. The button
            stays in the reserved, hover-revealed strip → no layout shift on hover (T-135 rule). */}
        <span className={styles.rootActions}>
          <Tooltip lines={['More actions']}>
            <button
              type="button"
              className={styles.headerBtn}
              aria-label="Root actions"
              data-testid={isProject ? 'filetree-root-kebab' : `tree-root-kebab-${root.id}`}
              onClick={(e) => ctx.openRootKebab(e, root)}
            >
              <KebabIcon />
            </button>
          </Tooltip>
        </span>
      </div>
      {!rootCollapsed && !missing && (
        <div className={styles.rootChildren}>
          <TreeNodes dir={root.path} ctx={ctx} />
          {(ctx.childrenByPath[root.path]?.length ?? 0) === 0 && (
            <div className={styles.empty}>Empty folder</div>
          )}
        </div>
      )}
    </div>
  )
}
