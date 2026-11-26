// Pomade — E-037: the Git panel's runtime state. Which repo each project has drilled into, the
// per-repo view toggles, the Not pushed list, and the History cache: pages fetched on demand (never
// the whole log), keyed by repo + mode. Both are stamped with the branch position they were read at
// (`branchStamp`: HEAD and the upstream counts) — a commit, a push, a fetch or a pull changes it,
// the cache is stale and the visible view reloads it. Merge expansions are cached by hash (a
// commit's parents never change). T-320: a one-shot request to bring a repo's row into view (an app's
// `git.reveal`), consumed by the panel once it has shown the repo. Session-only: nothing here is persisted.

import { create } from 'zustand'

import type { CommitSummary, LogPage } from '@shared/git-history'
import type { RepoState } from '@shared/git-state'
import type { Id } from '@shared/types'
import { cleanIpcError } from '../../../lib/ipc-errors'

export interface HistoryState {
  /** The branch position the pages were read at (`branchStamp`); null = no commits yet. */
  stamp: string | null
  commits: CommitSummary[]
  more: boolean
  loading: boolean
  error: string | null
}

/** The Not pushed list, read at `stamp`. */
export type UnpushedState = { stamp: string; status: 'loading' } | { stamp: string; status: 'ok'; page: LogPage } | { stamp: string; status: 'error'; error: string }

export type MergeInner = { status: 'loading' } | { status: 'ok'; page: LogPage } | { status: 'error'; error: string }

interface RepoToggles {
  /** "Show every commit": the full log instead of the first-parent line. */
  all?: boolean
  changesCollapsed?: boolean
  /** E-041 — In progress folded. */
  progressCollapsed?: boolean
  historyCollapsed?: boolean
  /** E-039 — the Discarded section (files discarded in the last 7 days). */
  discardedCollapsed?: boolean
  /** T-231 — the Not pushed group. */
  unpushedCollapsed?: boolean
}

/** T-320 — bring repo `root`'s row into view in `projectId`'s Git panel; `nonce` re-fires a repeat. */
export interface RepoRevealRequest {
  projectId: Id
  root: string
  nonce: number
}

interface GitPanelState {
  /** The repo root a project with 2+ repos (or the Workspace project) has drilled into. */
  drillByProject: Record<Id, string | undefined>
  /** T-320 — the pending row reveal, until the panel performs it. */
  revealRequest: RepoRevealRequest | null
  toggles: Record<string, RepoToggles>
  history: Record<string, HistoryState>
  /** The Not pushed list, by repo root. */
  unpushed: Record<string, UnpushedState>
  /** Expanded merge rows, by `<repo>\0<hash>`. */
  expanded: Record<string, true>
  merges: Record<string, MergeInner>

  drill: (projectId: Id, repo: string | undefined) => void
  /** T-320 — show repo `root` in `projectId`'s panel: a drill into another repo goes back to the
   *  list (a drill into this repo stays), and the row is brought into view. */
  revealRepo: (projectId: Id, root: string) => void
  /** The panel performed request `nonce` (a newer request stays). */
  consumeReveal: (nonce: number) => void
  setToggle: (repo: string, patch: RepoToggles) => void
  /** Load page one when nothing is cached for `stamp`, else keep the cache. */
  ensureHistory: (repo: string, all: boolean, stamp: string | null) => void
  /** Read the Not pushed list when nothing is cached for `stamp` (or the last read failed). */
  ensureUnpushed: (repo: string, stamp: string) => void
  /** Append the next page. */
  loadMore: (repo: string, all: boolean) => void
  toggleMerge: (repo: string, hash: string) => void
}

/** Where the branch stands: HEAD, its upstream and the counts against it. History and Not pushed
 *  depend on exactly this — any commit, push, fetch or pull from anywhere changes it. Null before
 *  the first commit. */
export function branchStamp(repo: Pick<RepoState, 'head' | 'upstream' | 'ahead' | 'behind'>): string | null {
  return repo.head === null ? null : `${repo.head} ${repo.upstream ?? ''} ${repo.ahead} ${repo.behind}`
}

export function historyKey(repo: string, all: boolean): string {
  return `${repo}\0${all ? 'all' : 'first-parent'}`
}

export function mergeKey(repo: string, hash: string): string {
  return `${repo}\0${hash}`
}

let revealSeq = 0

export const useGitPanelStore = create<GitPanelState>((set, get) => {
  const putHistory = (key: string, patch: Partial<HistoryState>): void =>
    set((s) => {
      const prev = s.history[key]
      if (!prev) return s
      return { history: { ...s.history, [key]: { ...prev, ...patch } } }
    })

  const fetchPage = async (repo: string, all: boolean, stamp: string | null, skip: number): Promise<void> => {
    const key = historyKey(repo, all)
    try {
      const page = await window.pomade.git.log(repo, { all, skip })
      const cur = get().history[key]
      // A newer load (the branch moved, or a restart of page one) owns the cache now.
      if (!cur || cur.stamp !== stamp || cur.commits.length !== skip) return
      putHistory(key, { commits: [...cur.commits, ...page.commits], more: page.more, loading: false, error: null })
    } catch (err) {
      const cur = get().history[key]
      if (!cur || cur.stamp !== stamp) return
      putHistory(key, { loading: false, error: cleanIpcError(err) })
    }
  }

  return {
    drillByProject: {},
    revealRequest: null,
    toggles: {},
    history: {},
    unpushed: {},
    expanded: {},
    merges: {},

    drill: (projectId, repo) => set((s) => ({ drillByProject: { ...s.drillByProject, [projectId]: repo } })),

    revealRepo: (projectId, root) =>
      set((s) => {
        const drilled = s.drillByProject[projectId]
        const drillByProject = drilled === undefined || drilled === root ? s.drillByProject : { ...s.drillByProject, [projectId]: undefined }
        return { drillByProject, revealRequest: { projectId, root, nonce: ++revealSeq } }
      }),

    consumeReveal: (nonce) => set((s) => (s.revealRequest?.nonce === nonce ? { revealRequest: null } : s)),

    setToggle: (repo, patch) => set((s) => ({ toggles: { ...s.toggles, [repo]: { ...s.toggles[repo], ...patch } } })),

    ensureHistory: (repo, all, stamp) => {
      const key = historyKey(repo, all)
      const cur = get().history[key]
      if (cur && cur.stamp === stamp && !cur.error) return
      set((s) => ({
        history: { ...s.history, [key]: { stamp, commits: [], more: false, loading: stamp !== null, error: null } }
      }))
      if (stamp !== null) void fetchPage(repo, all, stamp, 0)
    },

    ensureUnpushed: (repo, stamp) => {
      const cur = get().unpushed[repo]
      if (cur && cur.stamp === stamp && cur.status !== 'error') return
      // The rows read at the last stamp stay drawn while the new ones load — no flash on a commit.
      if (!cur || cur.status !== 'ok') set((s) => ({ unpushed: { ...s.unpushed, [repo]: { stamp, status: 'loading' } } }))
      else set((s) => ({ unpushed: { ...s.unpushed, [repo]: { ...cur, stamp } } }))
      const settle = (next: UnpushedState): void => {
        if (get().unpushed[repo]?.stamp === stamp) set((s) => ({ unpushed: { ...s.unpushed, [repo]: next } }))
      }
      window.pomade.git.unpushed(repo).then(
        (page) => settle({ stamp, status: 'ok', page }),
        (err: unknown) => settle({ stamp, status: 'error', error: cleanIpcError(err) })
      )
    },

    loadMore: (repo, all) => {
      const key = historyKey(repo, all)
      const cur = get().history[key]
      if (!cur || cur.loading || !cur.more) return
      putHistory(key, { loading: true })
      void fetchPage(repo, all, cur.stamp, cur.commits.length)
    },

    toggleMerge: (repo, hash) => {
      const key = mergeKey(repo, hash)
      if (get().expanded[key]) {
        set((s) => {
          const expanded = { ...s.expanded }
          delete expanded[key]
          return { expanded }
        })
        return
      }
      set((s) => ({ expanded: { ...s.expanded, [key]: true } }))
      const known = get().merges[key]
      if (known && known.status !== 'error') return
      set((s) => ({ merges: { ...s.merges, [key]: { status: 'loading' } } }))
      window.pomade.git.mergeCommits(repo, hash).then(
        (page) => set((s) => ({ merges: { ...s.merges, [key]: { status: 'ok', page } } })),
        (err: unknown) => set((s) => ({ merges: { ...s.merges, [key]: { status: 'error', error: cleanIpcError(err) } } }))
      )
    }
  }
})
