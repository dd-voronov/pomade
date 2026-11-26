// Pomade — file tree (Wave 2a; visuals + ignored-items transparency: T-018/T-019). Re-roots
// at the active project's rootPath, renders the fs.tree lazily (one level per expand),
// opens files into doc tabs, and stays live via the fs.watch → EV.fsChanged debounced
// refresh. Context menu / header buttons create files & folders and reveal items in Finder.
//
// T-159 — this file is now the COMPOSITION + render layer only: the data cache/watch wiring lives
// in useTreeData, selection/anchor/ordering in useTreeSelection, the mutating clipboard/move/paste/
// trash/bulk flows in useTreeOps (filetree-ops.ts), and the JSX in GotoBox / TreeSection / TreeNodes
// / TreeContextMenu / MountPopup / TreeModals. FileTree wires them together and holds only the
// cross-cutting glue state (open menu, symlink popover, drag-and-drop, mount popup, root rename).

import { useCallback, useEffect, useMemo, useState } from 'react'

import type { FileNode } from '@shared/types'
import { PROJECT_ROOT_ID } from '@shared/types'
import { ancestorsWithin, isUnderFolder } from '@shared/paths'
import { buildAllProjects, useWorkspaceStore } from '../../stores/workspace-store'
import { useTabsStore } from '../../stores/tabs-store'
import { useMountsStore, validateMountPath } from '../../stores/mounts-store'
import { useProjectScopeFolders } from '../../stores/project-scope'
import { useAppSettingsStore } from '../../stores/app-settings-store'
import { useRevealStore } from '../../stores/reveal-store'
import { useNewProjectStore } from '../../stores/new-project-store'
import { useToast } from '../../hooks/useToast'
import { cleanIpcError } from '../../lib/ipc-errors'
import { openDocHistory } from '../git/history/doc-history-store'
import { openFileCompare } from '../git/history/history-actions'
import { NamePrompt } from './NamePrompt'
import { SymlinkPopover } from './SymlinkPopover'
import { useSettingsStore } from '../settings'
import {
  EMPTY_COLLAPSED,
  EMPTY_MOUNTS,
  parentOf,
  statD,
  toSel,
  useTreeOps,
  type MenuState,
  type RootDesc
} from './filetree-ops'
import { useTreeData } from './use-tree-data'
import { useTreeSelection } from './use-tree-selection'
import { GotoBox } from './GotoBox'
import { MountPopup } from './MountPopup'
import { CollisionModal, DeleteConfirmModal, OpenManyModal } from './TreeModals'
import { TreeSection, type TreeSectionCtx } from './TreeSection'
import { TreeContextMenu, type TreeMenuActions } from './TreeContextMenu'
import { TreeToolbar } from './TreeToolbar'
import styles from './FileTree.module.css'

export function FileTree(): React.JSX.Element | null {
  const projects = useWorkspaceStore((s) => s.projects)
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId)
  // T-027 — the absolute workspace root. A workspace switch keeps the active project the
  // Workspace project (rootPath ''), so rootPath alone doesn't change; keying
  // the reset + watch effects on wsRoot too forces a fresh tree + watcher for the new root.
  const wsRoot = useWorkspaceStore((s) => s.root)
  const project = useMemo(
    () => buildAllProjects(projects).find((p) => p.id === activeProjectId),
    [projects, activeProjectId]
  )
  const rootPath = project?.rootPath ?? ''

  // T-063 — preview-tab mode: a single tree click reuses ONE tab until it's committed.
  const previewTabMode = useAppSettingsStore((s) => s.previewTabMode)
  // E-016 — retarget open doc tabs when an in-app move/rename changes their on-disk path.
  const retargetPaths = useTabsStore((s) => s.retargetPaths)
  // E-012 (final) / P-021 — reveal requests from the symlink popover and the go-to-path row funnel
  // through this store; FileTree performs the reveal for its active project.
  const revealRequest = useRevealStore((s) => s.request)
  const requestReveal = useRevealStore((s) => s.reveal)
  const toast = useToast()

  // E-026 — mounted extra roots + collapse state for the active project (mounts-store).
  const mounts = useMountsStore((s) => s.mountsByProject[activeProjectId] ?? EMPTY_MOUNTS)
  const collapsedRoots = useMountsStore((s) => s.collapsedByProject[activeProjectId] ?? EMPTY_COLLAPSED)
  const hydrateMounts = useMountsStore((s) => s.hydrateProject)
  const addMount = useMountsStore((s) => s.addMount)
  const removeMount = useMountsStore((s) => s.removeMount)
  const renameMount = useMountsStore((s) => s.renameMount)
  const setMountInScope = useMountsStore((s) => s.setMountInScope)
  const scopeFolders = useProjectScopeFolders(activeProjectId)
  const setRootCollapsed = useMountsStore((s) => s.setRootCollapsed)

  // The ordered root list the tree renders: pinned project root first, then each mount.
  const roots = useMemo<RootDesc[]>(
    () => [
      { id: PROJECT_ROOT_ID, path: rootPath, kind: 'project' },
      ...mounts.map((m) => ({ id: m.id, path: m.path, kind: 'mount' as const, name: m.name, inScope: !!m.inScope }))
    ],
    [rootPath, mounts]
  )
  const collapsedSet = useMemo(() => new Set(collapsedRoots), [collapsedRoots])

  // T-026 — the Ignored items settings live in the unified Settings surface (File tree section).
  const openSettings = useSettingsStore((s) => s.openSettings)
  // T-182 — dispatch "Start new project from here": the Projects panel owns the create-project wizard.
  const startProjectFromFolder = useNewProjectStore((s) => s.startFromFolder)
  // T-049 — collapse to a thin rail (mirrors the Projects panel).
  const collapsed = useAppSettingsStore((s) => s.layout.fileTreeCollapsed)
  const toggleCollapsed = useAppSettingsStore((s) => s.toggleFileTreeCollapsed)

  // ── the extracted hooks ────────────────────────────────────────────────────────
  const data = useTreeData({ roots, rootPath, wsRoot, activeProjectId, mounts, hydrateMounts })
  const selection = useTreeSelection({
    childrenByPath: data.childrenByPath,
    expanded: data.expanded,
    roots,
    collapsedSet,
    rootPath,
    wsRoot
  })
  const ops = useTreeOps({
    activeProjectId,
    wsRoot,
    rootPath,
    previewTabMode,
    loadDir: data.loadDir,
    setExpanded: data.setExpanded,
    clearSelIfAffected: selection.clearSelIfAffected,
    toast,
    retargetPaths
  })

  // ── cross-cutting glue state ─────────────────────────────────────────────────────
  const [menu, setMenu] = useState<MenuState | null>(null)
  // E-012 (final) — the open symlink popover: the clicked link's rel path, whether it's a dir, and
  // the indicator's screen rect to anchor under.
  const [symlinkPop, setSymlinkPop] = useState<{ rel: string; isDir: boolean; rect: DOMRect } | null>(
    null
  )
  const [dragPath, setDragPath] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null) // folder path
  const [rootDrop, setRootDrop] = useState(false)
  // E-026 — the mount popup (add a root) + the raw path being typed.
  const [mountOpen, setMountOpen] = useState(false)
  const [mountInput, setMountInput] = useState('')
  // E-047 — the popup's Add to project scope box (off for every new popup).
  const [mountAddToScope, setMountAddToScope] = useState(false)
  // T-144 — inline rename of a MOUNT's header label (a cosmetic label, NOT a disk rename).
  const [rootRename, setRootRename] = useState<{ id: string; value: string } | null>(null)

  // E-026 — the live validation of what's typed in the mount popup (the popup's brain, T-129).
  const mountValidation = useMemo(
    () =>
      validateMountPath(mountInput, {
        projectRoot: rootPath,
        workspaceRoot: wsRoot ?? '',
        home: window.pomade.env.home ?? undefined,
        existingRootPaths: roots.map((r) => r.path)
      }),
    [mountInput, rootPath, wsRoot, roots]
  )

  // E-026 — commit the mount popup: a duplicate flashes the existing root, anything else (including
  // an outside-workspace absolute path, T-132) adds a mount and flashes the new header.
  const closeMountPopup = (): void => {
    setMountOpen(false)
    setMountInput('')
    setMountAddToScope(false)
  }
  const submitMount = (): void => {
    const v = mountValidation
    if (v.reason === 'empty') return
    if (v.reason === 'duplicate') {
      const dupe = roots.find((r) => r.path === v.canonicalPath)
      if (dupe) data.flashRoot(dupe.id)
      closeMountPopup()
      return
    }
    const id = addMount(activeProjectId, v.canonicalPath, v.outside, mountAddToScope)
    closeMountPopup()
    if (id) requestAnimationFrame(() => data.flashRoot(id))
  }

  const unmountRoot = useCallback(
    (mountId: string): void => {
      removeMount(activeProjectId, mountId)
    },
    [removeMount, activeProjectId]
  )

  // Expand every ancestor of `path`, select it, and scroll it into view, in the first root section
  // (in display order) that shows it — the project root, else a mount; a collapsed section opens.
  // A path no root shows is ignored. The root itself scrolls its header into view and flashes it.
  // `expand` also opens `path` when it is a folder.
  const revealPath = useCallback(
    async (path: string, expand = false): Promise<void> => {
      const root = roots.find((r) => isUnderFolder(path, r.path))
      if (!root) return
      if (collapsedSet.has(root.id)) setRootCollapsed(activeProjectId, root.id, false)
      if (path === root.path) {
        data.flashRoot(root.id)
        return
      }
      const ancestors = ancestorsWithin(path, root.path)
      // Load each ancestor dir so the target row is materialized, then expand them.
      for (const dir of ancestors) await data.loadDir(dir)
      await data.loadDir(parentOf(path))
      if (ancestors.length) {
        data.setExpanded((prev) => {
          const n = new Set(prev)
          ancestors.forEach((d) => n.add(d))
          return n
        })
      }
      // kind: stat follows the link, so a symlinked dir resolves to 'dir' (matches the tree).
      let kind: 'file' | 'dir' = 'file'
      try {
        kind = (await statD(path)).isFile ? 'file' : 'dir'
      } catch {
        /* keep 'file' — a vanished path just won't highlight */
      }
      if (expand && kind === 'dir') {
        await data.loadDir(path)
        data.setExpanded((prev) => new Set(prev).add(path))
      }
      selection.setSelection([{ path, kind }])
      selection.setAnchor({ path, kind })
      data.scrollToRow(path)
    },
    [roots, collapsedSet, setRootCollapsed, activeProjectId, data, selection]
  )

  // Perform a queued reveal request once this tree is rooted at the requested project (a
  // cross-project "Open in project…" switches the project first, then this fires).
  useEffect(() => {
    if (!revealRequest || revealRequest.projectId !== activeProjectId) return
    void revealPath(revealRequest.path, revealRequest.expand)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per request once the tree is rooted at its project; revealPath is rebuilt every render (data/selection), so keying on it would re-reveal on every render
  }, [revealRequest, activeProjectId, rootPath])

  // ── E-018: the click matrix ──────────────────────────────────────────────────
  // Plain click → select this row alone AND perform the row's normal action (open a file /
  // toggle a folder). Cmd+click → toggle this row. Shift+click → the contiguous range of VISIBLE
  // rows between the anchor and this row, replacing the selection. Cmd+Shift → the same range,
  // ADDED. Every modified click is selection-only: it never opens a doc, so it can never trigger
  // the T-063 preview-replace. The second click of a double-click only selects: the first click
  // already opened the file / toggled the folder, and `onRowDoubleClick` starts the rename.
  const onRowClick = (e: React.MouseEvent, node: FileNode): void => {
    const additive = e.metaKey || e.ctrlKey
    if (e.shiftKey) {
      const from = selection.anchor?.path ?? node.path
      const a = selection.visibleRows.findIndex((n) => n.path === from)
      const b = selection.visibleRows.findIndex((n) => n.path === node.path)
      if (b < 0) return
      // A vanished anchor degrades to a single-row selection rather than guessing a range.
      const range =
        a < 0
          ? [toSel(node)]
          : selection.visibleRows.slice(Math.min(a, b), Math.max(a, b) + 1).map(toSel)
      selection.setSelection((prev) => {
        if (!additive) return range
        const have = new Set(prev.map((s) => s.path))
        return [...prev, ...range.filter((s) => !have.has(s.path))]
      })
      // The anchor is NOT moved: a following Shift+click recomputes from the same origin.
      if (!selection.anchor) selection.setAnchor(toSel(node))
      return
    }
    if (additive) {
      const item = toSel(node)
      selection.setSelection((prev) =>
        prev.some((s) => s.path === item.path)
          ? prev.filter((s) => s.path !== item.path)
          : [...prev, item]
      )
      selection.setAnchor(item)
      return
    }
    selection.selectOnly(node)
    if (e.detail > 1) return
    if (node.kind === 'dir') data.toggle(node.path)
    else ops.openDoc(node)
  }

  // Double-click → the same Rename prompt as the context menu's Rename. A modified double-click
  // is selection-only, like a modified click.
  const onRowDoubleClick = (e: React.MouseEvent, node: FileNode): void => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) return
    e.preventDefault()
    ops.setRename({ path: node.path, name: node.name })
  }

  const openMenu = useCallback(
    (e: React.MouseEvent, target: FileNode | null): void => {
      e.preventDefault()
      e.stopPropagation()
      // E-018 — right-clicking INSIDE a multi-selection keeps it and opens the BULK menu; a
      // right-click anywhere else collapses the selection to that row (pre-E-018 behavior).
      if (target && selection.selection.length > 1 && selection.selectedPaths.has(target.path)) {
        setMenu({ x: e.clientX, y: e.clientY, target, bulk: selection.orderSelection(selection.selection) })
        return
      }
      if (target) selection.selectOnly(target)
      setMenu({ x: e.clientX, y: e.clientY, target, bulk: null })
    },
    [selection]
  )

  // E-026 — right-click on a MOUNT header → its own commands menu. The project root header falls
  // through to openMenu(e, null) instead (no Rename/Unmount).
  const openMountMenu = useCallback((e: React.MouseEvent, root: RootDesc): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      target: null,
      bulk: null,
      mount: { id: root.id, path: root.path, kind: root.kind, name: root.name, inScope: root.inScope }
    })
  }, [])

  // T-144 — the per-root ⋯ kebab: the SAME clamped commands menu, anchored just below-left of the
  // kebab button. `kind` gates Rename/Unmount to mounts.
  const openRootKebab = useCallback((e: React.MouseEvent, root: RootDesc): void => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    setMenu({
      x: r.left,
      y: r.bottom + 2,
      target: null,
      bulk: null,
      mount: { id: root.id, path: root.path, kind: root.kind, name: root.name, inScope: root.inScope }
    })
  }, [])

  // T-144 — the file-tree SECTION ⋯ kebab (ignored items… · show/hide ignored items · mount folder).
  const openSectionMenu = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    setMenu({ x: r.left, y: r.bottom + 2, target: null, bulk: null, section: true })
  }

  // T-144/T-179 — begin/commit/cancel the inline mount-rename. The single-shot Enter/blur guard
  // (the Enter/Escape path and the onBlur that follows must not both fire) lives in the shared
  // InlineRenameInput now; this is just its commit/cancel logic.
  const startRootRename = useCallback((root: RootDesc): void => {
    setRootRename({ id: root.id, value: root.name ?? '' })
  }, [])
  const cancelRootRename = useCallback((): void => setRootRename(null), [])
  const commitRootRename = useCallback((): void => {
    const r = rootRename
    setRootRename(null)
    if (!r) return
    // Empty (or whitespace) clears the name → the header reverts to the path.
    renameMount(activeProjectId, r.id, r.value.trim() || undefined)
  }, [rootRename, renameMount, activeProjectId])

  const reveal = useCallback(
    (node: FileNode | null): void => {
      const rel = node ? (node.kind === 'dir' ? node.path : parentOf(node.path)) : rootPath
      void window.pomade.app.openPath(rel)
    },
    [rootPath]
  )

  // E-026 (T-136) — reveal ANY root's own folder in Finder (the project root or a mount). An
  // absolute (outside) path goes through showItemInFolder; a ws-relative path through openPath.
  const revealRoot = useCallback((root: RootDesc): void => {
    if (root.path.startsWith('/')) void window.pomade.app.showItemInFolder(root.path)
    else void window.pomade.app.openPath(root.path)
  }, [])

  const clearDrag = useCallback((): void => {
    setDragPath(null)
    setDropTarget(null)
    setRootDrop(false)
  }, [])

  // E-018 — Escape clears the selection. Yields to anything with its own Escape meaning: an open
  // menu/dialog/popover (they close first) and text fields (the go-to-path row clears itself). This
  // is the tree's single window-keydown listener; GotoBox owns its own suggestion-popover Escape.
  useEffect(() => {
    if (selection.selection.length === 0) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (menu || ops.prompt || ops.rename || ops.collision || symlinkPop || ops.openMany || ops.deleteConfirm)
        return
      const el = document.activeElement
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement | null)?.isContentEditable) return
      selection.setSelection([])
      selection.setAnchor(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    selection,
    menu,
    ops.prompt,
    ops.rename,
    ops.collision,
    symlinkPop,
    ops.openMany,
    ops.deleteConfirm
  ])

  // Collapsed: only the icon strip (E-029) remains, and it carries the expand
  // button. The tree's state lives on in the hooks above. Placed after all hooks (rules-of-hooks).
  if (collapsed) return null

  // The render context handed to every root section + node row (created fresh each render, exactly
  // as the old inline renderers re-ran each render).
  const ctx: TreeSectionCtx = {
    childrenByPath: data.childrenByPath,
    expanded: data.expanded,
    dropTarget,
    selectedPaths: selection.selectedPaths,
    dragPath,
    selectionCount: selection.selection.length,
    onRowClick,
    onRowDoubleClick,
    openMenu,
    selectOnly: selection.selectOnly,
    setDragPath,
    setDropTarget,
    clearDrag,
    moveTo: ops.moveTo,
    setSymlinkPop,
    toggle: data.toggle,
    collapsedSet,
    missingRoots: data.missingRoots,
    rootRename,
    flashRootId: data.flashRootId,
    rootDrop,
    rootPath,
    scopeFolders,
    wsRoot,
    activeProjectId,
    setRootCollapsed,
    openMountMenu,
    setRootDrop,
    setRootRename,
    commitRootRename,
    cancelRootRename,
    openRootKebab
  }

  const menuActions: TreeMenuActions = {
    wsRoot,
    clip: ops.clip,
    showIgnored: data.showIgnored,
    setShowIgnored: data.setShowIgnored,
    openSettings,
    setMountInput,
    setMountOpen,
    copyToClipboard: ops.copyToClipboard,
    revealRoot,
    startRootRename,
    unmountRoot,
    setRootInScope: (mountId, inScope) => setMountInScope(activeProjectId, mountId, inScope),
    isMixedSelection: ops.isMixedSelection,
    filesOf: ops.filesOf,
    requestOpenInEditor: ops.requestOpenInEditor,
    showHistory: (path) => openDocHistory(activeProjectId, path),
    compareFiles: (left, right) => {
      openFileCompare(activeProjectId, left, right).catch((err: unknown) =>
        toast(`Could not compare: ${cleanIpcError(err)}`, 'error')
      )
    },
    setClip: ops.setClip,
    pasteBlocked: ops.pasteBlocked,
    targetDirFor: ops.targetDirFor,
    pasteInto: ops.pasteInto,
    requestDelete: ops.requestDelete,
    copySelectionPath: ops.copySelectionPath,
    bulkReveal: ops.bulkReveal,
    setPrompt: ops.setPrompt,
    startProjectFromFolder,
    setRename: ops.setRename,
    reveal
  }

  return (
    <aside className={styles.tree} aria-label="Files">
      <TreeToolbar
        selectionCount={selection.selection.length}
        onCollapse={() => void toggleCollapsed()}
        onNewFile={() => ops.setPrompt({ kind: 'file', dir: ops.targetDirFor(selection.primary) })}
        onNewFolder={() => ops.setPrompt({ kind: 'dir', dir: ops.targetDirFor(selection.primary) })}
        onSectionMenu={openSectionMenu}
      />

      <GotoBox
        rootPath={rootPath}
        wsRoot={wsRoot}
        activeProjectId={activeProjectId}
        requestReveal={requestReveal}
        openDoc={ops.openDoc}
      />

      {/* E-026 — the pinned project root plus each mount, stacked; each a collapsible section.
          Right-click / empty-space click on the body still targets the project root. */}
      <div
        className={styles.body}
        onContextMenu={(e) => openMenu(e, null)}
        onClick={(e) => {
          // A click on the empty tree body (not on a row) clears the selection, so the header
          // "New file"/"New folder" buttons fall back to the project root.
          if (e.target === e.currentTarget) selection.clearSelection()
        }}
        data-testid="tree-body"
      >
        {roots.map((r) => (
          <TreeSection key={r.id} root={r} ctx={ctx} />
        ))}
      </div>

      {menu && <TreeContextMenu menu={menu} actions={menuActions} onClose={() => setMenu(null)} />}

      {ops.prompt && (
        <NamePrompt
          title={ops.prompt.kind === 'file' ? 'New file' : 'New folder'}
          placeholder={ops.prompt.kind === 'file' ? 'name.md' : 'folder-name'}
          onSubmit={(name) => void ops.submitName(name)}
          onClose={() => ops.setPrompt(null)}
        />
      )}

      {ops.rename && (
        <NamePrompt
          title="Rename"
          initial={ops.rename.name}
          submitLabel="Rename"
          onSubmit={(name) => void ops.submitRename(name)}
          onClose={() => ops.setRename(null)}
        />
      )}

      {ops.openMany && (
        <OpenManyModal
          items={ops.openMany}
          onCancel={() => ops.setOpenMany(null)}
          onConfirm={(items) => {
            ops.setOpenMany(null)
            ops.openInEditor(items)
          }}
        />
      )}

      {ops.deleteConfirm && (
        <DeleteConfirmModal
          items={ops.deleteConfirm}
          onCancel={() => ops.setDeleteConfirm(null)}
          onConfirm={(items) => {
            ops.setDeleteConfirm(null)
            void ops.bulkTrash(items)
          }}
        />
      )}

      {symlinkPop && (
        <SymlinkPopover
          rel={symlinkPop.rel}
          isDir={symlinkPop.isDir}
          anchorRect={symlinkPop.rect}
          onClose={() => setSymlinkPop(null)}
        />
      )}

      {ops.collision && (
        <CollisionModal
          collision={ops.collision}
          onCancel={() => ops.setCollision(null)}
          onResolve={(c, how) => {
            ops.setCollision(null)
            void ops.performMove(c.src, c.dest, how)
          }}
        />
      )}

      {mountOpen && (
        <MountPopup
          input={mountInput}
          onInput={setMountInput}
          validation={mountValidation}
          addToScope={mountAddToScope}
          onAddToScope={setMountAddToScope}
          onSubmit={submitMount}
          onClose={closeMountPopup}
        />
      )}
    </aside>
  )
}
