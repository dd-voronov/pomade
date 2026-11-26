// Pomade — E-030: git state as apps see it (docs/HOST-API.md §4 `git.read`). Pure: the shape the
// Host API serves, cut from the one git-state snapshot (shared/git-state.ts) — never a second
// producer, never a git command per call.

import { gitReposInScope, type GitRepoState } from 'pomade-kit/protocol'

import type { GitSnapshot, RepoState } from '@shared/git-state'

/** One repo for an app: the documented `GitRepoState` fields only — not the tree's ignored entries,
 *  not the Git panel's `head` / `ignoredHolders` / `operation`, not a change's `staged`. */
export function toAppRepo(repo: RepoState): GitRepoState {
  return {
    name: repo.name,
    root: repo.root,
    absPath: repo.absPath,
    remoteUrl: repo.remoteUrl,
    branch: repo.branch,
    upstream: repo.upstream,
    ahead: repo.ahead,
    behind: repo.behind,
    hasCommits: repo.hasCommits,
    changes: repo.changes.map((c) => ({
      path: c.path,
      status: c.status,
      ...(c.from !== undefined ? { from: c.from } : {}),
      ...(c.dir ? { dir: c.dir } : {})
    })),
    ...(repo.error !== undefined ? { error: repo.error } : {})
  }
}

/** The repos of a scope (`scopeRoot` workspace-relative; `''` = the workspace), sorted by root:
 *  the repos at or below the folder plus the nearest repo holding it. */
export function appRepos(snapshot: GitSnapshot, scopeRoot: string): GitRepoState[] {
  return gitReposInScope(snapshot.repos, scopeRoot).map(toAppRepo)
}
