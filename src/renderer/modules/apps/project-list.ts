// Pomade — E-030: the Projects panel's groups → projects tree as the Host API's `project.list` result
// (docs/HOST-API.md §4 "project.read"). Pure: the same walk as the Projects panel (and
// `buildProjectsPanelOrderedProjects`) — top-level groups interleaved with Ungrouped at its stored
// position; a group lists its projects (by `order`), then its sub-groups. Each entry carries its
// group path of names from the top level down.

import type { GroupInfo, ProjectInfo, ProjectListResult } from 'pomade-kit/protocol'

import type { Group, Project } from '@shared/types'
import { childGroups, topLevelTokens, UNGROUPED_ID } from '../projects-panel/reorder'
import { WORKSPACE_REF } from './project-ref'

export function buildProjectList(
  groups: Group[],
  projects: Project[],
  ungroupedOrder: number | undefined
): ProjectListResult {
  const byGroup = new Map<string, Project[]>()
  for (const p of [...projects].sort((a, b) => a.order - b.order)) {
    const key = p.groupId ?? ''
    byGroup.set(key, [...(byGroup.get(key) ?? []), p])
  }
  const outGroups: GroupInfo[] = []
  const outProjects: ProjectInfo[] = []
  const emitProjects = (key: string, groupId: string | null, groupPath: string[]): void => {
    for (const p of byGroup.get(key) ?? []) {
      outProjects.push({ id: p.id, kind: 'project', name: p.name, root: p.rootPath, groupId, groupPath: [...groupPath] })
    }
  }
  const walk = (g: Group, parentPath: string[]): void => {
    const path = [...parentPath, g.name]
    outGroups.push({ id: g.id, name: g.name, parentId: g.parentId ?? null, path })
    emitProjects(g.id, g.id, path)
    for (const child of childGroups(groups, g.id)) walk(child, path)
  }
  for (const token of topLevelTokens(groups, ungroupedOrder)) {
    if (token === UNGROUPED_ID) emitProjects('', null, [])
    else {
      const g = groups.find((x) => x.id === token)
      if (g) walk(g, [])
    }
  }
  return { workspace: { ...WORKSPACE_REF }, groups: outGroups, projects: outProjects }
}
