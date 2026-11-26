// Pomade — E-036: the renderer's copy of main's git snapshot (main/git-state.ts) plus the derived
// tree index. Subscribes on first use: hydrates once from `git.state()`, then replaces the
// snapshot on every `git:state` broadcast. Main decides when to refresh (watcher, focus, after a
// restore); the renderer never polls.

import { useEffect } from 'react'
import { create } from 'zustand'

import {
  EMPTY_GIT_SNAPSHOT,
  buildGitTreeIndex,
  type GitSnapshot,
  type GitTreeIndex
} from '@shared/git-state'

interface GitStateStore {
  snapshot: GitSnapshot
  index: GitTreeIndex
  /** True once the first snapshot arrived. */
  loaded: boolean
}

export const useGitStateStore = create<GitStateStore>(() => ({
  snapshot: EMPTY_GIT_SNAPSHOT,
  index: buildGitTreeIndex(EMPTY_GIT_SNAPSHOT),
  loaded: false
}))

function publish(snapshot: GitSnapshot): void {
  useGitStateStore.setState({ snapshot, index: buildGitTreeIndex(snapshot), loaded: true })
}

let loaded: Promise<void> | null = null

/** Start listening (idempotent); settles once the first snapshot is in. The subscription lives
 *  for the window's lifetime — the git state is app-wide, like the workspace itself. */
function ensureSubscribed(): Promise<void> {
  if (loaded) return loaded
  window.pomade.git.onState(publish)
  loaded = window.pomade.git
    .state()
    .then(publish)
    .catch(() => {
      /* no workspace yet / git unavailable: stay empty until a broadcast arrives */
    })
  return loaded
}

/** Use from any component that shows git state: makes sure the store is live. */
export function useGitStateSubscription(): void {
  useEffect(() => {
    void ensureSubscribed()
  }, [])
}

/** The current snapshot, once the store is live (E-030: the Host API's git reads). */
export async function loadGitState(): Promise<GitSnapshot> {
  await ensureSubscribed()
  return useGitStateStore.getState().snapshot
}
