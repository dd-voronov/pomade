// Pomade — the rails of the Git panel's operations (main process). The rails themselves are
// git-core's (`git-core/rails.ts`, shared with the `pomade-git` command) and re-exported here;
// this module adds what needs the main process: a repo's fresh state by its workspace root, and
// the per-repo lock with the git-state refresh after every operation.

import type { GitBlock, GitOpResult, PushTarget } from '@shared/git-ops'
import type { RepoState } from '@shared/git-state'

import { withRepoLockAt } from '../git-core/lock'
import { isBlock, pushTargetOf, readOk, remotesOf, StepFailure } from '../git-core/rails'
import { gitState } from './git-state'
import { abs } from './ws-path'

export * from '../git-core/rails'

/** One repo's state read now (`repo` = a discovered root, from the renderer). */
export async function stateOf(repo: unknown): Promise<RepoState> {
  if (typeof repo !== 'string') throw new Error('Not a repository in this workspace.')
  const state = await gitState.freshState(repo)
  if (!state) throw new Error('Not a repository in this workspace.')
  return state
}

/** Where a push of this branch goes (a block when Pomade cannot push it, null with no remote) and
 *  how many of its commits are not on the remote yet — for a branch not there yet, every commit no
 *  branch of that remote has. */
export async function pushPlan(state: RepoState): Promise<{ target: PushTarget | GitBlock | null; ahead: number }> {
  const cwd = state.absPath
  const target = pushTargetOf(state, await remotesOf(cwd))
  if (isBlock(target) || !target?.setUpstream) return { target, ahead: state.ahead }
  const n = state.hasCommits ? await readOk(cwd, ['rev-list', '--count', 'HEAD', '--not', `--remotes=${target.remote}`]) : '0'
  return { target, ahead: Number(n?.trim()) || 0 }
}

/** Run `fn` holding the repo's lock (git-core/lock.ts — shared with `pomade-git`), as `title` (what
 *  a refused second operation names); a second operation on the same repo is refused, not queued:
 *  what it previewed may no longer hold once the first one is done. A `background` operation gives
 *  way instead: an operation the user asked for stops it (`fn`'s `yielded` signal aborts) and runs. */
export async function withRepoLock(
  repo: string,
  title: string,
  fn: (yielded: AbortSignal) => Promise<GitOpResult>,
  opts: { background?: boolean } = {}
): Promise<GitOpResult> {
  try {
    return await withRepoLockAt(
      abs(repo),
      title,
      fn,
      (holder) => ({
        ok: false,
        failure: { kind: 'busy', message: `“${holder}” is still running in this repository — wait for it to finish, then try again.` }
      }),
      { background: opts.background === true }
    )
  } catch (err) {
    if (err instanceof StepFailure) return { ok: false, failure: err.failure }
    const msg = (err as Error).message || String(err)
    return { ok: false, failure: { kind: 'other', message: msg, copy: msg } }
  } finally {
    gitState.refreshRepo(repo)
  }
}
