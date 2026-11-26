// Pomade T-004 (round 8) — caret-bridge flight recorder.
//
// Three rounds of "e2e green, field broken" mean the next field failure must explain itself:
// every stage of the toggle caret bridge (snapshot → schedule → match → land) appends one entry
// here. Read it from the running app via devtools (Cmd+Opt+I):  window.__pomadeCaretTrace
//
// Local-only diagnostics: entries hold at most the first 40 chars of a block's match key
// (the user's own document content, never leaving the renderer), tiny and bounded.

interface CaretTraceEntry {
  at: string
  stage: string
  [k: string]: unknown
}

const MAX_ENTRIES = 40

declare global {
  interface Window {
    __pomadeCaretTrace?: CaretTraceEntry[]
  }
}

export function traceCaret(stage: string, data: Record<string, unknown> = {}): void {
  try {
    const ring = (window.__pomadeCaretTrace ??= [])
    ring.push({ at: new Date().toISOString().slice(11, 23), stage, ...data })
    if (ring.length > MAX_ENTRIES) ring.splice(0, ring.length - MAX_ENTRIES)
  } catch {
    /* diagnostics must never break the feature they observe */
  }
}

/** Bounded, whitespace-collapsed preview of a match key for trace entries. */
export function traceKey(key: string): string {
  return key.slice(0, 40)
}
