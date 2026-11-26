// Pomade T-184 — ProseMirror (Milkdown) Cmd+click link layer for the RENDERED editor.
//
// The rendered-mode counterpart of `cm-editor-links.ts`: same terminal-parity behavior (plain
// click = caret/selection, Cmd+hover underlines existence-validated links only, Cmd+click routes
// through the terminal matrix), same shared scanner/resolver via `editor-links.ts`. Wikilinks are
// already rendered as literal `[[…]]` text and visually styled `.pm-wikilink` (T-054); this plugin
// adds the Cmd affordance + activation on top of the SAME text run rather than re-detecting them.
//
// Read-only by construction: it only reads the doc and dispatches meta-only transactions carrying
// its decorations — it never edits content, so the round-trip guard is untouched (this plugin, like
// the wikilink-decoration plugin beside it, is used ONLY by the live editor, never the headless
// guard). A markdown `[text](href)` link arrives here as a `link` MARK on its text: each run of
// link-marked text is one region whose target is the mark's `href` (resolved by
// `resolveMarkdownHref` — doc-folder-relative, existence-checked, URLs to the browser), and a plain
// candidate overlapping a link-marked run is skipped, so the link's TEXT is never guessed at
// (`[guide docs](x.md)` opens x.md, never a `guide` stem).

import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'

import {
  activateEditorLink,
  resolveRegion,
  scanLineRegions,
  type EditorLinkNav,
  type LineLinkRegion,
  type ResolvedLink
} from './editor-links'

interface ActiveLink {
  from: number
  to: number
  resolved: ResolvedLink
}
interface LinkPluginState {
  deco: DecorationSet
  active: ActiveLink[]
}
/** A textblock flattened for scanning: `text` is its plain text, `map[i]` the doc position of
 *  char `i`, `href[i]` the `href` of the `link` mark on that char (null when unlinked). */
interface BuiltBlock {
  start: number
  text: string
  map: number[]
  href: (string | null)[]
}

const EMPTY: LinkPluginState = { deco: DecorationSet.empty, active: [] }

/** Flatten the textblock enclosing `pos` (null if `pos` is not inside one). Non-text leaves
 *  (images, breaks) count as one space with no link mapping, mirroring the caret-anchor plain text. */
function textblockAt(view: EditorView, pos: number): BuiltBlock | null {
  const $pos = view.state.doc.resolve(pos)
  for (let d = $pos.depth; d >= 0; d--) {
    const node = $pos.node(d)
    if (!node.isTextblock) continue
    const start = $pos.start(d)
    let text = ''
    const map: number[] = []
    const href: (string | null)[] = []
    node.forEach((child: ProseNode, offset: number) => {
      const base = start + offset
      if (child.isText && child.text) {
        const link = child.marks.find((m) => m.type.name === 'link')
        const h = link ? String(link.attrs.href ?? '') : null
        for (let i = 0; i < child.text.length; i++) {
          text += child.text[i]
          map.push(base + i)
          href.push(h)
        }
      } else {
        text += ' '
        map.push(base)
        href.push(null)
      }
    })
    return { start, text, map, href }
  }
  return null
}

/** True iff any char in `[from, to)` of the built block carries a link mark. */
function overlapsLinkMark(built: BuiltBlock, from: number, to: number): boolean {
  for (let i = from; i < to && i < built.href.length; i++) {
    if (built.href[i] !== null) return true
  }
  return false
}

/** Every link region in the block: one per maximal run of text sharing a link mark's `href`, plus
 *  the scanned candidates that do NOT overlap a link-marked run (the mark owns its text). */
function blockRegions(built: BuiltBlock): LineLinkRegion[] {
  const regions: LineLinkRegion[] = []
  let i = 0
  while (i < built.href.length) {
    const h = built.href[i]
    if (h === null) {
      i++
      continue
    }
    let j = i + 1
    while (j < built.href.length && built.href[j] === h) j++
    if (h) regions.push({ from: i, to: j, href: h })
    i = j
  }
  for (const r of scanLineRegions(built.text)) {
    if (!overlapsLinkMark(built, r.from, r.to)) regions.push(r)
  }
  return regions
}

export function editorLinksProsePlugin(nav: EditorLinkNav): Plugin<LinkPluginState> {
  const key = new PluginKey<LinkPluginState>('pomadeEditorLinks')
  let meta = false
  let inside = false
  let seq = 0
  let lastBlockStart = -1
  let lastX = 0
  let lastY = 0
  let currentView: EditorView | null = null

  const clear = (): void => {
    seq++
    lastBlockStart = -1
    const view = currentView
    if (!view) return
    const st = key.getState(view.state)
    if (!st || (st.deco === DecorationSet.empty && st.active.length === 0)) return
    view.dispatch(view.state.tr.setMeta(key, EMPTY))
  }

  const scan = (view: EditorView, x: number, y: number): void => {
    const info = view.posAtCoords({ left: x, top: y })
    if (!info) {
      clear()
      return
    }
    const built = textblockAt(view, info.pos)
    if (!built) {
      clear()
      return
    }
    if (built.start === lastBlockStart) return // same block — no re-probe
    lastBlockStart = built.start
    const mySeq = ++seq
    const regions = blockRegions(built)
    if (regions.length === 0) {
      view.dispatch(view.state.tr.setMeta(key, EMPTY))
      return
    }
    const ctx = nav.getContext()
    void Promise.all(
      regions.map(async (r) => ({ r, resolved: await resolveRegion(r, ctx) }))
    ).then((results) => {
      if (mySeq !== seq || !meta) return // superseded, or Cmd released mid-probe
      const active: ActiveLink[] = []
      const decos: Decoration[] = []
      for (const { r, resolved } of results) {
        if (!resolved) continue // unresolvable ⇒ never underlined (no dead links)
        const from = built.map[r.from]
        const to = built.map[r.to - 1] + 1
        active.push({ from, to, resolved })
        decos.push(Decoration.inline(from, to, { class: 'pm-editor-link' }))
      }
      if (mySeq !== seq) return
      view.dispatch(
        view.state.tr.setMeta(key, { deco: DecorationSet.create(view.state.doc, decos), active })
      )
    })
  }

  const handleMouseDown = (view: EditorView, e: MouseEvent): boolean => {
    if (!e.metaKey) return false // plain click ⇒ pure caret/selection
    const info = view.posAtCoords({ left: e.clientX, top: e.clientY })
    if (!info) return false
    const st = key.getState(view.state)
    const hit = st?.active.find((a) => info.pos >= a.from && info.pos <= a.to)
    if (hit) {
      e.preventDefault()
      activateEditorLink(hit.resolved, e.clientX, e.clientY, nav.onAmbiguous)
      return true
    }
    const built = textblockAt(view, info.pos)
    if (!built) return false
    const region = blockRegions(built).find(
      (r) => info.pos >= built.map[r.from] && info.pos <= built.map[r.to - 1] + 1
    )
    if (!region) return false
    e.preventDefault()
    const { clientX, clientY } = e
    void resolveRegion(region, nav.getContext()).then((resolved) => {
      if (resolved) activateEditorLink(resolved, clientX, clientY, nav.onAmbiguous)
    })
    return true
  }

  return new Plugin<LinkPluginState>({
    key,
    state: {
      init: () => EMPTY,
      apply(tr, value) {
        const next = tr.getMeta(key) as LinkPluginState | undefined
        if (next) return next
        if (tr.docChanged) return EMPTY // an edit clears the layer (and keeps it silent while typing)
        return value
      }
    },
    props: {
      decorations(state) {
        return key.getState(state)?.deco
      },
      handleDOMEvents: {
        mousemove(view, event) {
          lastX = event.clientX
          lastY = event.clientY
          if (meta) scan(view, event.clientX, event.clientY) // INERT while Cmd is up
          return false
        },
        mouseenter() {
          inside = true
          return false
        },
        mouseleave() {
          inside = false
          clear()
          return false
        },
        mousedown(view, event) {
          return handleMouseDown(view, event)
        }
      }
    },
    view(editorView) {
      currentView = editorView
      const onKey = (e: KeyboardEvent): void => {
        if (e.metaKey === meta) return
        meta = e.metaKey
        if (!meta) clear()
        else if (inside && currentView) scan(currentView, lastX, lastY)
      }
      const onBlur = (): void => {
        if (!meta) return
        meta = false
        clear()
      }
      window.addEventListener('keydown', onKey)
      window.addEventListener('keyup', onKey)
      window.addEventListener('blur', onBlur)
      return {
        destroy() {
          window.removeEventListener('keydown', onKey)
          window.removeEventListener('keyup', onKey)
          window.removeEventListener('blur', onBlur)
          currentView = null
        }
      }
    }
  })
}
