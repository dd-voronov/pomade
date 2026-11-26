// Pomade — jump-store (renderer). E-020 (T-086).
// A one-shot "put the caret on line N of tab T" request, dispatched when a `path:line` link is
// Cmd+clicked in a terminal and consumed by that tab's EditorPane once its raw controller is
// ready (the pane may not even be mounted yet at click time).
//
// Deliberately a TRANSIENT store, never a field on the tab: a line number is a one-time
// navigation intent, not a property of the document. Persisting it on the tab would mean every
// restart re-jumped the caret to wherever a terminal link once pointed, and the tab's shape is
// serialized into ProjectState where an ephemeral value has no business being.
//
// `nonce` makes an identical repeat request (same tab, same line) re-fire the consumer's effect;
// `take()` clears the slot so a jump is applied exactly once.

import { create } from 'zustand'

export interface JumpRequest {
  tabId: string
  /** 1-based line. Clamped to the document by the editor controller. */
  line: number
  nonce: number
}

interface JumpState {
  request: JumpRequest | null
  /** Ask tab `tabId` to place its caret on 1-based `line`. */
  jumpTo: (tabId: string, line: number) => void
  /** Consume the pending request for `tabId` (returns the line, or null when there is none). */
  take: (tabId: string) => number | null
}

let seq = 0

export const useJumpStore = create<JumpState>((set, get) => ({
  request: null,
  jumpTo: (tabId, line) => set({ request: { tabId, line, nonce: ++seq } }),
  take: (tabId) => {
    const req = get().request
    if (!req || req.tabId !== tabId) return null
    set({ request: null })
    return req.line
  }
}))
