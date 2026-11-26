// Pomade T-184 — CodeMirror 6 Cmd+click link layer, shared by RAW and LIVE editors.
//
// Terminal parity (E-020 / T-092): plain click stays pure caret/selection; Cmd+hover underlines
// EXISTENCE-VALIDATED links only (no dead links — an unresolvable token is never decorated), and
// Cmd+click opens through the terminal router. The layer is INERT while Cmd is up — the mousemove
// handler early-returns, so editor typing latency and idle hovering pay nothing.
//
// Cost model (the Owner, explicit): scanning is scoped to the ONE line under the pointer; resolution
// goes through the terminal resolver's cache (POSITIVE ~5 s / NEGATIVE ~30 s); a doc edit clears
// the decorations (so there is no per-keystroke work); and nothing probes a line the pointer never
// Cmd+hovers.

import { StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type PluginValue
} from '@codemirror/view'

import {
  activateEditorLink,
  resolveRegion,
  scanLineRegions,
  type EditorLinkNav,
  type ResolvedLink
} from './editor-links'

/** A resolved, on-screen link range in DOC coordinates, kept for click hit-testing. */
interface ActiveLink {
  from: number
  to: number
  resolved: ResolvedLink
}

const linkMark = Decoration.mark({ class: 'cm-editorLink' })

// Decorations live in a StateField driven by effects — the resolve step is async, so the plugin
// dispatches an effect when a line's probes come back. A doc change clears them (the layer must
// never survive an edit as a stale underline, and this is also what keeps it silent while typing).
const setLinkDeco = StateEffect.define<DecorationSet>()
const clearLinkDeco = StateEffect.define<null>()

const linkDecoField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = tr.docChanged ? Decoration.none : deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setLinkDeco)) next = e.value
      else if (e.is(clearLinkDeco)) next = Decoration.none
    }
    return next
  },
  provide: (f) => EditorView.decorations.from(f)
})

const linkBaseTheme = EditorView.baseTheme({
  '.cm-editorLink': { textDecoration: 'underline', cursor: 'pointer' }
})

/**
 * The shared CM link extension. Pass the host's `EditorLinkNav` (doc resolution bases + the
 * ambiguity-picker opener). Returns the decoration field, the interaction plugin, and the base
 * theme — RawEditor and LiveEditor add the exact same array.
 */
export function editorLinks(nav: EditorLinkNav): Extension {
  const plugin = ViewPlugin.fromClass(
    class implements PluginValue {
      private meta = false
      private inside = false
      private seq = 0
      private lastLineFrom = -1
      private lastX = 0
      private lastY = 0
      private active: ActiveLink[] = []

      constructor(private readonly view: EditorView) {
        window.addEventListener('keydown', this.onKey)
        window.addEventListener('keyup', this.onKey)
        window.addEventListener('blur', this.onBlur)
        view.scrollDOM.addEventListener('mousemove', this.onMove)
        view.scrollDOM.addEventListener('mouseenter', this.onEnter)
        view.scrollDOM.addEventListener('mouseleave', this.onLeave)
      }

      destroy(): void {
        window.removeEventListener('keydown', this.onKey)
        window.removeEventListener('keyup', this.onKey)
        window.removeEventListener('blur', this.onBlur)
        this.view.scrollDOM.removeEventListener('mousemove', this.onMove)
        this.view.scrollDOM.removeEventListener('mouseenter', this.onEnter)
        this.view.scrollDOM.removeEventListener('mouseleave', this.onLeave)
      }

      // Cmd tracking. Releasing Cmd clears the affordance immediately; pressing it while the
      // pointer is already parked over this pane re-scans the parked line (a stationary press must
      // still underline — the terminal's T-092 "wiggle to wake" lesson). Gated on `inside` so a
      // hidden pane (display:none, never entered) never probes on a global Cmd keydown.
      private onKey = (e: KeyboardEvent): void => {
        if (e.metaKey === this.meta) return
        this.meta = e.metaKey
        if (!this.meta) this.clear()
        else if (this.inside) this.scan(this.lastX, this.lastY)
      }
      // A blurred window never delivers the keyup, so treat blur as "Cmd released".
      private onBlur = (): void => {
        if (!this.meta) return
        this.meta = false
        this.clear()
      }

      private onEnter = (): void => {
        this.inside = true
      }
      private onLeave = (): void => {
        this.inside = false
        this.clear()
      }

      private onMove = (e: MouseEvent): void => {
        this.lastX = e.clientX
        this.lastY = e.clientY
        if (!this.meta) return // INERT while Cmd is up — no scan, no probe.
        this.scan(e.clientX, e.clientY)
      }

      // Scan + resolve the ONE line under (x, y). Re-scanning the same line is skipped (the pointer
      // sweeping within a line must not re-probe); a fresh line bumps `seq` so a stale async reply
      // for the previous line is discarded on arrival.
      private scan(x: number, y: number): void {
        const pos = this.view.posAtCoords({ x, y })
        if (pos == null) {
          this.clear()
          return
        }
        const line = this.view.state.doc.lineAt(pos)
        if (line.from === this.lastLineFrom) return
        this.lastLineFrom = line.from
        const mySeq = ++this.seq
        const regions = scanLineRegions(line.text)
        if (regions.length === 0) {
          this.publish(mySeq, [])
          return
        }
        const ctx = nav.getContext()
        void Promise.all(
          regions.map(async (r) => ({ r, resolved: await resolveRegion(r, ctx) }))
        ).then((results) => {
          if (mySeq !== this.seq || !this.meta) return // superseded, or Cmd released mid-probe
          const active: ActiveLink[] = []
          for (const { r, resolved } of results) {
            if (!resolved) continue // unresolvable ⇒ never underlined (no dead links)
            active.push({ from: line.from + r.from, to: line.from + r.to, resolved })
          }
          this.publish(mySeq, active)
        })
      }

      private publish(mySeq: number, active: ActiveLink[]): void {
        if (mySeq !== this.seq) return
        this.active = active
        // `true` sorts the ranges: wikilink / markdown-link regions are collected before plain
        // candidates, so the list is not in document order and CM requires sorted decoration ranges.
        const deco = active.length
          ? Decoration.set(
              active.map((a) => linkMark.range(a.from, a.to)),
              true
            )
          : Decoration.none
        this.view.dispatch({ effects: setLinkDeco.of(deco) })
      }

      private clear(): void {
        this.seq++
        this.lastLineFrom = -1
        if (this.active.length === 0 && this.view.state.field(linkDecoField).size === 0) return
        this.active = []
        this.view.dispatch({ effects: clearLinkDeco.of(null) })
      }

      // Cmd+mousedown activates a link and consumes the event (so the caret never moves); a plain
      // mousedown is left entirely to CodeMirror (pure caret/selection). A Cmd+click over a
      // resolved link (from the current hover) fires immediately; a "cold" Cmd+click over a
      // link-SHAPED token with no prior hover resolves on the spot and then routes.
      handleMouseDown(e: MouseEvent): boolean {
        if (!e.metaKey) return false
        const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY })
        if (pos == null) return false
        const hit = this.active.find((a) => pos >= a.from && pos <= a.to)
        if (hit) {
          e.preventDefault()
          activateEditorLink(hit.resolved, e.clientX, e.clientY, nav.onAmbiguous)
          return true
        }
        const line = this.view.state.doc.lineAt(pos)
        const region = scanLineRegions(line.text).find(
          (r) => pos >= line.from + r.from && pos <= line.from + r.to
        )
        if (!region) return false // Cmd+click on non-link text ⇒ leave the caret to CodeMirror
        e.preventDefault()
        const { clientX, clientY } = e
        void resolveRegion(region, nav.getContext()).then((resolved) => {
          if (resolved) activateEditorLink(resolved, clientX, clientY, nav.onAmbiguous)
        })
        return true
      }
    }
  )

  const clickHandler = EditorView.domEventHandlers({
    mousedown(e, view) {
      const value = view.plugin(plugin)
      return value ? value.handleMouseDown(e) : false
    }
  })

  return [linkDecoField, plugin, clickHandler, linkBaseTheme]
}
