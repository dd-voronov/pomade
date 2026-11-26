// Pomade — T-327: why an agent tab's session changed (docs/HOST-API.md §4 `agentTabs`, "Bindings
// over time"), as `agentTab.changed` carries it: `session: { cause, previousSessionId }`.
//
// The cause is read off evidence, never guessed:
//   • what opened the bind window — the tab's agent launch, the session command typed in the tab
//     (`AGENT_SESSION_COMMANDS`: clear · fork · resume), or a retry while the tab had no trusted id;
//   • the new transcript's own record of its parent (`forkedFrom`, read in main by the session
//     watcher: claude's `forkedFrom.sessionId` on a branch's copied lines, codex's line-0
//     `session_meta.forked_from_id`) — a transcript that names a parent is a fork whatever
//     opened the window.
// A retry window after the tab already had a session has neither, so it is `unknown`; so is a
// binding that goes to `null` (Pomade can no longer tell which session the tab holds) and a
// session the user binds by hand.
//
// The terminals store notes the cause just before it writes the new binding; the event diff
// (`agent-tab-info.ts#agentTabEvents`) takes it when the session it explains reaches the list.

import type { AgentTabSessionCause, AgentTabSessionChange } from 'pomade-kit/protocol'

/** What opened a tab's bind window: its agent's launch (no resume), a session command typed in
 *  the tab, or a retry submit while the tab had no trusted id. */
export type BindTrigger = 'launch' | 'clear' | 'fork' | 'resume' | 'retry'

/** Why a window's bind happened. `forkedFrom` is the parent the new transcript records (null: none);
 *  `hadSession` whether the tab was bound to a session before (it decides a retry). */
export function bindCause(trigger: BindTrigger, forkedFrom: string | null, hadSession: boolean): AgentTabSessionCause {
  if (trigger === 'resume') return 'resume' // an existing session adopted — its own parent is history
  if (forkedFrom !== null) return 'fork'
  switch (trigger) {
    case 'launch':
      return 'first'
    case 'clear':
    case 'fork':
      return trigger
    case 'retry':
      return hadSession ? 'unknown' : 'first'
  }
}

/** The `session` part of an `agentTab.changed` whose changes include `session`: the noted cause of
 *  the session the tab now holds (`unknown` when none was noted for it, and always when the tab
 *  now holds none), and the session it held before. */
export function sessionChange(
  previousSessionId: string | null,
  sessionId: string | null,
  noted: AgentTabSessionCause | undefined
): AgentTabSessionChange {
  return { cause: sessionId === null ? 'unknown' : (noted ?? 'unknown'), previousSessionId }
}

// tabId → the cause of the binding the store is about to write, and the session it explains.
const notes = new Map<string, { sessionId: string; cause: AgentTabSessionCause }>()

/** The tab is about to be bound to `sessionId`, for `cause`. */
export function noteSessionCause(tabId: string, sessionId: string, cause: AgentTabSessionCause): void {
  notes.set(tabId, { sessionId, cause })
}

/** Drop a tab's note (its agent left, or a binding Pomade cannot explain replaced it). */
export function forgetSessionCause(tabId: string): void {
  notes.delete(tabId)
}

/** The noted cause of the tab's binding to `sessionId`, consumed; undefined when the note is for
 *  another session or there is none. */
export function takeSessionCause(tabId: string, sessionId: string | null): AgentTabSessionCause | undefined {
  const note = notes.get(tabId)
  if (!note) return undefined
  notes.delete(tabId)
  return note.sessionId === sessionId ? note.cause : undefined
}
