// Pomade — E-036: the Projects panel's "am I safe" badge. A project row shows `● 5 ↑2` — uncommitted
// files and unpushed commits over the project's repos (shared/git-state summarizeScope); nothing at
// all when clean and pushed. The Workspace row sums every repo. The collapsed rail has no room for
// numbers: a launcher gets a small dot, and its tooltip carries the same lines as the badge's.

import { summarizeScope, type GitSnapshot, type ScopeSummary } from '@shared/git-state'

import { Tooltip } from '../../components/Tooltip'
import { useGitStateStore, useGitStateSubscription } from './git-state-store'
import styles from './GitBadge.module.css'

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** "5 uncommitted files · 2 unpushed commits" (zero parts omitted). */
function countsLine(uncommitted: number, unpushed: number): string {
  const parts: string[] = []
  if (uncommitted > 0) parts.push(plural(uncommitted, 'uncommitted file', 'uncommitted files'))
  if (unpushed > 0) parts.push(plural(unpushed, 'unpushed commit', 'unpushed commits'))
  return parts.join(' · ')
}

/** Tooltip lines for a scope: each repo that has something, by folder name, under the total when
 *  more than one repo contributes. */
export function gitSummaryLines(s: ScopeSummary): string[] {
  if (s.uncommitted === 0 && s.unpushed === 0) return []
  const repoLines: string[] = []
  for (const r of s.repos) {
    const line = countsLine(r.uncommitted, r.unpushed ?? 0)
    if (line) repoLines.push(`${r.name}: ${line}`)
  }
  return repoLines.length === 1 ? repoLines : [countsLine(s.uncommitted, s.unpushed), ...repoLines]
}

/** The live snapshot, subscribing the git state on first use. */
export function useGitSnapshot(): GitSnapshot {
  useGitStateSubscription()
  return useGitStateStore((s) => s.snapshot)
}

export function GitBadge({
  scopeRoot,
  testId,
  counterSlot = false
}: {
  scopeRoot: string | null
  testId: string
  /** Keep the attention counter's slot when no counter follows (rows with a hover kebab). */
  counterSlot?: boolean
}): React.JSX.Element | null {
  const snapshot = useGitSnapshot()
  const s = summarizeScope(snapshot, scopeRoot)
  if (s.uncommitted === 0 && s.unpushed === 0) return null
  return (
    <Tooltip lines={gitSummaryLines(s)} testId={`${testId}-tooltip`}>
      <span
        className={`${styles.badge} ${counterSlot ? styles.counterSlot : ''}`}
        data-testid={testId}
        data-uncommitted={s.uncommitted}
        data-unpushed={s.unpushed}
        aria-label={countsLine(s.uncommitted, s.unpushed)}
      >
        {s.uncommitted > 0 && (
          <span className={styles.part} data-testid={`${testId}-uncommitted`}>
            <span className={styles.dot} aria-hidden="true" />
            {s.uncommitted}
          </span>
        )}
        {s.unpushed > 0 && (
          <span className={styles.part} data-testid={`${testId}-unpushed`}>
            <span className={styles.arrow} aria-hidden="true">
              ↑
            </span>
            {s.unpushed}
          </span>
        )}
      </span>
    </Tooltip>
  )
}

/** The collapsed rail's mark: amber when anything is uncommitted, else blue for unpushed only. */
export function GitRailDot({ summary, testId }: { summary: ScopeSummary; testId: string }): React.JSX.Element | null {
  if (summary.uncommitted === 0 && summary.unpushed === 0) return null
  return (
    <span
      className={`${styles.railDot} ${summary.uncommitted > 0 ? styles.railDotUncommitted : styles.railDotUnpushed}`}
      data-testid={testId}
      data-uncommitted={summary.uncommitted}
      data-unpushed={summary.unpushed}
      aria-hidden="true"
    />
  )
}
