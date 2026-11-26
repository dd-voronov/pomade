// Pomade T-182 — "start new project from here" request store (renderer).
// A tiny leaf store that lets the file tree ask the Projects panel to open the create-project wizard
// pre-seeded with a folder. It decouples the request from the Projects panel, which owns the modal
// state (mirrors reveal-store's pattern): FileTree's "Start new project from here" folder
// context-menu item dispatches through here; the Projects panel subscribes and opens ProjectModal in
// existing-folder mode with the root path pre-filled.
//
// Non-persisted, runtime-only. `nonce` makes an identical repeat request re-fire the effect
// (right-clicking the same folder twice reopens the wizard both times).

import { create } from 'zustand'

export interface NewProjectRequest {
  /** Workspace-relative folder the wizard's root field is pre-filled with. Only ever an
   *  in-workspace path — the menu item is disabled on outside-workspace folders. */
  rootPath: string
  nonce: number
}

interface NewProjectState {
  request: NewProjectRequest | null
  /** Ask the Projects panel to open the create-project wizard rooted at `rootPath` (existing-folder mode). */
  startFromFolder: (rootPath: string) => void
}

let seq = 0

export const useNewProjectStore = create<NewProjectState>((set) => ({
  request: null,
  startFromFolder: (rootPath) => set({ request: { rootPath, nonce: ++seq } })
}))
