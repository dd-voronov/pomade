// Pomade — E-039: the repo view's `⋯` — the operations one level down, each opening its preview
// dialog, each item's hover explaining the git term behind it: Pull, Get their changes then push,
// Publish branch · New branch, Switch branch, Rebase onto main / the upstream (E-040) · Undo last
// commit, Connect remote · Discard all changes. While a rebase is stopped: Resolve conflicts and
// Abort, back to before.

import { useState } from 'react'

import { glossaryLines } from '@shared/git-glossary'
import type { GitOpRequest } from '@shared/git-ops'
import type { RepoState } from '@shared/git-state'
import type { Id } from '@shared/types'
import { ContextMenu, type MenuItem } from '../../../components/ContextMenu'
import { Tooltip } from '../../../components/Tooltip'
import { openConflictTab } from '../open-git-tabs'
import { useGitOpsStore } from './git-ops-store'
import styles from '../panel/GitPanel.module.css'

function sep(items: MenuItem[]): void {
  if (items.length > 0 && !('separator' in items[items.length - 1])) items.push({ separator: true })
}

/** The repo's `⋯` items. */
function menuItems(repo: RepoState, projectId: Id, open: (req: GitOpRequest) => void): MenuItem[] {
  const items: MenuItem[] = []
  if (repo.operation === 'rebase' || repo.operation === 'merge') {
    items.push(
      {
        label: 'Resolve conflicts…',
        testId: 'git-menu-resolve',
        tooltip: glossaryLines('conflict'),
        onSelect: () => openConflictTab(projectId, repo.root, repo.name)
      },
      {
        label: 'Abort, back to before…',
        testId: 'git-menu-abort',
        tooltip: glossaryLines('abort'),
        onSelect: () => open({ op: repo.operation === 'merge' ? 'merge-abort' : 'rebase-abort' })
      }
    )
    return items
  }
  if (repo.upstream !== null) {
    items.push({ label: 'Pull…', testId: 'git-menu-pull', tooltip: glossaryLines('pull'), onSelect: () => open({ op: 'pull' }) })
    // With nothing of its own to push it would be Pull under another name.
    if (repo.ahead > 0) {
      items.push({
        label: 'Get their changes, then push…',
        testId: 'git-menu-sync',
        tooltip: glossaryLines('pull'),
        onSelect: () => open({ op: 'sync-push' })
      })
    }
  }
  if (repo.remoteUrl !== null && repo.upstream === null && repo.branch !== null && repo.hasCommits) {
    items.push({ label: 'Publish branch…', testId: 'git-menu-publish', tooltip: glossaryLines('publish'), onSelect: () => open({ op: 'publish' }) })
  }
  if (repo.hasCommits) {
    sep(items)
    items.push(
      { label: 'New branch…', testId: 'git-menu-new-branch', tooltip: glossaryLines('branch'), onSelect: () => open({ op: 'create-branch', name: '' }) },
      { label: 'Switch branch…', testId: 'git-menu-switch', tooltip: glossaryLines('branch'), onSelect: () => open({ op: 'switch-branch', branch: '' }) }
    )
    if (repo.branch !== null && repo.branch !== 'main' && repo.branch !== 'master') {
      items.push({ label: 'Rebase onto main…', testId: 'git-menu-rebase-main', tooltip: glossaryLines('rebase'), onSelect: () => open({ op: 'rebase', onto: 'main' }) })
    }
    if (repo.upstream !== null) {
      items.push({
        label: `Rebase onto ${repo.upstream}…`,
        testId: 'git-menu-rebase-upstream',
        tooltip: glossaryLines('rebase'),
        onSelect: () => open({ op: 'rebase', onto: 'upstream' })
      })
    }
    sep(items)
    items.push({
      label: 'Undo last commit…',
      testId: 'git-menu-undo',
      tooltip: glossaryLines('undo-commit'),
      onSelect: () => open({ op: 'undo-commit' })
    })
  }
  if (repo.remoteUrl === null) {
    items.push({
      label: 'Connect remote…',
      testId: 'git-menu-connect',
      tooltip: glossaryLines('remote'),
      onSelect: () => open({ op: 'connect-remote', url: '' })
    })
  }
  if (repo.changes.length > 0) {
    sep(items)
    items.push({
      label: 'Discard all changes…',
      testId: 'git-menu-discard-all',
      danger: true,
      tooltip: glossaryLines('discard'),
      onSelect: () => open({ op: 'discard', paths: null })
    })
  }
  return items
}

export function RepoMenu({ repo, projectId }: { repo: RepoState; projectId: Id }): React.JSX.Element {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const openDialog = useGitOpsStore((s) => s.openDialog)
  const items = menuItems(repo, projectId, (req) => openDialog(repo.root, repo.name, req))
  return (
    <>
      <Tooltip lines={['More git actions']}>
        <button
          type="button"
          className={styles.headerBtn}
          aria-label="More git actions"
          aria-haspopup="menu"
          data-testid="git-repo-menu"
          disabled={items.length === 0}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setAt({ x: r.left, y: r.bottom + 2 })
          }}
        >
          ⋯
        </button>
      </Tooltip>
      {at && <ContextMenu x={at.x} y={at.y} items={items} onClose={() => setAt(null)} testId="git-repo-menu-list" ariaLabel="Git actions" />}
    </>
  )
}
