// Pomade — the editor pane header: the expandable name/path field (T-090), dirty dot, scope mark
// (T-101), file-type chip, symlink chip (E-012), and the action cluster (mode toggle, Save, the ⋯
// doc-actions menu, close). Presentational — EditorPane owns all state and passes handlers.

import type { RichKind } from './doc-kind'
import { ScopeMark } from '../../components/ScopeMark'
import { Tooltip } from '../../components/Tooltip'
import { ContextMenu, type MenuItem } from '../../components/ContextMenu'
import { languageLabel } from './doc-kind'
import { SymlinkGlyph } from '../filetree/icons'
import styles from './EditorPane.module.css'

export function EditorHeader(props: {
  path: string
  title: string
  headerPath: string
  showPath: boolean
  setShowPath: (v: boolean) => void
  dirty: boolean
  showScopeMark: boolean
  scope: 'in-project' | 'outside-project' | 'outside-workspace'
  scopeLines: string[]
  isSymlink: boolean
  onSymlinkClick: (rect: DOMRect) => void
  richKind: RichKind | null
  currentView: 'live' | 'rendered' | 'raw'
  modeLabel: string
  toggleMode: () => void
  saved: boolean
  refusal: boolean
  onSave: () => void
  actionsAnchor: { x: number; y: number } | null
  setActionsAnchor: (a: { x: number; y: number } | null) => void
  onHeaderContextMenu: (e: React.MouseEvent) => void
  onRequestClose: () => void
  // ⋯ doc-actions menu wiring
  closeSavedDocs: () => void
  requestCloseAll: () => void
  mdDefaultMode: 'raw' | 'rendered'
  setMarkdownDefaultMode: (m: 'raw' | 'rendered') => void
  docRichView: 'live' | 'rendered'
  switchRichView: () => void
  showAddProperties: boolean
  onAddProperties: () => void
  // E-038 — the History button: absent for an Untitled doc (no file, nothing to look back at).
  historyOpen: boolean
  onToggleHistory: (() => void) | null
  // T-226 — a version tab: the chip naming the version, and Save replaces the document.
  version: { label: string; docName: string } | null
}): React.JSX.Element {
  const {
    path,
    title,
    headerPath,
    showPath,
    setShowPath,
    dirty,
    showScopeMark,
    scope,
    scopeLines,
    isSymlink,
    onSymlinkClick,
    richKind,
    currentView,
    modeLabel,
    toggleMode,
    saved,
    refusal,
    onSave,
    actionsAnchor,
    setActionsAnchor,
    onHeaderContextMenu,
    onRequestClose,
    closeSavedDocs,
    requestCloseAll,
    mdDefaultMode,
    setMarkdownDefaultMode,
    docRichView,
    switchRichView,
    showAddProperties,
    onAddProperties,
    historyOpen,
    onToggleHistory,
    version
  } = props

  return (
    <header className={styles.header}>
      <div className={styles.titleWrap}>
        {/* T-090 — the name field is an expandable path display, not a second copy of the tab
            title: click toggles name ⇄ path (one global, persisted setting), right-click opens
            the editor's no-selection menu for this doc. A chrome-less button — the pointer
            cursor and a quiet hover wash are the whole affordance. */}
        <button
          type="button"
          className={`${styles.title} ${showPath ? styles.titlePath : ''}`}
          data-testid="editor-title"
          data-expanded={showPath ? 'true' : 'false'}
          title={headerPath}
          aria-pressed={showPath}
          onClick={(e) => {
            // On macOS a Ctrl+click delivers BOTH contextmenu and click; the menu already
            // opened, so don't also toggle behind it.
            if (e.ctrlKey) return
            void setShowPath(!showPath)
          }}
          onContextMenu={onHeaderContextMenu}
        >
          <bdi className={styles.titleInner}>{showPath ? headerPath : title}</bdi>
        </button>
        {dirty && <span className={styles.dirtyDot} data-testid="editor-dirty" aria-label="unsaved" />}
        {/* T-101 — scope mark: right of the name/path, BEFORE the file-type chip, same stacking
            tooltip as the tab. Orange = outside project, red = outside workspace. */}
        {showScopeMark && (
          <ScopeMark
            tone={scope === 'outside-workspace' ? 'danger' : 'warning'}
            lines={scopeLines}
            testId="editor-scope"
          />
        )}
        {version && (
          <Tooltip lines={[`An earlier version of ${version.docName}, in its own tab.`, `Save replaces ${version.docName} with this text.`]}>
            <span className={styles.versionChip} data-testid="editor-version">
              Version {version.label}
            </span>
          </Tooltip>
        )}
        <span className={styles.lang} data-testid="editor-lang">
          {languageLabel(path)}
        </span>
        {isSymlink && (
          <Tooltip lines={['Symbolic link — click to see target']}>
            <button
              type="button"
              className={styles.symlink}
              data-testid="editor-symlink"
              aria-label="Symbolic link — click to see target"
              onClick={(e) => onSymlinkClick(e.currentTarget.getBoundingClientRect())}
            >
              <SymlinkGlyph />
            </button>
          </Tooltip>
        )}
      </div>
      <div className={styles.actions}>
        {richKind !== null && (
          <button
            type="button"
            className={styles.toggle}
            data-testid="mode-toggle"
            data-mode={currentView}
            onClick={toggleMode}
          >
            {modeLabel}
          </button>
        )}
        {onToggleHistory && (
          <Tooltip lines={['Document history (Cmd+Shift+H)']}>
            <button
              type="button"
              className={styles.toggle}
              data-testid="doc-history-toggle"
              aria-label="Document history"
              aria-pressed={historyOpen}
              onClick={onToggleHistory}
            >
              History
            </button>
          </Tooltip>
        )}
        {/* T-143 — Save deliberately KEEPS its native `title=` (not the design-system Tooltip):
            the button is `disabled` in the refusal and "Saved" states, and a disabled control
            fires no hover/focus events, so the JS tooltip would never appear exactly when its
            explanation is needed. Native `title=` is the only tooltip that shows on a disabled
            button — the T-109 precedent. */}
        <button
          type="button"
          className={`${styles.iconBtn} ${saved ? styles.savedBtn : ''}`}
          data-testid="doc-save"
          data-saved={saved ? 'true' : 'false'}
          disabled={refusal || saved}
          title={
            refusal
              ? 'File is not supported: editing is not available'
              : version
                ? saved
                  ? `${version.docName} holds this version`
                  : `Replace ${version.docName} with this version (Cmd+S)`
                : saved
                  ? 'Saved — no unsaved changes'
                  : 'Save (Cmd+S)'
          }
          onClick={onSave}
        >
          {saved ? 'Saved' : 'Save'}
        </button>
        <div className={styles.menuWrap}>
          <Tooltip lines={['Document actions']}>
            <button
              type="button"
              className={styles.iconBtn}
              data-testid="doc-actions"
              aria-label="Document actions"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setActionsAnchor(actionsAnchor ? null : { x: r.left, y: r.bottom + 2 })
              }}
            >
              ⋯
            </button>
          </Tooltip>
          {actionsAnchor && (
            <ContextMenu
              x={actionsAnchor.x}
              y={actionsAnchor.y}
              onClose={() => setActionsAnchor(null)}
              testId="doc-actions-menu"
              items={[
                {
                  label: 'Close saved docs',
                  testId: 'action-close-saved',
                  onSelect: closeSavedDocs
                },
                { label: 'Close all docs', testId: 'action-close-all', onSelect: requestCloseAll },
                {
                  // T-015 — minimal durable home for the app-level default until E-006's unified
                  // Settings absorbs it. Toggles rendered ⇄ raw for new markdown.
                  label: `New md opens: ${mdDefaultMode === 'rendered' ? 'Rich' : 'Raw'}`,
                  testId: 'action-default-md-mode',
                  role: 'menuitemcheckbox',
                  checked: mdDefaultMode === 'rendered',
                  data: { 'data-default-mode': mdDefaultMode },
                  onSelect: () =>
                    void setMarkdownDefaultMode(mdDefaultMode === 'rendered' ? 'raw' : 'rendered')
                },
                // E-024 — per-doc rich-view override: which rich view THIS doc's mode button
                // targets. Label names the CURRENT rich view; click switches to the other.
                ...(richKind === 'markdown'
                  ? [
                      {
                        label: `Rich view: ${docRichView === 'live' ? 'Live' : 'Rendered'}`,
                        testId: 'action-rich-view',
                        data: { 'data-rich-view': docRichView },
                        onSelect: switchRichView
                      } satisfies MenuItem
                    ]
                  : []),
                // E-013 — create a frontmatter block on a markdown file that has none. Shown only
                // in rendered mode and only when there's no frontmatter yet.
                ...(showAddProperties
                  ? [
                      {
                        label: 'Add properties',
                        testId: 'action-add-properties',
                        onSelect: onAddProperties
                      } satisfies MenuItem
                    ]
                  : [])
              ]}
            />
          )}
        </div>
        <Tooltip lines={['Close document']}>
          <button
            type="button"
            className={styles.iconBtn}
            data-testid="doc-close"
            aria-label={`Close ${title}`}
            onClick={onRequestClose}
          >
            ×
          </button>
        </Tooltip>
      </div>
    </header>
  )
}
