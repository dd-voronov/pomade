// Pomade — E-037: a repo's "am I safe" marks, shared by the All repositories rows and the repo
// view: `● n` uncommitted, `↑n` unpushed, `↓n` behind (as of the last fetch — Pomade does not
// fetch here), and the remote line — `github.com/owner/name`, or the Local only warning.

import { glossaryLines } from '@shared/git-glossary'
import { remoteLabel } from '@shared/git-history'
import type { RepoState } from '@shared/git-state'
import { Tooltip } from '../../../components/Tooltip'
import styles from './GitPanel.module.css'

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

export const LOCAL_ONLY = 'Local only — commits exist only on this Mac'

/** The ws-relative root as a test-id key ('' → '.'). */
export function repoKey(root: string): string {
  return root === '' ? '.' : root
}

export function RepoCounts({ repo }: { repo: RepoState }): React.JSX.Element | null {
  const uncommitted = repo.changes.length
  const upstream = repo.upstream ?? ''
  const key = repoKey(repo.root)
  if (uncommitted === 0 && repo.ahead === 0 && repo.behind === 0) return null
  return (
    <span className={styles.counts} data-testid={`git-counts-${key}`}>
      {uncommitted > 0 && (
        <Tooltip lines={[`${plural(uncommitted, 'uncommitted file', 'uncommitted files')}`, ...glossaryLines('uncommitted')]}>
          <span className={styles.count} data-testid={`git-uncommitted-${key}`} data-count={uncommitted}>
            <span className={styles.countDot} aria-hidden="true" />
            {uncommitted}
          </span>
        </Tooltip>
      )}
      {repo.ahead > 0 && (
        <Tooltip lines={[`${plural(repo.ahead, 'commit', 'commits')} not pushed to ${upstream}`, ...glossaryLines('push')]}>
          <span className={styles.count} data-testid={`git-ahead-${key}`} data-count={repo.ahead}>
            <span className={styles.countArrow} aria-hidden="true">
              ↑
            </span>
            {repo.ahead}
          </span>
        </Tooltip>
      )}
      {repo.behind > 0 && (
        <Tooltip
          lines={[`${plural(repo.behind, 'commit', 'commits')} on ${upstream} not here yet`, 'As of the last fetch', ...glossaryLines('fetch')]}
        >
          <span className={styles.count} data-testid={`git-behind-${key}`} data-count={repo.behind}>
            <span className={styles.countArrow} aria-hidden="true">
              ↓
            </span>
            {repo.behind}
          </span>
        </Tooltip>
      )}
    </span>
  )
}

/** The remote line: where commits go, or that they go nowhere. A branch with no upstream on a
 *  repo that has a remote is called out — its commits are not on the remote either. */
export function RemoteLine({ repo }: { repo: RepoState }): React.JSX.Element {
  const key = repoKey(repo.root)
  if (repo.error) {
    return (
      <span className={`${styles.remote} ${styles.remoteError}`} data-testid={`git-remote-${key}`} title={repo.error}>
        {repo.error}
      </span>
    )
  }
  if (repo.remoteUrl === null) {
    return (
      <Tooltip lines={glossaryLines('local-only')}>
        <span className={`${styles.remote} ${styles.localOnly}`} data-testid={`git-remote-${key}`} data-local-only="true">
          {LOCAL_ONLY}
        </span>
      </Tooltip>
    )
  }
  const label = remoteLabel(repo.remoteUrl)
  const unpublished = repo.branch !== null && repo.upstream === null
  return (
    <Tooltip lines={[repo.remoteUrl, ...(unpublished ? [`${repo.branch} is not on the remote`] : []), ...glossaryLines('remote')]}>
      <span className={styles.remote} data-testid={`git-remote-${key}`}>
        <span className={`${styles.remoteLabel} ${/^[/~.]/.test(label) ? styles.remotePath : ''}`}>
          <bdi>{label}</bdi>
        </span>
        {unpublished && <span className={styles.unpublished}> · branch not pushed</span>}
      </span>
    </Tooltip>
  )
}

/** The branch name, or the detached / unborn state in words. */
export function branchLabel(repo: RepoState): string {
  if (repo.branch) return repo.branch
  // A stopped rebase leaves HEAD detached by design; say what is going on instead.
  if (repo.operation === 'rebase') return 'rebasing'
  return repo.hasCommits ? 'detached HEAD' : 'no commits yet'
}
