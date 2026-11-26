// Pomade — shared cross-process types.
// Wave 1 authors exactly the types pinned in docs/contracts/types.md below.
// Waves 2a / 2b / 2c / 3 may APPEND new exports only — never reorder/reformat existing ones.

import type {
  AgentTabState,
  AppShortcut,
  AppTabKind,
  ErrorPayload,
  BackendMode,
  FileChange,
  FrameTarget,
  JsonValue,
  MethodParams,
  ProjectRef,
  RejectReason,
  RosterMode,
  SessionExit,
  SessionInfo,
  SessionRef,
  StripIcon,
  Surface,
  Theme
} from 'pomade-kit/protocol'
import type { CompareSource } from './compare'
import type { DocVersion } from './doc-version'
import { DEFAULT_LOCAL_HISTORY_CAP_MB } from './local-history'

export type Id = string // nanoid

export interface Group {
  id: Id
  name: string
  description?: string
  image?: string
  // E-010 (T-035) — an emoji glyph shown as the group's icon. Takes precedence over `image`
  // when both are set; when neither is set a default glyph is shown. Optional/additive.
  icon?: string
  // E-015 — nested groups. `parentId` is the id of the containing group; absent/undefined =
  // a TOP-LEVEL group. The group hierarchy is a TREE derived from this field over the flat
  // `WorkspaceConfig.groups` array (max depth 4). `order` is scoped to a group's SIBLINGS
  // (children of the same parent), not global. Additive & optional: a config written before
  // this field (every group flat) loads unchanged — every group simply reads as top-level
  // (depth 1). See `modules/projects-panel/reorder.ts` for the tree helpers + migration.
  parentId?: Id
  order: number
  // T-183 — a focus/emphasis marker: when true the group's name renders BOLD in the expanded
  // Projects panel list (an in-focus highlight, NOT a favorites system — no reordering, no section).
  // Additive & optional; older workspace.json loads unchanged. Persisted via workspace.saveConfig.
  highlighted?: boolean
  // T-190 — a user-chosen row color (the SHARED 6-hue `TabColor` palette). Tints the group
  // header in the expanded Projects panel and its rail chip; interacts automatically with `highlighted`
  // (soft→medium fill). Absent = no color. Additive & optional; persisted via workspace.saveConfig
  // exactly like `highlighted`.
  color?: TabColor
}

export interface Project {
  id: Id
  name: string
  groupId?: Id
  rootPath: string // workspace-relative, '' = workspace root
  area?: string
  description?: string
  image?: string
  // E-010 (T-035) — an emoji glyph shown as the project's icon. Takes precedence over
  // `image` when both are set; when neither is set a default glyph is shown. Additive.
  icon?: string
  visibleAgents: string[] // agent ids; ['*'] = all, [] = none
  order: number
  // T-183 — a focus/emphasis marker: when true the project's name renders BOLD in the expanded
  // Projects panel list (an in-focus highlight, NOT a favorites system — no reordering, no section).
  // Additive & optional; older workspace.json loads unchanged. Persisted via workspace.saveConfig.
  highlighted?: boolean
  // T-190 — a user-chosen row color (the SHARED 6-hue `TabColor` palette). Tints the project
  // row in the expanded Projects panel and its rail chip; interacts automatically with `highlighted`
  // (soft→medium fill) and the active state (a 2-tone-darker border). Absent = no color. Additive
  // & optional; persisted via workspace.saveConfig exactly like `highlighted`.
  color?: TabColor
  // E-030 — hosted apps' per-project settings (Host API `project.getSettings` / `setSettings`),
  // keyed by app id: each app reads and writes only its own entry. Plain JSON; absent when no app
  // stored anything. Lives with the project, so it survives renames and moves and goes with the
  // project when it is deleted. Persisted via workspace.saveConfig.
  appSettings?: Record<string, Record<string, JsonValue>>
}

// The Workspace project `__workspace__`, not stored in workspace.json; the Host API's Workspace project id.
export { WORKSPACE_PROJECT_ID } from 'pomade-kit/protocol'

export interface AgentInfo {
  id: string // 'claude' | 'codex' | folder name
  name: string
  command: string
  kind: 'claude' | 'codex' | 'custom'
  configDir?: string // absolute, for history scanning
  resolved: boolean // false only when the interactive login zsh answered "not found" (first word); true when found or unknown
  // E-033 — the launch modes (`args` follow the command): the agents app's, else the provider's
  // Normal and Full autonomy (`pomade-kit/protocol` `providerModes`).
  modes: RosterMode[]
}

export type TabKind = 'doc' | 'terminal' | 'agent' | 'app' | 'commit' | 'compare' | 'attached' | 'conflict' | 'branch'

export interface TabBase {
  id: Id
  projectId: Id
  kind: TabKind
  title: string
}

export interface DocTab extends TabBase {
  kind: 'doc'
  path: string
  // E-024 — 'live' joined 'raw'/'rendered': the byte-true CodeMirror live view (markdown
  // only). Persists per tab in ProjectState.openTabs like the other modes, so a live tab
  // restores live across relaunch.
  mode: 'raw' | 'rendered' | 'live'
  // E-024 — this DOC's rich view (which view the two-state mode button targets from raw):
  // set when the user leaves a rich view or picks one in the ⋯ menu, persisted with the
  // tab. Absent = follow the app-level "Keep/Adjust formatting" setting at toggle time.
  richView?: 'live' | 'rendered'
  dirty: boolean
  // E-004 (T-046): user-chosen soft background tint — same palette + persistence as
  // TerminalTab.color, now available on doc tabs too. Absent = no tint.
  color?: TabColor
  // E-012 (round-3) — true when the doc's file is a symbolic link. Set at tab creation from the
  // FileNode (opened from the tree) or from an fs.stat lstat (opened by path). Drives the small
  // symlink glyph in the tab strip. Absent (not false) on plain files, so old state loads unchanged.
  symlink?: boolean
  // T-061 — per-tab "unread / wants attention" flag, the SAME red dot as TerminalTab.attention.
  // Set by the "Mark unread" context-menu action (docs have no attention EVENTS, only manual
  // marks); cleared on the activation EDGE like a terminal's dot. On a doc tab the red dot
  // visually REPLACES the blue dirty dot while set (dirty state itself untouched). Persists in
  // ProjectState.openTabs like `dirty`/`color`; absent (not false) when there's nothing pending.
  attention?: boolean
  // T-185 — the persisted READING POSITION (the first visible line / viewport top, NOT the caret:
  // "cursor can be placed randomly while reading a completely different part"). A block-text anchor
  // (see renderer caret-anchor.ts — the same cross-engine representation the T-004 caret bridge
  // uses), so ONE stored value survives raw⇄live⇄rendered without raw line numbers. Captured at
  // tab switch / close / quit; applied FIRST-PAINT on reopen (T-149), app restart, and mode
  // switches — never on a fresh open from the tree (a new tab has no `viewport`, so it starts at
  // top, or at `:line` when opened via a link). Rides ProjectState.openTabs like the other doc
  // fields; absent on tabs written before this feature (they open at top).
  viewport?: DocViewport
  // T-226 — a version tab: an earlier version of the doc at `path` (a commit's, a local-history
  // snapshot, a discarded draft) opened as its own editable tab (shared/doc-version.ts). It is not
  // the doc's tab: lookups by path skip it, and its Save replaces the doc after a confirm.
  version?: DocVersion
}

// T-185 — a persisted reading-position anchor. Structurally identical to the renderer's
// `CaretAnchor` (caret-anchor.ts): the caret/viewport BLOCK as whitespace-stripped, lowercased
// plain text (`key`), the offset inside that block's plain text (`offset`), and the 0..1 position
// in the body as a last-resort fallback (`fraction`). Lives in shared/types because DocTab (and
// the T-150 details-modal allowlist) must describe it; the renderer treats a `CaretAnchor` as one.
export interface DocViewport {
  key: string
  offset: number
  fraction: number
}

export interface TerminalTab extends TabBase {
  kind: 'terminal' | 'agent'
  termId: string
  agentId?: string
  cwd: string
  status: 'live' | 'dead'
  lastCommand?: string
  resumeSessionId?: string
  // T-115 (E-022) — the last command this tab's SHELL actually executed (the zsh shim's preexec
  // marker, capped at EXEC_MARKER_CAP bytes). DELIBERATELY distinct from `lastCommand`, whose
  // Relaunch semantics are "re-RUN this": `lastExec` means "pre-type this, never run it" — on a
  // revive main types it into the fresh shell WITHOUT a trailing CR. Plain-terminal tabs only (an
  // agent tab's input belongs to the CLI) and never the agent-launch command itself. Sticky: only
  // a real preexec overwrites it, and the pre-typed text is never executed, so it survives any
  // number of reloads. Absent (not '') when the shell has run nothing yet.
  lastExec?: string
  // E-005 (T-024, ahead of T-021's rename UI): true once the user names the tab —
  // automatic titles (agent→shell downgrade, future auto-naming) must not overwrite it.
  renamed?: boolean
  // E-004 (T-021): user-chosen soft background tint from the fixed palette below (a palette
  // KEY, not a hex — the actual color is a token in tokens.css so it follows the theme).
  // Absent = no tint. Lives on the tab, so it persists in ProjectState like every other field.
  color?: TabColor
  // T-056 — per-tab "wants attention" flag. Set (via updateTab) when this terminal/agent tab
  // raises an attention event (turn-end BEL / OSC 9·99·777 notification, natural pty exit) while
  // it is NOT the active tab; cleared when the tab itself is activated (opening the project alone
  // does NOT clear it — that only resets the Projects panel counter). Drives the red per-tab dot. Lives
  // on the tab, so it persists like `dirty`/`color`; absent (not false) when there's no pending
  // attention, so older state loads unchanged.
  attention?: boolean
  // E-025 — the working directory the AGENT CLI was launched in (absolute, shell-reported).
  // DELIBERATELY distinct from `cwd`, which is the tab's LIVE last-known directory (handleCwd
  // overwrites it on every `cd`): the provider's session store is keyed on the cwd the CLI ran
  // in, so this — not the live cwd — is what resolves the store to watch and the directory a
  // resume must spawn in (fixes the subfolder capture-miss, T-127 §subfolder). Set from the
  // exec-marker launch signal (both launch paths flow through it); cleared when the agent hands
  // the shell back. Agent tabs only; absent on older state (falls back to `cwd`).
  cwdAtLaunch?: string
  // E-025 — the session-attribution bind state of an agent tab (the persisted leg of the
  // Spawned → AwaitingId → Bound/Unbound machine; transient states are runtime-only):
  //   'bound'   — `resumeSessionId` was attributed by a prompt-gated window (or an explicit
  //               resume/claim) and is trusted for auto-resume.
  //   'unbound' — a bind window closed with no uniquely-attributable id (none appeared, or the
  //               case was ambiguous and we refused — never a coin-flip bind). Drives the ⚠️
  //               mark; the tab keeps working and rebinds on the next (re)bind cycle.
  // Absent on plain terminals, on pre-E-025 state, and between a launch and its first outcome.
  bindState?: 'bound' | 'unbound'
  // E-033 — when the agent was launched in this tab (ISO 8601), stamped with `cwdAtLaunch` at the
  // launch marker; cleared when the agent hands the shell back. Agent tabs only.
  launchedAt?: string
  // E-033 — the title came from an app (`agentTabs.setTitle`); a user rename or the agent handing
  // the shell back clears it. Absent = the default title, or the user's (`renamed`).
  appTitled?: boolean
  // E-033 — an app marked the tab's session unnamed: the tab shows its default title in italics with
  // an "unnamed" dot. Cleared by any title set (the app's or a user rename) and by the agent exiting.
  unnamed?: boolean
}

// E-027 — a hosted app's tab: an <iframe> on `pomade-app://<appId>/<entry>` (docs/HOST-API.md).
// Persists only the app id; name, icon and entry are read from the app's manifest at mount, so
// an app update or removal is picked up without touching saved state.
export interface AppTab extends TabBase {
  kind: 'app'
  appId: string
  // E-029 — the strip icon this tab was opened for (its route and tab icon come from the
  // manifest); absent for a tab opened from the new-tab menu (the app's default view).
  icon?: string
  // Same user tint and "mark unread" flag every tab kind carries (T-046 / T-061 semantics).
  color?: TabColor
  attention?: boolean
  // E-027 — the route the tab renders, set when the app opened it at a route (`tabs.openApp`, an
  // app shortcut, a notice) or navigated to one by itself (T-269 `tabs.setRoute`); absent = "" (the
  // app's default view) for the icon-less tab, the icon's route for an icon tab.
  route?: string
  // T-244 — true once the user names the tab: its title no longer follows the manifest (the
  // strip icon's title, or the app's name) nor the app (a keyed tab's `tabs.setTitle`).
  renamed?: boolean
  // T-268 — a keyed tab (`tabs.openApp` with `key`): one per (app, key, project). It renders
  // `route` and carries no `icon`; absent for the icon-less tab and icon tabs.
  key?: string
  // T-268 — a keyed tab's app tab kind (a manifest `tabKinds` id): its icon and default title.
  // Kept when the manifest drops the kind (the tab then shows the app's icon and name).
  tabKind?: string
  // T-268 — a keyed tab's title came from the app (`title`, `tabs.setTitle`): it no longer follows
  // the manifest (its kind's title, the app's name).
  appTitled?: boolean
}

// E-037 — a commit's details (message, author, date, hash, changed files), opened from the Git
// panel's History. Persists the repo (its ws-relative root) and the full hash; everything shown
// is read from git when the pane mounts, so a commit that is gone restores to a readable notice.
export interface CommitTab extends TabBase {
  kind: 'commit'
  repo: string
  hash: string
  color?: TabColor
  attention?: boolean
}

// E-037 — a comparison: two versions of a document in one tab (shared/compare.ts). The right side,
// when it is the live document, shares the doc tab's buffer. Persists the two sources; the pane
// re-reads them on mount, and a source that no longer resolves renders as a notice.
export interface CompareTab extends TabBase {
  kind: 'compare'
  left: CompareSource
  right: CompareSource
  color?: TabColor
  attention?: boolean
}

// E-034 — a terminal tab attached to a session an app's keeper holds (docs/modules/terminal/
// attached-terminals.md). Persists only the reference; the screen comes from the keeper on every
// attach, so a restored tab is attached again with the session's earlier and live output.
export interface AttachedTab extends TabBase {
  kind: 'attached'
  session: SessionRef
  // True when the title is not the session's own (given to `tabs.openAttached`, or the user
  // renamed the tab): the session's title changes no longer retitle it.
  renamed?: boolean
  color?: TabColor
  attention?: boolean
}

// E-040 — the conflict tab of a stopped rebase in `repo` (its ws-relative root): theirs / result /
// yours per conflicted file, Mark resolved & continue, Abort. Persists only the repo; the pane reads
// the rebase from git when it mounts, so a rebase that ended restores to a notice.
export interface ConflictTab extends TabBase {
  kind: 'conflict'
  repo: string
  color?: TabColor
  attention?: boolean
}

// E-041 — a branch in `repo` (its ws-relative root): its commits main lacks and the total change
// against where it left main, with the branch's operations. `branch` = `feature` or `origin/feature`.
// Persists only the two; the pane reads the branch when it mounts, so a branch that is gone
// restores to a notice.
export interface BranchTab extends TabBase {
  kind: 'branch'
  repo: string
  branch: string
  color?: TabColor
  attention?: boolean
}

export type Tab = DocTab | TerminalTab | AppTab | CommitTab | CompareTab | AttachedTab | ConflictTab | BranchTab

// ─── E-004 (T-021) append — tab colors ────────────────────────────────────────
// A small fixed palette of soft, token-derived tints for terminal/agent tabs. Stored as a
// key on the tab; tokens.css maps each key to a --tab-tint-* variable (so it re-themes for
// free). '<none>' is represented by an absent `color` field, not a member here.
export type TabColor = 'red' | 'amber' | 'green' | 'teal' | 'blue' | 'purple'
export const TAB_COLORS: TabColor[] = ['red', 'amber', 'green', 'teal', 'blue', 'purple']

// ─── T-115 (E-022) append — exec-marker payload caps ──────────────────────────
// The zsh shim's `preexec` marker truncates the command line with `printf '%.Ns'`, so a captured
// `TerminalTab.lastExec` whose BYTE length equals a cap exactly is possibly cut mid-command.
// Such a payload is still captured and persisted (it is the honest record of what ran) but is
// NEVER pre-typed on revive: handing the user a corrupted line to press Enter on is the one
// unacceptable outcome (T-115 truncation guard, applied at pre-type time in `terminals-store`).
/** The cap the shim generated by THIS app version applies. */
export const EXEC_MARKER_CAP = 500
/** Every cap Pomade has ever shipped. A STALE shim in `userData/zsh-integration/` (written by an
 *  older app run, or a copy the user kept) keeps emitting the OLD cap, so the truncation guard has
 *  to reject all of them — a 160-byte payload from such a shim is just as possibly-cut as a
 *  500-byte one from today's. */
export const EXEC_MARKER_CAPS: number[] = [160, EXEC_MARKER_CAP]

// ─── E-025 append — prompt-gated session-id attribution ───────────────────────
// THE window tunable (one named constant, per the locked spec): a first-prompt submit in an
// agent tab opens a BIDIRECTIONAL ±window on that tab's session store — a transcript created up
// to this long BEFORE the submit qualifies too (the watcher may have been armed late), as does
// one appearing up to this long after. Widen if the real-world capture rate isn't high enough;
// a wider window only ever risks `Unbound` (refuse-don't-guess), never a wrong bind.
export const SESSION_BIND_WINDOW_MS = 30_000

// E-025 — the per-agent SESSION-COMMAND table (data, not code — the anti-vendor-lock lever;
// adding an agent's vocabulary is a table row, never a code path). Keyed by the provider's
// store FAMILY: built-in codex is the only 'codex'; built-in claude AND folder agents (Claude
// Code under a pinned CLAUDE_CONFIG_DIR) are 'claude'. Two structurally distinct kinds of
// re-arm (locked with the Owner 2026-08-19):
//   `clear` / `fork` — commands that move this tab to a NEW session: an empty one (`clear`) or a
//              copy of the current one (`fork`). Both write the new transcript when the command
//              runs; the tab re-enters AwaitingId and binds it at the NEXT first-prompt submit,
//              KEEPING its last-known id until the rebind succeeds. Which of the two it was is
//              the cause an app hears (`agentTab.changed`).
//   `resume` — the command that switches the live tab to a DIFFERENT EXISTING transcript. Its
//              own handler, not a flag on rebind: it never hunts for a new id — it ADOPTS an
//              existing one (the explicit `<id>` argument validated on disk, or the existing
//              file that starts growing in the window).
// Each row is read off the CLI's own command list (docs/modules/agents/session-stores.md):
// claude's `/clear` (aliases `/reset`, `/new`) and `/branch` ("create a branch of the current
// conversation"); claude's `/fork` copies the conversation into a BACKGROUND session and keeps
// this tab on its own — no rebind, and no row. Codex: `/clear` and `/new` start a new chat,
// `/fork` forks the current one.
// An unknown/undetected command degrades gracefully — worst case is `Unbound`, never a wrong
// bind. A line matches a command exactly or as `<cmd> <arg>`.
export interface AgentSessionCommands {
  clear: string[]
  fork: string[]
  resume: string
}
export const AGENT_SESSION_COMMANDS: Record<'claude' | 'codex', AgentSessionCommands> = {
  claude: { clear: ['/clear', '/reset', '/new'], fork: ['/branch'], resume: '/resume' },
  codex: { clear: ['/clear', '/new'], fork: ['/fork'], resume: '/resume' }
}

// T-149 — one entry on a project's undo-close (reopen) stack: the full Tab object as it was at
// close time plus the index it occupied in the strip. Persisted in ProjectState so "reopen closed
// tab" survives an app restart; a reopened tab keeps its ORIGINAL id (the scrollback snapshot key),
// so terminal replay / agent --resume machinery works unchanged. Kind-agnostic — docs, terminals,
// and agents all ride the same stack.
export interface ClosedTabEntry {
  tab: Tab
  index: number
}

// T-149 — the per-project reopen stack is LIFO and capped: the 11th close evicts the OLDEST entry
// (and forgets its scrollback snapshot). One named constant, per the locked spec.
export const REOPEN_STACK_CAP = 10

export interface ProjectState {
  openTabs: Tab[]
  activeTabId?: Id
  // T-149 — the per-project undo-close stack (most-recent close LAST). Persisted next to
  // openTabs; absent (or []) on state files written before T-149. Owned by tabs-store.
  reopenStack?: ClosedTabEntry[]
  // E-013 (T-053 round-3) — frontmatter properties-panel expand/collapse, now PER-PROJECT (was a
  // global AppSetting). Collapsing in one doc applies live to every open pane of the SAME project
  // and survives restart; other projects are untouched. Absent = expanded (default true).
  propertiesPanelExpanded?: boolean
  // E-026 — extra file-tree roots mounted below the project root, in display order. Persisted
  // per project; absent on pre-E-026 state files (config-store.loadState defaults to []).
  mounts?: Mount[]
  // E-026 — ids of roots currently collapsed to their header line. Holds mount ids and, for the
  // pinned project root, the sentinel PROJECT_ROOT_ID. Absent = nothing collapsed.
  collapsedRoots?: string[]
  // E-029 — the strip icon whose panel the side panel shows in this project ('files', or
  // `app:<appId>/<iconId>`). Absent = Files. Owned by side-panel-store.
  sidePanel?: string
  // E-047 (T-291) — the folders hosted apps put in this project's scope (Host API
  // `project.addScopeFolder`), in the order added. Owned by main (`app-scope-folders.ts`); no
  // renderer store saves it. Absent = none.
  appScopeFolders?: AppScopeFolder[]
} // .pomade/state/<projectId>.json

// E-026 — a mounted extra tree root. `path` is the user's canonical form: workspace-relative
// when the folder is inside the workspace (Slice 1), an absolute path when outside it (Slice 2).
// `outside` disambiguates without re-classifying on every render — true iff `path` is an
// absolute outside-workspace path. `classifyScope(path, projectRoot, scopeFolders)` still owns the
// orange/red tier; `outside` only routes fs reads (fs.tree vs fs.treeOutside).
export interface Mount {
  id: Id
  path: string
  outside?: boolean
  // T-144 — an optional user-given display name for the mount's header. When set, the header
  // shows this instead of the path label; Copy path still copies the real `path`. Absent (or
  // cleared) reverts the header to the path. The pinned project root is NOT renamable.
  name?: string
  // E-047 — the folder is in the project's scope: its files count as the project's (no orange or
  // red scope mark, the short header path). Absent = not in scope.
  inScope?: true
}

// E-026 — the collapsedRoots sentinel standing in for the pinned project root (which has no
// Mount id of its own).
export const PROJECT_ROOT_ID = '__project_root__'

// E-026 (T-140 / T-141) — workspace-scoped, machine-local Projects panel UI state. Lives OUTSIDE the
// git-tracked workspace.json (a toggle would otherwise churn git and sync view state across
// machines) and outside any per-project state file — it is workspace-level: `collapsedGroups`
// holds the ids of Projects panel groups/sub-groups currently collapsed, and `lastActiveProjectId` is
// the project the app reopens on boot. Project + group ids are workspace-scoped, so keeping this
// per-workspace (`.pomade/state/workspace-ui.json`, gitignored via the `state/` line) is correct.
// Written as a PARTIAL patch merged in main (config-store.saveWorkspaceUi), mirroring ProjectState.
export interface WorkspaceUiState {
  lastActiveProjectId: Id | null
  collapsedGroups: Id[]
  // Where the user left each app's overlay (its card's top-left corner in window coordinates, px),
  // by app id; that app's next overlay that names no place opens there, clamped into the window.
  overlayPositions: Record<string, OverlayPosition>
}

export interface OverlayPosition {
  left: number
  top: number
}

export interface WorkspaceConfig {
  groups: Group[]
  projects: Project[]
  // T-019 — the tree's configurable ignored items. Required on the type, but
  // config-store.getWorkspace() defensively defaults it for any workspace.json that lacks it.
  fileTree: FileTreeSettings
  // E-010 (round-3) — optional workspace-level identity icon (the apex of the
  // Workspace > Groups > projects hierarchy). Additive & optional; older workspace.json
  // loads unchanged. Persisted via the normal workspace.saveConfig.
  identity?: WorkspaceIdentity
  // E-015 — the Ungrouped pseudo-group's position within the TOP-LEVEL ordering. It shares
  // the same integer order space as top-level groups' `order`. Absent/undefined = Ungrouped
  // sorts LAST (the pre-E-015 behavior). Additive & optional; older workspace.json loads
  // unchanged. Persisted via the normal workspace.saveConfig.
  ungroupedOrder?: number
}

// E-010 (round-3) — workspace identity: emoji glyph OR a workspace-relative image path,
// mutually exclusive (the icon picker clears one when the other is chosen), matching the
// group/project icon precedence: icon (emoji) → image → default glyph.
export interface WorkspaceIdentity {
  /** Emoji glyph; takes precedence over `image`. */
  icon?: string
  /** Workspace-relative image path (copied in via fs.pickImage, like group/project images). */
  image?: string
}

export interface AgentOverrides {
  commands: Record<string, string>
  hidden: string[]
}

/** T-273 — one changed path in a tree watcher's batch: workspace-relative under an in-workspace
 *  watch, absolute under an outside mount. `exists` is the path's existence when the batch closed —
 *  a consumer compares it with what it shows, never the native event kind (macOS reports a plain
 *  write as a rename). */
export interface FsChange {
  path: string
  exists: boolean
}

/** T-273 — `fs:changed`: a tree watcher's batch for one watched root. `changes` is null when the
 *  batch cannot name its paths (an event without a path, too many paths, an outside root's own
 *  appearance or removal): the consumer re-reads everything it shows under `root`. */
export interface FsChangedEvent {
  root: string
  changes: FsChange[] | null
}

export interface FileNode {
  name: string
  path: string // ws-relative
  kind: 'file' | 'dir'
  children?: FileNode[]
  // T-019 append — true when this entry matches the workspace's configured ignored items.
  // Only ever present when the caller asked fs.tree for { includeIgnored: true }; absent
  // (not false) on every other tree, so old snapshots/behavior are unaffected.
  ignored?: boolean
  // E-012 append — true when this entry is a symbolic link (detected via lstat during the
  // tree walk). `kind` still reflects the LINK TARGET (a symlink to a dir shows kind:'dir'
  // and is expandable), so symlinks stay transparent; this flag only drives the small tree
  // indicator. Absent (not false) on non-symlinks, so old snapshots are unaffected.
  symlink?: boolean
  // E-012 (final) — true when this symlink's target does NOT exist (a broken link). Computed
  // for free in buildTree (the follow-`stat` already throws on a broken link), so the tree can
  // tint the indicator danger without an extra round-trip. Only ever set alongside symlink:true;
  // absent on healthy links and non-symlinks.
  broken?: boolean
  // True on a folder listed in the workspace's unwatched folders (`FileTreeSettings.unwatched`):
  // the watcher and the indexes skip it, the tree reads it on expand. Absent everywhere else —
  // a folder inside an unwatched one carries no mark of its own.
  unwatched?: true
}

// E-012 (final) — resolved destination of a symbolic link (fs.linkTarget). `targetAbs` is the
// realpath of the FINAL target (chained links resolved once); for a broken link it is the raw
// readlink text resolved against the link's own directory (realpath throws on broken links).
// `targetRel` is the workspace-relative path when the target lives inside the workspace, else
// null (outside the workspace). `exists` is false for a broken link.
export interface LinkTarget {
  targetAbs: string
  targetRel: string | null
  exists: boolean
}

export interface SessionRecord {
  sessionId: string
  agentId: string
  startedAt: string
  preview: string
  cwd: string
}

// ─── T-019 append (file tree ignored items: transparent + configurable) ────────
// Names (exact entry-name match, same granularity the tree walk already used) hidden
// from the file tree by default. User-editable in the tree's ignore settings; the
// underlying fs watcher keeps its own broader, hardcoded ignore regex (perf/robustness
// invariant, out of scope here) — this list only governs what the TREE displays.
export interface FileTreeSettings {
  ignore: string[]
  /** Unwatched folders: workspace-relative folders Pomade's watcher and indexes skip by path.
   *  The tree still shows them, read on expand. A listed path that no longer exists stays. */
  unwatched: string[]
}

export const DEFAULT_TREE_IGNORE: string[] = ['.git', 'node_modules', '.DS_Store']

export const DEFAULT_FILETREE_SETTINGS: FileTreeSettings = {
  ignore: [...DEFAULT_TREE_IGNORE],
  unwatched: []
}

// ─── Wave 1 defaults (not a contract type; a convenience for bootstrapping) ───
export const EMPTY_WORKSPACE_CONFIG: WorkspaceConfig = {
  groups: [],
  projects: [],
  fileTree: DEFAULT_FILETREE_SETTINGS
}

// ─── Wave 3 appends (git + fs.stat) ──────────────────────────────────────────
// Real filesystem stat for a workspace-relative path (used for the editor's
// byte-accurate size guard and external-change detection).
export interface FileStat {
  size: number // bytes
  mtimeMs: number // last-modified, epoch ms
  isFile: boolean // reflects the TARGET (stat, follows a symlink) — a link to a file is isFile:true
  // E-012 (round-3) — true when the path itself is a symbolic link (from lstat, does NOT follow).
  // Independent of `isFile`, which describes the target. Drives the editor-header symlink chip.
  isSymbolicLink: boolean
}

// ─── E-002 (T-015) appends — app-level editor settings ───────────────────────
// App-wide (not per-workspace) preferences. Durable home for settings that E-006
// (unified Settings surface) will later absorb. Kept in the workspace (T-313 appends below).
export type MarkdownDefaultMode = 'rendered' | 'raw'

// E-024 (P-024 §2) — the behavior setting behind the two rich engines. 'keep' → the rich
// view is LIVE (byte-preserving: only typed bytes ever change the file); 'adjust' → the
// rich view is Milkdown RENDERED (canonicalizing on save — E-023's accepted contract).
// The user picks a BEHAVIOR; the engine is an implementation detail behind it.
export type MarkdownFormatting = 'keep' | 'adjust'

// ─── E-007 (T-029/T-030) appends — machine-local layout settings ─────────────
// Column widths + Projects panel collapse are view state (`.pomade/state/view.json`, gitignored —
// per-display ergonomics, not shared config) — never in
// workspace.json. Widths are px; clamped to LAYOUT_LIMITS on write.
export interface LayoutSettings {
  projectsPanelWidth: number
  fileTreeWidth: number
  projectsPanelCollapsed: boolean
  // T-049 — the file-tree column collapses to a rail too (focus mode: maximum editor space).
  fileTreeCollapsed: boolean
}

export const DEFAULT_LAYOUT_SETTINGS: LayoutSettings = {
  projectsPanelWidth: 240,
  fileTreeWidth: 240,
  projectsPanelCollapsed: false,
  fileTreeCollapsed: false
}

// Clamp bounds for the resizable columns. Projects panel/fileTree min-max are absolute per-column
// limits; the renderer additionally keeps the working area ≥ mainMin (so editors/terminals
// stay usable at extreme drags) and shows a fixed-width rail when the Projects panel is collapsed.
export const LAYOUT_LIMITS = {
  projectsPanelMin: 160,
  projectsPanelMax: 480,
  fileTreeMin: 160,
  fileTreeMax: 560,
  mainMin: 320,
  // E-010 (round-3) — widened 44 → 52 so the collapsed-rail launchers (project 32px,
  // workspace 40px) keep comfortable padding and stay centered.
  railWidth: 52,
  // E-029 — the icon strip, always visible; a collapsed side panel leaves just the strip.
  // `fileTreeWidth` is the panel beside it, so strip and expanded side panel take stripWidth + fileTreeWidth.
  stripWidth: 44
} as const

export interface AppSettings {
  // Default view for freshly-opened markdown docs: 'raw' opens raw, 'rendered' opens the rich
  // view `markdownFormatting` selects. The parse gate is the only exception: a body Milkdown
  // cannot parse opens raw in Adjust (Rendered).
  markdownDefaultMode: MarkdownDefaultMode
  // E-024 — Keep formatting (Live view) vs Adjust formatting (Milkdown Rendered) as the
  // rich view for markdown. Default KEEP (the Owner, P-024 §2). Read at open/toggle time
  // only — changing it NEVER re-renders already-open docs.
  markdownFormatting: MarkdownFormatting
  // E-006 (T-027) — on launch, briefly confirm the remembered workspace before continuing
  // (offering a change). Default off: continue silently into the last workspace, as today.
  confirmWorkspaceOnStartup: boolean
  // E-007 (T-029/T-030) — column widths + Projects panel collapse state (view state).
  layout: LayoutSettings
  // T-063 — file-tree preview-tab mode. ON (default): a doc opened by a single tree click reuses
  // ONE "preview" tab — the next tree click REPLACES it, unless any other interaction (an edit,
  // a click into a pane, switching tabs) "committed" it first; a dirty doc is never replaced.
  // OFF: today's one-tab-per-click behavior. A preference.
  previewTabMode: boolean
  // T-084 — terminal auto-copy-on-select. ON (default): committing a MOUSE selection in a live
  // terminal copies it to the clipboard and flashes a "Copied N chars" hint in the pane corner.
  // OFF: a selection is just a selection. Cmd+C and the terminal context menu's Copy work
  // regardless of this toggle. A preference.
  terminalAutoCopy: boolean
  // T-090 — the editor header's name field. OFF (default): the file NAME, as before. ON: an
  // informative path — project-relative, workspace-relative, or absolute, depending on where the
  // doc lives. ONE global for every doc and every pane; clicking the field is the ONLY toggle
  // (deliberately no Settings checkbox). View state.
  editorHeaderShowPath: boolean
  // T-153 — per-surface font selections, persisted as font IDs (see renderer font-catalog.ts,
  // the single source of the id→CSS-stack mapping and the curated option lists). Defaults are
  // 'sf-mono' so an untouched install renders exactly as before (the SF Mono stacks).
  //   • terminalFont  — xterm font for terminals AND agent panes (monospace options only).
  //   • editorRawFont — the raw editor's prose font (monos + curated proportional); code-shaped
  //     regions (code blocks, inline code, tables, frontmatter) stay pinned to mono regardless.
  terminalFont: string
  editorRawFont: string
  // E-013 (T-053 round-3) — the properties-panel expand/collapse setting MOVED to ProjectState
  // (per-project, `.pomade/state/<projectId>.json`); it is no longer an AppSetting.
  // T-152 — app-level em-dash auto-replacement. ON (default): typing `--` followed by a
  // boundary (space / Tab / Enter) replaces the `--` with an em-dash `—` (U+2014) in the three
  // editable markdown doc modes (raw, live, rendered), prose contexts only (never code / raw
  // frontmatter; .csv excluded). OFF: `--` stays literal everywhere. A preference.
  emDashReplace: boolean
  // E-036 — the file tree's git marks (letters, tints, folder dots, ghost rows of deleted files).
  // ON (default). Toggled from the tree's ⋯ menu ("Show git status"); a preference.
  showGitStatus: boolean
  // E-032 — the notice sources (app ids, `pomade-git`, …) the user muted: their notices still
  // land in the Notices panel, but never as a toast nor in the icon's count. A preference.
  mutedNoticeSources: string[]
  // T-223 — the Document history groups the user folded (`HistoryGroup` ids: current, discarded,
  // local, commits). One choice for every document, remembered across restarts. View state.
  docHistoryFolded: string[]
  // T-267 — the comparison tab's "Changes only" switch: ON folds every run of unchanged lines (three
  // lines kept around each change). One choice for every comparison tab, remembered across restarts.
  // View state.
  compareChangesOnly: boolean
  // T-274 — local history's two extension lists (Settings ▸ General ▸ Local history). A file whose
  // extension is in `localHistoryAlways` gets a version for every change; one in `localHistoryNever`
  // is a streaming file and gets none (shared/local-history.ts `versionRule`). Entries are
  // normalized extensions (`.md`). A preference; main applies an edit at once.
  localHistoryAlways: string[]
  localHistoryNever: string[]
  // T-311 — experimental: when Pomade switches the active project on its own (not a pick in the
  // Projects panel), a toast names the new project with a "Back to <previous>" action. ON (default);
  // Settings ▸ General ▸ Experimental. A preference.
  projectSwitchToast: boolean
  // T-234 — the local-history store's size cap in MB (Settings ▸ General ▸ Local history, one of
  // LOCAL_HISTORY_CAP_CHOICES_MB): above it the oldest local versions go first. A preference; main
  // applies it at once, and a lower cap prunes right away.
  localHistoryCapMb: number
}

export const DEFAULT_LOCAL_HISTORY_ALWAYS: string[] = ['.md', '.txt']
export const DEFAULT_LOCAL_HISTORY_NEVER: string[] = ['.log', '.jsonl', '.ndjson']

export const DEFAULT_APP_SETTINGS: AppSettings = {
  markdownDefaultMode: 'rendered',
  // E-024 — Keep formatting (Live) is the default rich view (locked in P-024 §2).
  markdownFormatting: 'keep',
  confirmWorkspaceOnStartup: false,
  layout: DEFAULT_LAYOUT_SETTINGS,
  // T-063 — preview-tab mode defaults ON.
  previewTabMode: true,
  // T-084 — auto-copy-on-select defaults ON (locked product decision).
  terminalAutoCopy: true,
  // T-090 — the header name field starts COLLAPSED (file name only), as before the task.
  editorHeaderShowPath: false,
  // T-152 — em-dash auto-replacement defaults ON.
  emDashReplace: true,
  showGitStatus: true,
  mutedNoticeSources: [],
  docHistoryFolded: [],
  compareChangesOnly: false,
  localHistoryAlways: [...DEFAULT_LOCAL_HISTORY_ALWAYS],
  localHistoryNever: [...DEFAULT_LOCAL_HISTORY_NEVER],
  projectSwitchToast: true,
  // T-153 — both surfaces default to SF Mono (= font-catalog DEFAULT_FONT_ID 'sf-mono'), so an
  // untouched install looks identical to before this feature.
  terminalFont: 'sf-mono',
  editorRawFont: 'sf-mono',
  localHistoryCapMb: DEFAULT_LOCAL_HISTORY_CAP_MB
}

// (E-011's CLAUDE_NOTIF_ARGS / CODEX_NOTIF_ARGS lived here until P-018: the pty now
// masquerades as TERM_PROGRAM=Apple_Terminal, under which agent CLIs emit their turn-end
// BEL flag-free — no injected flags, no zsh wrappers. See docs/modules/agents/agent-providers.md.)

// ─── E-014 (T-051 property autocomplete) appends — workspace frontmatter index ─
// A cheap frequency index of frontmatter keys and (for list-typed keys) values across all
// workspace .md files, built by a bounded main-process scan (fs.frontmatterIndex). Powers the
// properties-panel autocomplete: suggest keys by frequency when adding a property, and suggest
// existing values when editing a list key (tags/aliases/…). A stale index is acceptable — it's
// only suggestions — so main caches it per app run (rebuilt on a workspace switch).
export interface FrontmatterIndex {
  keys: Record<string, number> // key name → number of files that use it
  values: Record<string, Record<string, number>> // key → (value → occurrence count)
}

// ─── E-020 (T-086) appends — terminal file-link resolution ─────────────────────
// A path token scraped from terminal output, resolved on disk by main (`fs.probePath`).
// Main owns the resolution because it alone knows `$HOME` (for `~/…`), can stat paths
// OUTSIDE the workspace (the escape-refusing `fs.*` helpers cannot), and can compare
// CANONICAL paths — on macOS realpath rewrites /var → /private/var, so an inside/outside
// test done with raw strings in the renderer would misclassify every /tmp fixture.
export interface PathProbe {
  /** The resolved ABSOLUTE path (canonicalized — realpath, so it FOLLOWS a symlink chain to the
   *  real target; `abs`/`wsRel` name the target, never an intermediate link). */
  abs: string
  /** Workspace-relative path when the target lives inside the workspace, else null. */
  wsRel: string | null
  /** True for a regular file (follows symlinks) — false means a directory. */
  isFile: boolean
  // T-170 — true when the RAW probed path (before the realpath-follow above) is itself a
  // symbolic link (one `lstat`, does not recurse through a chain). A terminal-link open resolves
  // `wsRel`/`abs` to the REAL target — the link's own path is never what gets opened — so this is
  // the only way that route can still know "the referenced path was a symlink" and set the
  // tab-strip glyph, matching the file-tree open path (which reads its own `FileNode.symlink`).
  isSymbolicLink: boolean
}

// ─── T-150 append — per-kind key allowlist + runtime field-type map ─────────────
// The "Show tab details" admin/debug popup (docs/modules/tabs/tab-details.md) edits a tab's RAW
// persisted JSON and validates it on Save. TypeScript interface types are ERASED at runtime, so
// the validator needs an explicit, runtime-visible description of each Tab kind's persisted shape.
//
// >>> KEEP IN SYNC with the DocTab / TerminalTab interfaces above. <<<  Every persisted field must
// appear here mapped to its JSON primitive type, or a genuine field is rejected on Save as an
// "unknown key". `id` and `kind` are listed (they are SHOWN in the popup) but the validator treats
// them as IMMUTABLE — panes, PTYs, and scrollback snapshots key off `id`, and a mid-life `kind`
// change is meaningless.
// T-185 added 'object' for DocTab.viewport (a `{ key, offset, fraction }` anchor). The validator
// (renderer TabDetails.validateAndDiff) treats 'object' as a plain JSON object — a `null` or an
// array is rejected, matching how the other types reject wrong-shaped values.
export type TabFieldType = 'string' | 'boolean' | 'object'

// Terminal and agent tabs share ONE interface (TerminalTab, kind: 'terminal' | 'agent'), so they
// share ONE allowlist — the full TerminalTab surface. A plain terminal that has never been an
// agent simply has the agent-only fields absent, which is allowed (known-but-absent keys may be
// added; only UNKNOWN keys reject).
// `satisfies Record<keyof ___Tab, TabFieldType>` (rather than a plain `Record<string, ...>`
// annotation) is what makes this compile-time-enforced: TypeScript requires every key of the
// interface to appear here with a value, so a field added to DocTab/TerminalTab but not to its
// map fails typecheck instead of silently rejecting on Save at runtime.
const DOC_TAB_FIELDS = {
  id: 'string',
  projectId: 'string',
  kind: 'string',
  title: 'string',
  path: 'string',
  mode: 'string',
  richView: 'string',
  dirty: 'boolean',
  color: 'string',
  symlink: 'boolean',
  attention: 'boolean',
  // T-185 — the reading-position anchor object.
  viewport: 'object',
  // T-226 — the version a version tab holds.
  version: 'object'
} satisfies Record<keyof DocTab, TabFieldType>
const TERMINAL_TAB_FIELDS = {
  id: 'string',
  projectId: 'string',
  kind: 'string',
  title: 'string',
  termId: 'string',
  agentId: 'string',
  cwd: 'string',
  status: 'string',
  lastCommand: 'string',
  resumeSessionId: 'string',
  lastExec: 'string',
  renamed: 'boolean',
  color: 'string',
  attention: 'boolean',
  cwdAtLaunch: 'string',
  bindState: 'string',
  launchedAt: 'string',
  appTitled: 'boolean',
  unnamed: 'boolean'
} satisfies Record<keyof TerminalTab, TabFieldType>

const APP_TAB_FIELDS = {
  id: 'string',
  projectId: 'string',
  kind: 'string',
  title: 'string',
  appId: 'string',
  icon: 'string',
  color: 'string',
  attention: 'boolean',
  route: 'string',
  renamed: 'boolean',
  key: 'string',
  tabKind: 'string',
  appTitled: 'boolean'
} satisfies Record<keyof AppTab, TabFieldType>

const COMMIT_TAB_FIELDS = {
  id: 'string',
  projectId: 'string',
  kind: 'string',
  title: 'string',
  repo: 'string',
  hash: 'string',
  color: 'string',
  attention: 'boolean'
} satisfies Record<keyof CommitTab, TabFieldType>

const COMPARE_TAB_FIELDS = {
  id: 'string',
  projectId: 'string',
  kind: 'string',
  title: 'string',
  left: 'object',
  right: 'object',
  color: 'string',
  attention: 'boolean'
} satisfies Record<keyof CompareTab, TabFieldType>

const CONFLICT_TAB_FIELDS = {
  id: 'string',
  projectId: 'string',
  kind: 'string',
  title: 'string',
  repo: 'string',
  color: 'string',
  attention: 'boolean'
} satisfies Record<keyof ConflictTab, TabFieldType>

const BRANCH_TAB_FIELDS = {
  id: 'string',
  projectId: 'string',
  kind: 'string',
  title: 'string',
  repo: 'string',
  branch: 'string',
  color: 'string',
  attention: 'boolean'
} satisfies Record<keyof BranchTab, TabFieldType>

const ATTACHED_TAB_FIELDS = {
  id: 'string',
  projectId: 'string',
  kind: 'string',
  title: 'string',
  session: 'object',
  renamed: 'boolean',
  color: 'string',
  attention: 'boolean'
} satisfies Record<keyof AttachedTab, TabFieldType>

/** Per-kind runtime field → JSON-primitive-type map (T-150 validator). Terminal and agent share
 *  the TerminalTab surface. */
export const TAB_FIELD_TYPES: Record<TabKind, Record<string, TabFieldType>> = {
  doc: DOC_TAB_FIELDS,
  terminal: TERMINAL_TAB_FIELDS,
  agent: TERMINAL_TAB_FIELDS,
  app: APP_TAB_FIELDS,
  commit: COMMIT_TAB_FIELDS,
  compare: COMPARE_TAB_FIELDS,
  attached: ATTACHED_TAB_FIELDS,
  conflict: CONFLICT_TAB_FIELDS,
  branch: BRANCH_TAB_FIELDS
}

/** Per-kind allowed persisted keys, derived from TAB_FIELD_TYPES (the Save validator rejects any
 *  key not listed for the tab's kind). */
export const TAB_FIELD_ALLOWLIST: Record<TabKind, string[]> = {
  doc: Object.keys(DOC_TAB_FIELDS),
  terminal: Object.keys(TERMINAL_TAB_FIELDS),
  agent: Object.keys(TERMINAL_TAB_FIELDS),
  app: Object.keys(APP_TAB_FIELDS),
  commit: Object.keys(COMMIT_TAB_FIELDS),
  compare: Object.keys(COMPARE_TAB_FIELDS),
  attached: Object.keys(ATTACHED_TAB_FIELDS),
  conflict: Object.keys(CONFLICT_TAB_FIELDS),
  branch: Object.keys(BRANCH_TAB_FIELDS)
}

/** T-150 — the two fields shown but never editable (a change or removal rejects on Save). */
export const TAB_IMMUTABLE_FIELDS: readonly string[] = ['id', 'kind']

// ─── E-027 — app hosting (docs/HOST-API.md) ───────────────────────────────────

/** E-028 — the PATH line in the user's login-shell rc file (`commands.pathLine`). `lineTarget` is
 *  the command folder the line names (null: no line; '' : a marked line edited past recognition);
 *  it equals `binDir` when this Pomade's commands are on PATH in other terminals. */
export interface PathLineStatus {
  rcFile: string
  binDir: string
  lineTarget: string | null
}

/** An app Pomade can host, as the renderer sees it (`apps.list` / EV.appsChanged). A dev link
 *  wins over an installed copy with the same id; an invalid or unreachable app is still listed,
 *  with the reason in `unavailable`. */
export interface HostedApp {
  id: string
  /** The manifest name; the id when the manifest is unreadable. */
  name: string
  version: string | null
  source: 'installed' | 'dev-link'
  /** Where it is served from: the build folder (absolute) or the dev-server URL. */
  location: string
  /** The frame URL (`pomade-app://<id>/<entry>`, or `<dev-server>/<entry>`); null when unavailable. */
  entryUrl: string | null
  iconUrl: string | null
  /** T-244 — the icon is a one-colour SVG: Pomade draws it in its own colour (a CSS mask), like
   *  its built-in icons; false = shown as the image itself. */
  iconTint: boolean
  /** Bumped whenever the app's files or manifest change — open frames reload on a bump. */
  revision: number
  /** Why the app cannot open (invalid manifest, missing entry, dev server down); null = available. */
  unavailable: string | null
  /** E-029 — the app's left-strip icons in manifest order; `[]` when unavailable. */
  strip: HostedStripIcon[]
  /** T-268 — the app's tab kinds (manifest `tabKinds`) by id, with their images; `{}` when none or unavailable. */
  tabKinds: Record<string, HostedTabKind>
  /** E-027 — the strip icon whose panel frame loads hidden at launch (`startOnLaunch`); null = none. */
  launchPanel: string | null
  /** E-027 — the app's live Pomade-wide shortcuts (conflicting ones removed); `[]` when unavailable. */
  shortcuts: AppShortcut[]
  /** E-027 — the app's shortcuts that do nothing, with why (Pomade's own chord, or another app's). */
  shortcutConflicts: string[]
  /** E-028 — the app's backend and how it is doing; null when it has none (or is unavailable). */
  backend: AppBackendStatus | null
}

/** E-028 — an app backend's state, as the strip icon's tooltip shows it. `connected` = it is on the
 *  Host API socket now. */
export interface AppBackendStatus {
  mode: BackendMode
  state: 'starting' | 'running' | 'restarting' | 'stopped'
  /** The tooltip's muted second line, plain words: "pid 4182", "exited with code 1 · crash 2",
   *  "connected to Pomade", a reason it is stopped. Never a launchd label. Null: nothing to add. */
  detail: string | null
  pid: number | null
  connected: boolean
}

/** E-029 — a strip icon as the renderer sees it: the manifest entry plus its image URL (the
 *  icon's own image, else the app's icon, else null for the generic glyph). */
export interface HostedStripIcon extends StripIcon {
  iconUrl: string | null
  /** T-244 — as `HostedApp.iconTint`, for this icon's image. */
  iconTint: boolean
}

/** T-268 — an app tab kind as the renderer sees it: the manifest entry plus its image URL (the
 *  kind's own image, else the app's icon, else null for the generic glyph). */
export interface HostedTabKind extends AppTabKind {
  iconUrl: string | null
  /** As `HostedApp.iconTint`, for this kind's image. */
  iconTint: boolean
}

/** E-029 — EV.appsBadge: one strip icon's badge. `count: 0` = no badge. */
export interface AppBadge {
  appId: string
  icon: string
  count: number
  urgent: boolean
}

/** `apps.openFrame` — what the renderer opened a frame for: its surface and, for a strip icon,
 *  the icon id. Main resolves the route from the manifest (`FrameTarget`). */
export interface AppFrameRequest {
  surface: Surface
  icon?: string
  /** E-027 — the route the frame opens at, over the icon's (an icon-less tab's `AppTab.route`). */
  route?: string
  /** T-268 — a keyed tab's key and app tab kind (`AppTab.key` / `.tabKind`), for its `welcome`. */
  key?: string
  kind?: string
  /** E-031 — the active project when the frame handshakes; main delivers `project.changed` only
   *  when the active project differs from what the frame last saw. */
  project?: ProjectRef
}

/** `apps.openFrame` — the host's answer to a frame's `hello` (§3). */
export type AppFrameOpen =
  | { status: 'welcome'; pomadeVersion: string; hostApi: number; target: FrameTarget; theme: Theme }
  | { status: 'reject'; reason: RejectReason; hostApi: number }
  | { status: 'unavailable'; reason: string }

/** One Host API call's outcome, as the app receives it. */
export type AppCallOutcome = { ok: true; value: unknown } | { ok: false; error: ErrorPayload }

/** E-030 — a call main has gated and validated whose work is renderer-owned state (tabs; the
 *  workspace store's groups and projects): the frame bridge serves it
 *  (`modules/apps/delegated-calls.ts`). */
export type AppDelegatedCall =
  | { method: 'files.reveal'; params: MethodParams<'files.reveal'> }
  | { method: 'tabs.openFile'; params: MethodParams<'tabs.openFile'> }
  | { method: 'tabs.openTerminal'; params: MethodParams<'tabs.openTerminal'> }
  | { method: 'tabs.openAttached'; params: MethodParams<'tabs.openAttached'> }
  | { method: 'project.list'; params: MethodParams<'project.list'> }
  | { method: 'project.getSettings'; params: MethodParams<'project.getSettings'>; appId: string }
  | { method: 'project.setSettings'; params: MethodParams<'project.setSettings'>; appId: string }
  | { method: 'project.getAgents'; params: MethodParams<'project.getAgents'> }
  | { method: 'project.setAgents'; params: MethodParams<'project.setAgents'> }
  | { method: 'project.activate'; params: MethodParams<'project.activate'> }
  | { method: 'files.pickFolder'; params: MethodParams<'files.pickFolder'> }
  | { method: 'tabs.openApp'; params: MethodParams<'tabs.openApp'>; appId: string }
  | { method: 'overlay.open'; params: MethodParams<'overlay.open'>; appId: string }
  | { method: 'overlay.resize'; params: MethodParams<'overlay.resize'> }
  | { method: 'overlay.close'; params: MethodParams<'overlay.close'> }
  // T-268 — the calling tab frame's own tab (the frame bridge knows which).
  | { method: 'tabs.setTitle'; params: MethodParams<'tabs.setTitle'> }
  // T-269 — the calling tab frame navigated by itself: its tab's recorded route.
  | { method: 'tabs.setRoute'; params: MethodParams<'tabs.setRoute'> }
  | { method: 'tabs.close'; params: MethodParams<'tabs.close'> }
  | { method: 'git.getState'; params: MethodParams<'git.getState'> }
  | { method: 'git.watch'; params: MethodParams<'git.watch'> }
  | { method: 'git.unwatch'; params: MethodParams<'git.unwatch'> }
  // T-320 — `root`: the repo root main resolved `params.path` to, workspace-relative (real paths).
  | { method: 'git.reveal'; params: MethodParams<'git.reveal'>; root: string }
  | { method: 'notices.post'; params: MethodParams<'notices.post'>; appId: string }
  // E-033 — agent tabs: renderer-owned tabs; `launch`/`resume` cwds were checked on disk by main.
  | { method: 'agentTabs.list'; params: MethodParams<'agentTabs.list'> }
  | { method: 'agentTabs.setTitle'; params: MethodParams<'agentTabs.setTitle'> }
  | { method: 'agentTabs.focus'; params: MethodParams<'agentTabs.focus'> }
  | { method: 'agentTabs.launch'; params: MethodParams<'agentTabs.launch'> }
  | { method: 'agentTabs.resume'; params: MethodParams<'agentTabs.resume'> }
  // T-325 — `icon` is resolved by main: the strip icon whose panel to show.
  | { method: 'panel.show'; params: { icon: string; route?: string }; appId: string }

/** `apps.call` — one Host API call's outcome, or (E-030) the validated call for the renderer to
 *  serve; never a rejected promise. */
export type AppCallResult = AppCallOutcome | { delegate: AppDelegatedCall }

/** Renderer-owned state a call may need: the active project as a Host API ProjectRef. */
export interface AppCallContext {
  activeProject: ProjectRef
}

/** EV.appsStateChanged — another frame of the same app set a state key (`value: null` = removed). */
export interface AppStateChanged {
  frameId: string
  key: string
  value: JsonValue | null
}

/** E-028 — EV.appsServeDelegated: a socket client's delegated call for the window to serve;
 *  answered with `apps.delegatedResult(requestId, outcome)`. */
export interface AppDelegatedServe {
  requestId: string
  call: AppDelegatedCall
}

/** E-028 — EV.appsApiRequest: another app's call for a frame that serves its app's API; the frame
 *  answers with `apps.apiResponse(frameId, requestId, outcome)`. */
export interface AppApiRequest {
  frameId: string
  requestId: string
  from: string
  method: string
  params: JsonValue
}

/** EV.appsFilesChanged — a batch of changes for one frame's watch. */
export interface AppFilesChanged {
  frameId: string
  watchId: string
  changes: FileChange[]
}

// ─── E-031 — the event bus (docs/HOST-API.md §4 `events`) ─────────────────────

/** EV.appsEvent — one bus event for one app frame: a platform event the frame subscribes to
 *  (`project.changed` for every frame), another app's `<appId>:<event>`, or the publisher's
 *  `events.subscribersChanged`. Main has delivered it; the frame bridge posts it as is. */
export interface AppBusEvent {
  frameId: string
  name: string
  payload: JsonValue
}

/** E-033 — EV.ptyAgentState: what the agent in a term is doing, read from its output by the kit's
 *  AgentStateScanner (`waiting` at a permission or trust prompt is `needs-you`; `unknown` is idle). */
export interface PtyAgentState {
  termId: string
  state: Exclude<AgentTabState, 'exited'>
}

/** `pty.setTab` — the tab a term runs in, as the renderer knows it: `agentTab.exited` names it. */
export interface PtyTabRef {
  tabId: Id
  projectId: Id
}

// ─── E-034 — attached terminals (docs/modules/terminal/attached-terminals.md) ──────

/** Where an attached tab's connection to the keeper stands. `unreachable`: the owning app's keeper
 *  does not answer (its backend is not running) — retried · `gone`: the keeper holds no such
 *  session — retried, in case the owner starts it again · `rejected`: the keeper refused Pomade. */
export type AttachedState =
  | { kind: 'connecting' }
  | { kind: 'attached'; info: SessionInfo }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'gone' }
  | { kind: 'rejected'; message: string }

/** EV.attachedEvent — what main hears from the keeper for one attached tab. `snapshot`: draw into
 *  an emptied terminal · `delta`: output missed during a reconnect, written on top · `attention`:
 *  the session wants the user (a bell, a notification, an exit nobody asked for). */
export type AttachedEvent =
  | { type: 'state'; state: AttachedState }
  | { type: 'snapshot'; data: string; info: SessionInfo; resync: boolean }
  | { type: 'delta'; data: string; info: SessionInfo }
  | { type: 'output'; data: string }
  | { type: 'resized'; cols: number; rows: number }
  | { type: 'exit'; exit: SessionExit }
  | { type: 'info'; info: SessionInfo }
  | { type: 'attention' }

/** EV.attachedEvent's payload: the event for the attached tab `tabId`. */
export interface AttachedEventPayload {
  tabId: Id
  event: AttachedEvent
}

// E-047 (T-291) — an app scope folder: a folder a hosted app put in a project's scope through the
// Host API. Never shown in the file tree; in scope only while its app is hosted and available.
// `path` is in the Mount form: workspace-relative inside the workspace, absolute outside it.
export interface AppScopeFolder {
  appId: string
  path: string
}

// E-047 (T-291) — main → renderer: a project's app scope folders changed (EV.appScopeFolders).
export interface AppScopeFoldersChanged {
  projectId: Id
  folders: AppScopeFolder[]
}

// ─── T-313 appends — where app settings live ─────────────────────────────────
// AppSettings is one object over IPC, kept in two workspace files. Preferences — what the user
// sets on purpose — live in `.pomade/settings.json` (git-tracked, travels with the workspace).
// View state — what changes while working: column widths and collapses, the editor header's
// name/path click, Document history folds, the comparison tab's Changes only switch — lives in
// `.pomade/state/view.json` (gitignored), so resizing or folding never makes a commit.
export const APP_VIEW_STATE_KEYS = [
  'layout',
  'editorHeaderShowPath',
  'docHistoryFolded',
  'compareChangesOnly'
] as const satisfies ReadonlyArray<keyof AppSettings>
export type AppViewStateKey = (typeof APP_VIEW_STATE_KEYS)[number]
/** `.pomade/state/view.json`. */
export type AppViewState = Pick<AppSettings, AppViewStateKey>
/** `.pomade/settings.json`. */
export type AppPreferences = Omit<AppSettings, AppViewStateKey>
