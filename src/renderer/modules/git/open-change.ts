// Pomade — E-037: what a click on an uncommitted file in the Git panel opens. A file opens the
// comparison tab last commit (HEAD) ↔ the current document — a renamed file compares from its old
// name, a new file against nothing. A deleted file opens its last committed version (the tree's
// deleted-file view, with Restore file); an untracked folder is revealed in Files.

import type { GitFileChange, RepoState } from '@shared/git-state'
import type { Id } from '@shared/types'
import { useRevealStore } from '../../stores/reveal-store'
import { useGitUiStore } from './git-ui-store'
import { openComparison } from './open-compare'

export function openChange(projectId: Id, repo: RepoState, change: GitFileChange, opts: { preview: boolean }): Promise<void> {
  if (change.dir) {
    useRevealStore.getState().reveal(change.path, projectId)
    return Promise.resolve()
  }
  if (change.status === 'deleted') {
    useGitUiStore.getState().openDeleted(change.path)
    return Promise.resolve()
  }
  return openComparison(
    projectId,
    { kind: 'rev', repo: repo.root, rev: 'HEAD', path: change.from ?? change.path },
    { kind: 'file', path: change.path },
    opts
  )
}
