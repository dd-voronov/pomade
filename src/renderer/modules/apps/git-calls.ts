// Pomade — E-030: the Host API's git methods (docs/HOST-API.md §4 `git.read`), served from the
// renderer's copy of the git-state snapshot (`git-state-store`, fed by main's `GitStateService`
// broadcast) — no git command per call. Main has gated `git.read` and validated the params.
//
//   git.getState   the scope's repos now
//   git.watch      a watch held for the frame: after each new snapshot (or a project move) the
//                  scope's repos are recomputed and `git.changed` is posted when they differ from
//                  what the watch last delivered
//   git.unwatch    drop it
//
// A scope is a project id (its folder, looked up at every evaluation, so a moved project's watch
// follows it) or the workspace (absent / `__workspace__`). A watched project that is deleted has
// no repos. Watches end with the frame session (`onGitChanged`'s cleanup), like `files.watch`.

import type { GitChangedPayload, GitRepoState } from 'pomade-kit/protocol'

import { WORKSPACE_PROJECT_ID, type AppCallOutcome, type AppDelegatedCall } from '@shared/types'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { loadGitState, useGitStateStore } from '../git/git-state-store'
import { appRepos } from './app-git'

type GitCall = Extract<AppDelegatedCall, { method: 'git.getState' | 'git.watch' | 'git.unwatch' }>

interface GitWatch {
  /** Absent = the workspace. */
  projectId?: string
  /** The scope's repos as last delivered, serialized. */
  seen: string
}

const sinks = new Map<string, (payload: GitChangedPayload) => void>()
const watches = new Map<string, Map<string, GitWatch>>()
let watchSeq = 0
let subscribed = false

/** A scope's folder: `''` for the workspace, the project's root, or null when no such project. */
function scopeRoot(projectId: string | undefined): string | null {
  if (projectId === undefined || projectId === WORKSPACE_PROJECT_ID) return ''
  return useWorkspaceStore.getState().projects.find((p) => p.id === projectId)?.rootPath ?? null
}

function reposOf(projectId: string | undefined): GitRepoState[] {
  const root = scopeRoot(projectId)
  return root === null ? [] : appRepos(useGitStateStore.getState().snapshot, root)
}

function reevaluate(): void {
  for (const [frameId, frameWatches] of watches) {
    const post = sinks.get(frameId)
    if (!post) continue
    for (const [watchId, w] of frameWatches) {
      const repos = reposOf(w.projectId)
      const seen = JSON.stringify(repos)
      if (seen === w.seen) continue
      w.seen = seen
      post({ watchId, repos })
    }
  }
}

function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = true
  useGitStateStore.subscribe((s, prev) => {
    if (s.snapshot !== prev.snapshot) reevaluate()
  })
  useWorkspaceStore.subscribe((s, prev) => {
    if (s.projects !== prev.projects) reevaluate()
  })
}

/** The frame bridge's event sink for one frame session; the returned cleanup ends the session's
 *  git watches. */
export function onGitChanged(frameId: string, post: (payload: GitChangedPayload) => void): () => void {
  sinks.set(frameId, post)
  return () => {
    if (sinks.get(frameId) !== post) return
    sinks.delete(frameId)
    watches.delete(frameId)
  }
}

function notFound(projectId: string | undefined): AppCallOutcome {
  return { ok: false, error: { code: 'not-found', message: `No project ${JSON.stringify(projectId)}` } }
}

export async function serveGit(call: GitCall, frameId: string): Promise<AppCallOutcome> {
  switch (call.method) {
    case 'git.getState': {
      const root = scopeRoot(call.params.projectId)
      if (root === null) return notFound(call.params.projectId)
      return { ok: true, value: { repos: appRepos(await loadGitState(), root) } }
    }
    case 'git.watch': {
      const { projectId } = call.params
      if (scopeRoot(projectId) === null) return notFound(projectId)
      await loadGitState()
      ensureSubscribed()
      const watchId = `g${++watchSeq}`
      // A session that ended meanwhile gets an id that never fires (its result is dropped anyway).
      if (sinks.has(frameId)) {
        let frameWatches = watches.get(frameId)
        if (!frameWatches) {
          frameWatches = new Map()
          watches.set(frameId, frameWatches)
        }
        const scope = projectId === undefined || projectId === WORKSPACE_PROJECT_ID ? {} : { projectId }
        frameWatches.set(watchId, { ...scope, seen: JSON.stringify(reposOf(projectId)) })
      }
      return { ok: true, value: { watchId } }
    }
    case 'git.unwatch':
      watches.get(frameId)?.delete(call.params.watchId)
      return { ok: true, value: {} }
  }
}
