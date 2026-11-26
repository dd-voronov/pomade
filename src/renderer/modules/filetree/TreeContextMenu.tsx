// Pomade — the file-tree context menu (T-158 items-array over the shared ContextMenu primitive;
// extracted from FileTree in T-159). Builds the four variants (section ⋯ / root header / bulk
// selection / single node) as one MenuItem[]. Every testid, disabled/aria-disabled state, native
// title, aria-pressed, header, and separator from the original forked markup is preserved verbatim.

import type { FileNode } from '@shared/types'

import { ContextMenu, type MenuItem } from '../../components/ContextMenu'
import { useAppSettingsStore } from '../../stores/app-settings-store'
import type { SettingsSectionId } from '../settings'
import {
  isOutside,
  SCOPE_ADD_TIP,
  SCOPE_REMOVE_TIP,
  toSel,
  type ClipState,
  type MenuState,
  type RootDesc,
  type SelItem
} from './filetree-ops'

export interface TreeMenuActions {
  wsRoot: string | null
  clip: ClipState | null
  showIgnored: boolean
  setShowIgnored: React.Dispatch<React.SetStateAction<boolean>>
  openSettings: (section?: SettingsSectionId) => void
  setMountInput: (v: string) => void
  setMountOpen: (v: boolean) => void
  copyToClipboard: (text: string, label: string) => void
  revealRoot: (root: RootDesc) => void
  startRootRename: (root: RootDesc) => void
  unmountRoot: (mountId: string) => void
  /** E-047 — put a mount in the project's scope or take it out. */
  setRootInScope: (mountId: string, inScope: boolean) => void
  isMixedSelection: (items: SelItem[] | null) => boolean
  filesOf: (items: SelItem[]) => SelItem[]
  requestOpenInEditor: (items: SelItem[]) => void
  /** E-038 — open the doc with its History panel showing. */
  showHistory: (path: string) => void
  /** E-038 — a comparison tab for two files. */
  compareFiles: (left: string, right: string) => void
  setClip: React.Dispatch<React.SetStateAction<ClipState | null>>
  pasteBlocked: (target: FileNode | null) => boolean
  targetDirFor: (node: { kind: 'file' | 'dir'; path: string } | null) => string
  pasteInto: (dir: string) => Promise<void>
  requestDelete: (items: SelItem[]) => void
  copySelectionPath: (items: SelItem[], absolute: boolean) => void
  bulkReveal: (items: SelItem[]) => void
  setPrompt: (v: { kind: 'file' | 'dir'; dir: string }) => void
  startProjectFromFolder: (path: string) => void
  setRename: (v: { path: string; name: string }) => void
  reveal: (node: FileNode | null) => void
}

export function buildTreeMenu(m: MenuState, a: TreeMenuActions): MenuItem[] {
  // T-144 — the file-tree SECTION ⋯ kebab menu.
  if (m.section) {
    const { showGitStatus, setShowGitStatus } = useAppSettingsStore.getState()
    return [
      {
        label: 'Ignored items…',
        testId: 'menu-ignored-items',
        onSelect: () => a.openSettings('filetree')
      },
      {
        // E-036 — git marks in the tree (letters, tints, folder dots, ghost rows); remembered.
        label: showGitStatus ? 'Hide git status' : 'Show git status',
        testId: 'menu-toggle-git-status',
        pressed: showGitStatus,
        onSelect: () => void setShowGitStatus(!showGitStatus)
      },
      {
        label: a.showIgnored ? 'Hide ignored items' : 'Show ignored items',
        testId: 'menu-toggle-ignored',
        pressed: a.showIgnored,
        onSelect: () => a.setShowIgnored((v) => !v)
      },
      { separator: true },
      {
        label: 'Mount new folder…',
        testId: 'menu-mount-folder',
        onSelect: () => {
          a.setMountInput('')
          a.setMountOpen(true)
        }
      }
    ]
  }

  // E-026 / T-144 — a ROOT header's own commands menu.
  if (m.mount) {
    const mnt = m.mount
    return [
      {
        label: 'Copy path',
        testId: 'menu-copy-path',
        onSelect: () => a.copyToClipboard(mnt.path, 'Copied path')
      },
      {
        label: 'Copy full path',
        testId: 'menu-copy-full-path',
        onSelect: () => {
          // An outside mount's path is already absolute; a within-workspace one needs wsRoot.
          const p = mnt.path
          const abs = p.startsWith('/') ? p : p ? `${a.wsRoot ?? ''}/${p}` : a.wsRoot ?? ''
          a.copyToClipboard(abs, 'Copied full path')
        }
      },
      { separator: true },
      {
        label: 'Reveal in Finder',
        testId: 'menu-reveal',
        onSelect: () => a.revealRoot({ id: mnt.id, path: mnt.path, kind: mnt.kind })
      },
      ...(mnt.kind === 'mount'
        ? [
            { separator: true } satisfies MenuItem,
            {
              label: mnt.inScope ? 'Remove from project scope' : 'Add to project scope',
              testId: 'menu-mount-scope',
              data: { 'data-in-scope': mnt.inScope ? 'true' : 'false' },
              tooltip: [mnt.inScope ? SCOPE_REMOVE_TIP : SCOPE_ADD_TIP],
              onSelect: () => a.setRootInScope(mnt.id, !mnt.inScope)
            } satisfies MenuItem,
            {
              label: 'Rename',
              testId: 'menu-rename-mount',
              onSelect: () => a.startRootRename({ id: mnt.id, path: mnt.path, kind: mnt.kind, name: mnt.name })
            } satisfies MenuItem,
            {
              label: 'Unmount',
              testId: 'menu-unmount',
              onSelect: () => a.unmountRoot(mnt.id)
            } satisfies MenuItem
          ]
        : [])
    ]
  }

  // E-018 — BULK variant: the whole multi-selection is the target of every action.
  if (m.bulk) {
    const bulk = m.bulk
    const mixed = a.isMixedSelection(bulk)
    const mixedTitle = mixed ? 'Selection mixes inside and outside the workspace' : undefined
    return [
      { header: `${bulk.length} items selected`, headerTestId: 'menu-bulk-count' },
      ...(a.filesOf(bulk).length > 0
        ? [
            {
              label: 'Open in editor',
              testId: 'menu-open-editor',
              onSelect: () => a.requestOpenInEditor(bulk)
            } satisfies MenuItem,
            { separator: true } satisfies MenuItem
          ]
        : []),
      ...(bulk.length === 2 && a.filesOf(bulk).length === 2
        ? [
            {
              label: 'Compare',
              testId: 'menu-compare',
              onSelect: () => a.compareFiles(bulk[0].path, bulk[1].path)
            } satisfies MenuItem,
            { separator: true } satisfies MenuItem
          ]
        : []),
      {
        label: 'Cut',
        testId: 'menu-cut',
        disabled: mixed,
        title: mixedTitle,
        onSelect: () => a.setClip({ paths: bulk.map((i) => i.path), op: 'cut' })
      },
      {
        label: 'Copy',
        testId: 'menu-copy',
        disabled: mixed,
        title: mixedTitle,
        onSelect: () => a.setClip({ paths: bulk.map((i) => i.path), op: 'copy' })
      },
      {
        label: 'Paste',
        testId: 'menu-paste',
        disabled: a.pasteBlocked(m.target) || mixed,
        title: !a.pasteBlocked(m.target) || !a.clip ? undefined : "Can't paste across the workspace boundary",
        onSelect: () => void a.pasteInto(a.targetDirFor(m.target))
      },
      { separator: true },
      {
        label: 'Move to Trash',
        testId: 'menu-delete',
        disabled: mixed,
        title: mixedTitle,
        onSelect: () => a.requestDelete(bulk)
      },
      { separator: true },
      {
        label: 'Copy path',
        testId: 'menu-copy-path',
        onSelect: () => a.copySelectionPath(bulk, false)
      },
      {
        label: 'Copy full path',
        testId: 'menu-copy-full-path',
        onSelect: () => a.copySelectionPath(bulk, true)
      },
      { separator: true },
      { label: 'Reveal in Finder', testId: 'menu-reveal', onSelect: () => a.bulkReveal(bulk) }
    ]
  }

  // Single-node / root / empty-body variant.
  const target = m.target
  const items: MenuItem[] = []
  // E-018 — "Open in editor" also joins the SINGLE-file menu.
  if (target?.kind === 'file') {
    items.push(
      {
        label: 'Open in editor',
        testId: 'menu-open-editor',
        onSelect: () => a.requestOpenInEditor([toSel(target)])
      },
      {
        label: 'Show history',
        testId: 'menu-show-history',
        onSelect: () => a.showHistory(target.path)
      },
      { separator: true }
    )
  }
  items.push(
    {
      label: 'New file',
      testId: 'menu-new-file',
      onSelect: () => a.setPrompt({ kind: 'file', dir: a.targetDirFor(target) })
    },
    {
      label: 'New folder',
      testId: 'menu-new-folder',
      onSelect: () => a.setPrompt({ kind: 'dir', dir: a.targetDirFor(target) })
    },
    { separator: true }
  )
  // T-182 — start a project rooted at this folder. Folder-only; an OUTSIDE-workspace folder is
  // grayed + disabled with a design-system tooltip; within-workspace folders are enabled.
  if (target?.kind === 'dir') {
    items.push(
      isOutside(target.path)
        ? {
            label: 'Start new project from here',
            testId: 'menu-new-project-here',
            disabled: true,
            tooltip: ['This folder is outside your workspace']
          }
        : {
            label: 'Start new project from here',
            testId: 'menu-new-project-here',
            onSelect: () => a.startProjectFromFolder(target.path)
          },
      { separator: true }
    )
  }
  if (target) {
    items.push(
      {
        label: 'Cut',
        testId: 'menu-cut',
        onSelect: () => a.setClip({ paths: [target.path], op: 'cut' })
      },
      {
        label: 'Copy',
        testId: 'menu-copy',
        onSelect: () => a.setClip({ paths: [target.path], op: 'copy' })
      }
    )
  }
  items.push({
    label: 'Paste',
    testId: 'menu-paste',
    disabled: a.pasteBlocked(target),
    title: !a.clip || !a.pasteBlocked(target) ? undefined : "Can't paste across the workspace boundary",
    onSelect: () => void a.pasteInto(a.targetDirFor(target))
  })
  if (target) {
    items.push(
      { separator: true },
      {
        label: 'Rename',
        testId: 'menu-rename',
        onSelect: () => a.setRename({ path: target.path, name: target.name })
      },
      {
        label: 'Move to Trash',
        testId: 'menu-delete',
        onSelect: () => a.requestDelete([toSel(target)])
      },
      { separator: true },
      {
        label: 'Copy path',
        testId: 'menu-copy-path',
        onSelect: () => a.copyToClipboard(target.path, 'Copied path')
      },
      {
        label: 'Copy full path',
        testId: 'menu-copy-full-path',
        onSelect: () => {
          // An outside node's path is already absolute; only an in-workspace (relative) path
          // needs wsRoot prepended.
          const full = isOutside(target.path)
            ? target.path
            : a.wsRoot
              ? `${a.wsRoot}/${target.path}`
              : target.path
          a.copyToClipboard(full, 'Copied full path')
        }
      }
    )
  }
  items.push(
    { separator: true },
    { label: 'Reveal in Finder', testId: 'menu-reveal', onSelect: () => a.reveal(target) }
  )
  return items
}

export function TreeContextMenu({
  menu,
  actions,
  onClose
}: {
  menu: MenuState
  actions: TreeMenuActions
  onClose: () => void
}): React.JSX.Element {
  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      onClose={onClose}
      testId="tree-menu"
      scrimTestId="tree-menu-scrim"
      items={buildTreeMenu(menu, actions)}
      data={{
        'data-bulk': menu.bulk ? 'true' : undefined,
        'data-mount': menu.mount ? 'true' : undefined,
        'data-section': menu.section ? 'true' : undefined
      }}
    />
  )
}
