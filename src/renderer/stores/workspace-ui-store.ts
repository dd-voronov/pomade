// Pomade — workspace-ui-store (renderer). E-026 (T-140 / T-141): workspace-scoped, machine-local
// Projects panel UI state persisted to `.pomade/state/workspace-ui.json` (gitignored) — the set of
// collapsed Projects panel groups/sub-groups (T-140), the last-active project reopened on boot (T-141) and
// where the user left each app's overlay (T-238).
//
// Persistence discipline mirrors workspace-store: mutations persist IMMEDIATELY via IPC (no
// renderer-side debounce) so the last toggle before quit is never lost; main coalesces + debounces
// the actual disk write and flushes it on quit. Each save is a PARTIAL patch carrying only the
// field this call owns, so the collapsed-groups writer and the last-active-project writer never
// clobber each other (config-store.saveWorkspaceUi merges over the last-known state).

import { create } from 'zustand'

import type { Id, OverlayPosition, WorkspaceUiState } from '@shared/types'

interface WorkspaceUiStore {
  collapsedGroups: Id[]
  lastActiveProjectId: Id | null
  /** Where the user left each app's overlay (by app id); that app's next overlay opens there. */
  overlayPositions: Record<string, OverlayPosition>
  hydrated: boolean

  /** Load the current workspace's UI state. Called from workspace-store.hydrate (boot) and
   *  changeWorkspace (switch); always reloads (per-workspace state), and returns the loaded
   *  snapshot so the caller can apply the boot-time last-active-project restore synchronously. */
  hydrate: () => Promise<WorkspaceUiState>

  isCollapsed: (groupId: Id) => boolean
  toggleGroupCollapsed: (groupId: Id) => void
  /** T-141 — persist the project selected when the app was last used (written on every switch). */
  setLastActiveProject: (id: Id) => void
  /** The user left `appId`'s overlay at `position`: its next overlay opens there. */
  setOverlayPosition: (appId: string, position: OverlayPosition) => void
}

export const useWorkspaceUiStore = create<WorkspaceUiStore>((set, get) => ({
  collapsedGroups: [],
  lastActiveProjectId: null,
  overlayPositions: {},
  hydrated: false,

  hydrate: async () => {
    const ui = await window.pomade.workspaceUi.load()
    set({
      collapsedGroups: ui.collapsedGroups,
      lastActiveProjectId: ui.lastActiveProjectId,
      overlayPositions: ui.overlayPositions,
      hydrated: true
    })
    return ui
  },

  isCollapsed: (groupId) => get().collapsedGroups.includes(groupId),

  toggleGroupCollapsed: (groupId) => {
    const current = get().collapsedGroups
    const next = current.includes(groupId)
      ? current.filter((id) => id !== groupId)
      : [...current, groupId]
    set({ collapsedGroups: next })
    void window.pomade.workspaceUi.save({ collapsedGroups: next })
  },

  setLastActiveProject: (id) => {
    if (get().lastActiveProjectId === id) return
    set({ lastActiveProjectId: id })
    void window.pomade.workspaceUi.save({ lastActiveProjectId: id })
  },

  setOverlayPosition: (appId, position) => {
    const current = get().overlayPositions[appId]
    if (current?.left === position.left && current.top === position.top) return
    const next = { ...get().overlayPositions, [appId]: position }
    set({ overlayPositions: next })
    void window.pomade.workspaceUi.save({ overlayPositions: next })
  }
}))
