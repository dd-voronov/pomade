// Pomade — E-030: Host API calls whose work is renderer-owned state. Main has already gated the
// capability and validated the params (and checked the paths on disk); it hands the call back
// as `{ delegate }` and the frame bridge serves it here, against the stores.
//
//   files.reveal       — T-275: the Files panel of the target project (the Workspace project when the path
//                        lies outside its folder) shows, expanded to the path, which is selected
//   tabs.openFile      — open (or focus) the file's doc tab in the target project, right of its
//                        active tab, and switch to that project
//   tabs.openTerminal  — a terminal tab in `cwd` running `command`, same placement and switch
//   tabs.openAttached  — E-034: a terminal tab attached to an app's session, same placement and switch
//   project.list       — the Projects panel's groups → projects tree (`project-list.ts`)
//   project.get/setSettings — the calling app's entry in `Project.appSettings` (merge; null removes)
//   project.get/setAgents   — `Project.visibleAgents` (the Workspace project: every agent, read-only)
//   project.activate   — T-324: the project becomes active, its tabs as they are; the Projects panel
//                        reveals its row (T-311)
//   files.pickFolder   — resolves the root project to its folder, then main's native picker
//                        (`apps.pickFolder`, which re-checks the frame and the paths)
//   tabs.openApp       — E-027: open or focus the calling app's own tab at a route (`openAppRoute`);
//                        T-268: with `key`, that keyed tab
//   tabs.setRoute      — T-269: the calling tab frame navigated by itself — its tab records the route,
//                        and the frame gets no `route.changed` for it
//   tabs.setTitle      — T-268: the calling tab frame retitles its own tab, unless the user renamed it
//   tabs.close         — T-268: the calling tab frame closes its own tab, as the user's close does
//   overlay.open       — T-236: the calling app's overlay at a route, height and anchor
//                        (`overlay-store.ts`) — only while the calling frame is shown; closing
//                        returns focus to that frame
//   overlay.resize     — T-238: the overlay frame's new height (the card clamps it)
//   overlay.close      — E-027: answered here; the frame bridge then closes the overlay frame
//   panel.show         — T-325: the calling app's panel for the icon main resolved comes forward in the
//                        active project's side panel, expanded — a click on that strip icon, minus its
//                        tab — at `route` when given (`app-panel-routes.ts`); focus is not moved
//   git.getState / git.watch / git.unwatch — the git-state snapshot, scoped (`git-calls.ts`)
//   git.reveal         — T-320: the Git panel of the target project (the Workspace project when the
//                        repo is outside its scope) shows, with the repo's row in view
//   notices.post       — E-032: the notice joins the notices store (list + toast); an action without
//                        a project belongs to the caller's project (`postingProject`)
//   agentTabs.*        — E-033: the agent tabs (`modules/agents/agent-tab-calls.ts`)
//
// A tab's target project is `params.projectId`, else `active` — the active project for a frame, the
// Workspace project for a backend or a command (`socket-bridge.ts`); an id that names no project (nor the
// Workspace project) is `not-found`.

import { mergeProjectSettings, settingsSizeProblem, type JsonValue, type ProjectRef } from 'pomade-kit/protocol'

import {
  WORKSPACE_PROJECT_ID,
  type AppCallOutcome,
  type AppTab,
  type AppDelegatedCall,
  type Id,
  type Project
} from '@shared/types'
import { useAppSettingsStore } from '../../stores/app-settings-store'
import { useAppsStore } from '../../stores/apps-store'
import { useRevealStore } from '../../stores/reveal-store'
import { useSidePanelStore } from '../../stores/side-panel-store'
import { useTabsStore } from '../../stores/tabs-store'
import { useTerminalsStore } from '../../stores/terminals-store'
import { buildAllProjects, useWorkspaceStore } from '../../stores/workspace-store'
import { reposInScope, type GitSnapshot } from '@shared/git-state'
import { loadGitState } from '../git/git-state-store'
import { GIT_PANEL } from '../git/panel/GitPanel'
import { useGitPanelStore } from '../git/panel/git-panel-store'
import { serveGit } from './git-calls'
import { useNoticesStore } from '../../stores/notices-store'
import { openAppRoute } from './open-app'
import { useOverlayStore } from './overlay-store'
import { openAttachedTab } from '../terminal/open-attached'
import { buildProjectList } from './project-list'
import { serveAgentTabs } from '../agents/agent-tab-calls'
import { useAppPanelRoutes } from '../side-panels/app-panel-routes'
import { appStripKey } from '../side-panels/strip-model'

function notFound(message: string): AppCallOutcome {
  return { ok: false, error: { code: 'not-found', message } }
}

/** The frame a delegated call came from. */
export interface CallerFrame {
  /** Whether it is shown now: an active tab, the shown panel. */
  isShown: () => boolean
  /** Its `<iframe>` element in Pomade's document. */
  element: HTMLElement
  /** T-268 — a tab frame's tab (wherever it is now); absent for a panel or an overlay. */
  tabId?: Id
  /** T-269 — the frame says it renders `route` now (`tabs.setRoute`): no `route.changed` for it. */
  atRoute?: (route: string) => void
}

/** An app tab by id, in whichever project's strip it is now. */
function findTab(tabId: Id): { projectId: Id; tab: AppTab } | null {
  for (const [projectId, tabs] of Object.entries(useTabsStore.getState().tabsByProject)) {
    const tab = tabs.find((t): t is AppTab => t.id === tabId && t.kind === 'app')
    if (tab) return { projectId, tab }
  }
  return null
}

/** The project a call targets, or null when the id names none. */
function targetProject(projectId: string | undefined, active: ProjectRef): Id | null {
  const id = projectId ?? active.id
  if (id === WORKSPACE_PROJECT_ID) return id
  return useWorkspaceStore.getState().projects.some((p) => p.id === id) ? id : null
}

/** Show `projectId` with its tabs loaded, so a tab opened now is never replaced by hydration. */
async function showProject(projectId: Id): Promise<void> {
  await useTabsStore.getState().hydrateProject(projectId)
  const ws = useWorkspaceStore.getState()
  if (ws.activeProjectId !== projectId) ws.setActiveProject(projectId)
}

/** The project whose Files panel shows `path`: `projectId` when `path` lies in its folder, else the
 *  Workspace project (rooted at the workspace, so it shows every path). */
function revealProject(projectId: Id, path: string): Id {
  const root = buildAllProjects(useWorkspaceStore.getState().projects).find((p) => p.id === projectId)?.rootPath ?? ''
  return root === '' || path === root || path.startsWith(`${root}/`) ? projectId : WORKSPACE_PROJECT_ID
}

/** The project whose Git panel shows repo `root`: `projectId` when the repo is in its scope (at or
 *  below its folder, or the repo holding it — what its panel lists), else the Workspace project. */
function gitRevealProject(projectId: Id, root: string, snapshot: GitSnapshot): Id {
  if (projectId === WORKSPACE_PROJECT_ID) return projectId
  const folder = buildAllProjects(useWorkspaceStore.getState().projects).find((p) => p.id === projectId)?.rootPath ?? ''
  return reposInScope(snapshot, folder).some((r) => r.root === root) ? projectId : WORKSPACE_PROJECT_ID
}

function invalid(message: string): AppCallOutcome {
  return { ok: false, error: { code: 'invalid-params', message } }
}

/** A real project for settings / agent-list calls: the Workspace project has none of its own. */
function realProject(projectId: string, what: string): Project | AppCallOutcome {
  if (projectId === WORKSPACE_PROJECT_ID) return invalid(`The Workspace project has no ${what}`)
  return useWorkspaceStore.getState().projects.find((p) => p.id === projectId) ?? notFound(`No project ${JSON.stringify(projectId)}`)
}

function isOutcome(v: Project | AppCallOutcome): v is AppCallOutcome {
  return 'ok' in v
}

/** `appSettings` with `appId`'s entry replaced by `settings` — dropped when empty, and the whole
 *  map dropped when nothing is left. */
function withAppSettings(
  all: Project['appSettings'],
  appId: string,
  settings: Record<string, JsonValue>
): Project['appSettings'] {
  const next = { ...all }
  if (Object.keys(settings).length > 0) next[appId] = settings
  else delete next[appId]
  return Object.keys(next).length > 0 ? next : undefined
}

export async function serveDelegated(
  call: AppDelegatedCall,
  active: ProjectRef,
  frameId: string,
  /** The caller's own project — a tab frame's tab's project; default `active`. A notice posted
   *  without a project belongs to it. */
  postingProject?: Id,
  /** The calling frame; a socket client has none and never asks for what needs one. */
  caller?: CallerFrame
): Promise<AppCallOutcome> {
  switch (call.method) {
    case 'git.getState':
    case 'git.watch':
    case 'git.unwatch':
      return serveGit(call, frameId)
    case 'files.pickFolder': {
      const rootId = call.params.root ?? WORKSPACE_PROJECT_ID
      const root =
        rootId === WORKSPACE_PROJECT_ID ? '' : useWorkspaceStore.getState().projects.find((p) => p.id === rootId)?.rootPath
      if (root === undefined) return notFound(`No project ${JSON.stringify(rootId)}`)
      return window.pomade.apps.pickFolder(frameId, root, call.params.initial)
    }
    case 'project.list': {
      const ws = useWorkspaceStore.getState()
      return { ok: true, value: buildProjectList(ws.groups, ws.projects, ws.ungroupedOrder) }
    }
    case 'project.getSettings': {
      const project = realProject(call.params.projectId, 'project settings')
      if (isOutcome(project)) return project
      return { ok: true, value: { settings: structuredClone(project.appSettings?.[call.appId] ?? {}) } }
    }
    case 'project.setSettings': {
      const project = realProject(call.params.projectId, 'project settings')
      if (isOutcome(project)) return project
      const merged = mergeProjectSettings(project.appSettings?.[call.appId] ?? {}, call.params.settings)
      const tooBig = settingsSizeProblem(merged)
      if (tooBig) return invalid(tooBig)
      useWorkspaceStore
        .getState()
        .updateProject(project.id, { appSettings: withAppSettings(project.appSettings, call.appId, merged) })
      return { ok: true, value: { settings: structuredClone(merged) } }
    }
    case 'project.getAgents': {
      if (call.params.projectId === WORKSPACE_PROJECT_ID) return { ok: true, value: { visibleAgents: ['*'] } }
      const project = realProject(call.params.projectId, 'agent list')
      if (isOutcome(project)) return project
      return { ok: true, value: { visibleAgents: [...project.visibleAgents] } }
    }
    case 'project.setAgents': {
      const project = realProject(call.params.projectId, 'agent list')
      if (isOutcome(project)) return project
      useWorkspaceStore.getState().updateProject(project.id, { visibleAgents: [...call.params.visibleAgents] })
      return { ok: true, value: {} }
    }
    case 'project.activate': {
      const projectId = targetProject(call.params.projectId, active)
      if (projectId === null) return notFound(`No project ${JSON.stringify(call.params.projectId)}`)
      await showProject(projectId)
      return { ok: true, value: {} }
    }
    case 'files.reveal': {
      const target = targetProject(call.params.projectId, active)
      if (target === null) return notFound(`No project ${JSON.stringify(call.params.projectId)}`)
      const projectId = revealProject(target, call.params.path)
      await showProject(projectId)
      // The project's chosen panel loads first, so it cannot overwrite Files after the reveal selects it.
      await useSidePanelStore.getState().hydrateProject(projectId)
      const settings = useAppSettingsStore.getState()
      if (settings.layout.fileTreeCollapsed) await settings.setFileTreeCollapsed(false)
      // The side panel brings Files forward and the file tree expands to the path, for this request.
      useRevealStore.getState().reveal(call.params.path, projectId, { expand: true })
      return { ok: true, value: {} }
    }
    case 'git.reveal': {
      const target = targetProject(call.params.projectId, active)
      if (target === null) return notFound(`No project ${JSON.stringify(call.params.projectId)}`)
      const snapshot = await loadGitState()
      if (!snapshot.repos.some((r) => r.root === call.root)) return notFound(`No repository at ${JSON.stringify(call.params.path)}`)
      const projectId = gitRevealProject(target, call.root, snapshot)
      await showProject(projectId)
      // The project's chosen panel loads first, so it cannot overwrite Git after it is selected.
      await useSidePanelStore.getState().hydrateProject(projectId)
      const settings = useAppSettingsStore.getState()
      if (settings.layout.fileTreeCollapsed) await settings.setFileTreeCollapsed(false)
      useSidePanelStore.getState().select(projectId, GIT_PANEL)
      useGitPanelStore.getState().revealRepo(projectId, call.root)
      return { ok: true, value: {} }
    }
    case 'tabs.openFile': {
      const projectId = targetProject(call.params.projectId, active)
      if (projectId === null) return notFound(`No project ${JSON.stringify(call.params.projectId)}`)
      await showProject(projectId)
      useTabsStore.getState().openDocByPath(projectId, call.params.path)
      return { ok: true, value: {} }
    }
    case 'tabs.openTerminal': {
      const projectId = targetProject(call.params.projectId, active)
      if (projectId === null) return notFound(`No project ${JSON.stringify(call.params.projectId)}`)
      await showProject(projectId)
      const { cwd, command, title } = call.params
      await useTerminalsStore.getState().newCommandTerminal(projectId, {
        cwd,
        ...(command !== undefined ? { command } : {}),
        ...(title !== undefined ? { title } : {})
      })
      return { ok: true, value: {} }
    }
    case 'tabs.openAttached': {
      const projectId = targetProject(call.params.projectId, active)
      if (projectId === null) return notFound(`No project ${JSON.stringify(call.params.projectId)}`)
      await showProject(projectId)
      openAttachedTab(projectId, call.params.session, call.params.title)
      return { ok: true, value: {} }
    }
    case 'tabs.openApp': {
      const projectId = targetProject(call.params.projectId, active)
      if (projectId === null) return notFound(`No project ${JSON.stringify(call.params.projectId)}`)
      const app = useAppsStore.getState().apps.find((a) => a.id === call.appId && !a.unavailable)
      if (!app) return notFound(`App "${call.appId}" is not available`)
      await showProject(projectId)
      const { route, key, title, kind } = call.params
      openAppRoute(
        app,
        route ?? '',
        projectId,
        key === undefined
          ? undefined
          : { key, ...(title !== undefined ? { title } : {}), ...(kind !== undefined ? { kind } : {}) }
      )
      return { ok: true, value: {} }
    }
    case 'tabs.setRoute': {
      const own = caller?.tabId === undefined ? null : findTab(caller.tabId)
      if (!own) return invalid('tabs.setRoute is only for a tab frame')
      const { projectId, tab } = own
      const { route } = call.params
      // The frame first, so the tab's new route reaches it as where it already is.
      caller?.atRoute?.(route)
      if (tab.route !== route) useTabsStore.getState().updateTab(projectId, tab.id, { route })
      return { ok: true, value: {} }
    }
    case 'tabs.setTitle': {
      const own = caller?.tabId === undefined ? null : findTab(caller.tabId)
      if (!own) return invalid('tabs.setTitle is only for a tab frame')
      const { projectId, tab } = own
      if (!tab.renamed && !(tab.title === call.params.title && tab.appTitled === true)) {
        useTabsStore.getState().updateTab(projectId, tab.id, { title: call.params.title, appTitled: true })
      }
      return { ok: true, value: {} }
    }
    case 'tabs.close': {
      const own = caller?.tabId === undefined ? null : findTab(caller.tabId)
      if (!own) return invalid('tabs.close is only for a tab frame')
      // After the answer is posted: closing takes this very frame away.
      const { projectId, tab } = own
      setTimeout(() => useTabsStore.getState().requestClose(projectId, tab.id), 0)
      return { ok: true, value: {} }
    }
    case 'overlay.open': {
      // A background frame never pops UI over the user.
      if (!caller?.isShown()) return invalid('overlay.open needs a visible frame: an active tab or the shown panel')
      const app = useAppsStore.getState().apps.find((a) => a.id === call.appId && !a.unavailable)
      if (!app) return notFound(`App "${call.appId}" is not available`)
      const { height, anchor } = call.params
      useOverlayStore.getState().show(app.id, call.params.route ?? '', {
        ...(height !== undefined ? { height } : {}),
        ...(anchor !== undefined ? { anchor } : {}),
        opener: caller.element
      })
      return { ok: true, value: {} }
    }
    case 'panel.show': {
      const app = useAppsStore.getState().apps.find((a) => a.id === call.appId && !a.unavailable)
      if (!app) return notFound(`App "${call.appId}" is not available`)
      const projectId = useWorkspaceStore.getState().activeProjectId
      // The project's chosen panel loads first, so it cannot overwrite this selection.
      await useSidePanelStore.getState().hydrateProject(projectId)
      const key = appStripKey(app.id, call.params.icon)
      // The route first: a panel frame this call mounts opens at it; a mounted one gets `route.changed`.
      if (call.params.route !== undefined) useAppPanelRoutes.getState().setRoute(key, call.params.route)
      useSidePanelStore.getState().select(projectId, key)
      const settings = useAppSettingsStore.getState()
      if (settings.layout.fileTreeCollapsed) await settings.setFileTreeCollapsed(false)
      return { ok: true, value: {} }
    }
    case 'overlay.resize':
      useOverlayStore.getState().resize(call.params.height)
      return { ok: true, value: {} }
    case 'overlay.close':
      return { ok: true, value: {} }
    case 'agentTabs.list':
    case 'agentTabs.setTitle':
    case 'agentTabs.focus':
    case 'agentTabs.launch':
    case 'agentTabs.resume':
      return serveAgentTabs(call, active)
    case 'notices.post':
      // E-032 — main checked the notice and its action's capability; it joins the list and shows.
      useNoticesStore.getState().post({ source: call.appId, ...call.params, postingProject: postingProject ?? active.id })
      return { ok: true, value: {} }
  }
}
