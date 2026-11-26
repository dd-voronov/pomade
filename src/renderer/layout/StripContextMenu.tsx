// Pomade T-149 — the tab-strip EMPTY-SPACE context menu (right-click the end zone, right of the
// last tab). Renders through the shared ContextMenu primitive (T-158). It carries the SAME five
// actions as the Tab-Panel kebab (TerminalActions) but is a DELIBERATELY INDEPENDENT COPY, not
// generated from shared config with it (the Owner: the two will diverge later) — the item list is
// built here. Right-clicking a TAB still opens the per-tab menu; this menu is wired to the end
// zone only.

import type { Id, Project } from '@shared/types'
import { ContextMenu, type MenuItem } from '../components/ContextMenu'
import { useTabsStore } from '../stores/tabs-store'
import { useTerminalsStore } from '../stores/terminals-store'

export interface StripContextMenuProps {
  x: number
  y: number
  project: Project
  onClose: () => void
}

export function StripContextMenu(props: StripContextMenuProps): React.JSX.Element {
  const { x, y, project, onClose } = props
  const projectId: Id = project.id
  // Subscribed so "Reopen closed tab" is disabled the instant the stack empties.
  const canReopen = useTabsStore((s) => (s.reopenStackByProject[projectId] ?? []).length > 0)

  const items: MenuItem[] = [
    {
      label: 'Reopen closed tab',
      testId: 'strip-reopen-closed-tab',
      disabled: !canReopen,
      onSelect: () => void useTerminalsStore.getState().reopenClosedTab(projectId)
    },
    { separator: true },
    {
      label: 'Stop all terminals',
      testId: 'strip-stop-terminals',
      onSelect: () => {
        void useTerminalsStore.getState().stopAllTerminals(projectId)
      }
    },
    {
      label: 'Exit all agents',
      testId: 'strip-exit-agents',
      onSelect: () => {
        void useTerminalsStore.getState().exitAllAgents(projectId)
      }
    },
    {
      label: 'Close all docs',
      testId: 'strip-close-all-docs',
      onSelect: () => useTabsStore.getState().requestCloseAllDocs(projectId)
    },
    {
      label: 'Close saved docs',
      testId: 'strip-close-saved-docs',
      onSelect: () => useTabsStore.getState().closeSavedDocs(projectId)
    }
  ]

  return (
    <ContextMenu
      x={x}
      y={y}
      items={items}
      onClose={onClose}
      testId="strip-context-menu"
      scrimTestId="strip-menu-scrim"
    />
  )
}
