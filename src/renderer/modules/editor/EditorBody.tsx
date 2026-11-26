// Pomade — the editor pane body: the on-disk notices (DocNotices: missing / changed-outside /
// recovered; then CSV malformed),
// then the mounted editor for the current view (refusal panel, loading, live
// markdown, rendered markdown, CSV table, or raw CodeMirror) with its optional properties panel and
// the rendered-mode find panel. Presentational — EditorPane owns state, controller wiring, saves.

import type { EditorController, EditorKind } from './editor-controller'
import type { InitialView } from './initial-view'
import type { EditorLinkNav } from './editor-links'
import type { Refusal } from './doc-io'
import type { EditorFind } from './useEditorFind'
import { DocNotices } from './DocNotices'
import { EditorFindPanel } from './EditorFindPanel'
import { PropertiesPanel } from './PropertiesPanel'
import { RawEditor } from './RawEditor'
import { LiveEditor } from './LiveEditor'
import { RenderedMarkdown } from './RenderedMarkdown'
import { CsvTable } from './CsvTable'
import styles from './EditorPane.module.css'
import dialogStyles from '../../components/dialog.module.css'

export function EditorBody(props: {
  onContextMenu: (e: React.MouseEvent) => void
  onMouseDownCapture: () => void
  // notices
  missing: boolean
  changedOutside: boolean
  dirty: boolean
  csvMalformed: boolean
  onReload: () => void
  onDismissChange: () => void
  onCompareDisk: () => void
  recoveredAt: number | null
  onRecoveredCompare: () => void
  onRecoveredDiscard: () => void
  onDismissRecovered: () => void
  // body
  refusal: Refusal
  loaded: boolean
  liveShown: boolean
  mdRenderedShown: boolean
  tableShown: boolean
  find: EditorFind
  renderedShown: boolean
  showPropertiesPanel: boolean
  mdFrontmatter: string
  propertiesPanelExpanded: boolean
  onTogglePropertiesPanel: () => void
  onFrontmatterChange: (nextBlock: string) => void
  addPropsRequested: boolean
  path: string
  content: string
  mdBody: string
  reloadNonce: number
  onRenderedChange: (nextBody: string) => void
  onContentChange: (next: string) => void
  onSave: () => void
  onController: (c: EditorController | null) => void
  onOpenTarget: (target: string) => void
  linkNav: EditorLinkNav
  onRevealInFinder: () => void
  // T-185 — first-paint reading-position wiring, threaded to whichever editor mounts.
  visible: boolean
  getInitialView: (kind: EditorKind) => InitialView | null
}): React.JSX.Element {
  const {
    onContextMenu,
    onMouseDownCapture,
    missing,
    changedOutside,
    dirty,
    csvMalformed,
    onReload,
    onDismissChange,
    onCompareDisk,
    recoveredAt,
    onRecoveredCompare,
    onRecoveredDiscard,
    onDismissRecovered,
    refusal,
    loaded,
    liveShown,
    mdRenderedShown,
    tableShown,
    find,
    renderedShown,
    showPropertiesPanel,
    mdFrontmatter,
    propertiesPanelExpanded,
    onTogglePropertiesPanel,
    onFrontmatterChange,
    addPropsRequested,
    path,
    content,
    mdBody,
    reloadNonce,
    onRenderedChange,
    onContentChange,
    onSave,
    onController,
    onOpenTarget,
    linkNav,
    onRevealInFinder,
    visible,
    getInitialView
  } = props

  return (
    <>
      <DocNotices
        missing={missing}
        changedOutside={changedOutside}
        dirty={dirty}
        refused={!!refusal}
        onReload={onReload}
        onDismissChange={onDismissChange}
        onCompareDisk={onCompareDisk}
        recoveredAt={recoveredAt}
        onRecoveredCompare={onRecoveredCompare}
        onRecoveredDiscard={onRecoveredDiscard}
        onDismissRecovered={onDismissRecovered}
      />
      {csvMalformed && (
        <div className={styles.notice} data-testid="csv-malformed">
          This CSV could not be parsed as a table — showing the raw text instead.
        </div>
      )}
      {/* T-039 removed the informational "frontmatter is hidden/preserved" hint; T-040 removed the
          round-trip-guard banner too — it fired on frontmatter-less files and read as noise. E-023
          demoted the guard to a parse-only safety net (only UNPARSEABLE bodies open raw now); the
          mode button showing "Raw" is the sole indicator, and clicking it toggles to rendered
          IMMEDIATELY (T-042 removed the confirm dialog). (CSV's own unparseable/read-only notices
          are a separate mechanism and stay.) */}
      <div className={styles.bodyWrap} onContextMenu={onContextMenu} onMouseDownCapture={onMouseDownCapture}>
        {renderedShown && find.findOpen && (
          <EditorFindPanel
            query={find.findQuery}
            caseSensitive={find.findCase}
            info={find.findInfo}
            mode={tableShown ? 'table' : 'rendered'}
            onQueryChange={find.onFindQueryChange}
            onCaseSensitiveChange={find.onFindCaseChange}
            onNext={find.onFindNext}
            onPrev={find.onFindPrev}
            onClose={find.closeFind}
          />
        )}
        {refusal?.reason === 'version' ? (
          <div className={styles.refusal} data-testid="editor-refusal" data-reason="version">
            <div className={styles.refusalTitle}>Version not available</div>
            <p>{refusal.message}</p>
          </div>
        ) : refusal ? (
          <div className={styles.refusal} data-testid="editor-refusal">
            <div className={styles.refusalTitle}>
              {refusal.reason === 'binary' ? 'Binary file' : 'File too large'}
            </div>
            <p>
              {refusal.reason === 'binary'
                ? 'Pomade’s editor only opens text files. This looks like a binary file.'
                : 'This file is larger than 2 MB and won’t be opened in the editor.'}
            </p>
            {/* T-106 — every refusal variant (binary / image / oversize, in- or outside-workspace)
                offers Reveal in Finder via the same app.showItemInFolder IPC used elsewhere. */}
            <div className={styles.refusalActions}>
              <button
                type="button"
                className={dialogStyles.btnGhost}
                data-testid="refusal-reveal"
                onClick={onRevealInFinder}
              >
                Reveal in Finder
              </button>
            </div>
          </div>
        ) : !loaded ? (
          <div className={styles.loading} data-testid="editor-loading">
            Loading…
          </div>
        ) : liveShown ? (
          // E-024 — the live view scrolls in an OUTER container (CM has natural height in
          // this theme), the same architecture the rendered view uses; the properties panel
          // will share this scroll exactly like it does in Rendered.
          <div className={styles.mdScroll} data-testid="live-scroll">
            {showPropertiesPanel && (
              <PropertiesPanel
                block={mdFrontmatter}
                expanded={propertiesPanelExpanded}
                onToggleExpanded={onTogglePropertiesPanel}
                onChange={onFrontmatterChange}
                startAdding={addPropsRequested}
              />
            )}
            <LiveEditor
              path={path}
              value={mdBody}
              onChange={onRenderedChange}
              onSave={onSave}
              onController={onController}
              onOpenTarget={onOpenTarget}
              linkNav={linkNav}
              visible={visible}
              getInitialView={getInitialView}
            />
          </div>
        ) : mdRenderedShown ? (
          <div className={styles.mdScroll} data-testid="md-scroll">
            {showPropertiesPanel && (
              <PropertiesPanel
                block={mdFrontmatter}
                expanded={propertiesPanelExpanded}
                onToggleExpanded={onTogglePropertiesPanel}
                onChange={onFrontmatterChange}
                startAdding={addPropsRequested}
              />
            )}
            <RenderedMarkdown
              key={reloadNonce}
              initial={mdBody}
              onChange={onRenderedChange}
              onController={onController}
              linkNav={linkNav}
              visible={visible}
              getInitialView={getInitialView}
            />
          </div>
        ) : tableShown ? (
          <CsvTable
            key={reloadNonce}
            text={content}
            onChange={onContentChange}
            onController={onController}
          />
        ) : (
          <RawEditor
            path={path}
            value={content}
            onChange={onContentChange}
            onSave={onSave}
            onController={onController}
            linkNav={linkNav}
            visible={visible}
            getInitialView={getInitialView}
          />
        )}
      </div>
    </>
  )
}
