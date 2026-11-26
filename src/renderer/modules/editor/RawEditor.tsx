// Pomade Wave 2c — CodeMirror 6 raw editor. Line numbers, active-line highlight,
// language by file extension, app-themed. Controlled by `value`; edits flow up via
// onChange. Cmd/Ctrl+S is captured here too so saving works while CM holds focus.
//
// E-001: exposes an EditorController (getSelection/replaceSelection/focus + open/close the
// find panel) via `onController`, so EditorPane can drive the context menu and Cmd+F. Find
// uses @codemirror/search's own panel (T-012 "CodeMirror search panel restyled to tokens"),
// themed in cm-theme.ts.

import { minimalChange } from '@shared/text-change'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Compartment, EditorState, type Extension, type StateEffect } from '@codemirror/state'
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
  highlightSpecialChars
} from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  isolateHistory
} from '@codemirror/commands'
import {
  bracketMatching,
  indentOnInput,
  foldGutter,
  foldKeymap
} from '@codemirror/language'
import {
  search,
  openSearchPanel,
  closeSearchPanel,
  setSearchQuery,
  SearchQuery
} from '@codemirror/search'

import { buildEditorTheme, wikilinkHighlighter } from './cm-theme'
import { editorSearchKeymap } from './cm-search-keys'
import { editorLinks } from './cm-editor-links'
import { type EditorLinkNav } from './editor-links'
import { monoPin } from './cm-mono-pin'
import { checkboxCompletion } from './cm-checkbox'
import { emDashReplace } from './cm-emdash'
import { colorSwatches, findColorAt, type ColorSwatchOpen } from './cm-color-swatch'
import { pairedElements } from './cm-pairs'
import { nudgeSpellcheck, proseSpellcheckAttrs } from './cm-spellcheck'
import { formatColorCode, type RGBA } from './color-codes'
import { ColorPickerPopover } from './ColorPickerPopover'
import { extOf, isMarkdownPath, languageExtension } from './doc-kind'
import { fontStackFor, isProportionalFont, MONO_STACK } from '../../font-catalog'
import {
  anchorForOffset,
  bestMatch,
  blockAt,
  bodyStartOffset,
  clampOffset,
  plainToSrc,
  resolveAnchorOffset,
  sourceBlocks,
  srcToPlain
} from './caret-anchor'
import {
  cmViewportTopOffset,
  initialCMParts,
  type InitialView
} from './initial-view'
import { traceCaret, traceKey } from './caret-trace'
import { type EditorController, type EditorKind } from './editor-controller'
import { useAppSettingsStore } from '../../stores/app-settings-store'
import styles from './EditorPane.module.css'

// T-083 — files whose raw view gets the OS spellchecker (prose, not code) and the prose font.
// T-096 — every markdown extension counts, routed through `isMarkdownPath` (`.md`/`.markdown`/
// `.mkd`/`.mdown`/`.mdx`, plus an Untitled empty-path buffer — markdown by policy, T-192), so
// `.mdx`/`.mkd`/`.mdown` are no longer second-class; `.txt` is prose too. Code files stay off.
function isProseFile(path: string): boolean {
  return isMarkdownPath(path) || extOf(path) === 'txt'
}

// T-153 — the font-related extensions, isolated in a CodeMirror Compartment so changing the
// "Editor font (raw)" setting reconfigures LIVE (no editor rebuild, cursor/undo preserved).
//   • The `.cm-scroller` font is the user's selection for PROSE files (markdown/txt); code files
//     (js/json/…) always keep the standard mono stack — the setting governs prose, not code.
//   • The mono-pin layer runs only for MARKDOWN whose selection is PROPORTIONAL: a mono selection
//     needs no pinning (everything is already mono), and non-markdown has no code/table nodes.
function fontConfig(path: string, fontId: string): Extension {
  const isProse = isProseFile(path)
  const scrollerFont = isProse ? fontStackFor(fontId) : MONO_STACK
  const pin = isMarkdownPath(path) && isProportionalFont(fontId) ? [monoPin()] : []
  return [buildEditorTheme(scrollerFont), ...pin]
}

interface RawEditorProps {
  path: string
  value: string
  onChange: (next: string) => void
  onSave: () => void
  onController?: (controller: EditorController | null) => void
  /** T-184 — Cmd+click link navigation (doc resolution bases + the ambiguity-picker opener). */
  linkNav?: EditorLinkNav
  /** T-185 — the position to open at (saved viewport / `:line` / caret bridge), read ONCE at
   *  mount (or first show); null = open at the top. See initial-view.ts. */
  getInitialView?: (kind: EditorKind) => InitialView | null
  /** T-185 — whether this pane is the visible one; gates the first-paint apply (a hidden pane has
   *  no measurable geometry, so it applies on its first show instead). */
  visible?: boolean
}

export function RawEditor({
  path,
  value,
  onChange,
  onSave,
  onController,
  linkNav,
  getInitialView,
  visible
}: RawEditorProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  // T-185 — read live inside the mount effect / show effect without re-creating the editor.
  const getInitialViewRef = useRef(getInitialView)
  getInitialViewRef.current = getInitialView
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  // T-185 — the initial position is applied EXACTLY ONCE per editor instance: at mount when
  // visible, else on the first hidden→visible show. Never re-applied on a later show, so a scroll
  // the user made (retained across display:none) is never yanked back to the restored spot.
  const initialAppliedRef = useRef(false)
  // T-153 — the editor-raw font selection. Held in a ref so the CREATE effect (keyed on `path`)
  // reads the current value without depending on it (a font change must reconfigure, never
  // rebuild the editor); a separate effect reconfigures the font Compartment on change.
  const editorRawFont = useAppSettingsStore((s) => s.editorRawFont)
  const editorRawFontRef = useRef(editorRawFont)
  editorRawFontRef.current = editorRawFont
  const fontCompartment = useRef(new Compartment()).current
  // E-019 · T-068 — the color code whose swatch was clicked (null = no picker open).
  const [swatch, setSwatch] = useState<ColorSwatchOpen | null>(null)
  // Latest callbacks without re-creating the editor.
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const onControllerRef = useRef(onController)
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  onControllerRef.current = onController
  // T-152 — the em-dash toggle, read LIVE inside the CM input handler (the editor is built once
  // per file, so a stable ref keeps the handler seeing the current setting without a rebuild).
  const emDashEnabled = useAppSettingsStore((s) => s.emDashReplace)
  const emDashEnabledRef = useRef(emDashEnabled)
  emDashEnabledRef.current = emDashEnabled

  // T-184 — a STABLE nav object (the editor is built once per path; a fresh `linkNav` prop must
  // not rebuild it), delegating to the latest prop via a ref. getContext reads the doc's live
  // resolution bases at hover/click time.
  const linkNavRef = useRef(linkNav)
  linkNavRef.current = linkNav
  const stableLinkNav = useRef<EditorLinkNav>({
    getContext: () =>
      linkNavRef.current?.getContext() ?? { cwdAbs: '', projectRootAbs: '', wsRootAbs: '' },
    onAmbiguous: (p) => linkNavRef.current?.onAmbiguous(p)
  }).current

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const saveKeymap = keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          onSaveRef.current()
          return true
        }
      }
    ])

    const extensions: Extension[] = [
      lineNumbers(),
      foldGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      rectangularSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      EditorView.lineWrapping,
      search({ top: true }),
      // T-050 before T-077: `- ` + `[` is a checkbox (cancellable with Backspace/Escape), a bare
      // `[` auto-closes. Both extensions carry their own internal precedences — see cm-checkbox.ts
      // / cm-pairs.ts — so this array's order is not load-bearing.
      checkboxCompletion(),
      pairedElements(path),
      // T-152 — em-dash auto-replacement, markdown docs only (prose feature). Reads the toggle
      // live; frontmatter is guarded by body offset (raw shows the YAML `---` fence, which the
      // commonmark parser does not mark as code). Orthogonal to checkbox/pairs — see cm-emdash.ts.
      ...(isMarkdownPath(path)
        ? [
            emDashReplace({
              isEnabled: () => emDashEnabledRef.current,
              inFrontmatter: (state, pos) => pos < bodyStartOffset(state.doc.toString())
            })
          ]
        : []),
      saveKeymap,
      keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, ...editorSearchKeymap, indentWithTab]),
      // T-153 — theme + mono-pin live in a Compartment (reconfigured on font-setting change).
      fontCompartment.of(fontConfig(path, editorRawFontRef.current)),
      wikilinkHighlighter,
      // T-184 — Cmd+click link detection (inert while Cmd is up; shared with the Live editor).
      editorLinks(stableLinkNav),
      // E-019 — inline color swatches (T-067) + click-to-edit (T-068). Always on in v1, so no
      // Compartment is needed; `setSwatch` is a stable useState setter, safe in this frozen array.
      colorSwatches(setSwatch),
      languageExtension(path),
      // T-083 — prose files (markdown/txt) get the OS spellchecker's red squiggles like the
      // rendered view; code files stay off (identifiers would light up the whole document). See
      // cm-spellcheck.ts for the shared attrs and the Chromium-44 loaded-text caveat.
      ...(isProseFile(path) ? [proseSpellcheckAttrs] : []),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString())
      })
    ]

    // T-185 / T-194 — FIRST PAINT AT POSITION. When a target is known before the editor exists and
    // this pane is visible, bake the caret selection into the initial state and hand CodeMirror the
    // scroll as its `scrollTo` config: CM applies it on the FIRST layout measure, so the doc paints
    // already at the spot (a post-mount `scrollIntoView` no-ops against the not-yet-sized viewport —
    // the T-086 fresh-open bug). For a `toggle` the scroll follows the KEPT VIEWPORT while the caret
    // is only baked into the selection (T-194). A hidden pane can't be measured, so it defers to the
    // show effect.
    initialAppliedRef.current = false
    let initialSelection: { anchor: number } | undefined
    let initialScrollTo: StateEffect<unknown> | undefined
    if (visibleRef.current) {
      const iv = getInitialViewRef.current?.('raw')
      if (iv) {
        const p = initialCMParts(iv, value)
        if (p.selectionPos != null) initialSelection = { anchor: p.selectionPos }
        if (p.scrollPos != null) initialScrollTo = EditorView.scrollIntoView(p.scrollPos, { y: p.place })
        initialAppliedRef.current = true
      }
    }

    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: value, selection: initialSelection, extensions }),
      scrollTo: initialScrollTo
    })
    viewRef.current = view

    // T-083 — prose only: nudge Chromium to spell-check the ALREADY-loaded text (see
    // cm-spellcheck.ts). Disposed with the view below.
    const disposeSpellcheck = isProseFile(path) ? nudgeSpellcheck(view) : null

    const controller: EditorController = {
      kind: 'raw',
      getSelection: () => {
        const sel = view.state.selection.main
        return { text: view.state.sliceDoc(sel.from, sel.to), empty: sel.empty, from: sel.from, to: sel.to }
      },
      replaceRange: (from, to, text) => {
        const len = view.state.doc.length
        const f = Math.min(from, len)
        const t = Math.min(to, len)
        view.dispatch({
          changes: { from: f, to: t, insert: text },
          selection: { anchor: f + text.length }
        })
        view.focus()
      },
      focus: () => view.focus(),
      replaceDocument: (text) => {
        const change = minimalChange(view.state.doc.toString(), text)
        if (change) view.dispatch({ changes: change, annotations: isolateHistory.of('full') })
        view.focus()
        return true
      },
      // E-020 (T-086) — jump to a 1-based line (from a `path:line` terminal link). Clamped to
      // the document so a line number carried by stale output lands at the last line rather
      // than throwing out of doc.line().
      //
      // Round 3 fix: the old `scrollIntoView: true` was silently dropped on a FRESH open. The
      // jump runs the instant RawEditor registers its controller — before CodeMirror has run its
      // first layout measure — so the scroll was computed against a not-yet-sized viewport and
      // no-opped, leaving the caret's line selected but the view parked at the top (the user's
      // "opens the file but sits on line 1, nothing focused" report). We now (1) use an explicit
      // CENTERED scroll effect, and (2) re-issue it after the next animation frame, once the view
      // has real dimensions — the same "scroll after layout settles" lesson as the rendered caret
      // restore (T-004). Focus is likewise re-asserted post-layout.
      gotoLine: (n) => {
        // StrictMode: this controller may be the DOOMED first instance of a dev double mount, so
        // its view can be destroyed by the time the jump (or its deferred re-scroll) runs.
        // Dispatching to a destroyed view throws; `view.dom.isConnected` is false once destroy()
        // has detached the DOM, so bail rather than throw (EditorPane re-posts the jump to the
        // surviving instance).
        if (!view.dom.isConnected) return
        const clampLine = (): number => Math.min(Math.max(1, Math.floor(n)), view.state.doc.lines)
        const line = view.state.doc.line(clampLine())
        view.dispatch({
          selection: { anchor: line.from },
          effects: EditorView.scrollIntoView(line.from, { y: 'center' })
        })
        view.focus()
        requestAnimationFrame(() => {
          if (!view.dom.isConnected) return
          const at = view.state.doc.line(clampLine()).from
          view.dispatch({ effects: EditorView.scrollIntoView(at, { y: 'center' }) })
          if (!view.hasFocus) view.focus()
        })
      },
      // T-004 — caret anchor (raw side). The markdown AST tells us which characters of the
      // caret's block are text and which are markup, so the anchor we publish is the block's
      // PLAIN text — directly comparable with the rendered view's textContent (see caret-anchor
      // .ts). A caret on a blank line belongs to the block above (blockAt).
      getCaretAnchor: () => {
        const source = view.state.doc.toString()
        const head = view.state.selection.main.head
        const bodyFrom = bodyStartOffset(source)
        const span = Math.max(1, source.length - bodyFrom)
        const fraction = Math.min(1, Math.max(0, (head - bodyFrom) / span))
        const block = blockAt(sourceBlocks(source), head)
        if (!block) return { key: '', offset: 0, fraction }
        return { key: block.key, offset: srcToPlain(block, head), fraction }
      },
      setCaretAnchor: (anchor) => {
        // StrictMode: a doomed first controller's view can already be destroyed — don't dispatch
        // into it (see gotoLine). EditorPane's survivor guard re-applies to the live instance.
        if (!view.dom.isConnected) return
        const source = view.state.doc.toString()
        const blocks = sourceBlocks(source)
        const hit = anchor.key ? bestMatch(blocks.map((b) => b.key), anchor.key) : -1
        traceCaret('land-raw', {
          key: traceKey(anchor.key),
          hit,
          blocks: blocks.length,
          docLen: source.length
        })
        let target: number
        if (hit >= 0) {
          const block = blocks[hit]
          target = plainToSrc(block, clampOffset(block.plain, anchor.offset))
        } else {
          // No credible block match (e.g. the caret sat in frontmatter, which the rendered view
          // never shows). Land proportionally rather than at the top, snapped to a block start.
          const bodyFrom = bodyStartOffset(source)
          const guess = bodyFrom + Math.round(anchor.fraction * Math.max(0, source.length - bodyFrom))
          const near = blocks.reduce<number | null>(
            (best, b) => (best == null || Math.abs(b.from - guess) < Math.abs(best - guess) ? b.from : best),
            null
          )
          target = near ?? guess
        }
        view.dispatch({
          selection: { anchor: Math.min(Math.max(0, target), view.state.doc.length) },
          scrollIntoView: true
        })
        view.focus()
        traceCaret('landed-raw', { target, focused: view.hasFocus })
      },
      // T-185 — the reading position (viewport top): the block at the top of the visible scroller,
      // as the same block-text anchor the caret bridge uses. null when not laid out (hidden).
      getViewportAnchor: () => {
        if (!view.dom.isConnected || view.dom.offsetParent === null) return null
        const source = view.state.doc.toString()
        return anchorForOffset(source, cmViewportTopOffset(view))
      },
      // T-185 — restore a reading position WITHOUT moving the caret: scroll the matching block to
      // the top of the viewport. Used on a re-show (a background tab first switched to). Guarded
      // like the caret methods so a doomed dev double-mount never dispatches into a dead view.
      scrollToViewportAnchor: (anchor) => {
        if (!view.dom.isConnected) return
        const source = view.state.doc.toString()
        const pos = Math.min(Math.max(0, resolveAnchorOffset(source, anchor)), view.state.doc.length)
        view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start' }) })
      },
      // T-194 — mode-toggle restore: set the caret WITHOUT scrolling it in, scroll the KEPT viewport
      // to the top (one dispatch — CM scrolls only for the explicit effect, never for a plain
      // selection change), and re-focus (CM's focus is preventScroll, so the viewport is not yanked
      // to the caret). Guarded like the other bridge methods against a doomed dev double-mount.
      applyToggleView: (selection, viewport) => {
        if (!view.dom.isConnected) return
        const source = view.state.doc.toString()
        const clamp = (n: number): number => Math.min(Math.max(0, n), view.state.doc.length)
        const selPos = selection ? clamp(resolveAnchorOffset(source, selection)) : null
        const scrollPos = viewport ? clamp(resolveAnchorOffset(source, viewport)) : selPos
        view.dispatch({
          ...(selPos != null ? { selection: { anchor: selPos } } : {}),
          ...(scrollPos != null
            ? { effects: EditorView.scrollIntoView(scrollPos, { y: viewport ? 'start' : 'center' }) }
            : {})
        })
        view.focus()
      },
      openFind: (prefill) => {
        openSearchPanel(view)
        if (prefill) {
          view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: prefill })) })
        }
      },
      closeFind: () => {
        closeSearchPanel(view)
        view.focus()
      }
    }
    onControllerRef.current?.(controller)

    return () => {
      onControllerRef.current?.(null)
      setSwatch(null)
      disposeSpellcheck?.()
      view.destroy()
      viewRef.current = null
    }
    // Re-create only when the file identity changes (extension → language/theme).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt per path only; value seeds the doc and later values flow through the reconcile effect below; callbacks and settings are refs, the rest stable
  }, [path])

  // Reconcile external value changes (e.g. mode toggle bringing edits from the rendered
  // view, or a disk reload) without clobbering the cursor when nothing actually changed.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const change = minimalChange(view.state.doc.toString(), value)
    if (change) view.dispatch({ changes: change })
  }, [value])

  // T-153 — restyle LIVE when the editor-raw font setting changes: reconfigure the font
  // Compartment (scroller font + mono-pin) without rebuilding the editor, so cursor, scroll,
  // selection and undo history all survive the change.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: fontCompartment.reconfigure(fontConfig(path, editorRawFont)) })
  }, [editorRawFont, path, fontCompartment])

  // T-185 — a pane mounted HIDDEN (a background tab restored at startup) had no measurable geometry
  // at mount, so it applies its initial position on its FIRST show. A layout effect runs before the
  // show's paint, so the doc still appears already at the spot; `initialAppliedRef` makes it run at
  // most once, so a user scroll (retained across display:none) is never yanked back on a later show.
  useLayoutEffect(() => {
    if (!visible || initialAppliedRef.current) return
    const view = viewRef.current
    if (!view) return
    initialAppliedRef.current = true
    const iv = getInitialViewRef.current?.('raw')
    if (!iv) return
    const p = initialCMParts(iv, view.state.doc.toString())
    view.dispatch({
      ...(p.selectionPos != null ? { selection: { anchor: p.selectionPos } } : {}),
      ...(p.scrollPos != null ? { effects: EditorView.scrollIntoView(p.scrollPos, { y: p.place }) } : {})
    })
    if (p.selectionPos != null) view.focus()
  }, [visible])

  // ── E-019 · T-068 — commit a picked color ────────────────────────────────────────
  // ONE transaction, isolated in the history so Cmd+Z reverts the whole rewrite in a single step
  // and a later keystroke can't merge into it. The change flows through the normal update
  // listener, so the doc goes dirty exactly like typing. The range is re-resolved first: the
  // document may have changed while the popup was open.
  const closeSwatch = (): void => {
    setSwatch(null)
    viewRef.current?.focus()
  }

  const applySwatch = (next: RGBA): void => {
    const view = viewRef.current
    const hit = swatch
    setSwatch(null)
    if (!view || !hit) return
    const live = findColorAt(view.state, hit.from, hit.text)
    const stillThere = view.state.sliceDoc(hit.from, hit.to) === hit.text
    const target = live && live.text === hit.text ? live : stillThere ? hit : null
    const insert = formatColorCode(hit.parsed.notation, next)
    if (target && insert !== target.text) {
      view.dispatch({
        changes: { from: target.from, to: target.to, insert },
        annotations: isolateHistory.of('full'),
        userEvent: 'input.replace'
      })
    }
    view.focus()
  }

  return (
    <>
      <div ref={hostRef} className={styles.rawHost} data-testid="raw-editor" />
      {swatch && (
        <ColorPickerPopover
          anchorRect={swatch.rect}
          code={swatch.text}
          initial={swatch.parsed.rgba}
          notation={swatch.parsed.notation}
          onApply={applySwatch}
          onCancel={closeSwatch}
        />
      )}
    </>
  )
}
