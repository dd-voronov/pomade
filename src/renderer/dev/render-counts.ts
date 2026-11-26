// Pomade T-181 — render-count probe.
//
// A tiny module-level counter, bumped once in a component's body, exposed on window so an e2e
// spec can prove a subscription-narrowing fix actually stops a re-render (rather than trusting a
// selector's intent). Same precedent as `__pomadeStores` (App.tsx) and `__pomadeCaretTrace`
// (editor/caret-trace.ts): an always-on renderer-side hook, cheap and try/catch-guarded so
// diagnostics can never break the component they observe. Not part of the app surface.

declare global {
  interface Window {
    __pomadeRenderCounts?: Record<string, number>
  }
}

export function bumpRenderCount(name: string): void {
  try {
    const counts = (window.__pomadeRenderCounts ??= {})
    counts[name] = (counts[name] ?? 0) + 1
  } catch {
    /* diagnostics must never break the component they observe */
  }
}
