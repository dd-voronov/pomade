// Pomade — E-037: opening the git detail tabs. A single click in the Git panel opens its tab
// through the project's preview slot (the same "Single click opens a preview tab" setting the tree
// uses), so browsing History leaves one tab, not twenty; Enter or a row's "Open in a new tab"
// opens a tab that stays. A tab already open for the same thing is focused instead.

import { nanoid } from 'nanoid'

import type { BranchTab, CommitTab, ConflictTab, Id, Tab } from '@shared/types'
import { useAppSettingsStore } from '../../stores/app-settings-store'
import { useTabsStore } from '../../stores/tabs-store'

/** Open `tab` as the project's preview (replacing a preview that is a clean doc or another git
 *  detail tab), or as a real tab. */
export function openThroughPreview(tab: Tab, preview: boolean): void {
  const tabs = useTabsStore.getState()
  if (!preview || !useAppSettingsStore.getState().previewTabMode) {
    tabs.openTab(tab)
    return
  }
  const previewId = tabs.previewTabByProject[tab.projectId]
  const current = previewId ? tabs.tabsFor(tab.projectId).find((t) => t.id === previewId) : undefined
  const replaceable =
    current && (current.kind === 'commit' || current.kind === 'compare' || current.kind === 'branch' || (current.kind === 'doc' && !current.dirty))
  if (current && replaceable) tabs.replacePreviewTab(tab.projectId, current.id, tab)
  else tabs.openTab(tab, { preview: true })
}

/** Open (or focus) the commit-details tab for `hash` in `repo`. */
export function openCommitTab(
  projectId: Id,
  repo: string,
  commit: { hash: string; subject: string },
  opts: { preview: boolean }
): void {
  const tabs = useTabsStore.getState()
  const existing = tabs
    .tabsFor(projectId)
    .find((t): t is CommitTab => t.kind === 'commit' && t.repo === repo && t.hash === commit.hash)
  if (existing) {
    tabs.setActive(projectId, existing.id)
    if (!opts.preview) tabs.commitPreview(projectId, existing.id)
    return
  }
  const tab: CommitTab = {
    id: nanoid(),
    projectId,
    kind: 'commit',
    repo,
    hash: commit.hash,
    title: commit.subject || commit.hash.slice(0, 7)
  }
  openThroughPreview(tab, opts.preview)
}

/** Open (or focus) the conflict tab of the rebase stopped in `repo` (`name` titles it). A real tab,
 *  never the preview slot: it holds work in progress. */
export function openConflictTab(projectId: Id, repo: string, name: string): void {
  const tabs = useTabsStore.getState()
  const existing = tabs.tabsFor(projectId).find((t): t is ConflictTab => t.kind === 'conflict' && t.repo === repo)
  if (existing) {
    tabs.setActive(projectId, existing.id)
    return
  }
  tabs.openTab({ id: nanoid(), projectId, kind: 'conflict', repo, title: `Conflict · ${name}` } satisfies ConflictTab)
}

/** Open (or focus) the branch tab of `branch` (`feature`, `origin/feature`) in `repo`: through the
 *  preview slot on a single click, like a commit. */
export function openBranchTab(projectId: Id, repo: string, branch: string, opts: { preview: boolean }): void {
  const tabs = useTabsStore.getState()
  const existing = tabs.tabsFor(projectId).find((t): t is BranchTab => t.kind === 'branch' && t.repo === repo && t.branch === branch)
  if (existing) {
    tabs.setActive(projectId, existing.id)
    if (!opts.preview) tabs.commitPreview(projectId, existing.id)
    return
  }
  openThroughPreview({ id: nanoid(), projectId, kind: 'branch', repo, branch, title: branch } satisfies BranchTab, opts.preview)
}
