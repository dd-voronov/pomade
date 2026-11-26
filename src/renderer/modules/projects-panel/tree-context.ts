// Pomade — the shared bundle threaded through the Projects panel's recursive expanded tree
// (ProjectRow / GroupSection / UngroupedSection). It carries the derived view data, the store
// actions those rows fire, and the DnD hook — so recursion just forwards one `ctx` prop instead
// of a dozen. Assembled fresh each render by `ProjectsPanel`.

import type { Group, Id, Project } from '@shared/types'
import type { KebabItem } from './projects-panel-parts'
import type { ProjectsPanelDnd } from './useProjectsPanelDnd'

export type ModalState =
  | { kind: 'none' }
  | { kind: 'group'; group?: Group; parentId?: string }
  | {
      kind: 'project'
      project?: Project
      defaultGroupId?: string
      // T-182 — seeds passed to ProjectModal when opened from the file tree's "Start new project
      // from here" (root path pre-filled, existing-folder mode preselected).
      initialRootPath?: string
      initialCreateMode?: 'existing' | 'template'
    }
  | { kind: 'confirm-project'; project: Project }
  | { kind: 'confirm-group'; group: Group }
  | { kind: 'workspace-icon' }

export interface ProjectsPanelCtx {
  groups: Group[]
  projectsByGroup: Map<string, Project[]>
  collapsedGroupSet: Set<string>
  activeProjectId: Id
  attentionCounts: Record<Id, number>
  groupAttentionCounts: Record<Id, number>
  /** T-311 — the project whose row flashes after Pomade switched to it, or null. */
  flashProjectId: Id | null
  setActiveProject: (id: Id) => void
  toggleGroupCollapsed: (id: Id) => void
  updateProject: (id: Id, patch: Partial<Project>) => void
  updateGroup: (id: Id, patch: Partial<Group>) => void
  setModal: (m: ModalState) => void
  moveProjectBtn: (id: string, siblings: Project[], dir: -1 | 1) => void
  moveGroupBtn: (group: Group, dir: -1 | 1) => void
  openRowMenu: (e: React.MouseEvent, items: KebabItem[]) => void
  dnd: ProjectsPanelDnd
}
