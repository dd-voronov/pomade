// Pomade — unbound-store (renderer). E-025 slice 5.
// RUNTIME-ONLY, per-run reactive state for the Unbound ⚠️ affordance: which tabs' CURRENT
// unbound session the user chose to silence ("Ignore" in the recovery popover). Deliberately a
// tiny runtime-only leaf store and NOT a persisted tab field: "silence" is
// scoped to THIS unbound session — a rebind consumes it (terminals-store clears the flag on a
// bind and on the agent-exit downgrade), so a LATER unbound session surfaces the mark again,
// and an app restart turns an unbound tab into a dead pane anyway (no auto-resume without a
// trusted id), where no mark renders.

import { create } from 'zustand'

import type { Id } from '@shared/types'

interface UnboundState {
  /** tabId → true while the user has silenced the tab's CURRENT unbound session. */
  silenced: Record<Id, true | undefined>
  silence: (tabId: Id) => void
  unsilence: (tabId: Id) => void
}

export const useUnboundStore = create<UnboundState>((set, get) => ({
  silenced: {},
  silence: (tabId) => {
    set((s) => ({ silenced: { ...s.silenced, [tabId]: true } }))
  },
  unsilence: (tabId) => {
    if (!get().silenced[tabId]) return // guarded — a no-op for the common (never-silenced) case
    set((s) => {
      const next = { ...s.silenced }
      delete next[tabId]
      return { silenced: next }
    })
  }
}))
