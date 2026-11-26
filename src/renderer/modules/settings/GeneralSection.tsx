// Pomade E-006 (T-026/T-027) — General settings section.
//   - Markdown default open mode (app-level, T-015 — absorbed here from the editor's ⋯ menu).
//   - Startup behavior: confirm workspace on launch (T-027, default off).
//   - Change workspace… (T-027): native picker + clean state flush + reload.
//   - Commands in other terminals (E-028): the ~/.zprofile PATH line, on explicit action only.
//   - Local history (T-274): the two extension lists — every change / never any version; the
//     store's size cap and Delete versions now (T-234, LocalHistoryLimits).
//   - Experimental (T-311): features on trial, each one switchable off.

import { normalizeExtension } from '@shared/local-history'
import { DEFAULT_LOCAL_HISTORY_ALWAYS, DEFAULT_LOCAL_HISTORY_NEVER } from '@shared/types'
import { useAppSettingsStore } from '../../stores/app-settings-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { EDITOR_FONTS, TERMINAL_FONTS } from '../../font-catalog'
import { CommandsPathRow } from './CommandsPathRow'
import { LocalHistoryLimits } from './LocalHistoryLimits'
import { NameListEditor } from './NameListEditor'
import styles from './SettingsModal.module.css'

export function GeneralSection(): React.JSX.Element {
  const markdownDefaultMode = useAppSettingsStore((s) => s.markdownDefaultMode)
  const setMarkdownDefaultMode = useAppSettingsStore((s) => s.setMarkdownDefaultMode)
  const markdownFormatting = useAppSettingsStore((s) => s.markdownFormatting)
  const setMarkdownFormatting = useAppSettingsStore((s) => s.setMarkdownFormatting)
  const confirmWorkspaceOnStartup = useAppSettingsStore((s) => s.confirmWorkspaceOnStartup)
  const setConfirmWorkspaceOnStartup = useAppSettingsStore((s) => s.setConfirmWorkspaceOnStartup)
  const previewTabMode = useAppSettingsStore((s) => s.previewTabMode)
  const setPreviewTabMode = useAppSettingsStore((s) => s.setPreviewTabMode)
  const terminalAutoCopy = useAppSettingsStore((s) => s.terminalAutoCopy)
  const setTerminalAutoCopy = useAppSettingsStore((s) => s.setTerminalAutoCopy)
  const emDashReplace = useAppSettingsStore((s) => s.emDashReplace)
  const setEmDashReplace = useAppSettingsStore((s) => s.setEmDashReplace)
  const terminalFont = useAppSettingsStore((s) => s.terminalFont)
  const setTerminalFont = useAppSettingsStore((s) => s.setTerminalFont)
  const editorRawFont = useAppSettingsStore((s) => s.editorRawFont)
  const setEditorRawFont = useAppSettingsStore((s) => s.setEditorRawFont)
  const localHistoryAlways = useAppSettingsStore((s) => s.localHistoryAlways)
  const setLocalHistoryAlways = useAppSettingsStore((s) => s.setLocalHistoryAlways)
  const localHistoryNever = useAppSettingsStore((s) => s.localHistoryNever)
  const setLocalHistoryNever = useAppSettingsStore((s) => s.setLocalHistoryNever)
  const projectSwitchToast = useAppSettingsStore((s) => s.projectSwitchToast)
  const setProjectSwitchToast = useAppSettingsStore((s) => s.setProjectSwitchToast)
  const root = useWorkspaceStore((s) => s.root)
  const changeWorkspace = useWorkspaceStore((s) => s.changeWorkspace)

  return (
    <div data-testid="settings-general">
      <p className={styles.sectionTitle}>Editor</p>
      <div className={styles.row}>
        <span className={styles.rowText}>
          <span className={styles.rowLabel}>New markdown opens as</span>
          <span className={styles.hint}>
            Rich opens a .md file in the view “Editing markdown” picks — Live or Rendered. Raw
            opens its source. A file the rich view can’t parse still opens raw.
          </span>
        </span>
        <select
          className={styles.select}
          data-testid="setting-md-default-mode"
          value={markdownDefaultMode}
          onChange={(e) =>
            void setMarkdownDefaultMode(e.target.value === 'raw' ? 'raw' : 'rendered')
          }
        >
          <option value="rendered">Rich</option>
          <option value="raw">Raw</option>
        </select>
      </div>
      {/* E-024 — which rich view markdown gets: Keep = Live (only your typed bytes change
          the file), Adjust = Rendered (saving an edited doc rewrites the body in Pomade's
          canonical style). Read at open/toggle time — never re-renders open docs. */}
      <div className={styles.row}>
        <span className={styles.rowText}>
          <span className={styles.rowLabel}>Editing markdown</span>
          <span className={styles.hint}>
            Keep formatting: the rich view is Live — the file changes only where you type.
            Adjust formatting: the rich view is Rendered — saving an edited doc rewrites its
            body in Pomade’s canonical style. Open docs keep their current view either way.
          </span>
        </span>
        <select
          className={styles.select}
          data-testid="setting-md-formatting"
          value={markdownFormatting}
          onChange={(e) => void setMarkdownFormatting(e.target.value === 'adjust' ? 'adjust' : 'keep')}
        >
          <option value="keep">Keep formatting</option>
          <option value="adjust">Adjust formatting</option>
        </select>
      </div>
      {/* T-153 — the raw editor's PROSE font. Code-shaped regions (code blocks, inline code,
          tables, frontmatter) always stay mono, whichever font is picked. */}
      <div className={styles.row}>
        <span className={styles.rowText}>
          <span className={styles.rowLabel}>Editor font (raw)</span>
          <span className={styles.hint}>
            Font for the raw source editor. Code blocks, inline code, tables and frontmatter stay
            monospace whatever you pick, so pick a proportional face to read prose comfortably.
          </span>
        </span>
        <select
          className={styles.select}
          data-testid="setting-editor-raw-font"
          value={editorRawFont}
          onChange={(e) => void setEditorRawFont(e.target.value)}
        >
          {EDITOR_FONTS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      {/* T-152 — app-level `--` + boundary → em-dash (—) while typing, in every editable
          markdown view (raw / live / rendered), prose contexts only. */}
      <label className={styles.checkRow}>
        <input
          type="checkbox"
          data-testid="setting-em-dash-replace"
          checked={emDashReplace}
          onChange={(e) => void setEmDashReplace(e.target.checked)}
        />
        <span>Replace -- with — while typing</span>
      </label>
      <p className={styles.hint}>
        When on (default), typing <code>--</code> followed by a space, Tab, or Enter turns it into
        an em-dash (—) in markdown docs. Never inside code blocks, inline code, or frontmatter.
      </p>

      <p className={`${styles.sectionTitle} ${styles.group}`}>Tabs</p>
      <label className={styles.checkRow}>
        <input
          type="checkbox"
          data-testid="setting-preview-tab-mode"
          checked={previewTabMode}
          onChange={(e) => void setPreviewTabMode(e.target.checked)}
        />
        <span>Single click opens a preview tab</span>
      </label>
      <p className={styles.hint}>
        When on (default), a single click on a file in the tree or a row in the Git panel opens it in
        one <em>preview</em> tab, its title in italics — the next single click replaces it. The tab
        stays once you use it: click into it, edit, or switch to another tab. Right-click a Git row ▸
        Open in a new tab to open one that stays. Off: every click opens its own tab.
      </p>

      <p className={`${styles.sectionTitle} ${styles.group}`}>Terminal</p>
      {/* T-153 — the xterm font for terminals AND agent panes (monospace options only). Bundled
          fonts render without being installed to the Mac; changing this restyles live sessions. */}
      <div className={styles.row}>
        <span className={styles.rowText}>
          <span className={styles.rowLabel}>Terminal font</span>
          <span className={styles.hint}>
            Font for terminals and agent panes. Bundled fonts (JetBrains Mono, IBM Plex Mono) show
            hyphens and en/em dashes distinctly and aren’t installed on your Mac.
          </span>
        </span>
        <select
          className={styles.select}
          data-testid="setting-terminal-font"
          value={terminalFont}
          onChange={(e) => void setTerminalFont(e.target.value)}
        >
          {TERMINAL_FONTS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      <label className={styles.checkRow}>
        <input
          type="checkbox"
          data-testid="setting-terminal-auto-copy"
          checked={terminalAutoCopy}
          onChange={(e) => void setTerminalAutoCopy(e.target.checked)}
        />
        <span>Copy on select</span>
      </label>
      <p className={styles.hint}>
        When on (default), finishing a mouse selection in a terminal copies it straight to the
        clipboard and flashes a short confirmation. Cmd+C and the terminal’s right-click Copy
        work either way.
      </p>

      <CommandsPathRow />

      {/* T-274 — which files local history keeps versions of. Open documents and Pomade's own
          saves are always kept; the burst rule (more than 12 bursts an hour) is not a setting. */}
      <div data-testid="settings-local-history">
        <p className={`${styles.sectionTitle} ${styles.group}`}>Local history</p>
        <p className={styles.hint}>
          Pomade keeps a version each time a project text file changes, for 7 days. Open documents,
          your saves in Pomade and files in the first list keep every change. Any other file that
          keeps changing — more than 12 times within an hour — gets no versions until it has been
          quiet for an hour; files in the second list never get versions.
        </p>
        <p className={`${styles.rowLabel} ${styles.listLabel}`}>Always keep every change for</p>
        <NameListEditor
          testIdPrefix="lh-always"
          items={localHistoryAlways}
          defaults={DEFAULT_LOCAL_HISTORY_ALWAYS}
          onChange={(v) => void setLocalHistoryAlways(v)}
          emptyText="No extensions — only open documents and saves keep every change."
          placeholder="extension, e.g. .md"
          removeLabel={(ext) => `Stop keeping every change for ${ext}`}
          normalize={normalizeExtension}
        />
        <p className={`${styles.rowLabel} ${styles.listLabel}`}>Never keep versions of</p>
        <NameListEditor
          testIdPrefix="lh-never"
          items={localHistoryNever}
          defaults={DEFAULT_LOCAL_HISTORY_NEVER}
          onChange={(v) => void setLocalHistoryNever(v)}
          emptyText="No extensions — every text file can get versions."
          placeholder="extension, e.g. .log"
          removeLabel={(ext) => `Keep versions of ${ext} again`}
          normalize={normalizeExtension}
        />
        <LocalHistoryLimits />
      </div>

      <p className={`${styles.sectionTitle} ${styles.group}`}>Startup</p>
      <label className={styles.checkRow}>
        <input
          type="checkbox"
          data-testid="setting-confirm-workspace"
          checked={confirmWorkspaceOnStartup}
          onChange={(e) => void setConfirmWorkspaceOnStartup(e.target.checked)}
        />
        <span>Confirm workspace on startup</span>
      </label>
      <p className={styles.hint}>
        When on, Pomade briefly asks “Continue in this workspace?” at launch. Off (default):
        it continues silently into the last workspace.
      </p>

      <p className={`${styles.sectionTitle} ${styles.group}`}>Workspace</p>
      <div className={styles.row}>
        <span className={styles.rowText}>
          <span className={styles.rowLabel}>Current workspace</span>
          <span className={styles.wsPath} data-testid="setting-workspace-root">
            {root ?? '(none)'}
          </span>
        </span>
        <button
          type="button"
          className={styles.btn}
          data-testid="setting-change-workspace"
          onClick={() => void changeWorkspace()}
        >
          Change workspace…
        </button>
      </div>

      <p className={`${styles.sectionTitle} ${styles.group}`}>Experimental</p>
      <label className={styles.checkRow}>
        <input
          type="checkbox"
          data-testid="setting-project-switch-toast"
          checked={projectSwitchToast}
          onChange={(e) => void setProjectSwitchToast(e.target.checked)}
        />
        <span>Say when Pomade switches the project</span>
      </label>
      <p className={styles.hint}>
        When on (default), a switch Pomade makes for you — a notice, an app or an agent opening
        something in another project — shows a toast naming the project, with a button back to the
        one you were in.
      </p>
    </div>
  )
}
