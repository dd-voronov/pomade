// Pomade — E-038: which doc tabs have their History panel open (session-only: the panel is a view,
// not document state), and the entry points that open it for a path.

import { create } from 'zustand'

import type { Id } from '@shared/types'
import { useTabsStore } from '../../../stores/tabs-store'

interface DocHistoryState {
  /** Doc tab ids whose History panel is open. */
  open: Record<Id, true | undefined>
  toggle: (tabId: Id) => void
  show: (tabId: Id) => void
  hide: (tabId: Id) => void
}

export const useDocHistoryStore = create<DocHistoryState>((set) => ({
  open: {},
  toggle: (tabId) =>
    set((s) => {
      const open = { ...s.open }
      if (open[tabId]) delete open[tabId]
      else open[tabId] = true
      return { open }
    }),
  show: (tabId) => set((s) => (s.open[tabId] ? s : { open: { ...s.open, [tabId]: true } })),
  hide: (tabId) =>
    set((s) => {
      if (!s.open[tabId]) return s
      const open = { ...s.open }
      delete open[tabId]
      return { open }
    })
}))

/** Open the doc for `path` (a tab for it is focused or created) with its History panel showing. */
export function openDocHistory(projectId: Id, path: string): void {
  const tabId = useTabsStore.getState().openDocByPath(projectId, path)
  useDocHistoryStore.getState().show(tabId)
}
