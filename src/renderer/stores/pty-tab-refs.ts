// Pomade — E-031: tell main which tab (and project) each term runs in, so `agentTab.exited` can
// name them. Diffed off `tabsByProject` like the PTY reaper: a term is reported when it first
// appears (creation, hydration, a relaunch's termId swap) and again when its tab moves to another
// project. Nothing is reported on close — main must still know the tab while the reaper's kill
// ends the term.

import type { Id } from '@shared/types'
import { useTabsStore } from './tabs-store'

/** termId → its tab and project, for every terminal/agent tab in the store. */
export function termTabs(tabsByProject: Readonly<Record<Id, readonly { id: Id; kind: string; termId?: string }[]>>): Map<string, { tabId: Id; projectId: Id }> {
  const out = new Map<string, { tabId: Id; projectId: Id }>()
  for (const [projectId, tabs] of Object.entries(tabsByProject)) {
    for (const t of tabs) {
      if ((t.kind === 'terminal' || t.kind === 'agent') && t.termId) out.set(t.termId, { tabId: t.id, projectId })
    }
  }
  return out
}

/** Start reporting; returns the stop function. Mounted once, in `App`. */
export function startPtyTabRefs(): () => void {
  let known = new Map<string, { tabId: Id; projectId: Id }>()
  const sync = (tabsByProject: Parameters<typeof termTabs>[0]): void => {
    const now = termTabs(tabsByProject)
    for (const [termId, tab] of now) {
      const before = known.get(termId)
      if (before?.tabId !== tab.tabId || before.projectId !== tab.projectId) void window.pomade.pty.setTab(termId, tab)
    }
    known = now
  }
  sync(useTabsStore.getState().tabsByProject)
  return useTabsStore.subscribe((s, prev) => {
    if (s.tabsByProject !== prev.tabsByProject) sync(s.tabsByProject)
  })
}
