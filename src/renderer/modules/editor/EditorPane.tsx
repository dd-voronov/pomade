// Pomade Wave 2c — Document editor pane. Registered for TabKind 'doc'.
//   - Raw mode: CodeMirror 6 (language by extension, app-themed).
//   - Rendered mode: Milkdown for .md (editable), an editable lossless table for .csv.
//   - Cmd/Ctrl+S saves via fs.write; dirty tracking drives the tab dot.
//   - Robust to missing / binary / huge files; preserves CRLF + trailing newline.

import { useEffect, useMemo, useRef, useState } from 'react'

import type { DocTab, Tab } from '@shared/types'
import { classifyScope, scopeRelativePath } from '@shared/paths'
import { useTabsStore } from '../../stores/tabs-store'
import { buildAllProjects, useWorkspaceStore } from '../../stores/workspace-store'
import { useProjectScopeFolders } from '../../stores/project-scope'
import { useAppSettingsStore } from '../../stores/app-settings-store'
import { useToast } from '../../hooks/useToast'
import { useCloseGuard } from '../../hooks/useCloseGuard'
import { EditorLinkPicker } from './EditorLinkPicker'
import { useEditorLinkNav } from './useEditorLinkNav'
import { basename, richKindFor } from './doc-kind'
import { anchorForLine, type CaretAnchor } from './caret-anchor'
import type { InitialView } from './initial-view'
import type { EditorController, EditorKind } from './editor-controller'
import { useJumpStore } from '../../stores/jump-store'
import { registerViewportCapturer } from '../../stores/viewport-capture'
import { EditorContextMenu } from './EditorContextMenu'
import { useEditorFind } from './useEditorFind'
import { useDocFile } from './useDocFile'
import { useSavePipeline } from './useSavePipeline'
import { useRecovery } from './useRecovery'
import { announceDocChannels, registerDocChannel, type DocChannelState } from './doc-buffers'
import { openQuickPeek } from '../git/quick-peek'
import { openComparison } from '../git/open-compare'
import { DocHistoryPanel, type RestoreOutcome } from '../git/history/DocHistoryPanel'
import { useDocHistoryStore } from '../git/history/doc-history-store'
import { splitFrontmatter } from './doc-io'
import { parsesCleanly } from './md-roundtrip'
import { cleanIpcError } from '../../lib/ipc-errors'
import { CopyToModal } from './CopyToModal'
import {
  CloseGuardDialog,
  OutsideSaveDialog,
  OverwriteDialog,
  ReplaceWithVersionDialog,
  RestoreUnderDialog,
  SaveAsDialog,
  SaveConflictDialog
} from './EditorDialogs'
import { SymlinkPopover } from '../filetree/SymlinkPopover'
import { useEditorContextMenu } from './useEditorContextMenu'
import { useDocActions } from './useDocActions'
import { useEditorMode } from './useEditorMode'
import { useEditorController } from './useEditorController'
import { EditorHeader } from './EditorHeader'
import { EditorBody } from './EditorBody'
import styles from './EditorPane.module.css'

// T-194 — how long after scrolling settles before the reading position is persisted (setDocMeta).
// A plain debounce: only the last scroll in a burst pays the anchor read + store write.
const VIEWPORT_PERSIST_DEBOUNCE_MS = 500

export function EditorPane({ tab }: { tab: Tab }): React.JSX.Element {
  const doc = tab as DocTab
  const projectId = doc.projectId
  const tabId = doc.id

  const toast = useToast()
  const markDirty = useTabsStore((s) => s.markDirty)
  // T-187 — quit's "Save all docs" registry. This pane exposes a non-interactive save for its tab
  // so the quit flow can save every dirty doc across ALL projects (hidden panes included — panes are
  // never unmounted) before the app exits.
  const registerSaveGuard = useTabsStore((s) => s.registerSaveGuard)
  const unregisterSaveGuard = useTabsStore((s) => s.unregisterSaveGuard)
  // E-035 — quit's "Discard all changes" keeps this pane's unsaved state as a discarded draft.
  const registerDiscardGuard = useTabsStore((s) => s.registerDiscardGuard)
  const unregisterDiscardGuard = useTabsStore((s) => s.unregisterDiscardGuard)
  const requestCloseAllDocs = useTabsStore((s) => s.requestCloseAllDocs)
  const closeSavedDocs = useTabsStore((s) => s.closeSavedDocs)
  const setDocMeta = useTabsStore((s) => s.setDocMeta)
  // T-063 — clicking into this editor commits it out of preview mode (if it is the preview tab).
  const commitPreview = useTabsStore((s) => s.commitPreview)
  // T-101 — every project's tabs, for the cross-project duplicate-open indicator on this doc.
  const tabsByProject = useTabsStore((s) => s.tabsByProject)
  // E-016 — whether this pane is the visible one (active tab of the active project). Used to
  // re-check the file on disk when the pane comes back into view (see the visibility effect).
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId)
  const activeTabId = useTabsStore((s) => s.activeTabByProject[projectId])
  const visible = activeProjectId === projectId && activeTabId === tabId
  const wsRoot = useWorkspaceStore((s) => s.root)
  const mdDefaultMode = useAppSettingsStore((s) => s.markdownDefaultMode)
  const settingsHydrated = useAppSettingsStore((s) => s.hydrated)
  const setMarkdownDefaultMode = useAppSettingsStore((s) => s.setMarkdownDefaultMode)
  // T-090 — one global "the header shows the path, not just the name" flag. Subscribing here is
  // what makes a click in ONE header apply live to every open pane (and it is persisted, so the
  // choice survives a relaunch).
  const showPath = useAppSettingsStore((s) => s.editorHeaderShowPath)
  const setShowPath = useAppSettingsStore((s) => s.setEditorHeaderShowPath)
  // E-013 (T-053 round-3) — per-project properties-panel expand state. Subscribing here is what
  // makes a toggle in ONE pane apply live to every other open pane OF THE SAME PROJECT (no reopen);
  // other projects are unaffected.
  const propertiesPanelExpanded = useTabsStore((s) => s.propertiesPanelExpandedByProject[projectId] ?? true)
  const togglePropertiesPanelExpanded = useTabsStore((s) => s.togglePropertiesPanelExpanded)
  const projects = useWorkspaceStore((s) => s.projects)
  const project = useMemo(
    () => buildAllProjects(projects).find((p) => p.id === projectId),
    [projects, projectId]
  )
  const rootPath = project?.rootPath ?? ''
  const scopeFolders = useProjectScopeFolders(projectId)

  const path = doc.path
  // T-226 — a version tab: an earlier version of `path` in its own tab (shared/doc-version.ts).
  const version = doc.version
  const versionTab = !!version
  const richKind = richKindFor(path)
  // A file only offers "rendered" if it has a rich mode; otherwise force raw.
  const richActive = doc.mode === 'rendered' && richKind !== null
  // E-024 — the byte-true LIVE view (markdown only; a non-markdown tab that somehow says
  // 'live' falls through to raw). No parse gate: a text editor can't fail to display text.
  const liveShown = doc.mode === 'live' && richKind === 'markdown'

  // E-012 (final) — the open symlink popover for the header link chip (anchor rect).
  const [symlinkPop, setSymlinkPop] = useState<DOMRect | null>(null)
  // T-158 — the doc-actions ⋯ dropdown, opened through the shared ContextMenu primitive; the anchor
  // is captured from the trigger button's rect so the menu clamps to the viewport.
  const [actionsAnchor, setActionsAnchor] = useState<{ x: number; y: number } | null>(null)
  // E-013 — the editor ⋯ "Add properties" action, for a markdown file that has no frontmatter
  // yet: opens the panel's add-property row; the block is created on first commit.
  const [addPropsRequested, setAddPropsRequested] = useState(false)

  // The controller of whichever editor is currently mounted (raw CM or rendered PM).
  const controllerRef = useRef<EditorController | null>(null)
  // T-004 / T-194 — what to restore after a raw⇄live⇄rendered remount, snapshotted at toggle time
  // (before the mode change remounts the editor) off the OUTGOING engine, consumed when the new
  // editor registers its controller (setController):
  //   • caret    — the T-004 content anchor of the caret. Restored as the SELECTION only; NOT
  //                scrolled into view (T-194 decouples the caret from the toggle scroll).
  //   • viewport — the outgoing engine's on-screen viewport top (T-194). This is the SCROLL source:
  //                the incoming engine keeps the reading position instead of following the caret.
  // `kind` is the outgoing engine, so the restore fires only when the successor engine differs.
  const pendingToggleRef = useRef<{
    kind: 'raw' | 'rendered' | 'live'
    caret: CaretAnchor | null
    viewport: CaretAnchor | null
  } | null>(null)

  // ── E-001: right-click context menu (T-010/T-011) — the T-083 park-and-mount flow ──
  const {
    menu,
    setMenu,
    spell,
    setSpell,
    onContextMenu,
    onHeaderContextMenu,
    onBodyMouseDownCapture
  } = useEditorContextMenu(controllerRef, commitPreview, projectId, tabId)

  const rootRef = useRef<HTMLDivElement | null>(null)
  // The frontmatter block hidden from the current rendered session; re-attached on edit.
  const frontmatterRef = useRef('')
  // The body (content minus frontmatter); read at call time by the properties-panel writeback.
  const mdBodyRef = useRef('')
  const pathRef = useRef(path)
  pathRef.current = path

  // ── The document buffer + disk lifecycle (load/watch/reload/refusal) ──────────
  const docFile = useDocFile(projectId, tabId, pathRef, visible, markDirty, version?.source)
  const {
    content,
    setContent,
    loaded,
    refusal,
    missing,
    changedOutside,
    setChangedOutside,
    recoveredAt,
    setRecoveredAt,
    reloadNonce,
    isSymlink,
    savedRef,
    applyDirty,
    handleContentChange,
    reloadFromDiskRef,
    keepMine
  } = docFile

  // ── The save pipeline (writeTo/handleSave/Save-As/overwrite + conflict dialogs) ──
  const {
    saveAs,
    setSaveAs,
    overwrite,
    setOverwrite,
    outsideSavePrompt,
    resolveOutsideSave,
    saveConflict,
    resolveSaveConflict,
    writeTo,
    handleSave,
    handleSaveRef,
    confirmSaveAs,
    confirmOverwrite,
    saveForQuitRef,
    replacePrompt,
    resolveReplace,
    replaced
  } = useSavePipeline({
    projectId,
    tabId,
    pathRef,
    rootPath,
    doc: docFile,
    markDirty,
    setDocMeta,
    toast,
    flushEdits: () => controllerRef.current?.flushPendingEdits?.(),
    versionTab
  })

  // T-184 — link-resolution bases (doc dir → project root → ws root), the Cmd+click ambiguity
  // picker, and the deterministic e2e resolve probe; handed to whichever editor is mounted.
  const { linkNav, linkPicker, setLinkPicker } = useEditorLinkNav(pathRef, wsRoot, rootPath, tabId)

  // Rendered (Milkdown) AND live (E-024) edits carry only the body; re-attach the hidden
  // frontmatter so it survives on save byte-verbatim. Everything the rendered view can't
  // represent lives in frontmatter or was already ruled out by the round-trip guard; the
  // live view represents everything (it IS the source).
  const handleRenderedChange = (nextBody: string): void => {
    const next = frontmatterRef.current + nextBody
    setContent(next)
    applyDirty(next)
  }

  // E-013 — a properties-panel edit produces a NEW frontmatter block (surgical writeback). The
  // body is untouched; re-attach it, mark dirty, and let Cmd+S own the disk write — exactly the
  // same pipeline as a body edit. An empty block means the last property was removed → the whole
  // frontmatter block (delimiters + separating blank line) is dropped.
  const handleFrontmatterChange = (nextBlock: string): void => {
    const next = nextBlock + mdBodyRef.current
    setContent(next)
    applyDirty(next)
    if (nextBlock !== '') setAddPropsRequested(false)
    // A commit often unmounts the control that was clicked/typed (an input, a removed chip/row).
    // Refocus the pane root so Cmd+S — captured here via onKeyDownCapture — keeps working and
    // doesn't fall through to document.body.
    rootRef.current?.focus()
  }

  // ── Cmd/Ctrl+S captured at the pane root (covers CodeMirror AND Milkdown) ─────
  const onKeyDownCapture = (e: React.KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault()
      e.stopPropagation()
      void handleSaveRef.current()
    }
  }

  // ── Close (guarded when dirty) ────────────────────────────────────────────────
  const dirty = content !== savedRef.current
  const title = versionTab ? doc.title : path ? basename(path) : 'Untitled'

  // ── E-035: recovery copies + discarded drafts ─────────────────────────────────
  const recovery = useRecovery({ tabId, path, pathRef, title, dirty, doc: docFile, versionTab })
  const recoveryRef = useRef(recovery)
  recoveryRef.current = recovery
  // E-038 — the History panel's discarded-draft rows reload when a draft was just kept.
  const [draftsNonce, setDraftsNonce] = useState(0)
  // T-230 — History's Restore of a version kept under another path asks before renaming back.
  const [restoreUnder, setRestoreUnder] = useState<string | null>(null)
  const restoreUnderResolveRef = useRef<((ok: boolean) => void) | null>(null)
  const resolveRestoreUnder = (ok: boolean): void => {
    setRestoreUnder(null)
    const r = restoreUnderResolveRef.current
    restoreUnderResolveRef.current = null
    r?.(ok)
  }
  const confirmRestoreUnder = (earlier: string): Promise<boolean> =>
    new Promise((resolve) => {
      restoreUnderResolveRef.current?.(false)
      restoreUnderResolveRef.current = resolve
      setRestoreUnder(earlier)
    })
  const keepDraft = (reason: Parameters<typeof recovery.keepDraft>[0]): Promise<void> => {
    controllerRef.current?.flushPendingEdits?.()
    return recovery
      .keepDraft(reason)
      .then(() => setDraftsNonce((n) => n + 1))
      .catch((err: unknown) => {
        toast(`Could not keep a draft of ${title}: ${cleanIpcError(err)}`, 'error')
      })
  }
  useEffect(() => {
    registerDiscardGuard(tabId, () => {
      controllerRef.current?.flushPendingEdits?.()
      return recoveryRef.current.keepDraft('quit')
    })
    return () => unregisterDiscardGuard(tabId)
  }, [tabId, registerDiscardGuard, unregisterDiscardGuard])
  // The recovery banner's actions and the rule-8 resolutions (Keep mine / Use disk version, offered
  // by the disk ↔ my edits comparison through the doc channel). Each revert keeps the unsaved state
  // as a discarded draft first (its content is captured synchronously). The clicked button unmounts
  // with its banner, so focus returns to the editor — Cmd+S, captured at the pane root, keeps working.
  const refocusEditor = (): void => {
    if (controllerRef.current) controllerRef.current.focus()
    else rootRef.current?.focus()
  }
  const discardToDisk = (reason: 'recovery-discard' | 'load-disk'): void => {
    void keepDraft(reason)
    reloadFromDiskRef.current()
    refocusEditor()
  }
  const handleCompare = (): void => {
    openQuickPeek(doc).catch((err: unknown) => toast(`Could not open diff: ${cleanIpcError(err)}`, 'error'))
  }
  // ── The doc channel: the quick peek reads this buffer; a comparison tab (E-037) shares it ──
  // Another view's edit replaces the buffer here; a rich view that mounts its content once
  // (Milkdown, the CSV table) remounts the next time this pane is shown.
  const channelListeners = useRef(new Set<() => void>())
  const remountOnShowRef = useRef(false)
  const channelStateRef = useRef<DocChannelState>({ loaded: false, dirty: false, changedOutside: false, missing: false, refused: false })
  channelStateRef.current = { loaded, dirty: content !== savedRef.current, changedOutside, missing, refused: !!refusal }
  const keepMineNow = async (): Promise<void> => {
    await keepMine()
    await recoveryRef.current.putNow().catch(() => {})
  }
  const channelActionsRef = useRef({ keepMineNow, discardToDisk })
  channelActionsRef.current = { keepMineNow, discardToDisk }
  useEffect(() => {
    // A version tab is not the document: comparisons and the quick peek never reach its buffer.
    if (versionTab) return
    const read = (): string => {
      controllerRef.current?.flushPendingEdits?.()
      return docFile.contentRef.current
    }
    return registerDocChannel({
      tabId,
      projectId,
      path: () => pathRef.current,
      read,
      state: () => channelStateRef.current,
      write: (next) => {
        if (next === read()) return
        docFile.setContent(next)
        docFile.applyDirty(next)
        remountOnShowRef.current = true
      },
      save: async () => {
        if ((await saveForQuitRef.current()) === 'ok') return
        // Something needs a decision (an on-disk conflict, a first save outside the workspace):
        // the doc's own tab asks.
        useTabsStore.getState().setActive(projectId, tabId)
        await handleSaveRef.current()
      },
      reload: () => reloadFromDiskRef.current(),
      dismissChange: () => setChangedOutside(false),
      keepMine: () => channelActionsRef.current.keepMineNow(),
      loadDisk: () => channelActionsRef.current.discardToDisk('load-disk'),
      subscribe: (fn) => {
        channelListeners.current.add(fn)
        return () => {
          channelListeners.current.delete(fn)
        }
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one registration per pane; every member reads refs
  }, [tabId, projectId, versionTab])
  useEffect(() => {
    for (const fn of [...channelListeners.current]) fn()
  }, [content, dirty, loaded, changedOutside, missing, refusal])
  useEffect(() => announceDocChannels(), [path])
  useEffect(() => {
    if (visible && remountOnShowRef.current) {
      remountOnShowRef.current = false
      docFile.remountRich()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires per show; docFile is a fresh object every render and remountRich only bumps a nonce
  }, [visible])

  // The shared close guard (registers the tab-strip ×/Cmd+W/batch guard, holds the batch callback,
  // owns the T-118 focus-only-on-prompt rule). A dirty doc prompts; a clean one closes silently.
  const {
    prompt: closePrompt,
    setPrompt: setClosePrompt,
    resolveClose,
    closeNow,
    requestClose
  } = useCloseGuard(projectId, tabId, () => dirty)
  const saveThenClose = async (): Promise<void> => {
    const p = pathRef.current
    if (versionTab) {
      // A version tab's Save replaces the document: it asks first, like its Save button.
      setClosePrompt(false)
      if (await handleSaveRef.current()) {
        closeNow()
        resolveClose('proceed')
      } else resolveClose('cancel')
      return
    }
    if (!p) {
      // Untitled — needs a name first; open Save As and leave the tab open. The user bailed
      // out to name the doc, so treat it like Cancel: abort any surrounding batch.
      setClosePrompt(false)
      setSaveAs({ open: true, name: '' })
      resolveClose('cancel')
      return
    }
    const ok = (await writeTo(p, false)) === 'ok'
    if (ok) {
      setClosePrompt(false)
      closeNow()
      resolveClose('proceed')
    }
  }

  const requestCloseAll = (): void => {
    setActionsAnchor(null)
    // T-044 — route through the guard flow: clean docs close silently, each dirty doc prompts
    // Save / Discard / Cancel (Cancel aborts the rest). Replaces the old native window.confirm
    // that only offered discard-everything.
    requestCloseAllDocs(projectId)
  }

  // T-187 — register this doc's non-interactive save-for-quit so the quit flow's "Save all docs"
  // can reach it (the guard runs the live `saveForQuitRef` closure). Registered once per mount,
  // keyed by the globally-unique tab id; dropped on unmount.
  useEffect(() => {
    registerSaveGuard(tabId, () => saveForQuitRef.current())
    return () => unregisterSaveGuard(tabId)
  }, [tabId, registerSaveGuard, unregisterSaveGuard, saveForQuitRef])

  // View/mode concern: the T-015 default coercion, T-014 toggle (+ T-004 caret snapshot), E-024
  // rich-view switch, E-023 parse-health gate, CSV + frontmatter classification, and the derived
  // which-editor-is-shown flags + mode-button label.
  const {
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
  } = useEditorMode({
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
  })

  // In-document find (T-012): state + Cmd+F routing + close-on-leave, for the custom rendered/CSV
  // find panel (raw/live use CodeMirror's own).
  const find = useEditorFind(controllerRef, renderedShown, projectId, tabId)

  // Controller registration + T-004 caret bridge + one-shot terminal `path:line` jump (E-020).
  const setController = useEditorController({
    controllerRef,
    pendingToggleRef,
    tabId,
    loaded,
    content,
    richKind,
    docMode: doc.mode,
    forceRendered,
    mdGuard,
    renderedShown,
    tableShown,
    liveShown
  })
  // T-185 / T-194 — where this editor should open, computed fresh each render and read ONCE by
  // whichever engine mounts (or on its first show). Precedence, highest first:
  //   1. a pending `:line` jump (a FRESH open via a terminal/link) — the line is the only control
  //      (raw jumps to it; rich views translate it to a caret anchor). PEEKED here; the post-mount
  //      jump effect still `take()`s the slot exactly once and re-applies to the SAME spot (invisible),
  //      keeping the StrictMode survivor guards that own the one-shot clearing untouched. The `:line`
  //      is therefore ONE-SHOT (T-194): once taken, a later mode toggle finds no request here and
  //      keeps the reading position instead of re-jumping to the link line.
  //   2. the T-194 mode-toggle restore across a raw⇄live⇄rendered remount — the OUTGOING engine's
  //      viewport top is the SCROLL source (reading position kept), the caret bridge supplies the
  //      SELECTION only (baked in, not scrolled). PEEKED (setController clears the pending under its
  //      own survivor guard); only when the successor engine differs, matching that bridge's gate.
  //   3. the saved reading position (DocTab.viewport) — reopen (T-149), app restart, tab/project show.
  // A fresh tab from the tree has none of these ⇒ it opens at the top.
  const getInitialView = (kind: EditorKind): InitialView | null => {
    const jr = useJumpStore.getState().request
    if (jr && jr.tabId === tabId) {
      if (kind === 'raw') return { type: 'line', line: jr.line }
      if (kind === 'live' || kind === 'rendered') return { type: 'caret', anchor: anchorForLine(content, jr.line) }
      return null // CSV table has no line/position to open at
    }
    const pt = pendingToggleRef.current
    if (pt && kind !== 'table' && pt.kind !== kind) {
      return { type: 'toggle', selection: pt.caret, viewport: pt.viewport }
    }
    if (doc.viewport && kind !== 'table') return { type: 'viewport', anchor: doc.viewport }
    return null
  }

  // T-185 / T-194 — while this pane is the visible one, keep its reading position persisted two ways,
  // both writing the LIVE editor's viewport top onto the tab via setDocMeta:
  //   • SAVE POINTS (T-185): a capturer registered in viewport-capture, invoked by tabs-store at the
  //     save points (setActive on the OUTGOING tab, closeTab) and by App's quit handler via
  //     captureAllViewports.
  //   • DEBOUNCED SCROLL (T-194): ~500ms after scrolling settles, persist the position, so a
  //     restart/reopen restores the scrolled-to spot even with no tab switch / close / quit in
  //     between. Cheap by construction — each scroll tick only (re)schedules the timer; the anchor
  //     read + write happen once, after the scroll settles. Scroll events don't bubble, so the
  //     listener is CAPTURE-phase on the pane root to catch whichever engine's scroller fired.
  useEffect(() => {
    if (!visible) return
    const writeViewport = (): void => {
      const vp = controllerRef.current?.getViewportAnchor?.()
      if (vp) setDocMeta(projectId, tabId, { viewport: vp })
    }
    const dispose = registerViewportCapturer(tabId, writeViewport)
    const root = rootRef.current
    let timer: ReturnType<typeof setTimeout> | undefined
    const onScroll = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(writeViewport, VIEWPORT_PERSIST_DEBOUNCE_MS)
    }
    root?.addEventListener('scroll', onScroll, true)
    return () => {
      dispose()
      root?.removeEventListener('scroll', onScroll, true)
      if (timer) clearTimeout(timer)
    }
  }, [visible, tabId, projectId, setDocMeta])

  // e2e observability (T-175): the VISIBLE pane exposes its editor's current selection start, so
  // a spec can wait for a caret-placing click to REGISTER in the editor's state before it types.
  // Milkdown/ProseMirror mounts async: on a tab-switch the freshly-shown view accepts a click into
  // the DOM a beat before its own state catches up (a window Electron 44's newer Chromium widened),
  // so instant synthetic typing would otherwise land at the document start. A real user never types
  // that fast; this hook lets specs poll for the settle instead of sleeping. Same ungated
  // window-hook convention as App.tsx's `__pomadeStores`; reads the live controller, so it works
  // for the raw (CodeMirror) editor too.
  useEffect(() => {
    if (!visible) return
    const w = window as unknown as { __pomadeEditorSelectionFrom?: () => number }
    w.__pomadeEditorSelectionFrom = () => controllerRef.current?.getSelection().from ?? -1
    return () => {
      delete w.__pomadeEditorSelectionFrom
    }
  }, [visible])

  // E-013 — show the properties panel in a rich markdown view (Rendered OR Live — E-024
  // keeps them identical here) when the file HAS frontmatter, or the user asked to add some
  // (⋯ "Add properties"). No permanent empty panel otherwise.
  const showPropertiesPanel = (mdRenderedShown || liveShown) && (mdFrontmatter !== '' || addPropsRequested)
  // T-101 — where this doc lives relative to the pane's project scope (its root plus in-scope
  // folders, E-047); drives both the header path format and the scope-mark triangle. Duplicate =
  // the same file open as a doc tab in ≥2 different projects (adds a tooltip line; colour
  // unchanged; can force the triangle even for an in-project doc). Both computed from paths, never
  // stored — they follow the viewing project.
  const scope = useMemo(
    () => (path ? classifyScope(path, rootPath, scopeFolders) : 'in-project'),
    [path, rootPath, scopeFolders]
  )
  const duplicateOpen = useMemo(() => {
    if (!path) return false
    let projectsWithDoc = 0
    for (const ptabs of Object.values(tabsByProject)) {
      if (ptabs.some((t) => t.kind === 'doc' && t.path === path && !t.version)) projectsWithDoc++
      if (projectsWithDoc >= 2) return true
    }
    return false
  }, [tabsByProject, path])
  const showScopeMark = scope !== 'in-project' || duplicateOpen
  const scopeLines = useMemo(() => {
    const lines: string[] = []
    if (scope === 'outside-project') lines.push('Outside this project')
    else if (scope === 'outside-workspace') lines.push('Outside the workspace')
    if (duplicateOpen) lines.push('2+ copies open across projects')
    return lines
  }, [scope, duplicateOpen])
  // T-090/T-101 — what the header name field shows when EXPANDED, by where the doc lives:
  //   • in the project scope → the short path: from the project root (workspace-relative for the
  //     Workspace project, whose root IS the workspace root), or `<folder name>/…` under an
  //     in-scope folder (E-047);
  //   • outside it (orange OR red) → the `~`-relative FULL path (home-relative absolute, e.g.
  //     `~/Documents/my-workspace/…`), so the field never prints a workspace-relative path as if it
  //     were the whole story. An in-workspace out-of-scope doc's absolute path is wsRoot + path;
  //     an already-absolute (outside-workspace) path is used as-is — a terminal link / restored
  //     tab for an outside-workspace file stores its ABSOLUTE path.
  const headerPath = useMemo(() => {
    if (!path) return 'Untitled'
    const short = scopeRelativePath(path, rootPath, scopeFolders, wsRoot)
    if (short !== null) return short
    const abs = path.startsWith('/') ? path : wsRoot ? `${wsRoot}/${path}` : path
    const home = window.pomade.env.home
    return home && (abs === home || abs.startsWith(`${home}/`)) ? `~${abs.slice(home.length)}` : abs
  }, [path, rootPath, scopeFolders, wsRoot])

  // T-139 — the Save button reads the two EXISTING signals. It locks to "Saved" only when the
  // buffer is clean AND the file on disk hasn't diverged (changedOutside). Any edit — or a disk
  // divergence with an otherwise-clean buffer — flips it to an enabled "Save". A refused file
  // stays disabled (its own dimmed lock). The divergence case only changes the LABEL: the passive
  // on-disk notice already communicates it, so there's no second message here (product decision).
  // A version tab is "Saved" once its text replaced the document and it has no edits since.
  const saved = versionTab ? replaced && !dirty && !refusal : !dirty && !changedOutside && !refusal

  // Document/context-menu action handlers (duplicate, copy-to, clipboard, agent chat) + the agent
  // roster for the context menu + the Copy-to picker's open state.
  const {
    visibleAgents,
    copyToOpen,
    setCopyToOpen,
    handleOpenTarget,
    handleDuplicate,
    handleCopyTo,
    confirmCopyTo,
    handleCopyPath,
    handleCopyFullPath,
    revealInFinder,
    handleCopy,
    handleCut,
    handlePaste,
    handleFindReplace,
    handleNewAgentChat
  } = useDocActions({
    projectId,
    path,
    wsRoot,
    project,
    menu,
    controllerRef,
    openFind: find.openFind,
    toast
  })

  // ── E-038: Document history ────────────────────────────────────────────────────
  // Restore puts a whole version into the editor as ONE undoable edit (nothing is saved, git is
  // untouched): raw takes the whole file, live and rendered the body. When the engine on screen
  // cannot take it as such — the CSV table, a version whose frontmatter differs (the properties
  // panel is not part of the editor's undo), a version Milkdown cannot parse — the doc switches to
  // raw first, so Cmd+Z still undoes the restore as a whole.
  const historyOpen = useDocHistoryStore((s) => !!s.open[tabId])
  const toggleHistory = useDocHistoryStore((s) => s.toggle)
  const hideHistory = useDocHistoryStore((s) => s.hide)
  useEffect(() => () => hideHistory(tabId), [tabId, hideHistory])
  const rawControllerSoon = (): Promise<EditorController | null> =>
    new Promise((resolve) => {
      const t0 = performance.now()
      const tick = (): void => {
        const c = controllerRef.current
        if (c?.kind === 'raw') resolve(c)
        else if (performance.now() - t0 > 3000) resolve(null)
        else requestAnimationFrame(tick)
      }
      tick()
    })
  const restoreVersion = async (next: string): Promise<RestoreOutcome> => {
    const ctrl = controllerRef.current
    if (!loaded || refusal || !ctrl) return 'unavailable'
    ctrl.flushPendingEdits?.()
    if (next === docFile.contentRef.current) return 'same'
    if (ctrl.kind === 'raw') {
      ctrl.replaceDocument?.(next)
      return 'restored'
    }
    if (ctrl.replaceDocument) {
      const { frontmatter, body } = splitFrontmatter(next)
      if (frontmatter === frontmatterRef.current && (ctrl.kind === 'live' || (await parsesCleanly(body)))) {
        if (ctrl.replaceDocument(body)) return 'restored'
      }
    }
    toggleMode()
    const raw = await rawControllerSoon()
    if (!raw?.replaceDocument) return 'unavailable'
    raw.replaceDocument(next)
    return 'restored'
  }

  return (
    <div
      ref={rootRef}
      className={styles.pane}
      data-testid="editor-pane"
      data-doc-path={path}
      data-version={version?.label}
      data-mode={currentView}
      tabIndex={-1}
      onKeyDownCapture={onKeyDownCapture}
    >
      <EditorHeader
        path={path}
        title={versionTab ? basename(path) : title}
        headerPath={headerPath}
        showPath={showPath}
        setShowPath={(v) => void setShowPath(v)}
        dirty={dirty}
        showScopeMark={showScopeMark}
        scope={scope}
        scopeLines={scopeLines}
        isSymlink={isSymlink}
        onSymlinkClick={setSymlinkPop}
        richKind={richKind}
        currentView={currentView}
        modeLabel={modeLabel}
        toggleMode={toggleMode}
        saved={saved}
        refusal={!!refusal}
        onSave={() => void handleSave()}
        actionsAnchor={actionsAnchor}
        setActionsAnchor={setActionsAnchor}
        onHeaderContextMenu={onHeaderContextMenu}
        onRequestClose={() => requestClose()}
        closeSavedDocs={() => closeSavedDocs(projectId)}
        requestCloseAll={requestCloseAll}
        mdDefaultMode={mdDefaultMode}
        setMarkdownDefaultMode={(m) => void setMarkdownDefaultMode(m)}
        docRichView={docRichView}
        switchRichView={switchRichView}
        showAddProperties={(mdRenderedShown || liveShown) && mdFrontmatter === '' && !addPropsRequested}
        onAddProperties={() => setAddPropsRequested(true)}
        historyOpen={historyOpen}
        onToggleHistory={path && !versionTab ? () => toggleHistory(tabId) : null}
        version={version ? { label: version.label, docName: basename(path) } : null}
      />

      <div className={styles.main}>
        <div className={styles.editorColumn}>
          <EditorBody
            onContextMenu={onContextMenu}
            onMouseDownCapture={onBodyMouseDownCapture}
            missing={missing}
            changedOutside={changedOutside}
            dirty={dirty}
            csvMalformed={csvMalformed}
            onReload={() => reloadFromDiskRef.current()}
            onDismissChange={() => {
              setChangedOutside(false)
              refocusEditor()
            }}
            onCompareDisk={() => {
              if (path) void openComparison(projectId, { kind: 'disk', path }, { kind: 'file', path }, { preview: false })
            }}
            recoveredAt={recoveredAt}
            onRecoveredCompare={handleCompare}
            onRecoveredDiscard={() => discardToDisk('recovery-discard')}
            onDismissRecovered={() => {
              setRecoveredAt(null)
              refocusEditor()
            }}
            refusal={refusal}
            loaded={loaded}
            liveShown={liveShown}
            mdRenderedShown={mdRenderedShown}
            tableShown={tableShown}
            find={find}
            renderedShown={renderedShown}
            showPropertiesPanel={showPropertiesPanel}
            mdFrontmatter={mdFrontmatter}
            propertiesPanelExpanded={propertiesPanelExpanded}
            onTogglePropertiesPanel={() => togglePropertiesPanelExpanded(projectId)}
            onFrontmatterChange={handleFrontmatterChange}
            addPropsRequested={addPropsRequested}
            path={path}
            content={content}
            mdBody={mdBody}
            reloadNonce={reloadNonce}
            onRenderedChange={handleRenderedChange}
            onContentChange={handleContentChange}
            onSave={() => void handleSave()}
            onController={setController}
            onOpenTarget={handleOpenTarget}
            linkNav={linkNav}
            onRevealInFinder={revealInFinder}
            visible={visible}
            getInitialView={getInitialView}
          />
        </div>
        {historyOpen && path && !versionTab && (
          <DocHistoryPanel
            projectId={projectId}
            path={path}
            dirty={dirty}
            draftsNonce={draftsNonce}
            onRestore={restoreVersion}
            onConfirmRestoreUnder={confirmRestoreUnder}
            onClose={() => {
              hideHistory(tabId)
              refocusEditor()
            }}
          />
        )}
      </div>

      {/* T-184 — the Cmd+click link ambiguity picker (all modes share this one). */}
      {linkPicker && <EditorLinkPicker state={linkPicker} onClose={() => setLinkPicker(null)} />}

      {saveAs.open && (
        <SaveAsDialog
          name={saveAs.name}
          rootPath={rootPath}
          onNameChange={(name) => setSaveAs((s) => ({ ...s, name }))}
          onCancel={() => setSaveAs({ open: false, name: '' })}
          onConfirm={() => void confirmSaveAs()}
        />
      )}

      {overwrite && (
        <OverwriteDialog
          rel={overwrite.rel}
          onCancel={() => setOverwrite(null)}
          onConfirm={() => void confirmOverwrite()}
        />
      )}

      {outsideSavePrompt && (
        <OutsideSaveDialog
          title={title}
          onCancel={() => resolveOutsideSave(false)}
          onConfirm={() => resolveOutsideSave(true)}
        />
      )}

      {saveConflict && (
        <SaveConflictDialog
          title={title}
          onCancel={() => resolveSaveConflict('cancel')}
          onReload={() => resolveSaveConflict('reload')}
          onOverwrite={() => resolveSaveConflict('overwrite')}
        />
      )}

      {restoreUnder !== null && path && (
        <RestoreUnderDialog
          path={path}
          earlier={restoreUnder}
          onCancel={() => resolveRestoreUnder(false)}
          onConfirm={() => resolveRestoreUnder(true)}
        />
      )}

      {replacePrompt && (
        <ReplaceWithVersionDialog
          path={path}
          docDirty={replacePrompt.docDirty}
          onCancel={() => resolveReplace(false)}
          onConfirm={() => resolveReplace(true)}
        />
      )}

      {closePrompt && (
        <CloseGuardDialog
          title={title}
          onCancel={() => {
            setClosePrompt(false)
            resolveClose('cancel') // keep this doc AND abort the rest of a batch (T-044)
          }}
          onDiscard={() => {
            setClosePrompt(false)
            void keepDraft('close')
            closeNow()
            resolveClose('proceed')
          }}
          onSave={() => void saveThenClose()}
        />
      )}

      {menu && (
        <EditorContextMenu
          x={menu.x}
          y={menu.y}
          hasSelection={menu.hasSelection}
          agents={visibleAgents}
          spell={spell}
          onReplaceMisspelling={(s) => {
            // Chromium replaces the word under the last right-click itself (its markers, its
            // undo entry); we only re-focus so typing continues where the correction landed.
            void window.pomade.app.replaceMisspelling(s)
            controllerRef.current?.focus()
          }}
          onAddToDictionary={(w) => {
            void window.pomade.app.addToDictionary(w)
            controllerRef.current?.focus()
          }}
          onClose={() => {
            setMenu(null)
            setSpell(null)
          }}
          onDuplicate={handleDuplicate}
          onCopyTo={handleCopyTo}
          onCopyPath={handleCopyPath}
          onCopyFullPath={handleCopyFullPath}
          onCut={handleCut}
          onCopy={handleCopy}
          onPaste={handlePaste}
          onFindReplace={handleFindReplace}
          onNewAgentChat={handleNewAgentChat}
        />
      )}

      {copyToOpen && (
        <CopyToModal
          fileName={title}
          onCancel={() => setCopyToOpen(false)}
          onConfirm={confirmCopyTo}
        />
      )}

      {symlinkPop && path && (
        <SymlinkPopover
          rel={path}
          isDir={false}
          anchorRect={symlinkPop}
          onClose={() => setSymlinkPop(null)}
        />
      )}
    </div>
  )
}
