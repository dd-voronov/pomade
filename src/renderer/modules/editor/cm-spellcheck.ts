// T-083 — the OS spellchecker wiring for the two CodeMirror surfaces (raw + live). ONE place so
// the raw and live editors stay identical (a single object; T-179 dedupe ethos).
//
// WHY prose gets these and code does not: CodeMirror ships its contenteditable with
// `spellcheck=false`; prose files (markdown/txt) want the native red squiggles the rendered view
// has. `autocorrect`/`autocapitalize` stay OFF — hard autocorrection mid-markdown is worse than a
// squiggle (autocorrect became a live attribute in Chromium 44; before that it was inert).
//
// KNOWN Chromium limitation (Electron 44 / Chromium ≥ the 44 line), NOT an app defect:
// Chromium does not natively spell-check editable text that was inserted PROGRAMMATICALLY until
// that text is edited by the user. CodeMirror builds and continuously re-decorates its content DOM
// programmatically (syntax highlighting, viewport virtualization), so a freshly-OPENED CodeMirror
// document's text does not get red squiggles the way ProseMirror/Milkdown's does — ProseMirror
// minimises DOM mutation and so is checked on load. This is the CodeMirror maintainer's own
// account of the behaviour, and it tightened across Chromium majors (Electron 33's Chromium was
// lenient; Electron 44's is not). `nudgeSpellcheck` below is the best-effort mitigation; text the
// user actually types is checked normally via the input pipeline regardless.
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

/** The prose content-attributes (shared by RawEditor's prose branch and the always-prose
 *  LiveEditor). Overrides CodeMirror's `spellcheck=false` default. */
export const proseSpellcheckAttrs: Extension = EditorView.contentAttributes.of({
  spellcheck: 'true',
  autocorrect: 'off',
  autocapitalize: 'off'
})

/** Best-effort nudge to make Chromium (re)run a native spell pass over already-present text (see
 *  the module header for why loaded CodeMirror text is otherwise skipped). Toggling the
 *  `spellcheck` attribute across a frame prompts a fresh pass. This is ELEMENT-level only — it
 *  never touches line text nodes, so it does not perturb the `editor-spellcheck-stability`
 *  text-node-identity invariant (T-083 r3) — and it fires on focus / after mount, never on caret
 *  move. Returns a disposer the caller runs from its view-teardown. Reliability is bounded by the
 *  Chromium limitation above; the typed path does not depend on it. */
export function nudgeSpellcheck(view: EditorView): () => void {
  const el = view.contentDOM
  // The editor's OWN configured value (from proseSpellcheckAttrs, applied by CodeMirror during
  // construction — which has already run by the time this is called). Captured ONCE so a re-entrant
  // focusin can never read the transient 'false' and restore the wrong value. The nudge restores
  // THIS, never a hardcoded 'true', so it only re-triggers a pass — it never grants spellcheck
  // where the content attributes didn't.
  const own = el.getAttribute('spellcheck') ?? 'false'
  let backRaf = 0
  let mountRaf = 0
  let innerRaf = 0
  const nudge = (): void => {
    if (!view.dom.isConnected || own !== 'true') return
    // Off→own across a frame prompts a fresh spell pass. CodeMirror keeps its cached content-attrs
    // unchanged, so it won't clobber the restore.
    el.setAttribute('spellcheck', 'false')
    cancelAnimationFrame(backRaf)
    backRaf = requestAnimationFrame(() => {
      if (view.dom.isConnected) el.setAttribute('spellcheck', own)
    })
  }
  // One pass once the first layout + decoration have settled (double rAF).
  mountRaf = requestAnimationFrame(() => {
    innerRaf = requestAnimationFrame(nudge)
  })
  // And again whenever the user returns focus to the surface (about to read/edit).
  view.dom.addEventListener('focusin', nudge)
  return () => {
    cancelAnimationFrame(mountRaf)
    cancelAnimationFrame(innerRaf)
    cancelAnimationFrame(backRaf)
    view.dom.removeEventListener('focusin', nudge)
  }
}
