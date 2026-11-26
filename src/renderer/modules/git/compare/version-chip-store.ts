// Pomade — T-224: which comparison tab has a version chip's list open, and for which side
// (session-only: the list is a transient picker). Cmd+Shift+H opens the left one.

import { create } from 'zustand'

import type { CompareSide } from '@shared/doc-history'
import type { Id } from '@shared/types'

interface VersionChipState {
  /** Comparison tab ids with a chip's list open, and its side. */
  open: Record<Id, CompareSide | undefined>
  show: (tabId: Id, side: CompareSide) => void
  hide: (tabId: Id) => void
}

export const useVersionChipStore = create<VersionChipState>((set) => ({
  open: {},
  show: (tabId, side) => set((s) => (s.open[tabId] === side ? s : { open: { ...s.open, [tabId]: side } })),
  hide: (tabId) =>
    set((s) => {
      if (!s.open[tabId]) return s
      const open = { ...s.open }
      delete open[tabId]
      return { open }
    })
}))
