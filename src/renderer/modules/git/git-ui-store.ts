// Pomade Wave 3 — renderer-side git UI state: the quick-peek diff overlay and (E-036) the
// deleted-file view. Kept separate from workspace-store so persistence concerns stay there.

import { create } from 'zustand'

import type { DiffMode } from '@shared/ipc-api'

/** E-035 — the quick peek's comparisons: Saved ↔ Unsaved (disk vs the editor buffer) for every
 *  doc, plus the git modes when the file is inside a repo. */
export type PeekMode = 'saved-vs-unsaved' | DiffMode

export interface DiffTarget {
  path: string // the doc's path ('' for Untitled; absolute for an outside-workspace doc)
  tabId: string // whose buffer is the "Unsaved" side
  title: string
  repo: boolean // the git modes are offered
  mode: PeekMode // the mode the overlay opens in
}

interface GitUiState {
  diff: DiffTarget | null
  /** E-036 — the deleted file whose last committed version is open (a ghost row click). */
  deleted: string | null

  openDiff: (target: DiffTarget) => void
  closeDiff: () => void
  openDeleted: (path: string) => void
  closeDeleted: () => void
}

export const useGitUiStore = create<GitUiState>((set) => ({
  diff: null,
  deleted: null,

  openDiff: (target) => set({ diff: target }),
  closeDiff: () => set({ diff: null }),
  openDeleted: (path) => set({ deleted: path }),
  closeDeleted: () => set({ deleted: null })
}))
