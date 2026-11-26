// Pomade — reveal-store (renderer). E-012 (final).
// A tiny leaf store that lets any component ask the file tree to reveal a path (expand ancestors +
// select + scroll into view) in whichever root section shows it. It decouples the request from the
// FileTree component, which owns the tree's expand/select state: the symlink popover (opened
// from a tab or the editor header, outside the tree) and the go-to-path row both dispatch
// through here; FileTree subscribes and performs the reveal for its ACTIVE project.
//
// Non-persisted, runtime-only. `nonce` makes an identical repeat request re-fire the effect.
// `projectId` lets a cross-project reveal ("Open in project…") switch the active project first
// and have FileTree act only once it is rooted at that project. `expand` also opens a revealed
// folder itself (an app's `files.reveal`), where the default reveal only opens its ancestors.

import { create } from 'zustand'

export interface RevealRequest {
  /** A tree path: workspace-relative under the project root or a workspace mount; absolute under
   *  a mount outside the workspace. */
  path: string
  projectId: string
  /** A revealed folder opens too. */
  expand: boolean
  nonce: number
}

interface RevealState {
  request: RevealRequest | null
  reveal: (path: string, projectId: string, opts?: { expand?: boolean }) => void
}

let seq = 0

export const useRevealStore = create<RevealState>((set) => ({
  request: null,
  reveal: (path, projectId, opts) => set({ request: { path, projectId, expand: opts?.expand === true, nonce: ++seq } })
}))
