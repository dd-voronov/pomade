// Pomade — E-033: the agent tabs as the Host API shows them (docs/HOST-API.md §4 `agentTabs`).
//
// An agent tab is a TerminalTab of kind 'agent' (any project, the Workspace project included). Its
// Host API view (`AgentTabInfo`) is derived, never stored:
//   cwd / launchedAt — `cwdAtLaunch` / `launchedAt`, stamped at the agent's launch marker
//   sessionId        — `resumeSessionId` unless the binding is unsure (`bindState: 'unbound'`)
//   title            — the tab's title; its source is the user (`renamed`), an app (`appTitled`) or
//                      the default; `unnamed` is the app's mark
//   state            — `exited` for a dead tab or one restored from an earlier run and not revived
//                      yet; otherwise the agent's live state from main (agent-live-store), idle
//                      until its output says otherwise
//
// `startAgentTabEvents` publishes `agentTab.changed` on the event bus for every change, from the
// moment the workspace's tabs are restored (`pomade.ready`): what changed is diffed off the store;
// a session change carries the cause the terminals store noted for it (`session-cause.ts`).

import type { AgentTabInfo } from 'pomade-kit/protocol'

import { useAgentLiveStore } from '../../stores/agent-live-store'
import { useTabsStore } from '../../stores/tabs-store'
import { isRunTerm } from '../../stores/terminals-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { tabsRestored } from '../apps/platform-events'
import { agentTabEvents, collectAgentTabs, type LiveContext } from './agent-tab-info'
import { takeSessionCause } from './session-cause'

function liveContext(): LiveContext {
  return { states: useAgentLiveStore.getState().states, isRunTerm }
}

/** The agent tabs now, from the stores. */
export function currentAgentTabs(): AgentTabInfo[] {
  const ws = useWorkspaceStore.getState()
  return collectAgentTabs(
    useTabsStore.getState().tabsByProject,
    ws.projects.map((p) => p.id),
    liveContext()
  )
}

/** Start publishing `agentTab.changed`; returns the stop function. Mounted once, in `App`. A
 *  workspace load is a new baseline, taken once its tabs are restored (`pomade.ready`): the tabs it
 *  brings are not "opened" — an app lists them after `pomade.ready`. */
export function startAgentTabEvents(): () => void {
  let root: string | null = null
  let baseline: Map<string, AgentTabInfo> | null = null

  const sync = (): void => {
    const ws = useWorkspaceStore.getState()
    if (ws.root !== root) {
      root = ws.root
      baseline = null
    }
    if (baseline === null) {
      if (!ws.hydrated || !tabsRestored(ws.projects, useTabsStore.getState().hydratedProjects)) return
      baseline = new Map(currentAgentTabs().map((t) => [t.tabId, t]))
      return
    }
    const next = currentAgentTabs()
    for (const event of agentTabEvents(baseline, next, takeSessionCause)) {
      void window.pomade.events.platform('agentTab.changed', event)
    }
    baseline = new Map(next.map((t) => [t.tabId, t]))
  }

  const offTabs = useTabsStore.subscribe((s, prev) => {
    if (s.tabsByProject !== prev.tabsByProject || s.hydratedProjects !== prev.hydratedProjects) sync()
  })
  const offLive = useAgentLiveStore.subscribe(sync)
  const offWorkspace = useWorkspaceStore.subscribe(sync)
  sync()
  return () => {
    offTabs()
    offLive()
    offWorkspace()
  }
}
