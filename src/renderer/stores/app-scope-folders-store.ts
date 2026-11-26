// Pomade — E-047 (T-291): app scope folders (renderer). The folders hosted apps put in a project's
// scope through the Host API, per project, as main stores them (`ProjectState.appScopeFolders`).
// Main owns the field: this store only reads it — hydrated from the project's state file, then
// kept live by EV.appScopeFolders — and never saves. Which of them apply is `project-scope.ts`'s.

import { create } from 'zustand'

import type { AppScopeFolder, Id } from '@shared/types'

import { createProjectStatePersistence } from './project-state-persistence'

interface AppScopeFoldersState {
  foldersByProject: Record<Id, AppScopeFolder[]>
  hydratedProjects: Record<Id, boolean>
  hydrateProject: (projectId: Id) => Promise<void>
}

let subscribed = false

export const useAppScopeFoldersStore = create<AppScopeFoldersState>((set, get) => {
  const persistence = createProjectStatePersistence({
    isHydrated: (projectId) => get().hydratedProjects[projectId] === true,
    // Never saved: main writes the field (`app-scope-folders.ts`).
    payload: () => ({}),
    hydrate: async (projectId, isCurrent) => {
      const loaded = await window.pomade.state.load(projectId)
      // A workspace switch reset the store meanwhile, or main's word arrived first (it is newer).
      if (!isCurrent() || get().hydratedProjects[projectId]) return
      set((s) => ({
        foldersByProject: { ...s.foldersByProject, [projectId]: loaded?.appScopeFolders ?? [] },
        hydratedProjects: { ...s.hydratedProjects, [projectId]: true }
      }))
    },
    reset: () => set({ foldersByProject: {}, hydratedProjects: {} })
  })

  return {
    foldersByProject: {},
    hydratedProjects: {},
    hydrateProject: (projectId) => {
      if (!subscribed) {
        subscribed = true
        window.pomade.state.onAppScopeFolders(({ projectId: id, folders }) =>
          set((s) => ({
            foldersByProject: { ...s.foldersByProject, [id]: folders },
            hydratedProjects: { ...s.hydratedProjects, [id]: true }
          }))
        )
      }
      return persistence.hydrateProject(projectId)
    }
  }
})
