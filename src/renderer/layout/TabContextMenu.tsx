// Pomade E-004 (T-020/T-021) — the tab context menu, built on the shared ContextMenu primitive
// (T-158). Items are scoped by tab kind: close variants for every tab; Copy path / Rename document
// for doc tabs; Rename tab / Change color for terminal, agent & app tabs; cross-project Copy/Move; the
// color picker + project pickers are submenus (clamped + left-flipping via the primitive).

import { TAB_COLORS, type Id, type Project, type Tab, type TabColor } from '@shared/types'
import { ContextMenu, type MenuItem } from '../components/ContextMenu'
import styles from './TabStrip.module.css'

export interface TabContextMenuProps {
  x: number
  y: number
  tab: Tab
  onClose: () => void
  // close variants (all kinds)
  onCloseTab: () => void
  onCloseOthers: () => void
  onCloseRight: () => void
  // T-061 — "Mark unread" (all kinds): set the red dot; clears on the next activation edge.
  onMarkUnread: () => void
  // doc-only
  onCopyPath: () => void
  onCopyFullPath: () => void
  onRenameDoc: () => void
  // terminal/agent-only
  onRenameTab: () => void
  onSetColor: (color: TabColor | undefined) => void
  // T-097 / T-103 — cross-project actions. `otherProjects` is the picker list, already ordered
  // (Workspace project first, then Projects panel order) with the CURRENT project excluded — the
  // menu just renders it. Empty ⇒ the cross-project items are not offered at all (a workspace
  // with a single project has nowhere to send a tab).
  //   • `onMoveToProject` — MOVE (all kinds): the tab leaves this project.
  //   • `onCopyToProject` — COPY (docs only): a second tab for the same file in the target.
  otherProjects: Project[]
  onMoveToProject: (projectId: Id) => void
  onCopyToProject: (projectId: Id) => void
  // T-103 — reveal this tab's path in the OS file manager (all kinds): a doc reveals its file,
  // a terminal/agent reveals its cwd. Works for in- and out-of-workspace paths.
  onRevealInFinder: () => void
  // T-150 — "Show tab details" (all kinds): open the raw-persisted-JSON admin/debug popup.
  onShowDetails: () => void
}

const COLOR_LABEL: Record<TabColor, string> = {
  red: 'Red',
  amber: 'Amber',
  green: 'Green',
  teal: 'Teal',
  blue: 'Blue',
  purple: 'Purple'
}

export function TabContextMenu(props: TabContextMenuProps): React.JSX.Element {
  const { x, y, tab, onClose, otherProjects } = props
  const isDoc = tab.kind === 'doc'
  const isVersionTab = tab.kind === 'doc' && !!tab.version
  const currentColor = tab.color

  // T-046 — color available on EVERY tab kind (docs included). Radio rows: role menuitemradio +
  // aria-checked, a leading swatch glyph.
  const colorItems: MenuItem[] = [
    {
      label: 'None',
      testId: 'menu-tab-color-none',
      checked: !currentColor,
      glyph: <span className={styles.ctxSwatchNone} />,
      onSelect: () => props.onSetColor(undefined)
    },
    ...TAB_COLORS.map<MenuItem>((c) => ({
      label: COLOR_LABEL[c],
      testId: `menu-tab-color-${c}`,
      checked: currentColor === c,
      glyph: <span className={styles.ctxSwatch} style={{ background: `var(--tab-tint-${c}-active)` }} />,
      onSelect: () => props.onSetColor(c)
    }))
  ]

  const projectItems = (
    onPick: (id: Id) => void,
    testPrefix: string
  ): MenuItem[] =>
    otherProjects.map((p) => ({
      label: p.name,
      testId: `${testPrefix}-${p.id}`,
      onSelect: () => onPick(p.id)
    }))

  const items: MenuItem[] = [
    { label: 'Close', testId: 'menu-tab-close', onSelect: props.onCloseTab },
    { label: 'Close others', testId: 'menu-tab-close-others', onSelect: props.onCloseOthers },
    { label: 'Close to the right', testId: 'menu-tab-close-right', onSelect: props.onCloseRight },
    { separator: true },
    // T-061 — Mark unread: the SAME red dot as the attention counter, on any tab kind.
    { label: 'Mark unread', testId: 'menu-tab-mark-unread', onSelect: props.onMarkUnread },
    { separator: true },
    isDoc
      ? {
          label: 'Rename document',
          testId: 'menu-tab-rename-doc',
          onSelect: props.onRenameDoc,
          // A version tab holds an old text of the document; renaming it would rename the file.
          ...(isVersionTab
            ? {
                disabled: true,
                tooltip: ["A version can't be renamed — rename the document from its own tab."],
                tooltipTestId: 'menu-tab-rename-doc-tooltip'
              }
            : {})
        }
      : { label: 'Rename tab', testId: 'menu-tab-rename', onSelect: props.onRenameTab },
    {
      label: 'Change color',
      testId: 'menu-tab-color',
      submenu: colorItems,
      submenuTestId: 'menu-tab-color-submenu'
    },
    // T-103 — explicit Copy vs Move as two distinct items. A doc offers BOTH "Copy to another
    // project" (a second tab for the same file — no filesystem copy, deduped by path in the
    // target) and "Move to another project" (the tab leaves this strip); a terminal/agent offers
    // "Move to another project" only (the live PTY rides along). The picker under each is the
    // SAME Projects-panel-ordered project list.
    ...(otherProjects.length > 0 && isDoc
      ? [
          {
            label: 'Copy to another project',
            testId: 'menu-tab-copy-to',
            submenu: projectItems(props.onCopyToProject, 'menu-tab-copy-to-project'),
            submenuTestId: 'menu-tab-copy-to-submenu'
          } satisfies MenuItem
        ]
      : []),
    ...(otherProjects.length > 0
      ? [
          {
            label: 'Move to another project',
            testId: 'menu-tab-move',
            submenu: projectItems(props.onMoveToProject, 'menu-tab-move-project'),
            submenuTestId: 'menu-tab-move-submenu'
          } satisfies MenuItem
        ]
      : []),
    // T-103 — Reveal in Finder: a doc reveals its file, a terminal/agent reveals its cwd.
    // Independent of the cross-project scope. App, commit, comparison, attached, conflict and branch tabs have no path of their own.
    ...(tab.kind === 'app' || tab.kind === 'commit' || tab.kind === 'compare' || tab.kind === 'attached' || tab.kind === 'conflict' || tab.kind === 'branch'
      ? []
      : [
          { separator: true } satisfies MenuItem,
          { label: 'Reveal in Finder', testId: 'menu-tab-reveal', onSelect: props.onRevealInFinder } satisfies MenuItem
        ]),
    ...(isDoc
      ? [
          { separator: true } satisfies MenuItem,
          { label: 'Copy path', testId: 'menu-tab-copy-path', onSelect: props.onCopyPath } satisfies MenuItem,
          {
            label: 'Copy full path',
            testId: 'menu-tab-copy-full-path',
            onSelect: props.onCopyFullPath
          } satisfies MenuItem
        ]
      : []),
    // T-150 — "Show tab details" (admin/debug): the LAST section, every tab kind.
    { separator: true },
    { label: 'Show tab details', testId: 'menu-tab-details', onSelect: props.onShowDetails }
  ]

  return (
    <ContextMenu
      x={x}
      y={y}
      items={items}
      onClose={onClose}
      testId="tab-context-menu"
      scrimTestId="tab-menu-scrim"
      data={{ 'data-kind': tab.kind }}
    />
  )
}
