// Pomade — agent-live-store (renderer). E-033.
// RUNTIME-ONLY: what the agent in each term is doing right now (working · needs-you · idle), as
// main reads it from the agent's output (EV.ptyAgentState — the kit's AgentStateScanner). Keyed by
// termId; main resets a term to idle whenever an agent starts in it. Feeds the agent tabs' live
// state (`modules/agents/agent-tabs.ts`).

import { create } from 'zustand'

import type { PtyAgentState } from '@shared/types'

interface AgentLiveState {
  /** termId → the agent's live state, for every term an agent started in during this run. */
  states: Record<string, PtyAgentState['state']>
  set: (payload: PtyAgentState) => void
}

export const useAgentLiveStore = create<AgentLiveState>((set, get) => ({
  states: {},
  set: ({ termId, state }) => {
    if (get().states[termId] === state) return
    set((s) => ({ states: { ...s.states, [termId]: state } }))
  }
}))

/** Start listening; returns the stop function. Mounted once, in `App`. */
export function startAgentLiveStates(): () => void {
  return window.pomade.pty.onAgentState((payload) => useAgentLiveStore.getState().set(payload))
}
