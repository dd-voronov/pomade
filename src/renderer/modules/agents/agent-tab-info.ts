// Pomade — E-033: the pure half of the agent tabs (docs/HOST-API.md §4 `agentTabs`): an agent tab's
// Host API view, the list in Projects panel order, and the `agentTab.changed` events between two lists.
// No stores — `agent-tabs.ts` feeds these from them.

import type {
  AgentTabChange,
  AgentTabChangedPayload,
  AgentTabInfo,
  AgentTabSessionCause,
  AgentTabState
} from 'pomade-kit/protocol'

import { WORKSPACE_PROJECT_ID, type Id, type Tab, type TerminalTab } from '@shared/types'
import { sessionChange } from './session-cause'

/** What an agent tab's live state is read from. */
export interface LiveContext {
  /** termId → the agent's live state (agent-live-store). */
  states: Readonly<Record<string, Exclude<AgentTabState, 'exited'>>>
  /** True for a term this run created. */
  isRunTerm(termId: string): boolean
}

export function isAgentTab(tab: Tab): tab is TerminalTab & { kind: 'agent' } {
  return tab.kind === 'agent'
}

/** One agent tab as the Host API shows it. */
export function agentTabInfo(tab: TerminalTab, projectId: Id, live: LiveContext): AgentTabInfo {
  const running = tab.status === 'live' && (live.states[tab.termId] !== undefined || live.isRunTerm(tab.termId))
  return {
    tabId: tab.id,
    projectId,
    agentId: tab.agentId ?? '',
    cwd: tab.cwdAtLaunch ?? null,
    launchedAt: tab.launchedAt ?? null,
    sessionId: tab.bindState === 'unbound' ? null : (tab.resumeSessionId ?? null),
    title: tab.title,
    titleSource: tab.renamed ? 'user' : tab.appTitled ? 'app' : 'default',
    unnamed: !!tab.unnamed,
    state: running ? (live.states[tab.termId] ?? 'idle') : 'exited'
  }
}

/** Every agent tab, in Projects panel order (the Workspace project first, then the projects), each project's
 *  in tab order. */
export function collectAgentTabs(
  tabsByProject: Readonly<Record<Id, readonly Tab[]>>,
  projectOrder: readonly Id[],
  live: LiveContext
): AgentTabInfo[] {
  const order = [WORKSPACE_PROJECT_ID, ...projectOrder.filter((id) => id !== WORKSPACE_PROJECT_ID)]
  for (const id of Object.keys(tabsByProject)) if (!order.includes(id)) order.push(id)
  const out: AgentTabInfo[] = []
  for (const projectId of order) {
    for (const tab of tabsByProject[projectId] ?? []) {
      if (isAgentTab(tab)) out.push(agentTabInfo(tab, projectId, live))
    }
  }
  return out
}

/** What changed between two views of one tab. */
export function tabChanges(before: AgentTabInfo, after: AgentTabInfo): AgentTabChange[] {
  const out: AgentTabChange[] = []
  if (before.sessionId !== after.sessionId) out.push('session')
  if (before.title !== after.title || before.titleSource !== after.titleSource || before.unnamed !== after.unnamed) out.push('title')
  if (before.state !== after.state) out.push('state')
  if (before.projectId !== after.projectId) out.push('project')
  return out
}

/** Every `agentTab.changed` between two lists: a new tab is `opened`, a gone one `closed` (shown as
 *  it was last, `exited`), and a tab in both with something different names what changed. A
 *  change in `cwd` or `launchedAt` alone (a relaunch) is not an event. A `session` change also
 *  says why and what the tab held before (`session-cause.ts`); `causeOf` gives the cause noted for
 *  the tab's new session. */
export function agentTabEvents(
  prev: ReadonlyMap<string, AgentTabInfo>,
  next: readonly AgentTabInfo[],
  causeOf: (tabId: string, sessionId: string | null) => AgentTabSessionCause | undefined = () => undefined
): AgentTabChangedPayload[] {
  const out: AgentTabChangedPayload[] = []
  const seen = new Set<string>()
  for (const tab of next) {
    seen.add(tab.tabId)
    const before = prev.get(tab.tabId)
    if (!before) {
      out.push({ tab, changes: ['opened'] })
      continue
    }
    const changes = tabChanges(before, tab)
    if (changes.length === 0) continue
    out.push(
      changes.includes('session')
        ? { tab, changes, session: sessionChange(before.sessionId, tab.sessionId, causeOf(tab.tabId, tab.sessionId)) }
        : { tab, changes }
    )
  }
  for (const [tabId, tab] of prev) {
    if (!seen.has(tabId)) out.push({ tab: { ...tab, state: 'exited' }, changes: ['closed'] })
  }
  return out
}
