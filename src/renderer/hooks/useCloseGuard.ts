// Pomade — the shared close-guard (T-044/T-118). A pane registers a guard so EVERY close path
// (× button, Cmd+W, batch close) can confirm before discarding something valuable (an editor's
// unsaved edits, a live agent's context, a busy terminal's running command). The `closeDoneRef`
// batch-callback pattern lives here once: a batch close (Close others / Close to the right) passes
// a `done` we MUST fire when this tab's turn resolves (closed OR the prompt cancelled) so the next
// tab is processed; it is held while the modal is up.
//
// T-118 invariant (owned here): the guard activates its tab ONLY on the PROMPTING branch — the
// confirm is rendered by a pane that is display:none while hidden, so it must be made visible to
// decide about. A silent close must NOT touch the active tab: pre-focusing it turned a silent close
// of an inactive tab into an active one, moving the user's focus (T-107's right-neighbour rule).

import { useEffect, useRef, useState } from 'react'

import { useTabsStore, type CloseOutcome } from '../stores/tabs-store'

export interface CloseGuard {
  /** Whether the unsaved/running confirm dialog is currently shown. */
  prompt: boolean
  setPrompt: (v: boolean) => void
  /** Fire (and clear) the held batch callback with the outcome. */
  resolveClose: (outcome?: CloseOutcome) => void
  /** Close this tab now (`closeTab(projectId, tabId)`). */
  closeNow: () => void
  /** Run the guard for a direct close gesture (a pane's own × button); `done` is optional. */
  requestClose: (done?: (outcome?: CloseOutcome) => void) => void
}

// `shouldPrompt` is read at close-REQUEST time (not memoized) so a live signal — an editor's
// `dirty`, a terminal's foreground-busy ref — is always current.
export function useCloseGuard(
  projectId: string,
  tabId: string,
  shouldPrompt: () => boolean
): CloseGuard {
  const closeTab = useTabsStore((s) => s.closeTab)
  const setActive = useTabsStore((s) => s.setActive)
  const registerCloseGuard = useTabsStore((s) => s.registerCloseGuard)
  const unregisterCloseGuard = useTabsStore((s) => s.unregisterCloseGuard)
  const [prompt, setPrompt] = useState(false)
  const closeDoneRef = useRef<((outcome?: CloseOutcome) => void) | null>(null)

  const resolveClose = (outcome?: CloseOutcome): void => {
    const done = closeDoneRef.current
    closeDoneRef.current = null
    done?.(outcome)
  }
  const closeNow = (): void => closeTab(projectId, tabId)
  const requestClose = (done?: (outcome?: CloseOutcome) => void): void => {
    if (shouldPrompt()) {
      setActive(projectId, tabId)
      closeDoneRef.current = done ?? null
      setPrompt(true)
    } else {
      closeTab(projectId, tabId)
      done?.()
    }
  }
  // Latest closure kept in a ref so the registered guard always runs the current one.
  const requestCloseRef = useRef(requestClose)
  requestCloseRef.current = requestClose
  useEffect(() => {
    registerCloseGuard(tabId, (done) => {
      requestCloseRef.current(done)
    })
    return () => unregisterCloseGuard(tabId)
  }, [projectId, tabId, registerCloseGuard, unregisterCloseGuard])

  return { prompt, setPrompt, resolveClose, closeNow, requestClose }
}
