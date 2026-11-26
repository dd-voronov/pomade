// Pomade — PaneHost. THE invariant: it renders the panes of EVERY project and hides
// inactive ones with CSS (display:none). Panes are NEVER unmounted on project switch or
// tab switch — switching is purely a visibility flip driven by activeProjectId /
// activeTabByProject. This keeps terminal/editor instances (and later real PTYs' UI) alive.
//
// A pane is visible iff its project is the active project AND its tab is that project's
// active tab. Everything else stays mounted in the DOM with display:none.
//
// T-097 — the pane list is FLAT (one PaneSlot per tab of any project, keyed by tab id) and a
// pane's project is DATA (`data-project-id`), not DOM structure. It used to be nested in a
// per-project wrapper div, which made "move this tab to another project" unmount the pane out
// of one wrapper and mount a fresh one in the other — remounting xterm and losing everything
// the ring buffer doesn't hold. Flat + keyed by tab id, a projectId change is a prop change:
// React keeps the very same DOM node (the terminal keeps its scrollback, its fit, its PTY).
// The host carries `data-active-project` so the active project is still readable from the DOM.

import { memo } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useWorkspaceStore } from '../stores/workspace-store'
import { useTabsStore } from '../stores/tabs-store'
import { getPane } from '../panes/registry'
import { AppOverlay } from '../modules/apps/AppOverlay'
import { BulkCloseConfirm } from '../modules/terminal/BulkCloseConfirm'
import type { Id } from '@shared/types'
import styles from './PaneHost.module.css'

// T-181 — a per-tab identity string, PROJECT_ID + TAB_ID. Carrying identities as primitives (not
// tab objects, not {id, projectId} object literals) means an array of them compares correctly
// under useShallow's per-element Object.is: two equal strings ARE the same value in JS, so
// nothing needs a custom equality function to see that the list of open panes hasn't changed.
const KEY_SEP = ' '
function paneKey(projectId: Id, tabId: Id): string {
  return `${projectId}${KEY_SEP}${tabId}`
}
function splitPaneKey(key: string): [Id, Id] {
  const i = key.indexOf(KEY_SEP)
  return [key.slice(0, i), key.slice(i + 1)]
}

// T-181 — PaneSlot subscribes to its OWN tab directly (by id, from its own project's array)
// instead of receiving the tab object as a prop from PaneHost. `.find` returns the SAME object
// reference for every tab that didn't change (tabsByProject's per-tab map only replaces the
// mutated tab's object — see tabs-store.updateTab), so this selector is stable across a
// high-frequency field mutation (cwd, lastCommand, ...) on any OTHER tab, in this project or any
// other — and `memo` below turns that stability into an actual skipped render: PaneHost passes
// the same tabId/projectId/visible primitives on every unrelated store change, so React bails
// out of this component (and everything it renders — the real terminal/editor pane) without
// even calling it.
const PaneSlot = memo(function PaneSlot({
  tabId,
  projectId,
  visible
}: {
  tabId: Id
  projectId: Id
  visible: boolean
}): React.JSX.Element | null {
  const tab = useTabsStore((s) => s.tabsByProject[projectId]?.find((t) => t.id === tabId))
  if (!tab) return null
  const Renderer = getPane(tab.kind)
  return (
    <div
      className={styles.pane}
      style={{ display: visible ? 'block' : 'none' }}
      data-testid={`pane-${tab.id}`}
      data-project-id={tab.projectId}
      data-tab-id={tab.id}
      data-visible={visible}
    >
      {Renderer ? (
        <Renderer tab={tab} />
      ) : (
        <div className={styles.missing}>No renderer registered for “{tab.kind}”.</div>
      )}
    </div>
  )
})

export function PaneHost(): React.JSX.Element {
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId)

  // T-181 — PaneHost only needs to know WHICH panes exist (to mount/unmount PaneSlot) and WHICH
  // one is visible — never the tabs' field content. `paneKeys` selects a flat array of identity
  // strings (see paneKey above); useShallow compares it element-by-element BY VALUE, so a
  // high-frequency field mutation (cwd, lastCommand, color, dirty, ...) on any tab — which never
  // adds, removes, or moves a tab — yields the identical array of strings and useShallow hands
  // back the PREVIOUS array reference: PaneHost does not re-render for it. Only an actual
  // open/close/move (a real identity change) does.
  const paneKeys = useTabsStore(
    useShallow((s) =>
      Object.entries(s.tabsByProject).flatMap(([pid, tabs]) => tabs.map((t) => paneKey(pid, t.id)))
    )
  )
  const activeTabId = useTabsStore((s) => s.activeTabByProject[activeProjectId])
  const activeTabCount = useTabsStore((s) => s.tabsByProject[activeProjectId]?.length ?? 0)
  const hasVisible = activeTabCount > 0

  return (
    <div className={styles.host} data-testid="panehost" data-active-project={activeProjectId}>
      {paneKeys.map((key) => {
        const [projectId, tabId] = splitPaneKey(key)
        return (
          // T-097 invariant: the React key is the TAB ID ALONE, never the projectId+tabId
          // composite. A cross-project move changes only the projectId part of `key`; keying the
          // slot on that composite made React unmount the old slot and mount a new one — the pane
          // (and its xterm/PTY) rebuilt, the "hidden-not-unmounted" contract broken. Keyed on the
          // tab id (globally unique), the move is a pure `projectId` PROP change: same DOM node,
          // same TerminalPane mount, live session intact. The projectId+tabId composite stays the
          // identity string for the `useShallow` selector above (add/remove/move detection) only.
          <PaneSlot
            key={tabId}
            tabId={tabId}
            projectId={projectId}
            visible={projectId === activeProjectId && tabId === activeTabId}
          />
        )
      })}

      {!hasVisible && (
        <div className={styles.empty} data-testid="panehost-empty">
          <div className={styles.emptyDiamond} aria-hidden="true" />
          <p>No tabs open in this project.</p>
          <p className={styles.emptyHint}>Use the “+” in the tab strip to open one.</p>
        </div>
      )}
      {/* E-027 — an app shortcut's overlay frame, centred over the active tab. */}
      <AppOverlay />
      {/* T-299 — Stop all terminals / Exit all agents ask once here when a target is busy. */}
      <BulkCloseConfirm />
    </div>
  )
}
