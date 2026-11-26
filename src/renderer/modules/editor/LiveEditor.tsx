// Pomade E-024 — the LIVE markdown editor: CodeMirror 6 over the raw BODY source with the
// cm-live decoration layer (markers hidden + atomic, zero-reveal — see cm-live.ts for the
// locked P-024 §4 contract). The file is the document: no serializer exists on this path,
// so only typed bytes ever change the buffer. Receives the frontmatter-stripped body
// (EditorPane re-attaches the verbatim frontmatter on every change, exactly like the
// rendered view) and reports edits upward as plain text.

import { minimalChange } from '@shared/text-change'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, drawSelection, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands'
import {
  search,
  openSearchPanel,
  closeSearchPanel,
  setSearchQuery,
  SearchQuery
} from '@codemirror/search'

import {
  livePreview,
  liveMarkdownLanguage,
  linkClickHandler,
  openImageTarget,
  type LiveLinkHit
} from './cm-live'
import { buildLiveTheme } from './cm-live-theme'
import { wikilinkHighlighter } from './cm-theme'
import { editorSearchKeymap } from './cm-search-keys'
import { editorLinks } from './cm-editor-links'
import { type EditorLinkNav } from './editor-links'
import { useClampedPosition } from '../../hooks/use-clamped-position'
import { useAppSettingsStore } from '../../stores/app-settings-store'
import { Tooltip } from '../../components/Tooltip'
import { checkboxCompletion } from './cm-checkbox'
import { emDashReplace } from './cm-emdash'
import { nudgeSpellcheck, proseSpellcheckAttrs } from './cm-spellcheck'
import {
  anchorForOffset,
  bestMatch,
  blockAt,
  clampOffset,
  plainToSrc,
  resolveAnchorOffset,
  sourceBlocks,
  srcToPlain
} from './caret-anchor'
import {
  cmViewportTopOffset,
  initialCMParts,
  scrollElementIntoContainer,
  scrollParent,
  type InitialView
} from './initial-view'
import { traceCaret, traceKey } from './caret-trace'
import { type EditorController, type EditorKind } from './editor-controller'
import styles from './EditorPane.module.css'

interface LiveEditorProps {
  path: string
  /** The BODY source (frontmatter already split off by EditorPane). */
  value: string
  onChange: (next: string) => void
  onSave: () => void
  onController?: (controller: EditorController | null) => void
  /** E-024 — an image chip was clicked, or a link popover's Open pressed; `target` is the
   *  markdown URL as written (http(s) or a doc-relative/absolute path). */
  onOpenTarget?: (target: string) => void
  /** T-184 — Cmd+click link navigation (doc resolution bases + the ambiguity-picker opener). */
  linkNav?: EditorLinkNav
  /** T-185 — the position to open at (saved viewport / caret bridge / a `:line` pre-translated to a
   *  caret anchor), read ONCE at mount (or first show); null = top. See initial-view.ts. */
  getInitialView?: (kind: EditorKind) => InitialView | null
  /** T-185 — whether this pane is the visible one (gates the first-paint apply). */
  visible?: boolean
}

export function LiveEditor({
  path,
  value,
  onChange,
  onSave,
  onController,
  onOpenTarget,
  linkNav,
  getInitialView,
  visible
}: LiveEditorProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  // T-185 — read live inside the mount / show effects without re-creating the editor.
  const getInitialViewRef = useRef(getInitialView)
  getInitialViewRef.current = getInitialView
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  // T-185 — apply the initial position exactly once per instance (mount-when-visible, else first show).
  const initialAppliedRef = useRef(false)
  // E-024 slice 3 — the link whose URL popover is open (null = closed). The URL is edited
  // HERE, never inline in the buffer (P-024 §4: the URL half is atomic).
  const [linkPop, setLinkPop] = useState<LiveLinkHit | null>(null)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const onControllerRef = useRef(onController)
  const onOpenTargetRef = useRef(onOpenTarget)
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  onControllerRef.current = onController
  onOpenTargetRef.current = onOpenTarget
  // T-152 — em-dash toggle read live inside the CM input handler (stable ref, editor built once).
  const emDashEnabled = useAppSettingsStore((s) => s.emDashReplace)
  const emDashEnabledRef = useRef(emDashEnabled)
  emDashEnabledRef.current = emDashEnabled

  // T-184 — a STABLE nav object (see RawEditor) so a fresh `linkNav` prop never rebuilds the editor.
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
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      search({ top: true }),
      // `- ` + `[` completes to a checkbox exactly like raw mode (cancellable, T-050/T-077).
      checkboxCompletion(),
      // T-152 — em-dash auto-replacement. Live is always a markdown BODY (frontmatter already
      // split off), so no frontmatter guard; code context is guarded via the GFM syntax tree.
      emDashReplace({ isEnabled: () => emDashEnabledRef.current }),
      // The decoration layer FIRST (its Backspace/Delete keymap is Prec.highest anyway).
      livePreview(),
      openImageTarget.of((target) => onOpenTargetRef.current?.(target)),
      // Clicking a link's text opens the URL popover (setLinkPop is a stable setter).
      linkClickHandler(setLinkPop),
      // `[[wikilink]]` runs read as links (visual-only MatchDecorator — T-054 parity with
      // both other views).
      wikilinkHighlighter,
      // T-184 — Cmd+click link detection (shared with the Raw editor). Its mousedown handler acts
      // ONLY on Cmd (returns false otherwise), so plain-click link-text → the E-024 URL popover
      // (linkClickHandler above) is untouched.
      editorLinks(stableLinkNav),
      saveKeymap,
      // The markdown language ships its own keymap (Enter = continue list/quote by copying
      // the CURRENT marker — style-matched by construction; Backspace = delete markup).
      liveMarkdownLanguage(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...editorSearchKeymap]),
      buildLiveTheme(),
      // Live is a prose view — always a markdown file, so the OS spellchecker is on (same shared
      // attrs + Chromium-44 loaded-text caveat as the raw editor; see cm-spellcheck.ts).
      proseSpellcheckAttrs,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString())
      })
    ]

    // T-185 / T-194 — FIRST PAINT AT POSITION. Bake the caret selection into the initial state; the
    // SCROLL is applied to the OUTER container synchronously after creation (Live's own `.cm-scroller`
    // has natural height — CM's `scrollTo` config can't move the outer `.mdScroll`, so it is scrolled
    // directly, in-effect, before paint). For a `toggle` the scroll follows the KEPT VIEWPORT while
    // the caret is only baked into the selection (T-194). A hidden pane defers to the show effect below.
    initialAppliedRef.current = false
    const iv = visibleRef.current ? getInitialViewRef.current?.('live') : null
    const parts = iv ? initialCMParts(iv, value) : null

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        selection: parts?.selectionPos != null ? { anchor: parts.selectionPos } : undefined,
        extensions
      })
    })
    viewRef.current = view
    if (parts) {
      if (parts.scrollPos != null) scrollLiveOuter(view, parts.scrollPos, parts.place)
      initialAppliedRef.current = true
    }

    // T-083 — nudge Chromium to spell-check the ALREADY-loaded text (Live is always prose; see
    // cm-spellcheck.ts). Disposed with the view below.
    const disposeSpellcheck = nudgeSpellcheck(view)

    const controller: EditorController = {
      kind: 'live',
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
      // T-004 caret bridge — same block-plain-text anchors as the raw editor, computed on
      // the BODY (anchor matching is text-based, so the frontmatter offset the raw view
      // carries and this view doesn't never matters).
      getCaretAnchor: () => {
        const source = view.state.doc.toString()
        const head = view.state.selection.main.head
        const span = Math.max(1, source.length)
        const fraction = Math.min(1, Math.max(0, head / span))
        const block = blockAt(sourceBlocks(source), head)
        if (!block) return { key: '', offset: 0, fraction }
        return { key: block.key, offset: srcToPlain(block, head), fraction }
      },
      setCaretAnchor: (anchor) => {
        // StrictMode: a DOOMED first controller (dev double mount) may have a destroyed view by
        // the time the jump leg or toggle restore calls this. Dispatching to a destroyed view
        // throws; bail on a detached DOM so EditorPane's survivor guards can re-post/re-apply to
        // the surviving instance instead of the exception killing the whole apply.
        if (!view.dom.isConnected) return
        const source = view.state.doc.toString()
        const blocks = sourceBlocks(source)
        const hit = anchor.key ? bestMatch(blocks.map((b) => b.key), anchor.key) : -1
        traceCaret('land-live', {
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
          const guess = Math.round(anchor.fraction * source.length)
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
        // The outer .liveScroll owns scrolling (CM's own scroller has natural height), so
        // re-assert visibility against the real container after layout, like the rendered
        // caret restore does.
        requestAnimationFrame(() => {
          if (!view.dom.isConnected) return
          try {
            const pos = view.state.selection.main.head
            const at = view.domAtPos(pos).node
            const el = at instanceof HTMLElement ? at : at.parentElement
            el?.scrollIntoView({ block: 'center' })
          } catch {
            /* best-effort */
          }
          if (!view.hasFocus) view.focus()
        })
        traceCaret('landed-live', { target, focused: view.hasFocus })
      },
      // T-185 — reading position over the BODY source (the anchor is text-based, so it matches a
      // viewport captured in raw over the full file just as well). null when not laid out (hidden).
      getViewportAnchor: () => {
        if (!view.dom.isConnected || view.dom.offsetParent === null) return null
        return anchorForOffset(view.state.doc.toString(), cmViewportTopOffset(view))
      },
      // T-185 — scroll the matching block to the outer container's top, no caret move (re-show).
      scrollToViewportAnchor: (anchor) => {
        if (!view.dom.isConnected) return
        const pos = resolveAnchorOffset(view.state.doc.toString(), anchor)
        scrollLiveOuter(view, Math.min(Math.max(0, pos), view.state.doc.length), 'start')
      },
      // T-194 — mode-toggle restore: set the caret WITHOUT scrolling it in, scroll the KEPT viewport
      // to the outer container's top (scrollLiveOuter, since Live's own scroller has natural height),
      // and re-focus (preventScroll, so the caret doesn't yank the viewport back).
      applyToggleView: (selection, viewport) => {
        if (!view.dom.isConnected) return
        const source = view.state.doc.toString()
        const clamp = (n: number): number => Math.min(Math.max(0, n), view.state.doc.length)
        const selPos = selection ? clamp(resolveAnchorOffset(source, selection)) : null
        const scrollPos = viewport ? clamp(resolveAnchorOffset(source, viewport)) : selPos
        if (selPos != null) view.dispatch({ selection: { anchor: selPos } })
        if (scrollPos != null) scrollLiveOuter(view, scrollPos, viewport ? 'start' : 'center')
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
      setLinkPop(null)
      disposeSpellcheck()
      view.destroy()
      viewRef.current = null
    }
    // Re-create only when the file identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt per path only; value seeds the doc and later values flow through the reconcile effect below; callbacks and settings are refs, the rest stable
  }, [path])

  // Reconcile external value changes (disk reload, a mode toggle carrying edits, a
  // properties-panel-induced body change) without clobbering the caret when unchanged.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const change = minimalChange(view.state.doc.toString(), value)
    if (change) view.dispatch({ changes: change })
  }, [value])

  // T-185 — first-show restore for a pane mounted hidden (see RawEditor for the full rationale). A
  // layout effect keeps it pre-paint; `initialAppliedRef` makes it fire once so a later show keeps
  // the user's retained scroll.
  useLayoutEffect(() => {
    if (!visible || initialAppliedRef.current) return
    const view = viewRef.current
    if (!view) return
    initialAppliedRef.current = true
    const iv = getInitialViewRef.current?.('live')
    if (!iv) return
    const p = initialCMParts(iv, view.state.doc.toString())
    if (p.selectionPos != null) {
      view.dispatch({ selection: { anchor: p.selectionPos } })
      view.focus()
    }
    if (p.scrollPos != null) scrollLiveOuter(view, p.scrollPos, p.place)
  }, [visible])

  // ── Link URL popover (E-024: URL edits live HERE, never inline in the buffer) ──
  const closeLinkPop = (): void => {
    setLinkPop(null)
    viewRef.current?.focus()
  }
  const applyLinkUrl = (next: string): { applied: boolean } => {
    const view = viewRef.current
    const hit = linkPop
    if (!view || !hit) return { applied: false }
    // Re-verify the snapshot against the live doc — the buffer may have changed under the
    // open popover (same discipline as the color swatch writeback, T-068).
    const still = view.state.doc.sliceString(hit.urlFrom, hit.urlTo) === hit.url
    if (still && next !== hit.url) {
      view.dispatch({
        changes: { from: hit.urlFrom, to: hit.urlTo, insert: next },
        annotations: isolateHistory.of('full'),
        userEvent: 'input.replace'
      })
      return { applied: true }
    }
    return { applied: still }
  }

  return (
    <>
      <div ref={hostRef} className={styles.liveHost} data-testid="live-editor" />
      {linkPop && (
        <LinkPopover
          hit={linkPop}
          onApply={(url) => {
            applyLinkUrl(url)
            closeLinkPop()
          }}
          onOpen={(url) => {
            applyLinkUrl(url)
            setLinkPop(null)
            onOpenTargetRef.current?.(url)
          }}
          onCancel={closeLinkPop}
        />
      )}
    </>
  )
}

// T-185 — scroll the OUTER container (`.mdScroll`/`.liveScroll`) so the block at `pos` sits at its
// top (or centered) — the live view scrolls in that ancestor, not CM's own natural-height scroller.
// Driven off CM's HEIGHT MAP (`lineBlockAt` + `documentTop`), NOT the DOM node: at first paint CM
// virtualizes and hasn't rendered a far-down block yet, so `domAtPos` there is unreliable — the
// height map knows every block's position regardless. A RAF re-apply corrects the estimate once CM
// has measured the real line heights.
function scrollLiveOuter(view: EditorView, pos: number, place: 'start' | 'center'): void {
  const container = scrollParent(view.scrollDOM)
  if (container === view.scrollDOM) {
    view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: place }) })
    return
  }
  const clamped = Math.min(Math.max(0, pos), view.state.doc.length)
  const apply = (): void => {
    try {
      const block = view.lineBlockAt(clamped)
      const cr = container.getBoundingClientRect()
      let delta = view.documentTop + block.top - cr.top
      if (place === 'center') delta -= cr.height / 2 - block.height / 2
      container.scrollTop += delta
    } catch {
      // Fallback to the DOM node if the height map isn't ready (best-effort).
      try {
        const node = view.domAtPos(clamped).node
        const el = node instanceof HTMLElement ? node : node.parentElement
        if (el) scrollElementIntoContainer(el, container, place)
      } catch {
        /* best-effort */
      }
    }
  }
  apply()
  requestAnimationFrame(apply)
}

// ─── The link URL popover ─────────────────────────────────────────────────────────
// Anchored at the click, viewport-clamped (T-088 hook). Enter/Apply writes the URL back
// as ONE isolated history step; Open also launches the target (http(s) → default browser,
// local paths → their own tab, routed by EditorPane); Esc / scrim click cancels.

function LinkPopover({
  hit,
  onApply,
  onOpen,
  onCancel
}: {
  hit: LiveLinkHit
  onApply: (url: string) => void
  onOpen: (url: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [url, setUrl] = useState(hit.url)
  const { ref, left, top } = useClampedPosition<HTMLDivElement>(hit.x, hit.y + 12)

  return (
    <>
      <div className={styles.scrim} onClick={onCancel} />
      <div
        ref={ref}
        className={styles.linkPopover}
        style={{ left, top }}
        role="dialog"
        aria-label="Link URL"
        data-testid="link-popover"
      >
        <input
          className={styles.linkPopoverInput}
          data-testid="link-popover-url"
          value={url}
          autoFocus
          spellCheck={false}
          placeholder="https://…"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            // preventDefault: applying refocuses the editor synchronously, and without it
            // the tail of this very keystroke (keypress) lands in CodeMirror — an Enter
            // would type a newline INTO the link text.
            if (e.key === 'Enter') {
              e.preventDefault()
              onApply(url)
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              onCancel()
            }
          }}
        />
        <Tooltip lines={['Open link']}>
          <button
            type="button"
            className={styles.linkPopoverBtn}
            data-testid="link-popover-open"
            onClick={() => onOpen(url)}
          >
            Open
          </button>
        </Tooltip>
      </div>
    </>
  )
}
