// Pomade — E-033: the `agentTabs.*` Host API calls (docs/HOST-API.md §4 `agentTabs`), served
// against the stores once main has gated the capability and checked the params (and a launch or
// resume folder on disk).
//
//   agentTabs.list     — every agent tab, or one project's (`agent-tabs.ts`)
//   agentTabs.setTitle — an app's title (`appTitled`), or `null`: the session is unnamed — the
//                        default title (the agent's name) with the unnamed mark
//   agentTabs.focus    — the tab's project becomes active, the tab its active tab
//   agentTabs.launch   — a roster agent in a new tab: its mode's args, a folder, a first prompt
//   agentTabs.resume   — the session in a new tab; a live tab already bound to it is focused instead
//                        (two CLIs on one transcript would interleave it) — `resumeAgentSession`,
//                        which the Git panel's session link (E-043) uses too

import type { ProjectRef } from 'pomade-kit/protocol'

import {
  WORKSPACE_PROJECT_ID,
  type AgentInfo,
  type AppCallOutcome,
  type AppDelegatedCall,
  type Id,
  type Project,
  type TerminalTab
} from '@shared/types'
import { useTabsStore } from '../../stores/tabs-store'
import { useTerminalsStore } from '../../stores/terminals-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { currentAgentTabs } from './agent-tabs'

type AgentTabsCall = Extract<AppDelegatedCall, { method: `agentTabs.${string}` }>

function error(code: 'not-found' | 'invalid-params', message: string): AppCallOutcome {
  return { ok: false, error: { code, message } }
}

/** The project a call targets (default the active one), the Workspace project included. */
function targetProject(projectId: string | undefined, active: ProjectRef): Project | null {
  return useWorkspaceStore.getState().projectById(projectId ?? active.id) ?? null
}

/** An agent tab anywhere in the workspace, with its project. */
function findAgentTab(tabId: Id): { projectId: Id; tab: TerminalTab } | null {
  for (const [projectId, tabs] of Object.entries(useTabsStore.getState().tabsByProject)) {
    const tab = tabs.find((t) => t.id === tabId)
    if (tab) return tab.kind === 'agent' ? { projectId, tab } : null
  }
  return null
}

/** Show `projectId` with its tabs loaded, so a tab opened now is never replaced by hydration. */
async function showProject(projectId: Id): Promise<void> {
  await useTabsStore.getState().hydrateProject(projectId)
  const ws = useWorkspaceStore.getState()
  if (ws.activeProjectId !== projectId) ws.setActiveProject(projectId)
}

async function rosterAgent(agentId: string): Promise<AgentInfo | undefined> {
  return (await window.pomade.agents.roster()).find((a) => a.id === agentId)
}

/** A launch or resume folder: the call's, else the project's (workspace-relative). */
function folderOf(cwd: string | undefined, project: Project): string {
  return cwd ?? project.rootPath
}

/** Resume an agent's session in a new tab of `project` — or focus the live tab already bound to
 *  it. `cwd`: where the session ran (workspace-relative or absolute); default the project's folder.
 *  The agent must be in the roster and the session in its store for that folder. */
export async function resumeAgentSession(
  project: Project,
  { agentId, sessionId, cwd }: { agentId: string; sessionId: string; cwd?: string }
): Promise<AppCallOutcome> {
  const agent = await rosterAgent(agentId)
  if (!agent) return error('not-found', `No agent ${JSON.stringify(agentId)} in the roster`)
  const bound = currentAgentTabs().find((t) => t.agentId === agentId && t.sessionId === sessionId && t.state !== 'exited')
  if (bound) {
    await showProject(bound.projectId)
    useTabsStore.getState().setActive(bound.projectId, bound.tabId)
    return { ok: true, value: { tabId: bound.tabId } }
  }
  const folder = folderOf(cwd, project)
  const root = useWorkspaceStore.getState().root ?? ''
  const probe = await window.pomade.fs.probePath(folder === '' ? root : folder, root)
  const exists = probe !== null && (await window.pomade.agents.validateSession(agentId, probe.abs, sessionId))
  if (!exists) return error('not-found', `No session ${JSON.stringify(sessionId)} of ${JSON.stringify(agentId)} in ${JSON.stringify(folder)}`)
  await showProject(project.id)
  const tabId = await useTerminalsStore.getState().startAgent(project, agent, sessionId, { cwd: folder })
  return { ok: true, value: { tabId } }
}

export async function serveAgentTabs(call: AgentTabsCall, active: ProjectRef): Promise<AppCallOutcome> {
  switch (call.method) {
    case 'agentTabs.list': {
      const { projectId } = call.params
      if (projectId !== undefined && projectId !== WORKSPACE_PROJECT_ID && !targetProject(projectId, active)) {
        return error('not-found', `No project ${JSON.stringify(projectId)}`)
      }
      const tabs = currentAgentTabs().filter((t) => projectId === undefined || t.projectId === projectId)
      return { ok: true, value: { tabs } }
    }
    case 'agentTabs.setTitle': {
      const found = findAgentTab(call.params.tabId)
      if (!found) return error('not-found', `No agent tab ${JSON.stringify(call.params.tabId)}`)
      const { projectId, tab } = found
      const { title } = call.params
      if (title === null) {
        const agent = await rosterAgent(tab.agentId ?? '')
        useTabsStore.getState().updateTab(projectId, tab.id, {
          title: agent?.name ?? tab.agentId ?? tab.title,
          unnamed: true,
          appTitled: undefined,
          renamed: undefined
        })
      } else {
        useTabsStore.getState().updateTab(projectId, tab.id, { title, appTitled: true, unnamed: undefined, renamed: undefined })
      }
      return { ok: true, value: {} }
    }
    case 'agentTabs.focus': {
      const found = findAgentTab(call.params.tabId)
      if (!found) return error('not-found', `No agent tab ${JSON.stringify(call.params.tabId)}`)
      await showProject(found.projectId)
      useTabsStore.getState().setActive(found.projectId, found.tab.id)
      return { ok: true, value: {} }
    }
    case 'agentTabs.launch': {
      const { agentId, mode, prompt, cwd } = call.params
      const project = targetProject(call.params.projectId, active)
      if (!project) return error('not-found', `No project ${JSON.stringify(call.params.projectId)}`)
      const agent = await rosterAgent(agentId)
      if (!agent) return error('not-found', `No agent ${JSON.stringify(agentId)} in the roster`)
      if (mode !== undefined && !agent.modes.some((m) => m.id === mode)) {
        return error('invalid-params', `Agent ${JSON.stringify(agentId)} has no mode ${JSON.stringify(mode)}`)
      }
      if (!agent.resolved) return error('not-found', `The command of ${JSON.stringify(agentId)} (${agent.command}) is not found`)
      await showProject(project.id)
      const tabId = await useTerminalsStore.getState().startAgent(project, agent, undefined, {
        cwd: folderOf(cwd, project),
        ...(mode !== undefined ? { mode } : {}),
        ...(prompt !== undefined ? { prompt } : {})
      })
      return { ok: true, value: { tabId } }
    }
    case 'agentTabs.resume': {
      const project = targetProject(call.params.projectId, active)
      if (!project) return error('not-found', `No project ${JSON.stringify(call.params.projectId)}`)
      return resumeAgentSession(project, call.params)
    }
  }
}
