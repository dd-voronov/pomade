// Pomade T-185 — the reading-position CAPTURE registry (runtime-only, not persisted, not reactive).
//
// Persisting the viewport top means reading it off the LIVE editor at exactly the right moments —
// tab switch, close, quit — never per-scroll-tick. The visible EditorPane registers a capturer for
// its tab (a closure that reads its controller's `getViewportAnchor()` and writes it onto the tab
// via `setDocMeta`), and the save-point owners invoke it:
//   • tabs-store.setActive  — captures the OUTGOING tab BEFORE the switch (it is still visible, so
//     its scroll geometry is still measurable — a hidden pane is display:none and reads 0).
//   • tabs-store.closeTab   — captures the closing tab before it leaves, so its reopen-stack entry
//     (T-149) carries the position.
//   • App quit handler      — `captureAllViewports()` before `flushAllProjectState()`, so the
//     final visible position rides the quit flush.
//
// Only the single visible pane ever has a registered, measurable capturer; hidden panes keep the
// position last written onto their tab, which is exactly what a later reopen/restart restores.

const capturers = new Map<string, () => void>()

/** The visible EditorPane registers its tab's capturer; the returned disposer unregisters it
 *  (guarded so a stale disposer can't drop a newer registration for the same tab). */
export function registerViewportCapturer(tabId: string, fn: () => void): () => void {
  capturers.set(tabId, fn)
  return () => {
    if (capturers.get(tabId) === fn) capturers.delete(tabId)
  }
}

/** Capture one tab's live viewport now (no-op when the tab has no visible pane registered). */
export function captureViewport(tabId: string | undefined): void {
  if (tabId) capturers.get(tabId)?.()
}

/** Capture every currently-registered (visible) pane's viewport — the quit-flush entry point. */
export function captureAllViewports(): void {
  for (const fn of capturers.values()) fn()
}
