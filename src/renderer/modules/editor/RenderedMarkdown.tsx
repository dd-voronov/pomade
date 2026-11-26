// Pomade Wave 2c — Milkdown (ProseMirror) rendered markdown editor. The rendered view
// IS editable; every change serializes back to markdown and flows up via onChange, so the
// raw and rendered views share one document. commonmark + gfm.
//
// E-002 (T-016): GFM task-list items (`- [ ] `/`- [x] `) get a custom node view that renders
// a real, clickable checkbox. The gfm preset already parses/serializes the `checked` attr;
// its default toDOM emits only `<li data-item-type="task" data-checked>` with no visible
// control, so toggling was impossible. Clicking the checkbox flips the `checked` attr via a
// ProseMirror transaction → the serializer writes exactly `[ ]`/`[x]` (one-char diff on disk).
//
// E-001 (T-011/T-012): registers the pomade find plugin ($prose) for in-document search and
// exposes an EditorController (selection + find) to EditorPane via `onController`, mirroring
// RawEditor. Replace is raw-only for v1 (the panel says so).

import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  parserCtx,
  serializerCtx
} from '@milkdown/kit/core'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { $prose } from '@milkdown/kit/utils'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { closeHistory } from '@milkdown/kit/prose/history'
import { Plugin, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView, NodeView } from '@milkdown/kit/prose/view'
import { useLayoutEffect, useRef } from 'react'

import '@milkdown/kit/prose/view/style/prosemirror.css'
import '@milkdown/kit/prose/tables/style/tables.css'
import {
  bulletListSpreadFix,
  checkboxInputRule,
  commonmarkNoEmptyLine,
  configureRemarkStringify,
  emDashProsePlugin,
  softBreakFix,
  softBreakKeymap,
  wikilinkProsePlugin
} from './md-config'
import { useAppSettingsStore } from '../../stores/app-settings-store'
import { anchorKey, bestMatch, clampOffset, type CaretAnchor } from './caret-anchor'
import { scrollElementIntoContainer, scrollParent, type InitialView } from './initial-view'
import { traceCaret, traceKey } from './caret-trace'
import { type EditorController, type EditorKind } from './editor-controller'
import { findPlugin, makeRenderedFindApi } from './pm-search'
import { editorLinksProsePlugin } from './pm-editor-links'
import { focusSelectionSyncPlugin } from './pm-focus-sync'
import { type EditorLinkNav } from './editor-links'
import styles from './EditorPane.module.css'

interface RenderedMarkdownProps {
  initial: string
  onChange: (markdown: string) => void
  onController?: (controller: EditorController | null) => void
  /** T-184 — Cmd+click link navigation (doc resolution bases + the ambiguity-picker opener). */
  linkNav?: EditorLinkNav
  /** T-185 — the position to open at (saved viewport / caret bridge / a `:line` pre-translated to a
   *  caret anchor); null = top. Milkdown owns view construction, so this is applied synchronously in
   *  the `mounted` callback (best-effort first paint — see the note there). */
  getInitialView?: (kind: EditorKind) => InitialView | null
  /** T-185 — whether this pane is the visible one (gates the apply). */
  visible?: boolean
}

// Node view for `list_item`. Task items (checked !== null) render a leading checkbox that
// toggles the node's `checked` attr on click; plain list items reproduce the default DOM.
function listItemView(node: ProseNode, view: EditorView, getPos: () => number | undefined): NodeView {
  const li = document.createElement('li')
  li.setAttribute('data-label', String(node.attrs.label))
  li.setAttribute('data-list-type', String(node.attrs.listType))
  li.setAttribute('data-spread', String(node.attrs.spread))

  const isTask = node.attrs.checked != null
  if (!isTask) {
    // Default rendering: the <li> is itself the content host (content hole `0`).
    return {
      dom: li,
      contentDOM: li,
      update: (updated) => updated.type.name === 'list_item' && updated.attrs.checked == null
    }
  }

  li.setAttribute('data-item-type', 'task')
  li.setAttribute('data-checked', String(node.attrs.checked))

  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.className = styles.taskCheckbox
  checkbox.checked = node.attrs.checked === true
  checkbox.contentEditable = 'false'
  checkbox.setAttribute('data-testid', 'task-checkbox')
  // Don't let the click move the editor selection / start a drag.
  checkbox.addEventListener('mousedown', (e) => e.preventDefault())
  checkbox.addEventListener('change', () => {
    const pos = getPos()
    if (pos == null) return
    const current = view.state.doc.nodeAt(pos)
    if (!current) return
    view.dispatch(view.state.tr.setNodeAttribute(pos, 'checked', checkbox.checked))
  })

  const content = document.createElement('div')
  content.className = styles.taskContent

  li.appendChild(checkbox)
  li.appendChild(content)

  return {
    dom: li,
    contentDOM: content,
    update: (updated) => {
      if (updated.type.name !== 'list_item' || updated.attrs.checked == null) return false
      checkbox.checked = updated.attrs.checked === true
      li.setAttribute('data-checked', String(updated.attrs.checked))
      return true
    },
    // Keep ProseMirror from routing checkbox interactions through its own handlers.
    stopEvent: (e) => e.target === checkbox
  }
}

// T-185 — the ProseMirror textblock best-matching a reading-position anchor (same block-text match
// the caret bridge uses), or null.
function pmMatch(doc: ProseNode, anchor: CaretAnchor): { pos: number; node: ProseNode } | null {
  const blocks: { pos: number; node: ProseNode }[] = []
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      blocks.push({ pos, node })
      return false
    }
    return true
  })
  const hit = anchor.key ? bestMatch(blocks.map((b) => anchorKey(b.node.textContent)), anchor.key) : -1
  return hit >= 0 ? blocks[hit] : null
}

// T-185 — scroll the matching block's DOM node to the top (or center) of the md-scroll container.
// ProseMirror's own scrollIntoView doesn't move that ancestor, so the element is scrolled directly;
// a RAF re-assert covers the container's height not being settled this synchronously.
function scrollRenderedBlock(view: EditorView, anchor: CaretAnchor, place: 'start' | 'center'): void {
  const m = pmMatch(view.state.doc, anchor)
  if (!m) return
  const container = scrollParent(view.dom as HTMLElement)
  const doScroll = (): void => {
    try {
      const node = view.nodeDOM(m.pos)
      const el = node instanceof HTMLElement ? node : (node?.parentElement ?? null)
      if (el) scrollElementIntoContainer(el, container, place)
    } catch {
      /* best-effort */
    }
  }
  doScroll()
  requestAnimationFrame(doScroll)
}

// T-185/T-194 — the ProseMirror doc position best-matching a caret anchor (same block-text match the
// bridge uses): the matched textblock's start + the intra-block offset, walking non-text leaves
// (images/breaks) so ProseMirror positions and plain-text indices stay aligned; else a proportional
// guess. Extracted so setCaretAnchor (jump, scrolls) and applyToggleViewPM (toggle, no caret scroll)
// map an anchor identically.
function pmAnchorToPos(doc: ProseNode, anchor: CaretAnchor): number {
  const blocks: { pos: number; node: ProseNode }[] = []
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      blocks.push({ pos, node })
      return false
    }
    return true
  })
  const hit = anchor.key ? bestMatch(blocks.map((b) => anchorKey(b.node.textContent)), anchor.key) : -1
  if (hit < 0) return Math.round(anchor.fraction * doc.content.size)
  const { pos, node } = blocks[hit]
  const plainWithBreaks = node.textBetween(0, node.content.size, undefined, ' ')
  const plainTarget = clampOffset(plainWithBreaks, anchor.offset)
  let inBlock = node.content.size
  for (let k = 0; k <= node.content.size; k++) {
    if (node.textBetween(0, k, undefined, ' ').length >= plainTarget) {
      inBlock = k
      break
    }
  }
  return pos + 1 + inBlock
}

// T-194 — mode-toggle restore (rendered side): set the caret from `selection` WITHOUT scrolling it
// into view, and scroll the KEPT `viewport` block to the md-scroll container's top; with no viewport
// captured, center the caret's block as a fallback. Focus is preventScroll, and the selection is set
// with NO `scrollIntoView`, so nothing yanks the viewport to the caret.
function applyToggleViewPM(
  view: EditorView,
  selection: CaretAnchor | null,
  viewport: CaretAnchor | null
): void {
  if (!view.dom.isConnected) return
  if (selection) {
    const target = Math.min(Math.max(0, pmAnchorToPos(view.state.doc, selection)), view.state.doc.content.size)
    try {
      const sel = TextSelection.near(view.state.doc.resolve(target))
      view.dispatch(view.state.tr.setSelection(sel)) // no scrollIntoView — keep the viewport
    } catch {
      /* best-effort */
    }
  }
  if (viewport) scrollRenderedBlock(view, viewport, 'start')
  else if (selection) scrollRenderedBlock(view, selection, 'center')
  view.focus()
}

// T-185/T-194 — apply the initial position for the rendered engine. VIEWPORT (saved reading position)
// scrolls its block to the top; TOGGLE keeps the outgoing viewport and bakes the selection (no caret
// scroll). A `caret`/`line` FRESH open is still applied by the post-mount jump / caret-bridge
// machinery (setController / the jump effect), so this leaves those untouched.
function applyRenderedInitial(
  view: EditorView,
  iv: InitialView | null,
  appliedRef: { current: boolean }
): void {
  appliedRef.current = true
  if (!iv) return
  if (iv.type === 'viewport') scrollRenderedBlock(view, iv.anchor, 'start')
  else if (iv.type === 'toggle') applyToggleViewPM(view, iv.selection, iv.viewport)
}

function MilkdownInner({
  initial,
  onChange,
  onController,
  linkNav,
  getInitialView,
  visible
}: RenderedMarkdownProps): React.JSX.Element {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onControllerRef = useRef(onController)
  onControllerRef.current = onController
  // T-185 — the live ProseMirror view (set in `mounted`), the initial-position source, the
  // visibility gate, and the once-only applied flag — same first-paint / first-show contract as the
  // CodeMirror engines, applied through Milkdown's async mount.
  const viewRef = useRef<EditorView | null>(null)
  const getInitialViewRef = useRef(getInitialView)
  getInitialViewRef.current = getInitialView
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const initialAppliedRef = useRef(false)
  // T-184 — a STABLE nav object read via ref (the Milkdown editor is built once).
  const linkNavRef = useRef(linkNav)
  linkNavRef.current = linkNav
  const stableLinkNav = useRef<EditorLinkNav>({
    getContext: () =>
      linkNavRef.current?.getContext() ?? { cwdAbs: '', projectRootAbs: '', wsRootAbs: '' },
    onAmbiguous: (p) => linkNavRef.current?.onAmbiguous(p)
  }).current
  // Capture the initial value once so React re-renders never reset the editor.
  const initialRef = useRef(initial)
  // An edit the listener's 200 ms debounce has not reported yet (same condition the listener
  // uses), so `flushPendingEdits` emits only real pending edits — never a re-serialization of an
  // untouched doc, which could normalize markup the user never changed.
  const pendingEditRef = useRef(false)
  // T-152 — em-dash toggle, read LIVE inside the ProseMirror plugin (the editor is built once).
  const emDashEnabled = useAppSettingsStore((s) => s.emDashReplace)
  const emDashEnabledRef = useRef(emDashEnabled)
  emDashEnabledRef.current = emDashEnabled

  useEditor((root) =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root)
        ctx.set(defaultValueCtx, initialRef.current)
        configureRemarkStringify(ctx)
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          nodeViews: { ...(prev.nodeViews ?? {}), list_item: listItemView }
        }))
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          pendingEditRef.current = false
          onChangeRef.current(markdown)
        })
        // E-001 — hand EditorPane a controller once the ProseMirror view exists, and drop it
        // on teardown. The view is read lazily from the ctx so find/selection always act on
        // the live view.
        ctx.get(listenerCtx).mounted((mctx) => {
          const view = mctx.get(editorViewCtx)
          const controller: EditorController = {
            kind: 'rendered',
            getSelection: () => {
              const { from, to, empty } = view.state.selection
              return { text: view.state.doc.textBetween(from, to, '\n'), empty, from, to }
            },
            replaceRange: (from, to, text) => {
              const size = view.state.doc.content.size
              const f = Math.min(from, size)
              const t = Math.min(to, size)
              view.dispatch(view.state.tr.insertText(text, f, t))
              view.focus()
            },
            focus: () => view.focus(),
            replaceDocument: (text) => {
              let next: ProseNode | null = null
              try {
                next = mctx.get(parserCtx)(text)
              } catch {
                next = null
              }
              if (!next) return false
              // Closed on both sides: the restore is its own undo step, never merged with typing.
              view.dispatch(closeHistory(view.state.tr))
              view.dispatch(closeHistory(view.state.tr.replaceWith(0, view.state.doc.content.size, next.content)))
              pendingEditRef.current = false
              onChangeRef.current(mctx.get(serializerCtx)(view.state.doc))
              view.focus()
              return true
            },
            flushPendingEdits: () => {
              if (!pendingEditRef.current) return
              pendingEditRef.current = false
              onChangeRef.current(mctx.get(serializerCtx)(view.state.doc))
            },
            find: makeRenderedFindApi(view),
            // T-004 — caret anchor (rendered side): the caret's textblock as PLAIN text
            // (paragraph / heading / the paragraph inside a list item), which is exactly what the
            // raw side derives from the markdown AST — inline markup included, since neither side
            // reports it. See caret-anchor.ts.
            getCaretAnchor: () => {
              const doc = view.state.doc
              const head = view.state.selection.head
              const fraction = Math.min(1, Math.max(0, head / Math.max(1, doc.content.size)))
              const $h = doc.resolve(head)
              const block = $h.parent
              if (!block.isTextblock) {
                const text = $h.nodeAfter?.textContent ?? $h.nodeBefore?.textContent ?? ''
                return { key: anchorKey(text), offset: 0, fraction }
              }
              const plain = block.textContent
              // Round 8 — count non-text leaves (soft/hard breaks, images) as exactly ONE char,
              // matching the raw side's mdast plain text (`break` → ' ' in caret-anchor
              // collectText). Milkdown's break node happens to declare `leafText: '\n'` so the
              // default textBetween already counted 1 — the explicit ' ' pins that invariant
              // instead of depending on a third-party node spec staying that way.
              const inBlock = block.textBetween(0, Math.max(0, head - $h.start()), undefined, ' ').length
              return { key: anchorKey(plain), offset: inBlock, fraction }
            },
            setCaretAnchor: (anchor) => {
              // StrictMode parity guard: never dispatch/focus a destroyed view (a doomed dev
              // double-mount instance). Milkdown registers async so a doomed controller rarely
              // reaches here, but the jump leg can still call it — bail cleanly if detached.
              if (!view.dom.isConnected) return
              const doc = view.state.doc
              const target = pmAnchorToPos(doc, anchor)
              traceCaret('land-rendered', {
                key: traceKey(anchor.key),
                target,
                docSize: doc.content.size
              })
              try {
                const sel = TextSelection.near(doc.resolve(Math.min(Math.max(0, target), doc.content.size)))
                view.dispatch(view.state.tr.setSelection(sel).scrollIntoView())
              } catch {
                /* best-effort */
              }
              view.focus()
              traceCaret('landed-rendered', { target, focused: view.hasFocus() })
              // ProseMirror's own scrollIntoView does not move the pane's scroll container (the
              // absolutely-positioned `md-scroll` ancestor), so on any doc taller than the
              // viewport the restored caret stayed below the fold — round-6's "caret at the end of
              // the doc is not restored". Scroll the caret's own DOM node after layout settles.
              requestAnimationFrame(() => {
                try {
                  const pos = view.state.selection.head
                  const at = view.domAtPos(pos).node
                  const el = at instanceof HTMLElement ? at : at.parentElement
                  el?.scrollIntoView({ block: 'center' })
                } catch {
                  /* best-effort */
                }
              })
            },
            // T-185 — reading position: the textblock at the top of the visible md-scroll container,
            // as the same block-text anchor the caret bridge uses. null when not laid out (hidden).
            // Found by walking the rendered top-level blocks for the first whose bottom crosses the
            // container top — `posAtCoords` at the container's very top edge can miss into the
            // padding above the first block and return pos 0 (the heading), losing the position on a
            // rendered→raw toggle.
            getViewportAnchor: () => {
              if (!view.dom.isConnected || view.dom.offsetParent === null) return null
              const container = scrollParent(view.dom as HTMLElement)
              const crTop = container.getBoundingClientRect().top
              const doc = view.state.doc
              let el: HTMLElement | null = null
              for (const child of [...(view.dom as HTMLElement).children] as HTMLElement[]) {
                if (child.getBoundingClientRect().bottom > crTop + 2) {
                  el = child
                  break
                }
              }
              let pos = 0
              try {
                if (el) pos = view.posAtDOM(el, 0)
              } catch {
                /* best-effort — falls back to the document start */
              }
              pos = Math.min(Math.max(0, pos), doc.content.size)
              const fraction = Math.min(1, Math.max(0, pos / Math.max(1, doc.content.size)))
              const block = doc.resolve(pos).parent
              const text = block.isTextblock ? block.textContent : (el?.textContent ?? '')
              return { key: anchorKey(text), offset: 0, fraction }
            },
            // T-185 — scroll the matching block to the md-scroll container's top, no caret (re-show).
            scrollToViewportAnchor: (anchor) => {
              if (!view.dom.isConnected) return
              scrollRenderedBlock(view, anchor, 'start')
            },
            // T-194 — mode-toggle restore: keep the outgoing viewport, bake the selection (no caret
            // scroll). See applyToggleViewPM.
            applyToggleView: (selection, viewport) => applyToggleViewPM(view, selection, viewport)
          }
          viewRef.current = view
          onControllerRef.current?.(controller)
          // T-185 — FIRST PAINT AT POSITION. Milkdown owns view construction, so the position is
          // applied synchronously here in `mounted` (the DOM is built but the browser hasn't painted
          // yet), with a RAF re-assert for the md-scroll container whose height may not be settled
          // this synchronously — best-effort first paint (the RAW/LIVE engines, the markdown default,
          // get true pre-paint scroll; Rendered is the less-common "Adjust" engine). A hidden pane
          // defers to the show effect below.
          if (visibleRef.current) applyRenderedInitial(view, getInitialViewRef.current?.('rendered') ?? null, initialAppliedRef)
        })
        ctx.get(listenerCtx).destroy(() => {
          onControllerRef.current?.(null)
          viewRef.current = null
        })
      })
      .use(commonmarkNoEmptyLine)
      .use(gfm)
      .use(history)
      .use(bulletListSpreadFix)
      .use(softBreakFix)
      .use(softBreakKeymap)
      .use(listener)
      .use(
        $prose(
          () =>
            new Plugin({
              state: {
                init: () => null,
                apply: (tr) => {
                  if ((tr.docChanged || tr.storedMarksSet) && tr.getMeta('addToHistory') !== false) {
                    pendingEditRef.current = true
                  }
                  return null
                }
              }
            })
        )
      )
      .use($prose(() => findPlugin()))
      .use($prose(() => focusSelectionSyncPlugin()))
      .use($prose(() => wikilinkProsePlugin()))
      // T-184 — Cmd+click link detection (rendered counterpart of cm-editor-links).
      .use($prose(() => editorLinksProsePlugin(stableLinkNav)))
      .use($prose(() => checkboxInputRule()))
      .use($prose(() => emDashProsePlugin(() => emDashEnabledRef.current)))
  )

  // T-185 — first-show restore for a pane mounted hidden (see RawEditor). The view is set in
  // `mounted`, which may resolve after this effect's first run; keying on the visibility flip and
  // guarding on `viewRef.current` covers both orders. Once-only via `initialAppliedRef`.
  useLayoutEffect(() => {
    if (!visible || initialAppliedRef.current) return
    const view = viewRef.current
    if (!view) return
    applyRenderedInitial(view, getInitialViewRef.current?.('rendered') ?? null, initialAppliedRef)
  }, [visible])

  return (
    <div className={styles.milkdownHost} data-testid="rendered-editor">
      <Milkdown />
    </div>
  )
}

export function RenderedMarkdown(props: RenderedMarkdownProps): React.JSX.Element {
  return (
    <MilkdownProvider>
      <MilkdownInner {...props} />
    </MilkdownProvider>
  )
}
