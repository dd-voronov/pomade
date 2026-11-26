// Pomade — the editor pane's view/mode concern: the T-015 default-open coercion, the T-014 mode
// toggle (with the T-004 caret snapshot), the E-024 Live⇄Rendered rich-view switch, the E-023
// parse-health gate (mdGuard), the CSV parse/read-only classification, the markdown frontmatter
// split, and the derived which-editor-is-shown flags + the mode-button label. Reads/writes the
// shared caret + buffer refs owned by the pane.

import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'

import type { DocTab } from '@shared/types'
import { parseCsv } from './CsvTable'
import { splitFrontmatter } from './doc-io'
import { richViewDefault } from './open-mode'
import { parsesCleanly } from './md-roundtrip'
import { traceCaret, traceKey } from './caret-trace'
import type { CaretAnchor } from './caret-anchor'
import type { EditorController } from './editor-controller'
import type { RichKind } from './doc-kind'

type DocMetaPatch = Partial<Pick<DocTab, 'path' | 'title' | 'mode' | 'symlink' | 'richView'>>
type PendingToggle = {
  kind: 'raw' | 'rendered' | 'live'
  caret: CaretAnchor | null
  viewport: CaretAnchor | null
} | null

export interface EditorMode {
  mdGuard: 'unknown' | 'ok' | 'unparseable'
  forceRendered: boolean
  csvMalformed: boolean
  mdFrontmatter: string
  mdBody: string
  mdRenderedShown: boolean
  tableShown: boolean
  renderedShown: boolean
  docRichView: 'live' | 'rendered'
  modeLabel: string
  currentView: 'live' | 'rendered' | 'raw'
  toggleMode: () => void
  switchRichView: () => void
}

export function useEditorMode(params: {
  doc: DocTab
  richKind: RichKind
  richActive: boolean
  liveShown: boolean
  content: string
  loaded: boolean
  settingsHydrated: boolean
  mdDefaultMode: 'raw' | 'rendered'
  projectId: string
  tabId: string
  setDocMeta: (projectId: string, tabId: string, patch: DocMetaPatch) => void
  controllerRef: MutableRefObject<EditorController | null>
  pendingToggleRef: MutableRefObject<PendingToggle>
  frontmatterRef: MutableRefObject<string>
  mdBodyRef: MutableRefObject<string>
}): EditorMode {
  const {
    doc,
    richKind,
    richActive,
    liveShown,
    content,
    loaded,
    settingsHydrated,
    mdDefaultMode,
    projectId,
    tabId,
    setDocMeta,
    controllerRef,
    pendingToggleRef,
    frontmatterRef,
    mdBodyRef
  } = params

  const [mdGuard, setMdGuard] = useState<'unknown' | 'ok' | 'unparseable'>('unknown')
  const [forceRendered, setForceRendered] = useState(false) // override: edit rendered anyway (this tab)

  const path = doc.path

  // ── Uniform, configurable default open mode for markdown (T-015) ──────────────
  // The openers (file tree / new-doc) always open .md in 'rendered'. When the app-level
  // default is 'raw', coerce a markdown pane to raw once on mount — this is the only
  // correction the openers can't express. We deliberately DON'T force the other direction:
  // a tab the user left in raw (restored from a previous session) must stay raw when the
  // default is 'rendered'. The parse gate still forces raw afterwards when the BODY can't be
  // parsed — silently, the mode button showing "Raw" is the only indicator.
  // CSV keeps its own tab mode.
  const appliedDefaultRef = useRef(false)
  useEffect(() => {
    if (appliedDefaultRef.current) return
    if (!loaded || !settingsHydrated || richKind !== 'markdown') return
    appliedDefaultRef.current = true
    // E-024: the coercion covers BOTH rich modes ('rendered' and 'live') — under the raw
    // default every markdown pane opens raw, whatever rich view the opener chose.
    if (mdDefaultMode === 'raw' && doc.mode !== 'raw') {
      setDocMeta(projectId, tabId, { mode: 'raw' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot behind appliedDefaultRef; mdDefaultMode and doc.mode are read when load and settings hydration first both hold
  }, [loaded, settingsHydrated, richKind])

  // ── CSV: malformed → fall back to raw with a notice ──────────────────────────
  const csvParse = useMemo(
    () => (richKind === 'table' ? parseCsv(content) : null),
    [richKind, content]
  )
  const csvMalformed = richActive && richKind === 'table' && csvParse != null && !csvParse.ok

  // ── Markdown: frontmatter split + parse gate ─────────────────────────────────
  const { frontmatter: mdFrontmatter, body: mdBody } = useMemo(
    () => (richKind === 'markdown' ? splitFrontmatter(content) : { frontmatter: '', body: content }),
    [richKind, content]
  )
  frontmatterRef.current = mdFrontmatter
  mdBodyRef.current = mdBody

  // E-023 — parse-health gate (once loaded, when the doc is set to rendered). We check only that
  // Milkdown can PARSE the body it is about to render — the buffer, unsaved edits and recovered
  // drafts included, never the disk version. A parse failure forces the pane back to raw (the
  // safety net — a file the editor can't parse must not enter rendered by default). We deliberately do NOT
  // check round-trip fidelity anymore: canonicalization-on-save is accepted policy, so a file
  // that would be re-formatted on save still opens rendered. The mode button showing "Raw" is the
  // only indicator (T-040); clicking it switches immediately (T-042).
  useEffect(() => {
    if (!loaded || richKind !== 'markdown' || doc.mode !== 'rendered' || forceRendered) return
    let cancelled = false
    setMdGuard('unknown')
    void parsesCleanly(mdBody).then((ok) => {
      if (!cancelled) setMdGuard(ok ? 'ok' : 'unparseable')
    })
    return () => {
      cancelled = true
    }
    // mdBody (the text Milkdown is handed) is read once per entry into rendered mode; not a reactive dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the gate re-checks per entry into rendered; mdBody is read at that moment only
  }, [loaded, richKind, doc.mode, forceRendered, path])

  const mdRenderedShown =
    richActive && richKind === 'markdown' && (forceRendered || mdGuard === 'ok')
  const tableShown = richActive && richKind === 'table' && !csvMalformed
  const renderedShown = mdRenderedShown || tableShown

  // E-024 — THIS doc's rich view: the one currently shown, else the persisted per-tab
  // override, else the app-level Keep/Adjust default. Drives the ⋯ menu's "Rich view" line
  // (label = CURRENT state) and the raw→rich toggle target.
  const docRichView: 'live' | 'rendered' = liveShown
    ? 'live'
    : mdRenderedShown
      ? 'rendered'
      : (doc.richView ?? richViewDefault())

  // ── Mode toggle (T-014) ───────────────────────────────────────────────────────
  // The button LABEL shows the CURRENT view (not the click target); clicking toggles.
  // T-004 / T-194 — snapshot the outgoing engine's caret anchor AND its on-screen viewport top
  // (raw ⇄ live ⇄ rendered only; CSV has no linear caret) SYNCHRONOUSLY, before the mode change
  // remounts the editor. The successor keeps the VIEWPORT (reading position) and restores the caret
  // as the SELECTION only — see initial-view.ts / EditorController.applyToggleView.
  const snapshotToggle = (): void => {
    const ctrl = controllerRef.current
    if (ctrl && ctrl.kind !== 'table') {
      const caret = ctrl.getCaretAnchor?.() ?? null
      const viewport = ctrl.getViewportAnchor?.() ?? null
      pendingToggleRef.current = caret || viewport ? { kind: ctrl.kind, caret, viewport } : null
      traceCaret('snapshot', {
        from: ctrl.kind,
        key: caret ? traceKey(caret.key) : null,
        offset: caret?.offset ?? null,
        vp: viewport ? traceKey(viewport.key) : null
      })
    } else {
      pendingToggleRef.current = null
      traceCaret('snapshot-missing', {
        hasCtrl: !!ctrl,
        kind: ctrl?.kind ?? null,
        hasGetter: !!ctrl?.getCaretAnchor
      })
    }
  }

  const toggleMode = (): void => {
    snapshotToggle()
    if (renderedShown || liveShown) {
      // E-024 — persist which rich view this doc is leaving (DocTab.richView), so the
      // return leg of the two-state toggle comes back to the SAME view — across relaunch
      // too (richView rides in ProjectState with the rest of the tab).
      const leaving: 'live' | 'rendered' | undefined =
        richKind === 'markdown' ? (liveShown ? 'live' : 'rendered') : undefined
      setDocMeta(projectId, tabId, { mode: 'raw', ...(leaving ? { richView: leaving } : {}) })
      return
    }
    // Switching INTO rendered. An EXPLICIT toggle ALWAYS wins (T-040/T-042 doctrine): no banner,
    // no confirm, and no bounce — so set the override unconditionally here, before the mode flip.
    //
    // Setting the override on the toggle path makes the gesture authoritative regardless of when —
    // or whether — the parse gate has run: the gate only runs while `doc.mode === 'rendered'`, so a
    // tab sitting in raw still reads 'unknown' at toggle time. The gate forces raw only when the
    // body is unparseable; `forceRendered` bypasses even that — an explicit toggle wins
    // unconditionally, with the same save behaviour (frontmatter split out and re-attached verbatim).
    // E-024 — the raw→rich leg targets this DOC's rich view (persisted per-tab override),
    // else the app-level "Keep/Adjust formatting" default, read at toggle time. Only the
    // Milkdown target needs the parse-gate override; Live has no gate.
    const richTarget = richKind === 'markdown' ? (doc.richView ?? richViewDefault()) : 'rendered'
    if (richTarget === 'rendered' && richKind === 'markdown' && !forceRendered) {
      setForceRendered(true)
    }
    setDocMeta(projectId, tabId, { mode: richTarget })
  }

  // ⋯ menu: switch this doc's rich view between Live and Rendered. Sitting in a rich view,
  // the switch happens immediately (caret carried across, same bridge as the mode toggle);
  // sitting in raw, only the persisted target changes.
  const switchRichView = (): void => {
    const next: 'live' | 'rendered' = docRichView === 'live' ? 'rendered' : 'live'
    if (liveShown || mdRenderedShown) {
      // Same T-194 snapshot as a mode toggle — Live⇄Rendered is a remount too, keep the viewport.
      snapshotToggle()
      // Entering Milkdown bypasses the parse gate — an explicit gesture wins (T-042 doctrine).
      if (next === 'rendered' && !forceRendered) setForceRendered(true)
      setDocMeta(projectId, tabId, { mode: next, richView: next })
      return
    }
    setDocMeta(projectId, tabId, { richView: next })
  }

  const richLabel = richKind === 'table' ? 'Table' : 'Rendered'
  // T-014 — the toggle shows the CURRENT view: Live/Rendered/Table when rich, else Raw.
  const modeLabel = liveShown ? 'Live' : renderedShown ? richLabel : 'Raw'
  // The pane's current view for testing/data attributes: 'live' | 'rendered' | 'raw'.
  const currentView: 'live' | 'rendered' | 'raw' = liveShown ? 'live' : renderedShown ? 'rendered' : 'raw'

  return {
    mdGuard,
    forceRendered,
    csvMalformed,
    mdFrontmatter,
    mdBody,
    mdRenderedShown,
    tableShown,
    renderedShown,
    docRichView,
    modeLabel,
    currentView,
    toggleMode,
    switchRichView
  }
}
