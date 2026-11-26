// Pomade — root shell. Picker on first run; otherwise the window's columns
// (ProjectsPanel · IconStrip · SidePanel · main[TabStrip + PaneHost]).

import { useEffect, useRef } from 'react'

import { LAYOUT_LIMITS, WORKSPACE_PROJECT_ID } from '@shared/types'
import { buildAllProjects, useWorkspaceStore } from './stores/workspace-store'
import { useWorkspaceUiStore } from './stores/workspace-ui-store'
import { useTabsStore } from './stores/tabs-store'
import { useMountsStore } from './stores/mounts-store'
import { flushAllProjectState } from './stores/project-state-persistence'
import { captureAllViewports } from './stores/viewport-capture'
import { useTerminalsStore } from './stores/terminals-store'
import { useAppSettingsStore } from './stores/app-settings-store'
import { WorkspacePicker } from './layout/WorkspacePicker'
import { ProjectsPanel } from './modules/projects-panel/ProjectsPanel'
import { IconStrip } from './modules/side-panels/IconStrip'
import { SidePanel } from './modules/side-panels/SidePanel'
import { ColumnDivider } from './layout/ColumnDivider'
import { TabStrip } from './layout/TabStrip'
import { PaneHost } from './layout/PaneHost'
import { QuitConfirm } from './layout/QuitConfirm'
import { ToastHost } from './hooks/useToast'
import { registerPane } from './panes/registry'
import { PlaceholderPane } from './panes/PlaceholderPane'
import { TerminalPane } from './modules/terminal/TerminalPane'
import { AttachedTerminalPane } from './modules/terminal/AttachedTerminalPane'
import { EditorPane } from './modules/editor'
import { AppPane } from './modules/apps/AppPane'
import { CommitPane } from './modules/git/commit/CommitPane'
import { ComparePane } from './modules/git/compare/ComparePane'
import { ConflictPane } from './modules/git/conflict/ConflictPane'
import { BranchPane } from './modules/git/branches/BranchPane'
import { useAppsStore } from './stores/apps-store'
import { useAppShortcuts } from './modules/apps/app-shortcuts'
import { useSocketBridge } from './modules/apps/socket-bridge'
import { startOpenDocWatch } from './modules/editor/open-doc-watch'
import { startPlatformEvents } from './modules/apps/platform-events'
import { startAppTabTitles } from './modules/apps/open-app'
import { startPtyTabRefs } from './stores/pty-tab-refs'
import { startAgentLiveStates, useAgentLiveStore } from './stores/agent-live-store'
import { startAgentTabEvents } from './modules/agents/agent-tabs'
import { startNoticeQueue } from './stores/notices-store'
import { startGitRuns } from './modules/git/ops/git-runs-store'
import { startStrayPressGuard } from './stores/stray-press-guard'
import { flushAllRecovery } from './modules/editor/useRecovery'
import { GitOverlays } from './modules/git'
import { SettingsModal, StartupWorkspacePrompt, useSettingsStore } from './modules/settings'
import styles from './App.module.css'

// Wave 1: one placeholder renderer for all three kinds. Later waves override these:
//   registerPane('doc', EditorPane) · registerPane('terminal', TerminalPane) · registerPane('agent', AgentPane)
registerPane('doc', EditorPane) // WAVE2C: real document editor
registerPane('terminal', PlaceholderPane)
registerPane('agent', PlaceholderPane)
// WAVE2B: real terminal/agent renderer (last registration wins over the placeholder).
registerPane('terminal', TerminalPane)
registerPane('agent', TerminalPane)
// E-027: hosted-app tabs.
registerPane('app', AppPane)
// E-037: the commit-details and comparison tabs.
registerPane('commit', CommitPane)
registerPane('compare', ComparePane)
// E-040: the conflict tab of a stopped rebase.
registerPane('conflict', ConflictPane)
// E-041: the branch tab (In progress rows).
registerPane('branch', BranchPane)
// E-034 — a terminal tab attached to a session an app's keeper holds.
registerPane('attached', AttachedTerminalPane)

// e2e hook: Playwright specs reach the stores directly for setup the UI doesn't cover yet
// (e.g. simulating a tab rename until T-021 ships its UI). Not part of the app surface.
;(window as unknown as { __pomadeStores?: unknown }).__pomadeStores = {
  useTabsStore,
  useWorkspaceStore,
  useWorkspaceUiStore,
  useTerminalsStore,
  useAppSettingsStore,
  useMountsStore,
  useAppsStore,
  useAgentLiveStore
}

export function App(): React.JSX.Element {
  const hydrate = useWorkspaceStore((s) => s.hydrate)
  const hydrated = useWorkspaceStore((s) => s.hydrated)
  const root = useWorkspaceStore((s) => s.root)
  const projects = useWorkspaceStore((s) => s.projects)
  const hydrateProject = useTabsStore((s) => s.hydrateProject)
  const hydrateSettings = useAppSettingsStore((s) => s.hydrate)
  const hydrateApps = useAppsStore((s) => s.hydrate)

  // E-007 — machine-local layout: column widths + Projects panel collapse.
  const projectsPanelWidth = useAppSettingsStore((s) => s.layout.projectsPanelWidth)
  const fileTreeWidth = useAppSettingsStore((s) => s.layout.fileTreeWidth)
  const projectsPanelCollapsed = useAppSettingsStore((s) => s.layout.projectsPanelCollapsed)
  const fileTreeCollapsed = useAppSettingsStore((s) => s.layout.fileTreeCollapsed)
  const setProjectsPanelWidth = useAppSettingsStore((s) => s.setProjectsPanelWidth)
  const setFileTreeWidth = useAppSettingsStore((s) => s.setFileTreeWidth)
  const persistLayout = useAppSettingsStore((s) => s.persistLayout)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  // When collapsed, the Projects panel shows a fixed-width rail (the always-visible expand affordance)
  // instead of its stored width. The icon strip (E-029) is always
  // there; the side panel beside it takes the stored file-tree width, and nothing when collapsed.
  const effectiveProjectsPanel = projectsPanelCollapsed ? LAYOUT_LIMITS.railWidth : projectsPanelWidth
  const effectiveFileTree = LAYOUT_LIMITS.stripWidth + (fileTreeCollapsed ? 0 : fileTreeWidth)

  useEffect(() => {
    void hydrate()
    void hydrateSettings()
    void hydrateApps()
  }, [hydrate, hydrateSettings, hydrateApps])

  // E-007 (T-030) — Cmd+B toggles the Projects panel (menu-item path; focus-independent).
  useEffect(() => {
    return window.pomade.app.onToggleProjectsPanel(() => {
      void useAppSettingsStore.getState().toggleProjectsPanelCollapsed()
    })
  }, [])

  // T-049 — Cmd+Shift+B toggles the side panel: the View-menu item, and the keystroke main
  // takes before the page (main/window-shortcuts.ts) — whatever has focus, app frames included.
  useEffect(() => {
    return window.pomade.app.onToggleFileTree(() => {
      void useAppSettingsStore.getState().toggleFileTreeCollapsed()
    })
  }, [])

  // E-027 — app-declared Pomade-wide shortcuts (capture phase, from anywhere in the window).
  useAppShortcuts()
  // E-028 — the window's half of the Host API socket (active project, delegated calls).
  useSocketBridge()

  // Flush-on-quit: when main signals an imminent quit, await EVERY registered per-project
  // store's in-flight state.save IPCs (tabs, mounts, any future registrant — T-157's registry,
  // not a hand-picked store list), then ack so main can continue exiting; main's own
  // flushPendingWrites then drains the write queue. (workspace-store already persists
  // synchronously.) Without this, a save still in flight at quit could miss main's write queue.
  useEffect(() => {
    return window.pomade.app.onFlush(() => {
      // T-185 — capture the visible pane's reading position (a synchronous setDocMeta) BEFORE the
      // flush, so the final scroll position rides the in-flight saves the flush then awaits.
      captureAllViewports()
      // E-035 — pending recovery copies land on disk before main's teardown starts.
      void Promise.all([flushAllProjectState(), flushAllRecovery()]).finally(() =>
        window.pomade.app.flushAck()
      )
    })
  }, [])

  // E-035 (rule 8) — main watches every open doc in every project, so a write by any other
  // writer is caught when it lands, not only when its project becomes active.
  useEffect(() => startOpenDocWatch(), [])

  // E-031 — the platform events the renderer owns (Pomade ready, projects created / renamed /
  // opened, the active project) for main's event bus, and each term's tab for `agentTab.exited`.
  useEffect(() => startPlatformEvents(), [])
  useEffect(() => startPtyTabRefs(), [])
  // T-244 — app tab titles follow the manifests (a reinstall that renames an icon retitles its tabs).
  useEffect(() => startAppTabTitles(), [])
  // E-033 — each agent's live state (from main), and `agentTab.changed` for the event bus.
  useEffect(() => startAgentLiveStates(), [])
  useEffect(() => startAgentTabEvents(), [])

  // E-032 — notices posted while Pomade was closed (and, from now on, while it runs) by backends
  // and commands, through the queue in user data.
  useEffect(() => startNoticeQueue(), [])

  // E-042 — `pomade-git` runs (Runner's scheduled jobs, terminals, agents): each repo's last run, and
  // the mark of one that failed — including while Pomade was closed.
  useEffect(() => startGitRuns(), [])

  // T-228 — a double click's second press that lands in a pane its first press just opened is
  // dropped (no caret, no selection, the preview stays a preview).
  useEffect(() => startStrayPressGuard(), [])

  // T-036 — app-menu accelerators. Cmd+W: close the ACTIVE tab via requestClose (dirty-doc
  // guard runs; the tabs-store reaper kills the pty once no tab references it). No active
  // tab ⇒ no-op — the window stays. Cmd+T: new terminal tab inserted immediately right of
  // the active tab, focused (openTab activates it).
  useEffect(() => {
    const offClose = window.pomade.app.onCloseActiveTab(() => {
      const pid = useWorkspaceStore.getState().activeProjectId
      const tabs = useTabsStore.getState()
      const activeTabId = tabs.activeTabByProject[pid]
      if (activeTabId) tabs.requestClose(pid, activeTabId)
    })
    const offNew = window.pomade.app.onNewTerminalTab(() => {
      const ws = useWorkspaceStore.getState()
      const project = buildAllProjects(ws.projects).find((p) => p.id === ws.activeProjectId)
      if (!project) return
      const activeTabId = useTabsStore.getState().activeTabByProject[project.id]
      void useTerminalsStore
        .getState()
        .newTerminal(project, activeTabId ? { afterTabId: activeTabId } : undefined)
    })
    // T-149 — Cmd+Shift+T reopens the active project's most-recently closed tab (undo-close).
    // A no-op when its reopen stack is empty (reopenClosedTab handles that internally).
    const offReopen = window.pomade.app.onReopenClosedTab(() => {
      const pid = useWorkspaceStore.getState().activeProjectId
      void useTerminalsStore.getState().reopenClosedTab(pid)
    })
    return () => {
      offClose()
      offNew()
      offReopen()
    }
  }, [])

  // E-006 (T-026/T-027) — app-menu accelerators. Cmd+, opens the unified Settings surface;
  // "Change Workspace…" starts the workspace-switch flow. Same pattern as the T-036 events.
  useEffect(() => {
    const offSettings = window.pomade.app.onOpenSettings(() => {
      useSettingsStore.getState().openSettings()
    })
    const offChangeWs = window.pomade.app.onChangeWorkspace(() => {
      void useWorkspaceStore.getState().changeWorkspace()
    })
    return () => {
      offSettings()
      offChangeWs()
    }
  }, [])

  // Hydrate every project's tab state up front so PaneHost can keep all panes mounted — and its
  // mounts, whose in-scope folders decide the scope marks of those panes (E-047).
  useEffect(() => {
    if (!hydrated) return
    const ids = [WORKSPACE_PROJECT_ID, ...projects.map((p) => p.id)]
    for (const id of ids) {
      void hydrateProject(id)
      void useMountsStore.getState().hydrateProject(id)
    }
  }, [hydrated, projects, hydrateProject])

  // E-007 (T-029) — geometry clamps. Each column stays within its absolute [min,max] AND
  // leaves the working area ≥ mainMin, so extreme drags never squeeze the editor/terminal
  // out of existence. Widths change via CSS only (below), so panes don't remount.
  const bodyWidth = (): number =>
    bodyRef.current?.getBoundingClientRect().width ?? window.innerWidth
  const clampProjectsPanel = (raw: number): number => {
    const hi = Math.max(
      LAYOUT_LIMITS.projectsPanelMin,
      Math.min(LAYOUT_LIMITS.projectsPanelMax, bodyWidth() - effectiveFileTree - LAYOUT_LIMITS.mainMin)
    )
    return Math.min(hi, Math.max(LAYOUT_LIMITS.projectsPanelMin, raw))
  }
  const clampFileTree = (raw: number): number => {
    const hi = Math.max(
      LAYOUT_LIMITS.fileTreeMin,
      Math.min(
        LAYOUT_LIMITS.fileTreeMax,
        bodyWidth() - effectiveProjectsPanel - LAYOUT_LIMITS.stripWidth - LAYOUT_LIMITS.mainMin
      )
    )
    return Math.min(hi, Math.max(LAYOUT_LIMITS.fileTreeMin, raw))
  }

  if (root === null) {
    return (
      <>
        <WorkspacePicker />
        {/* T-098 — mounted in the picker branch too: main blocks the quit as soon as the page
            has loaded, so a window with no answering dialog would be unquittable. */}
        <QuitConfirm />
        <ToastHost />
      </>
    )
  }

  return (
    <div className={styles.app} data-testid="app-shell">
      <div className={styles.titlebar}>
        <span className={styles.brand}>Pomade</span>
      </div>
      <div
        ref={bodyRef}
        className={styles.body}
        style={
          {
            '--sidebar-w': `${effectiveProjectsPanel}px`,
            '--filetree-w': `${fileTreeWidth}px`,
            '--strip-w': `${LAYOUT_LIMITS.stripWidth}px`
          } as React.CSSProperties
        }
      >
        <ProjectsPanel />
        {!projectsPanelCollapsed && (
          <ColumnDivider
            ariaLabel="Resize Projects panel"
            testId="divider-projects-panel"
            onDrag={(clientX) => {
              const rect = bodyRef.current?.getBoundingClientRect()
              if (rect) setProjectsPanelWidth(clampProjectsPanel(clientX - rect.left))
            }}
            onKeyStep={(delta) => setProjectsPanelWidth(clampProjectsPanel(projectsPanelWidth + delta))}
            onCommit={() => void persistLayout()}
          />
        )}
        <IconStrip />
        <SidePanel />
        {!fileTreeCollapsed && (
          <ColumnDivider
            ariaLabel="Resize side panel"
            testId="divider-filetree"
            onDrag={(clientX) => {
              const rect = bodyRef.current?.getBoundingClientRect()
              if (rect) {
                setFileTreeWidth(clampFileTree(clientX - rect.left - effectiveProjectsPanel - LAYOUT_LIMITS.stripWidth))
              }
            }}
            onKeyStep={(delta) => setFileTreeWidth(clampFileTree(fileTreeWidth + delta))}
            onCommit={() => void persistLayout()}
          />
        )}
        <main className={styles.main}>
          <TabStrip />
          <PaneHost />
        </main>
      </div>
      <GitOverlays />
      <SettingsModal />
      <StartupWorkspacePrompt />
      <QuitConfirm />
      <ToastHost />
    </div>
  )
}
