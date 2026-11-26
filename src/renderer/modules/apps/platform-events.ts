// Pomade — E-031: the platform events the renderer owns, reported to main's event bus
// (`events.platform`; docs/modules/core/event-bus.md):
//
//   pomade.ready     — the workspace's tabs are restored (every project's tab state hydrated);
//                      once per workspace load (main keeps it sticky until the workspace closes)
//   project.created  — a project appeared in the workspace config
//   project.renamed  — a project's name or folder changed ({ project, previous })
//   project.removed  — a project left the workspace config (the project as it was)
//   project.changed  — the active project changed (the Workspace project included), or the active
//                      project was renamed or moved
//   project.opened   — a project (or the Workspace project) became active for the first time since
//                      the workspace loaded; the one active at launch counts as opened at ready
//   project.updated  — a project's group (or its group's path), visible agents or one app's
//                      settings changed ({ project: ProjectInfo, changes }); a settings change goes
//                      only to the app whose settings changed
//
// A workspace load (launch, or a switch) is a new baseline: the projects it brings are not
// "created", and nothing is "opened" before it is ready.

import type {
  JsonValue,
  PlatformEventName,
  PlatformEvents,
  ProjectChange,
  ProjectInfo,
  ProjectRef,
  ProjectUpdatedPayload
} from 'pomade-kit/protocol'

import { WORKSPACE_PROJECT_ID, type Group, type Id, type Project } from '@shared/types'
import { useTabsStore } from '../../stores/tabs-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { buildProjectList } from './project-list'
import { projectRefFor } from './project-ref'

export type PlatformEvent = {
  [E in PlatformEventName]: { name: E; payload: PlatformEvents[E] }
}[PlatformEventName]

export function sameRef(a: ProjectRef | null, b: ProjectRef): boolean {
  return a !== null && a.id === b.id && a.kind === b.kind && a.name === b.name && a.root === b.root
}

/** The workspace's projects as Host API refs, by id. */
export function projectRefs(projects: readonly Project[]): Map<Id, ProjectRef> {
  return new Map(projects.map((p) => [p.id, { id: p.id, kind: 'project', name: p.name, root: p.rootPath }]))
}

/** What changed between two snapshots of the projects: each id gone is `project.removed` (the
 *  project as it was), each new id `project.created`, each id whose name or folder changed
 *  `project.renamed`. */
export function projectEvents(prev: ReadonlyMap<Id, ProjectRef>, next: ReadonlyMap<Id, ProjectRef>): PlatformEvent[] {
  const out: PlatformEvent[] = []
  for (const [id, ref] of prev) if (!next.has(id)) out.push({ name: 'project.removed', payload: ref })
  for (const [id, ref] of next) {
    const before = prev.get(id)
    if (!before) out.push({ name: 'project.created', payload: ref })
    else if (before.name !== ref.name || before.root !== ref.root) {
      out.push({ name: 'project.renamed', payload: { project: ref, previous: before } })
    }
  }
  return out
}

/** What `project.updated` compares for one project: its place in the Projects panel, its visible agents,
 *  and each app's settings as canonical JSON. */
export interface ProjectFacts {
  info: ProjectInfo
  agents: readonly string[]
  settings: ReadonlyMap<string, string>
}

/** JSON with object keys sorted, so the same settings always read the same. */
function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] as JsonValue)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** The workspace's projects as `project.updated` sees them, by id. */
export function projectFacts(
  groups: Group[],
  projects: Project[],
  ungroupedOrder: number | undefined
): Map<Id, ProjectFacts> {
  const byId = new Map(projects.map((p) => [p.id, p]))
  const out = new Map<Id, ProjectFacts>()
  for (const info of buildProjectList(groups, projects, ungroupedOrder).projects) {
    const p = byId.get(info.id)
    if (!p) continue
    const settings = new Map(Object.entries(p.appSettings ?? {}).map(([appId, s]) => [appId, canonicalJson(s)]))
    out.set(info.id, { info, agents: [...p.visibleAgents], settings })
  }
  return out
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** One `project.updated` to send: to every subscriber (`to: null`) or to one app's. */
export interface ProjectUpdate {
  payload: ProjectUpdatedPayload
  to: string | null
}

/** What `project.updated` says between two snapshots: per project that was there before, a new
 *  group or group path and a new agent list go to everyone in one event; each app whose settings
 *  changed gets its own `settings` event. A new or removed project is no update. */
export function projectUpdates(prev: ReadonlyMap<Id, ProjectFacts>, next: ReadonlyMap<Id, ProjectFacts>): ProjectUpdate[] {
  const out: ProjectUpdate[] = []
  for (const [id, now] of next) {
    const before = prev.get(id)
    if (!before) continue
    const changes: ProjectChange[] = []
    if (before.info.groupId !== now.info.groupId || !sameList(before.info.groupPath, now.info.groupPath)) changes.push('group')
    if (!sameList(before.agents, now.agents)) changes.push('agents')
    if (changes.length > 0) out.push({ payload: { project: now.info, changes }, to: null })
    for (const appId of new Set([...before.settings.keys(), ...now.settings.keys()])) {
      if (before.settings.get(appId) !== now.settings.get(appId)) {
        out.push({ payload: { project: now.info, changes: ['settings'] }, to: appId })
      }
    }
  }
  return out
}

/** Every project's tab state (the Workspace project's included) is loaded: the tabs are restored. */
export function tabsRestored(projects: readonly Project[], hydrated: Readonly<Record<Id, boolean>>): boolean {
  return hydrated[WORKSPACE_PROJECT_ID] === true && projects.every((p) => hydrated[p.id] === true)
}

function emit(event: PlatformEvent): void {
  void window.pomade.events.platform(event.name, event.payload)
}

function emitUpdate(update: ProjectUpdate): void {
  if (update.to === null) void window.pomade.events.platform('project.updated', update.payload)
  else void window.pomade.events.platform('project.updated', update.payload, update.to)
}

/** Start reporting; returns the stop function. Mounted once, in `App`. */
export function startPlatformEvents(): () => void {
  let root: string | null = null
  let projects = new Map<Id, ProjectRef>()
  let facts = new Map<Id, ProjectFacts>()
  let factsOf: { groups: Group[]; projects: Project[]; ungroupedOrder: number | undefined } | null = null
  let active: ProjectRef | null = null
  let opened = new Set<Id>()
  let ready = false

  const open = (ref: ProjectRef): void => {
    if (!ready || opened.has(ref.id)) return
    opened.add(ref.id)
    emit({ name: 'project.opened', payload: ref })
  }

  const checkReady = (): void => {
    const ws = useWorkspaceStore.getState()
    if (ready || !ws.hydrated || ws.root !== root) return
    if (!tabsRestored(ws.projects, useTabsStore.getState().hydratedProjects)) return
    ready = true
    emit({ name: 'pomade.ready', payload: {} })
    if (active) open(active)
  }

  /** The facts for the store's groups and projects, rebuilt only when one of them changed. */
  const currentFacts = (ws: ReturnType<typeof useWorkspaceStore.getState>): Map<Id, ProjectFacts> => {
    if (factsOf && factsOf.groups === ws.groups && factsOf.projects === ws.projects && factsOf.ungroupedOrder === ws.ungroupedOrder) {
      return facts
    }
    factsOf = { groups: ws.groups, projects: ws.projects, ungroupedOrder: ws.ungroupedOrder }
    return projectFacts(ws.groups, ws.projects, ws.ungroupedOrder)
  }

  const onWorkspace = (): void => {
    const ws = useWorkspaceStore.getState()
    if (!ws.hydrated) return
    if (ws.root !== root) {
      // A new workspace: a new baseline.
      root = ws.root
      projects = projectRefs(ws.projects)
      facts = currentFacts(ws)
      opened = new Set()
      ready = false
    } else {
      const next = projectRefs(ws.projects)
      for (const event of projectEvents(projects, next)) emit(event)
      projects = next
      const nextFacts = currentFacts(ws)
      if (nextFacts !== facts) for (const update of projectUpdates(facts, nextFacts)) emitUpdate(update)
      facts = nextFacts
    }
    const ref = projectRefFor(ws.activeProjectId, ws.projects)
    if (!sameRef(active, ref)) {
      active = ref
      emit({ name: 'project.changed', payload: ref })
      open(ref)
    }
    checkReady()
  }

  const offWorkspace = useWorkspaceStore.subscribe(onWorkspace)
  const offTabs = useTabsStore.subscribe((s, prev) => {
    if (s.hydratedProjects !== prev.hydratedProjects) checkReady()
  })
  onWorkspace()
  return () => {
    offWorkspace()
    offTabs()
  }
}
