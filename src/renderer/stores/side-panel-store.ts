// Pomade — E-029 side-panel-store (renderer). Which strip icon's panel each project's side
// column shows, persisted per project as `ProjectState.sidePanel` through the shared per-project
// persistence (T-157: immediate partial saves, quit flush, workspace-switch reset). The stored
// key is resolved against the live strip at render time (`resolvePanel`), so it is never
// rewritten just because an app is momentarily unavailable.

import { create } from 'zustand'

import type { Id } from '@shared/types'
import { createProjectStatePersistence } from './project-state-persistence'

interface SidePanelState {
  /** Stored selection per project; absent = Files. */
  selectedByProject: Record<Id, string | undefined>
  hydratedProjects: Record<Id, boolean>
  hydrateProject: (projectId: Id) => Promise<void>
  select: (projectId: Id, key: string) => void
  /** T-156 project teardown. */
  dropProject: (projectId: Id) => void
}

export const useSidePanelStore = create<SidePanelState>((set, get) => {
  const persistence = createProjectStatePersistence({
    isHydrated: (projectId) => get().hydratedProjects[projectId] === true,
    payload: (projectId) => ({ sidePanel: get().selectedByProject[projectId] }),
    hydrate: async (projectId, isCurrent) => {
      const loaded = await window.pomade.state.load(projectId)
      if (!isCurrent()) return
      set((s) => ({
        selectedByProject: { ...s.selectedByProject, [projectId]: loaded?.sidePanel },
        hydratedProjects: { ...s.hydratedProjects, [projectId]: true }
      }))
    },
    reset: () => set({ selectedByProject: {}, hydratedProjects: {} })
  })

  return {
    selectedByProject: {},
    hydratedProjects: {},
    hydrateProject: (projectId) => persistence.hydrateProject(projectId),
    select: (projectId, key) => {
      if (get().selectedByProject[projectId] === key) return
      set((s) => ({ selectedByProject: { ...s.selectedByProject, [projectId]: key } }))
      persistence.persist(projectId)
    },
    dropProject: (projectId) => {
      set((s) => {
        const selectedByProject = { ...s.selectedByProject }
        const hydratedProjects = { ...s.hydratedProjects }
        delete selectedByProject[projectId]
        delete hydratedProjects[projectId]
        return { selectedByProject, hydratedProjects }
      })
      persistence.dropProject(projectId)
    }
  }
})
