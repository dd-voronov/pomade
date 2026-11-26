// Pomade — E-036: the git marks the file tree draws — the status letter at a row's right edge, the
// name tint, the folder dot, and their one-line hover explanations. The tree (filetree/TreeNodes)
// decides WHERE they go; this file owns what they look like and what they say.

import { baseName, parentPath, type GitFileChange, type GitFileStatus } from '@shared/git-state'

import { Tooltip } from '../../components/Tooltip'
import styles from './TreeGit.module.css'

export const GIT_LETTER: Record<GitFileStatus, string> = {
  modified: 'M',
  new: 'U',
  conflict: 'C',
  renamed: 'R',
  deleted: 'D'
}

const TINT: Record<GitFileStatus, string> = {
  modified: styles.tintModified,
  new: styles.tintNew,
  conflict: styles.tintConflict,
  renamed: styles.tintRenamed,
  deleted: styles.tintDeleted
}

/** Class for a row name carrying `change`'s tint ('' when clean). */
export function gitTintClass(change: GitFileChange | null): string {
  return change ? TINT[change.status] : ''
}

/** The one-line hover explanation for a letter. */
export function gitHint(change: GitFileChange): string {
  switch (change.status) {
    case 'modified':
      return 'M — Modified: changed since the last commit'
    case 'new':
      return 'U — New: not in any commit yet'
    case 'conflict':
      return 'C — Conflict: a merge left both versions in this file'
    case 'renamed': {
      const from = change.from ?? ''
      // Same folder: the old name says it all; elsewhere: the old path.
      const shown = parentPath(from) === parentPath(change.path) ? baseName(from) : from
      return `R — Renamed from ${shown}`
    }
    case 'deleted':
      return 'D — Deleted: gone from disk, still in the last commit. Click to view or restore'
  }
}

export const FOLDER_DOT_HINT = 'Something inside changed since the last commit'

export function GitLetter({
  change,
  path,
  afterSymlink
}: {
  change: GitFileChange
  path: string
  afterSymlink?: boolean
}): React.JSX.Element {
  return (
    <Tooltip lines={[gitHint(change)]} testId={`tree-git-hint-${path}`}>
      <span
        className={`${styles.letter} ${TINT[change.status]} ${afterSymlink ? styles.afterSymlink : ''}`}
        data-testid={`tree-git-${path}`}
        data-git-status={GIT_LETTER[change.status]}
      >
        {GIT_LETTER[change.status]}
      </span>
    </Tooltip>
  )
}

export function GitFolderDot({ path, afterSymlink }: { path: string; afterSymlink?: boolean }): React.JSX.Element {
  return (
    <Tooltip lines={[FOLDER_DOT_HINT]}>
      <span
        className={`${styles.dot} ${afterSymlink ? styles.afterSymlink : ''}`}
        data-testid={`tree-git-dot-${path}`}
        aria-label={FOLDER_DOT_HINT}
      />
    </Tooltip>
  )
}

export const ghostClasses = { row: styles.ghost, icon: styles.ghostIcon, name: styles.ghostName }
