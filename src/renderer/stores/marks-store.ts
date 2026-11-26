// Pomade — E-032 marks-store (renderer): the ONE mechanism behind attention marks and count badges
// on strip icons and rows. A mark is `{ count, urgent, quiet? }`, set by a SOURCE on a TARGET; what a
// target shows is all its sources combined (counts summed, urgent if any is, quiet — grey — only if
// all are). Targets:
//   strip:<stripKey>     — a strip icon (`files`, `git`, `notices`, `app:<appId>/<iconId>`)
//   row:project:<id>     — a project's row in the Projects panel (and its rail launcher)
//   row:repo:<root>      — a repository's row in the Git panel's lists (E-039)
// Sources: `app:<appId>` (`strip.setBadge`), `notices` / `notices-muted` (unread notices of unmuted /
// muted sources; the latter quiet), and the platform's own
// producers: `git:<root>` — a failed git operation in that repo, on the Git icon and the repo's
// row, until the repo is opened (E-039). Terminal attention feeds
// the project rows as a DERIVED source: a project's count is its tabs carrying the unread dot
// (T-151), computed from the tab set exactly as before and combined with the rows' set marks.
// Runtime only.

import { useMemo } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import type { Id, Tab } from '@shared/types'
import { useTabsStore } from './tabs-store'

export interface Mark {
  count: number
  urgent: boolean
  /** Counted but not calling for attention (drawn grey) — e.g. unread notices of a muted app. */
  quiet?: boolean
}

/** target → source → mark. */
export type Marks = Readonly<Record<string, Readonly<Record<string, Mark>>>>

export const stripTarget = (stripKey: string): string => `strip:${stripKey}`
export const projectRowTarget = (projectId: Id): string => `row:project:${projectId}`
export const repoRowTarget = (root: string): string => `row:repo:${root}`

/** `marks` with `source`'s mark on `target` set (a count ≤ 0, or null, removes it). Unchanged → the same object. */
export function withMark(marks: Marks, target: string, source: string, mark: Mark | null): Marks {
  const cur = marks[target]?.[source]
  if (!mark || mark.count <= 0) {
    if (!cur) return marks
    const rest = { ...marks[target] }
    delete rest[source]
    const next = { ...marks }
    if (Object.keys(rest).length > 0) next[target] = rest
    else delete next[target]
    return next
  }
  const quiet = mark.quiet === true
  if (cur && cur.count === mark.count && cur.urgent === mark.urgent && (cur.quiet === true) === quiet) return marks
  const next: Mark = { count: mark.count, urgent: mark.urgent, ...(quiet ? { quiet } : {}) }
  return { ...marks, [target]: { ...marks[target], [source]: next } }
}

/** `marks` without anything `source` set. Unchanged → the same object. */
export function withoutSource(marks: Marks, source: string): Marks {
  let next: Record<string, Readonly<Record<string, Mark>>> | null = null
  for (const [target, bySource] of Object.entries(marks)) {
    if (!(source in bySource)) continue
    next ??= { ...marks }
    const rest = { ...bySource }
    delete rest[source]
    if (Object.keys(rest).length > 0) next[target] = rest
    else delete next[target]
  }
  return next ?? marks
}

/** What `target` shows: its sources combined, or undefined when none marks it. */
export function combinedMark(marks: Marks, target: string): Mark | undefined {
  const bySource = marks[target]
  if (!bySource) return undefined
  let count = 0
  let urgent = false
  let quiet = true
  for (const m of Object.values(bySource)) {
    count += m.count
    urgent ||= m.urgent
    quiet &&= m.quiet === true
  }
  if (count <= 0) return undefined
  return quiet ? { count, urgent, quiet } : { count, urgent }
}

/** Terminal attention, the rows' derived source: per project, its tabs carrying the unread dot. */
export function tabAttentionCounts(tabsByProject: Readonly<Record<Id, readonly Tab[]>>): Record<Id, number> {
  const out: Record<Id, number> = {}
  for (const [pid, tabs] of Object.entries(tabsByProject)) {
    let n = 0
    for (const t of tabs) if (t.attention) n++
    if (n > 0) out[pid] = n
  }
  return out
}

/** Project row counts: the derived tab counts plus the rows' set marks. Without row marks it is
 *  `fromTabs` itself (the same object, so a consumer does not re-render). */
export function projectRowCounts(fromTabs: Record<Id, number>, marks: Marks): Record<Id, number> {
  const prefix = projectRowTarget('')
  let out: Record<Id, number> | null = null
  for (const target of Object.keys(marks)) {
    if (!target.startsWith(prefix)) continue
    const mark = combinedMark(marks, target)
    if (!mark) continue
    out ??= { ...fromTabs }
    const id = target.slice(prefix.length)
    out[id] = (out[id] ?? 0) + mark.count
  }
  return out ?? fromTabs
}

interface MarksState {
  marks: Marks
  setMark: (target: string, source: string, mark: Mark | null) => void
  clearSource: (source: string) => void
}

export const useMarksStore = create<MarksState>((set) => ({
  marks: {},
  setMark: (target, source, mark) => set((s) => ({ marks: withMark(s.marks, target, source, mark) })),
  clearSource: (source) => set((s) => ({ marks: withoutSource(s.marks, source) }))
}))

/** A strip icon's badge. */
export function useStripMark(stripKey: string): Mark | undefined {
  return useMarksStore(useShallow((s) => combinedMark(s.marks, stripTarget(stripKey)) ?? null)) ?? undefined
}

/** A Git panel repo row's mark. */
export function useRepoRowMark(root: string): Mark | undefined {
  return useMarksStore(useShallow((s) => combinedMark(s.marks, repoRowTarget(root)) ?? null)) ?? undefined
}

/** Every project row's count (the Projects panel, the rail). */
export function useProjectRowCounts(): Record<Id, number> {
  // T-181 — computed inside the selector and compared shallowly: an unrelated tab field change
  // keeps the same counts object, so the Projects panel does not re-render for it.
  const fromTabs = useTabsStore(useShallow((s) => tabAttentionCounts(s.tabsByProject)))
  const marks = useMarksStore((s) => s.marks)
  return useMemo(() => projectRowCounts(fromTabs, marks), [fromTabs, marks])
}
