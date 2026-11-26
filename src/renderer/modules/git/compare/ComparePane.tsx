// Pomade — E-037: the comparison tab. Two versions side by side on `@codemirror/merge`: changes
// highlighted, one scroll for both sides, labels with short hashes. The left side is always
// read-only. When the right side is the live document (version ↔ current, file ↔ file, disk ↔ my
// edits) it is editable and it IS the doc's buffer: edits flow into the doc tab through its channel
// (doc-buffers.ts) and the doc's edits flow back, so dirty state, Cmd+S and the rule-8 notices are
// the doc tab's own. Each change has a "take old" control that puts the left version of that chunk
// into the right side as an ordinary edit — Cmd+Z undoes it.
//
// No doc tab open for the file yet: the right side shows the file from disk (there are no unsaved
// edits without a doc tab) and the first edit opens the doc tab in the background — the edit is
// applied once its buffer has loaded, provided the file did not change in between.
//
// Hidden, never unmounted: the pane registers no window listener; Cmd+S is captured on its root.
//
// T-224 — each side's label is a version chip: it opens that side's version list (VersionList) and a
// pick changes the tab's sources in place. The body is keyed by the pair, so a new pair re-reads
// both sides and rebuilds the merge view in its mode, as a freshly opened tab would.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MergeView } from '@codemirror/merge'
import { Annotation, EditorState, Transaction, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'

import { compareKey, compareMode, rightIsLive, sourcePath, type CompareSource } from '@shared/compare'
import type { CompareSide } from '@shared/doc-history'
import { isDocTabOf, isVersionSource } from '@shared/doc-version'
import { minimalChange } from '@shared/text-change'
import type { CompareTab, Tab } from '@shared/types'
import { CheckToggle } from '../../../components/CheckToggle'
import { Tooltip } from '../../../components/Tooltip'
import { useToast } from '../../../hooks/useToast'
import { cleanIpcError } from '../../../lib/ipc-errors'
import { useAppSettingsStore } from '../../../stores/app-settings-store'
import { useTabsStore } from '../../../stores/tabs-store'
import { useWorkspaceStore } from '../../../stores/workspace-store'
import { buildEditorTheme } from '../../editor/cm-theme'
import { languageExtension } from '../../editor/doc-kind'
import { findDocChannel, onDocChannels, type DocChannel, type DocChannelState } from '../../editor/doc-buffers'
import { DocNotices } from '../../editor/DocNotices'
import { onOpenDocChanged } from '../../editor/open-doc-watch'
import { openComparison } from '../open-compare'
import { openVersionTab } from '../history/open-version'
import { readDiskSide, readSide, type SideContent } from './compare-sides'
import { mountFoldBands, type FoldBands } from './fold-bands'
import { useVersionChipStore } from './version-chip-store'
import { VersionList } from './VersionList'
import editorStyles from '../../editor/EditorPane.module.css'
import styles from './ComparePane.module.css'

/** Marks a change that came from the doc tab (not typed here): kept out of this side's undo
 *  history and never echoed back. */
const fromDoc = Annotation.define<boolean>()

/** "Changes only": every run of unchanged lines folds, three lines kept around each change. */
const CHANGES_ONLY = { margin: 3, minSize: 4 } as const

/** Merge colors from the git tokens, so a change reads like the tree's letters. */
const mergeTheme = EditorView.theme({
  '&.cm-merge-a .cm-changedLine, .cm-deletedChunk': {
    backgroundColor: 'color-mix(in srgb, var(--git-deleted) 9%, transparent)'
  },
  '&.cm-merge-b .cm-changedLine': { backgroundColor: 'color-mix(in srgb, var(--git-new) 10%, transparent)' },
  '&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText': {
    background: 'color-mix(in srgb, var(--git-deleted) 22%, transparent)'
  },
  '&.cm-merge-b .cm-changedText': { background: 'color-mix(in srgb, var(--git-new) 24%, transparent)' },
  '&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter': { background: 'var(--git-deleted)' },
  '&.cm-merge-b .cm-changedLineGutter': { background: 'var(--git-new)' }
})

function base(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}

/** The take-old control between the two sides. */
function renderTakeOld(): HTMLElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = styles.takeOld
  b.textContent = '→'
  b.title = 'Take old — put the left version of this change into your document (Cmd+Z undoes it)'
  b.setAttribute('aria-label', 'Take old: put the left version of this change into your document')
  b.setAttribute('data-testid', 'compare-take-old')
  return b
}

/** The version chip's chevron. */
function ChevronDown(): React.JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** The live doc tab for `path` in `projectId`, following panes as they mount and unmount. */
function useDocChannel(projectId: string, path: string, enabled: boolean): DocChannel | null {
  const [channel, setChannel] = useState<DocChannel | null>(() => (enabled ? findDocChannel(projectId, path) : null))
  useEffect(() => {
    if (!enabled) return
    const update = (): void => setChannel(findDocChannel(projectId, path))
    update()
    return onDocChannels(update)
  }, [projectId, path, enabled])
  return channel
}

function SideLabel({
  side,
  testId,
  dirty,
  onOpen,
  chip
}: {
  side: SideContent | null
  testId: string
  dirty?: boolean
  /** T-226 — the side is a fixed version: open it in its own tab. */
  onOpen?: () => void
  /** T-224 — the version chip: the side's version, a click opens its list. */
  chip: { side: CompareSide; open: boolean; onClick: () => void; ref: React.MutableRefObject<HTMLButtonElement | null> }
}): React.JSX.Element {
  const text = side ? side.label : 'Loading…'
  const detail = side && side.status === 'ok' ? side.detail : undefined
  return (
    <span className={styles.label} data-testid={testId} data-dirty={dirty || undefined}>
      <Tooltip lines={[chip.side === 'left' ? 'Choose the version on the left' : 'Choose the version on the right']}>
        <button
          ref={chip.ref}
          type="button"
          className={styles.chip}
          data-testid={`compare-chip-${chip.side}`}
          aria-haspopup="dialog"
          aria-expanded={chip.open}
          onClick={chip.onClick}
        >
          <span className={styles.labelMain}>{text}</span>
          {dirty && <span className={styles.labelDirty}>unsaved edits</span>}
          {detail && <span className={styles.labelDetail}>{detail}</span>}
          <span className={styles.chipChevron}>
            <ChevronDown />
          </span>
        </button>
      </Tooltip>
      {side?.status === 'ok' && side.commit && (
        <span className={styles.labelSubject} title={side.commit.subject}>
          {side.commit.subject}
        </span>
      )}
      {onOpen && (
        <span className={styles.labelOpenWrap}>
          <Tooltip lines={['Open this version in its own tab, to edit it and save it as the document']}>
            <button type="button" className={styles.labelOpen} data-testid={`${testId}-open`} onClick={onOpen}>
              Open in tab
            </button>
          </Tooltip>
        </span>
      )}
    </span>
  )
}

export function ComparePane({ tab }: { tab: Tab }): React.JSX.Element {
  const t = tab as CompareTab
  return <ComparePaneBody key={compareKey(t.left, t.right)} t={t} />
}

function ComparePaneBody({ t }: { t: CompareTab }): React.JSX.Element {
  const { projectId } = t
  const mode = compareMode(t.left, t.right)
  const live = rightIsLive(t.right)
  const docPath = sourcePath(t.right) || sourcePath(t.left)
  const toast = useToast()
  const commitPreview = useTabsStore((s) => s.commitPreview)
  const dirtyInStore = useTabsStore((s) =>
    live ? (s.tabsByProject[projectId] ?? []).some((x) => isDocTabOf(x, docPath) && x.kind === 'doc' && x.dirty) : false
  )

  const [left, setLeft] = useState<SideContent | null>(null)
  const [right, setRight] = useState<SideContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chanState, setChanState] = useState<DocChannelState | null>(null)
  /** The file changed on disk while no doc tab holds it (this pane shows the disk version). */
  const [diskChanged, setDiskChanged] = useState(false)
  const channel = useDocChannel(projectId, docPath, live)

  const changesOnly = useAppSettingsStore((s) => s.compareChangesOnly)
  const setChangesOnly = useAppSettingsStore((s) => s.setCompareChangesOnly)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const paneRef = useRef<HTMLDivElement | null>(null)
  const mergeRef = useRef<MergeView | null>(null)
  /** Whether the built merge view has its unchanged runs folded. */
  const foldedRef = useRef(false)
  const bandsRef = useRef<FoldBands | null>(null)
  const channelRef = useRef<DocChannel | null>(channel)
  channelRef.current = channel
  /** The disk text the right side started from while no doc tab held the file. */
  const baseRef = useRef<string | null>(null)
  /** Edits typed before the doc tab's buffer was there to take them (the latest full text). */
  const pendingRef = useRef<string | null>(null)
  const openedDocRef = useRef(false)

  // ── load the sides ──────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const now = Date.now()
    setError(null)
    void (async () => {
      try {
        const [l, r] = await Promise.all([
          readSide(t.left, now),
          live ? (null as SideContent | null) : readSide(t.right, now)
        ])
        if (cancelled) return
        setLeft(l)
        if (r) setRight(r)
      } catch (err) {
        if (!cancelled) setError(cleanIpcError(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [t.left, t.right, live])

  // The live right side's first text: the doc tab's buffer when one is open, else the disk.
  useEffect(() => {
    if (!live || right) return
    if (channel) {
      const st = channel.state()
      if (!st.loaded) return
      setRight(
        st.refused
          ? { status: 'refused', label: 'Now', reason: `${base(docPath)} cannot be opened in the editor.` }
          : { status: 'ok', text: channel.read(), label: 'Now', exists: !st.missing }
      )
      return
    }
    let cancelled = false
    void readDiskSide(docPath, 'Now').then(
      (r) => {
        if (cancelled) return
        if (r.status === 'ok') baseRef.current = r.text
        setRight(r)
      },
      (err: unknown) => {
        if (!cancelled) setError(cleanIpcError(err))
      }
    )
    return () => {
      cancelled = true
    }
  }, [live, right, channel, chanState, docPath])

  // ── the right editor: apply the doc's text without echoing it back ───────────
  const applyFromDoc = useCallback((text: string): void => {
    const view = mergeRef.current?.b
    if (!view) return
    const change = minimalChange(view.state.doc.toString(), text)
    if (change) view.dispatch({ changes: change, annotations: [fromDoc.of(true), Transaction.addToHistory.of(false)] })
  }, [])

  const applyLeft = useCallback((text: string): void => {
    const view = mergeRef.current?.a
    if (!view) return
    const change = minimalChange(view.state.doc.toString(), text)
    if (change) view.dispatch({ changes: change })
  }, [])

  // ── follow the doc tab's buffer and state ───────────────────────────────────
  useEffect(() => {
    if (!channel) {
      setChanState(null)
      return
    }
    const sync = (): void => {
      const st = channel.state()
      setChanState(st)
      if (!st.loaded || !mergeRef.current) return
      const pending = pendingRef.current
      if (pending !== null) {
        pendingRef.current = null
        const docText = channel.read()
        if (docText === baseRef.current) {
          channel.write(pending)
        } else {
          applyFromDoc(docText)
          toast(`${base(docPath)} changed on disk before your edit reached it — showing the current version.`, 'error')
        }
        baseRef.current = null
        return
      }
      applyFromDoc(channel.read())
    }
    sync()
    return channel.subscribe(sync)
  }, [channel, applyFromDoc, toast, docPath])

  // The doc tab closed while this comparison was open: the disk is the document again.
  const hadChannelRef = useRef(false)
  useEffect(() => {
    if (channel) {
      hadChannelRef.current = true
      return
    }
    if (!live || !hadChannelRef.current) return
    hadChannelRef.current = false
    openedDocRef.current = false
    void readDiskSide(docPath, 'Now').then((r) => {
      if (r.status !== 'ok') return
      baseRef.current = r.text
      applyFromDoc(r.text)
    })
  }, [channel, live, docPath, applyFromDoc])

  // ── disk changes: a disk side re-reads; an unheld live file raises the notice ─
  useEffect(() => {
    const paths = new Set([sourcePath(t.left), sourcePath(t.right)].filter(Boolean))
    const onChange = (): void => {
      if (t.left.kind === 'disk') {
        void readDiskSide(t.left.path, 'On disk now').then((l) => {
          setLeft(l)
          if (l.status === 'ok') applyLeft(l.text)
        })
      }
      if (!live && t.right.kind === 'disk') {
        void readDiskSide(t.right.path, 'On disk now').then((r) => {
          setRight(r)
          if (r.status === 'ok') applyFromDoc(r.text)
        })
      }
      if (live && !channelRef.current && pendingRef.current === null && baseRef.current !== null) {
        void readDiskSide(docPath, 'Now').then((r) => {
          if (r.status === 'ok' && r.text !== baseRef.current) setDiskChanged(true)
        })
      }
    }
    const offDoc = onOpenDocChanged((p) => {
      if (paths.has(p)) onChange()
    })
    const offTree = window.pomade.fs.onChanged(() => onChange())
    return () => {
      offDoc()
      offTree()
    }
  }, [t.left, t.right, live, docPath, applyLeft, applyFromDoc])

  // ── local edits on the right ────────────────────────────────────────────────
  const onLocalEdit = useCallback(
    (text: string): void => {
      commitPreview(projectId, t.id)
      const ch = channelRef.current
      if (ch && ch.state().loaded) {
        ch.write(text)
        return
      }
      pendingRef.current = text
      if (!openedDocRef.current && !ch) {
        openedDocRef.current = true
        useTabsStore.getState().openDocByPath(projectId, docPath, { background: true, afterTabId: t.id })
      }
    },
    [commitPreview, projectId, t.id, docPath]
  )
  const onLocalEditRef = useRef(onLocalEdit)
  onLocalEditRef.current = onLocalEdit

  // ── the merge view: built once both sides have text ─────────────────────────
  const ready = left?.status === 'ok' && right?.status === 'ok'
  useEffect(() => {
    const host = hostRef.current
    if (!host || !ready || mergeRef.current || left.status !== 'ok' || right.status !== 'ok') return
    const common: Extension[] = [
      lineNumbers(),
      EditorView.lineWrapping,
      buildEditorTheme(),
      mergeTheme,
      languageExtension(docPath),
      // A fold bar may have moved: the bands follow it.
      EditorView.updateListener.of((u) => {
        if (u.geometryChanged || u.viewportChanged || u.heightChanged || u.docChanged) bandsRef.current?.schedule()
      })
    ]
    const readOnly: Extension[] = [EditorState.readOnly.of(true), EditorView.editable.of(false)]
    const editable: Extension[] = [
      history(),
      keymap.of([...historyKeymap, ...defaultKeymap]),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return
        if (u.transactions.every((tr) => tr.annotation(fromDoc) === true || !tr.docChanged)) return
        onLocalEditRef.current(u.state.doc.toString())
      })
    ]
    const view = new MergeView({
      parent: host,
      orientation: 'a-b',
      highlightChanges: true,
      gutter: true,
      a: { doc: left.text, extensions: [...common, ...readOnly] },
      b: { doc: right.text, extensions: [...common, ...(live ? editable : readOnly)] },
      ...(live ? { revertControls: 'a-to-b' as const, renderRevertControl: renderTakeOld } : {}),
      // Bounded diffing: a huge or wildly different pair degrades to coarser chunks, never a freeze.
      diffConfig: { scanLimit: 2000, timeout: 400 },
      ...(changesOnly ? { collapseUnchanged: CHANGES_ONLY } : {})
    })
    mergeRef.current = view
    bandsRef.current = mountFoldBands(view, { layer: styles.foldBands, piece: styles.foldBand })
    foldedRef.current = changesOnly
    // The doc may have moved on while the view was being built.
    const ch = channelRef.current
    if (ch && ch.state().loaded) applyFromDoc(ch.read())
  }, [ready, left, right, live, docPath, applyFromDoc, changesOnly])
  // Changes only toggled (here or in another comparison tab): reconfigure the built view in place, so
  // the live side keeps its edits, undo history and cursor.
  useEffect(() => {
    const view = mergeRef.current
    if (!view || foldedRef.current === changesOnly) return
    foldedRef.current = changesOnly
    view.reconfigure({ collapseUnchanged: changesOnly ? CHANGES_ONLY : undefined })
  }, [changesOnly, ready])
  useEffect(
    () => () => {
      bandsRef.current?.destroy()
      bandsRef.current = null
      mergeRef.current?.destroy()
      mergeRef.current = null
    },
    []
  )

  // ── save, notices, header actions ───────────────────────────────────────────
  const save = useCallback(async (): Promise<void> => {
    const ch = channelRef.current
    if (!ch) return
    try {
      // Saving here after looking at the disk version is the decision the amber banner asks for.
      if (mode === 'disk-mine' && ch.state().changedOutside) await ch.keepMine()
      await ch.save()
    } catch (err) {
      toast(`Could not save ${base(docPath)}: ${cleanIpcError(err)}`, 'error')
    }
  }, [mode, docPath, toast])

  const onKeyDownCapture = (e: React.KeyboardEvent): void => {
    if (live && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault()
      e.stopPropagation()
      void save()
    }
  }

  const openInEditor = (): void => {
    useTabsStore.getState().openDocByPath(projectId, docPath)
  }

  const reloadUnheld = (): void => {
    setDiskChanged(false)
    void readDiskSide(docPath, 'Now').then((r) => {
      if (r.status !== 'ok') return
      baseRef.current = r.text
      applyFromDoc(r.text)
    })
  }

  const dirty = live && (chanState?.dirty ?? dirtyInStore)
  const changedOutside = chanState?.changedOutside ?? false
  const saved = !dirty && !changedOutside
  // File ↔ file: each side is labelled with its file's name.
  const named = (side: SideContent | null, path: string): SideContent | null =>
    mode === 'file-file' && side?.status === 'ok' ? { ...side, label: base(path) } : side
  const refusal = left?.status === 'refused' ? left : right?.status === 'refused' ? right : null
  // T-226 — a side holding a fixed version (a commit's, a local version, a discarded draft) opens in
  // its own tab, as a version of the compared document.
  const openSide = (source: CompareSource, side: SideContent | null): (() => void) | undefined => {
    if (!isVersionSource(source) || side?.status !== 'ok' || !side.exists) return undefined
    return () => {
      openVersionTab(projectId, docPath, source).catch((err: unknown) =>
        toast(`Could not open this version: ${cleanIpcError(err)}`, 'error')
      )
    }
  }
  // ── T-224: the version chips ──────────────────────────────────────────────────
  const chipOpen = useVersionChipStore((s) => s.open[t.id])
  const showChip = useVersionChipStore((s) => s.show)
  const hideChip = useVersionChipStore((s) => s.hide)
  const shown = useTabsStore((s) => s.activeTabByProject[projectId] === t.id)
  const activeProject = useWorkspaceStore((s) => s.activeProjectId === projectId)
  const visible = shown && activeProject
  const leftChipRef = useRef<HTMLButtonElement | null>(null)
  const rightChipRef = useRef<HTMLButtonElement | null>(null)
  // A list belongs to the tab on screen: switching away closes it.
  useEffect(() => {
    if (!visible && chipOpen) hideChip(t.id)
  }, [visible, chipOpen, hideChip, t.id])
  useEffect(() => () => hideChip(t.id), [hideChip, t.id])
  const closeChip = (): void => {
    hideChip(t.id)
    paneRef.current?.focus()
  }
  const chip = (side: CompareSide): React.ComponentProps<typeof SideLabel>['chip'] => ({
    side,
    open: chipOpen === side,
    onClick: () => (chipOpen === side ? hideChip(t.id) : showChip(t.id, side)),
    ref: side === 'left' ? leftChipRef : rightChipRef
  })
  // The chips are mounted before a list can open (a click on one, or Cmd+Shift+H on the tab on screen).
  const chipAnchor = chipOpen ? (chipOpen === 'left' ? leftChipRef : rightChipRef).current : null

  const folder = useMemo(() => {
    const i = docPath.lastIndexOf('/')
    return i < 0 ? '' : docPath.slice(0, i)
  }, [docPath])

  return (
    <div
      ref={paneRef}
      className={styles.pane}
      data-testid="compare-pane"
      data-mode={mode}
      data-path={docPath}
      tabIndex={-1}
      onKeyDownCapture={onKeyDownCapture}
      onMouseDown={() => commitPreview(projectId, t.id)}
    >
      <div className={editorStyles.header}>
        <span className={styles.title}>
          <span className={styles.name}>{base(docPath)}</span>
          {folder && <span className={styles.folder}>{folder}</span>}
        </span>
        <span className={styles.actions}>
          <CheckToggle
            checked={changesOnly}
            onChange={(v) => void setChangesOnly(v)}
            label="Changes only"
            tooltip={['Show only the changed lines, with 3 lines around each']}
            testId="compare-changes-only"
          />
          {live && (
            <>
              <button type="button" className={editorStyles.toggle} data-testid="compare-open-editor" onClick={openInEditor}>
                Open in editor
              </button>
              <Tooltip lines={[saved ? 'Everything is saved' : 'Save the document (Cmd+S)']}>
                <button
                  type="button"
                  className={`${editorStyles.iconBtn} ${saved ? editorStyles.savedBtn : ''}`}
                  data-testid="compare-save"
                  disabled={saved}
                  onClick={() => void save()}
                >
                  {saved ? 'Saved' : 'Save'}
                </button>
              </Tooltip>
            </>
          )}
        </span>
      </div>

      <div className={styles.labels} data-live={live || undefined}>
        <SideLabel
          side={named(left, sourcePath(t.left))}
          testId="compare-label-left"
          onOpen={openSide(t.left, left)}
          chip={chip('left')}
        />
        {live && <span className={styles.labelGap} aria-hidden="true" />}
        <SideLabel
          side={named(right, sourcePath(t.right))}
          testId="compare-label-right"
          dirty={dirty}
          onOpen={openSide(t.right, right)}
          chip={chip('right')}
        />
      </div>
      {visible && chipOpen && chipAnchor && (
        <VersionList
          projectId={projectId}
          tabId={t.id}
          side={chipOpen}
          path={docPath}
          pair={{ left: t.left, right: t.right }}
          anchor={chipAnchor}
          onClose={closeChip}
        />
      )}

      {live && mode === 'disk-mine' && changedOutside && chanState && !chanState.missing && (
        <div className={styles.resolve} data-testid="compare-resolve">
          <span className={styles.resolveText}>
            The file changed on disk since your edits. Take what you need from the left, then save — your version
            replaces the disk one.
          </span>
          <button
            type="button"
            className={styles.resolveBtn}
            data-testid="editor-keep-mine"
            title="Keep your unsaved edits; the next save writes them over the disk version"
            onClick={() => {
              // The bar unmounts with the choice: keep focus in the document so Cmd+S works next.
              mergeRef.current?.b.focus()
              void channel?.keepMine()
            }}
          >
            Keep mine
          </button>
          <button
            type="button"
            className={styles.resolveBtn}
            data-testid="editor-load-disk"
            title="Load the disk version; your edits are kept as a discarded draft"
            onClick={() => {
              mergeRef.current?.b.focus()
              channel?.loadDisk()
            }}
          >
            Use disk version
          </button>
        </div>
      )}
      {live && chanState && !(mode === 'disk-mine' && changedOutside) && (
        <DocNotices
          missing={chanState.missing}
          changedOutside={chanState.changedOutside}
          dirty={chanState.dirty}
          refused={chanState.refused}
          onReload={() => channel?.reload()}
          onDismissChange={() => channel?.dismissChange()}
          onCompareDisk={() =>
            void openComparison(projectId, { kind: 'disk', path: docPath }, { kind: 'file', path: docPath }, { preview: false })
          }
        />
      )}
      {live && !chanState && diskChanged && (
        <DocNotices
          missing={false}
          changedOutside
          dirty={false}
          refused={false}
          onReload={reloadUnheld}
          onDismissChange={() => setDiskChanged(false)}
        />
      )}

      {error ? (
        <div className={styles.message} data-testid="compare-error">
          Could not compare: {error}
        </div>
      ) : refusal && refusal.status === 'refused' ? (
        <div className={styles.message} data-testid="compare-refusal">
          {refusal.reason} Nothing to compare.
        </div>
      ) : !ready ? (
        <div className={styles.message} data-testid="compare-loading">
          Loading…
        </div>
      ) : null}
      <div className={styles.host} ref={hostRef} data-testid="compare-merge" hidden={!ready || !!error} />
    </div>
  )
}
