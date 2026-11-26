// Pomade — E-041: the renderer side of branches and worktrees. Each repo's In progress list (read
// from main, reloaded when the repo's git state moves and after a fetch) and the background fetch:
// when a repo view opens, at most once per FETCH_EVERY_MS, the remote is fetched quietly — a
// failure or a busy repo is left to the Fetch button. It runs as a background operation: anything
// the user starts in the repo meanwhile stops it and runs (the repo lock's give-way).

import { create } from 'zustand'

import type { InProgress } from '@shared/git-branches'
import { cleanIpcError } from '../../../lib/ipc-errors'
import { useTabsStore } from '../../../stores/tabs-store'

/** A quiet background fetch per repo, at most this often. */
export const FETCH_EVERY_MS = 5 * 60_000

interface ListState {
  data: InProgress | null
  error: string | null
}

interface BranchesState {
  lists: Record<string, ListState | undefined>
  load: (repo: string) => void
}

const inflight = new Map<string, Promise<void>>()
const again = new Set<string>()

export const useBranchesStore = create<BranchesState>((set, get) => ({
  lists: {},
  load: (repo) => {
    if (inflight.has(repo)) {
      again.add(repo)
      return
    }
    const run = window.pomade.git.inProgress(repo).then(
      (data) => set((s) => ({ lists: { ...s.lists, [repo]: { data, error: null } } })),
      (err: unknown) => set((s) => ({ lists: { ...s.lists, [repo]: { data: s.lists[repo]?.data ?? null, error: cleanIpcError(err) } } }))
    )
    inflight.set(repo, run)
    void run.finally(() => {
      inflight.delete(repo)
      if (again.delete(repo)) get().load(repo)
    })
  }
}))

const lastFetch = new Map<string, number>()

/** Fetch `repo`'s remote in the background, unless it was fetched in the last FETCH_EVERY_MS. Never
 *  toasts, never marks: what it finds shows as new rows and counts. */
export async function backgroundFetch(repo: string): Promise<void> {
  const now = Date.now()
  if (now - (lastFetch.get(repo) ?? 0) < FETCH_EVERY_MS) return
  lastFetch.set(repo, now)
  try {
    const p = await window.pomade.git.preview(repo, { op: 'fetch' })
    if (p.blocked) return
    const r = await window.pomade.git.run(repo, { op: 'fetch' }, { token: p.token, background: true })
    if (r.ok) useBranchesStore.getState().load(repo)
  } catch {
    // The Fetch button says what went wrong when it is pressed.
  }
}

/** Changes whenever an agent starts or ends in any of Pomade's terminals (an agent tab appears,
 *  goes, or its process ends) or a tab's session changes: In progress and the branch tab re-read
 *  "is an agent live here" and the session behind each row. */
export function useAgentsKey(): string {
  return useTabsStore((s) => {
    const parts: string[] = []
    for (const tabs of Object.values(s.tabsByProject)) {
      for (const t of tabs) if (t.kind === 'agent') parts.push(`${t.id}:${t.status}:${t.resumeSessionId ?? ''}`)
    }
    return parts.sort().join(',')
  })
}
