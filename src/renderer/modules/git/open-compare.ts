// Pomade — E-037: opening comparison tabs. One tab per comparison (the same two sources focus the
// open tab). The title is set once at open time from the commits involved (`compareTitle`).
//
//   openComparison(projectId, left, right, opts)     any two sources
//   openChange(…) (open-change.ts)                    Changes row → HEAD ↔ the current document
//   openCommitFile(projectId, repo, commit, file)     commit-details file → parent ↔ commit
//   setComparisonSides(projectId, tabId, left, right) T-224: a comparison tab's sides changed in place

import { nanoid } from 'nanoid'

import { compareKey, compareTitle, type CompareSource, type RevisionInfo } from '@shared/compare'
import type { CommitDetails, CommitFile } from '@shared/git-history'
import { joinRel } from '@shared/git-state'
import type { CompareTab, Id } from '@shared/types'
import { useTabsStore } from '../../stores/tabs-store'
import { openThroughPreview } from './open-git-tabs'

/** The commit a rev side points at, for the title (null when it does not resolve). */
async function revisionOf(s: CompareSource): Promise<RevisionInfo | undefined> {
  if (s.kind !== 'rev') return undefined
  try {
    const f = await window.pomade.git.fileAt(s.repo, s.rev, s.path)
    return f.kind === 'no-revision' ? undefined : f.commit
  } catch {
    return undefined
  }
}

/** Opens still reading their titles, by project + comparison: a second click (a double click's
 *  two clicks) waits for the first and then focuses its tab instead of opening a twin. */
const opening = new Map<string, Promise<void>>()

export async function openComparison(
  projectId: Id,
  left: CompareSource,
  right: CompareSource,
  opts: { preview: boolean; info?: { left?: RevisionInfo; right?: RevisionInfo } }
): Promise<void> {
  const key = `${projectId}\0${compareKey(left, right)}`
  const inFlight = opening.get(key)
  if (inFlight) await inFlight.catch(() => {})
  const tabs = useTabsStore.getState()
  const existing = tabs
    .tabsFor(projectId)
    .find((t): t is CompareTab => t.kind === 'compare' && compareKey(t.left, t.right) === compareKey(left, right))
  if (existing) {
    tabs.setActive(projectId, existing.id)
    if (!opts.preview) tabs.commitPreview(projectId, existing.id)
    return
  }
  const run = (async () => {
    const info = opts.info ?? {}
    const [l, r] = await Promise.all([info.left ?? revisionOf(left), info.right ?? revisionOf(right)])
    const tab: CompareTab = {
      id: nanoid(),
      projectId,
      kind: 'compare',
      left,
      right,
      title: compareTitle(left, right, { left: l, right: r }, Date.now())
    }
    openThroughPreview(tab, opts.preview)
  })()
  opening.set(key, run)
  try {
    await run
  } finally {
    if (opening.get(key) === run) opening.delete(key)
  }
}

/** A commit's file: its parent's version ↔ this commit's (both read-only). A root commit has no
 *  parent version; an added file's parent side and a deleted file's commit side read as absent. */
export function openCommitFile(
  projectId: Id,
  repo: string,
  commit: CommitDetails,
  file: CommitFile,
  opts: { preview: boolean }
): Promise<void> {
  const path = joinRel(repo, file.path)
  const parent = commit.parents[0]
  const left: CompareSource = parent
    ? { kind: 'rev', repo, rev: parent, path: joinRel(repo, file.from ?? file.path) }
    : { kind: 'none' }
  const right: CompareSource = { kind: 'rev', repo, rev: commit.hash, path }
  const self: RevisionInfo = { hash: commit.hash, date: commit.date, subject: commit.subject }
  return openComparison(projectId, left, right, { preview: opts.preview, info: { right: self } })
}

/** T-224 — a comparison tab shows another pair in place: its sources and title change, the pane
 *  re-reads both sides. A preview tab is kept: the user worked in it. Another tab may already show
 *  the same pair; both stay. */
export async function setComparisonSides(projectId: Id, tabId: Id, left: CompareSource, right: CompareSource): Promise<void> {
  const [l, r] = await Promise.all([revisionOf(left), revisionOf(right)])
  const tabs = useTabsStore.getState()
  tabs.commitPreview(projectId, tabId)
  tabs.updateTab(projectId, tabId, { left, right, title: compareTitle(left, right, { left: l, right: r }, Date.now()) })
}
