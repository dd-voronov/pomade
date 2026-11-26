// Pomade — E-027: the active project as a Host API ProjectRef (docs/HOST-API.md §4). The
// Workspace project (the Projects panel's Workspace row, or no matching project) is
// `{ id: "__workspace__", kind: "workspace", name: "Workspace", root: "" }`.

import type { ProjectRef } from 'pomade-kit/protocol'

import { WORKSPACE_PROJECT_ID, type Id, type Project } from '@shared/types'
import { useWorkspaceStore } from '../../stores/workspace-store'

export const WORKSPACE_REF: ProjectRef = {
  id: WORKSPACE_PROJECT_ID,
  kind: 'workspace',
  name: 'Workspace',
  root: ''
}

export function projectRefFor(activeProjectId: Id, projects: Project[]): ProjectRef {
  if (activeProjectId === WORKSPACE_PROJECT_ID) return WORKSPACE_REF
  const p = projects.find((x) => x.id === activeProjectId)
  if (!p) return WORKSPACE_REF
  return { id: p.id, kind: 'project', name: p.name, root: p.rootPath }
}

/** The active project's ref, read from the store now (no subscription). */
export function activeProjectRef(): ProjectRef {
  const s = useWorkspaceStore.getState()
  return projectRefFor(s.activeProjectId, s.projects)
}

/** The ref of project `id`, read from the store now; the Workspace project for an unknown or removed one. */
export function projectRefOf(id: Id): ProjectRef {
  return projectRefFor(id, useWorkspaceStore.getState().projects)
}
