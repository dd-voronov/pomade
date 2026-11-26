// Pomade — IPC channel names + the typed window.pomade API surface.
// Wave 1 authors this exactly per docs/contracts/ipc-app.md. Waves append new channels / namespaces only.

// Wave 1 uses FileNode/ProjectState/WorkspaceConfig/WorkspaceUiState directly. WAVE2B added
// AgentInfo/SessionRecord (pty / agents namespaces); WAVE3 added FileStat (fs.stat); E-012 added LinkTarget (symlink target resolution); E-002 (T-015)
// added AppSettings; E-014 added FrontmatterIndex (properties-panel autocomplete); E-020
// (T-086) added PathProbe (resolved terminal file-link target).
import type {
  PathLineStatus,
  AgentInfo,
  AppBadge,
  AppBusEvent,
  AppCallContext,
  AppCallOutcome,
  AppCallResult,
  AppFilesChanged,
  AppFrameOpen,
  AppFrameRequest,
  AppStateChanged,
  AppSettings,
  FileNode,
  FsChangedEvent,
  FileStat,
  FrontmatterIndex,
  LinkTarget,
  PathProbe,
  ProjectState,
  SessionRecord,
  WorkspaceConfig,
  HostedApp,
  PtyAgentState,
  PtyTabRef,
  WorkspaceUiState,
  AppDelegatedServe,
  AppApiRequest,
  AttachedEvent,
  Id,
  AppScopeFoldersChanged
} from './types'
import type { PurgeGroup, PurgePreview, RemovalSize, SnapshotRef } from './local-history'
import type { DiscardedDraft, DiscardedFile, DraftPut, RecoveryPut, RecoveryRecord } from './recovery'
import type { CommittedFile, GitSnapshot } from './git-state'
import type { GitRunSummary } from './git-runs'
import type { ProjectRef, QueuedNotice, RepoJob, SessionRef } from 'pomade-kit/protocol'
import type { CommitDetails, FileLogPage, LogPage } from './git-history'
import type { ConflictFile, RebaseState } from './git-conflict'
import type { BranchDetails, InProgress } from './git-branches'
import type { FolderGitInfo, GitOpPreview, GitOpRequest, GitOpResult, GitOpRun, InitRepoResult } from './git-ops'
import type { RevisionFile } from './compare'

// T-166 — the structured result of `fs.write`. A plain write always resolves `{ ok: true }`;
// an exclusive write (Save-As collision detection) resolves `{ ok: false, code: 'EEXIST' }`
// on a collision instead of rejecting — a data result to branch on, not an error message to
// grep. Any other failure still rejects the promise normally.
export type WriteFileResult = { ok: true } | { ok: false; code: 'EEXIST' }

// ─── Channel names: `namespace.method` ────────────────────────────────────────
export const CH = {
  workspace: {
    pick: 'workspace.pick',
    get: 'workspace.get',
    saveConfig: 'workspace.saveConfig',
    // E-006 (T-027) — change workspace. `pickRoot` opens an UNCONSTRAINED native folder
    // dialog and only RETURNS the path (does not commit); `change` commits a switch:
    // tears down PTYs + fs watchers, sets + persists the new root, returns the new get().
    pickRoot: 'workspace.pickRoot',
    change: 'workspace.change'
  },
  state: {
    load: 'state.load',
    save: 'state.save',
    // T-156 — delete a project's per-project state file (`.pomade/state/<projectId>.json`) on
    // project TEARDOWN. Escape-checked in main; a missing file is a no-op.
    remove: 'state.remove'
  },
  // E-026 (T-140 / T-141) — workspace-scoped, machine-local Projects panel UI state
  // (.pomade/state/workspace-ui.json): collapsed groups + last-active project.
  workspaceUi: {
    load: 'workspaceUi.load',
    save: 'workspaceUi.save'
  },
  fs: {
    tree: 'fs.tree',
    read: 'fs.read',
    write: 'fs.write',
    createFile: 'fs.createFile',
    createDir: 'fs.createDir',
    exists: 'fs.exists',
    copyDir: 'fs.copyDir',
    watch: 'fs.watch', // Wave 2a
    unwatch: 'fs.unwatch', // Wave 2a
    pickPath: 'fs.pickPath', // Wave 2a — native dir/file dialog constrained to workspace
    // E-008 (T-033) — native IMAGE picker that is NOT constrained to the workspace: an image
    // chosen from outside is copied into `.pomade/assets/<id>.<ext>` and the workspace-relative
    // path of the copy is returned (an inside-workspace pick is returned as-is). Returns null
    // on cancel.
    pickImage: 'fs.pickImage',
    readDataUrl: 'fs.readDataUrl', // Wave 2a — read a file as a data: URL (image preview)
    stat: 'fs.stat', // Wave 3 — size/mtime/isFile (byte-accurate editor guard)
    // E-001 (T-010) — collision-safe file copies. `duplicate` copies a file next to itself
    // ("name copy.ext"); `copyTo` copies it into another workspace folder. Both return the
    // new workspace-relative path of the copy.
    duplicate: 'fs.duplicate',
    copyTo: 'fs.copyTo',
    // E-004 (T-020) — rename/move a file within the workspace. Collision-refusing (rejects
    // if the destination already exists). Returns the new workspace-relative path.
    rename: 'fs.rename',
    // E-012 — file-manager operations for the tree context menu / drag-and-drop.
    // `move` moves a file OR directory (collision-refusing, self/descendant-guarded);
    // `copy` copies a file OR directory recursively (collision-safe " copy" suffixing);
    // `trash` sends a file/dir to the OS trash (recoverable — never rm).
    move: 'fs.move',
    copy: 'fs.copy',
    trash: 'fs.trash',
    // E-012 (final) — resolve the target of a symbolic link at a workspace-relative path.
    // Returns { targetAbs, targetRel, exists } (see LinkTarget). Backs the symlink popover.
    linkTarget: 'fs.linkTarget',
    // E-014 — build (cached per app run) a frequency index of frontmatter keys/values across
    // all workspace .md files, for the properties-panel autocomplete. See FrontmatterIndex.
    frontmatterIndex: 'fs.frontmatterIndex',
    // E-020 (T-086) — terminal file links. `probePath` resolves ONE path token (absolute,
    // `~/…`, or relative against a caller-supplied base) and stats it; `findByName` looks a
    // BARE filename up in a cached workspace basename index. Both back the Cmd+click link
    // provider: a token becomes a link only when one of them validates it.
    probePath: 'fs.probePath',
    findByName: 'fs.findByName',
    // E-020 round 2 — the same index keyed by basename-MINUS-extension, so an extension-less
    // word in agent output (`VISION`, `CONTRACTS`) is clickable the way it is in VS Code.
    findByStem: 'fs.findByStem',
    // E-020 round 4 — DIRECTORIES matched by full trailing-segment suffix (case-insensitive), for a
    // slashed folder token (`Docs/`, `_templates/`) that resolves against no probe base.
    findDirsBySuffix: 'fs.findDirsBySuffix',
    // T-086 (Fix A) — the FILE counterpart: FILES matched by full trailing-segment suffix
    // (case-SENSITIVE), for a slashed FILE token printed relative to a deep folder
    // (`session-docs-reviewed/…-reviewed.md`) that resolves against no probe base.
    findFilesBySuffix: 'fs.findFilesBySuffix',
    // T-102 (E-021) — the sanctioned outside-workspace door: read / write / stat ONE absolute
    // path resolving OUTSIDE the workspace (the doc object class for outside files). Every other
    // fs.* channel keeps the workspace escape-guard; these three require an absolute path.
    readOutside: 'fs.readOutside',
    writeOutside: 'fs.writeOutside',
    statOutside: 'fs.statOutside',
    // T-131 (E-026) — the outside-workspace mount door: a directory-tree read + a bounded
    // recursive watcher, scoped to ONE explicitly-mounted absolute root (tree-display only, no
    // index/link/git). `treeOutside` is the outside analogue of `tree` (absolute FileNode.paths);
    // `watchOutside`/`unwatchOutside` manage its single recursive fs.watch descriptor. Change
    // events reach the renderer on the SAME EV.fsChanged channel, keyed by the absolute root path.
    treeOutside: 'fs.treeOutside',
    watchOutside: 'fs.watchOutside',
    unwatchOutside: 'fs.unwatchOutside',
    // T-133 (E-026) — the outside-workspace WRITE doors: full create/rename/delete/duplicate/
    // move/copy INSIDE a mounted outside subtree, each on ABSOLUTE path(s) (requireAbs). Mirror
    // the in-workspace write ops but kept as separate doors so they can be reasoned about (and
    // disabled) independently; the renderer routes an absolute-path node to them.
    createFileOutside: 'fs.createFileOutside',
    createDirOutside: 'fs.createDirOutside',
    renameOutside: 'fs.renameOutside',
    duplicateOutside: 'fs.duplicateOutside',
    moveOutside: 'fs.moveOutside',
    copyOutside: 'fs.copyOutside',
    trashOutside: 'fs.trashOutside',
    // E-035 (rule 8) — the open-doc watcher: the renderer declares every open doc path (all
    // projects, outside docs included; replace semantics) and main reports writes to them on
    // EV.fsDocChanged(docPath). Independent of the per-root tree watchers above.
    watchDocs: 'fs.watchDocs'
  },
  // E-035 — unsaved-doc recovery copies + discarded drafts, stored only in user data.
  recovery: {
    put: 'recovery.put',
    get: 'recovery.get',
    remove: 'recovery.remove',
    keepDraft: 'recovery.keepDraft',
    drafts: 'recovery.drafts',
    discardedFiles: 'recovery.discardedFiles',
    markRestored: 'recovery.markRestored',
    forgetDiscarded: 'recovery.forgetDiscarded'
  },
  // E-044 — local history: the snapshots of a project file, stored in the workspace.
  localHistory: {
    list: 'localHistory.list',
    read: 'localHistory.read',
    keep: 'localHistory.keep',
    previewPurge: 'localHistory.previewPurge',
    purge: 'localHistory.purge',
    previewCap: 'localHistory.previewCap'
  },
  pty: {
    // Wave 2b
    create: 'pty.create',
    write: 'pty.write',
    resize: 'pty.resize',
    kill: 'pty.kill',
    sendExit: 'pty.sendExit',
    list: 'pty.list',
    buffer: 'pty.buffer', // Wave 2b — recent-output ring for re-attach repaint
    // E-020 (T-086) — the shell's CURRENT working directory, tracked from the zsh shim's
    // precmd marker (which now carries $PWD). First resolution step for a relative file link.
    cwd: 'pty.cwd',
    // T-116 (E-022) — the full attach PAINT: a revived terminal's restored scrollback snapshot,
    // the `── session restored ──` divider, then this pty's ring buffer. `buffer` deliberately
    // stays "what THIS pty emitted" (its other callers must not see a previous session).
    replay: 'pty.replay',
    // T-116 (E-022) — forget a TAB's scrollback snapshot (keyed by tab id, not termId): the file
    // is deleted when the tab closes, on any close path.
    forgetSnapshot: 'pty.forgetSnapshot',
    // E-025 — a first-prompt SUBMIT happened in an agent tab: open a bounded, bidirectional
    // ±window (SESSION_BIND_WINDOW_MS) on that tab's session store, tagged to that term. Two
    // structurally distinct modes: 'await-new' (fresh session / a clear / a fork — a NEW
    // transcript is expected) and 'adopt-existing' (in-session `/resume` — an EXISTING transcript
    // starts growing, or the explicit `/resume <id>` argument is validated on disk and adopted
    // immediately). The window resolves to a `pty:session-id` bind or a `pty:session-unbound`
    // refusal — never a guess.
    armSessionWindow: 'pty.armSessionWindow',
    // E-025 — seed session-id OWNERSHIP for a term (manual ⚠️-popover bind): an owned id is
    // never a bind candidate for any other tab while the ownership stands.
    claimSession: 'pty.claimSession',
    // E-031 — the tab (and its project) a term runs in, so main can name it in `agentTab.exited`.
    setTab: 'pty.setTab'
  },
  agents: {
    // Wave 2b
    roster: 'agents.roster',
    setCommand: 'agents.setCommand',
    sessions: 'agents.sessions',
    // E-025 — does `sessionId`'s transcript exist in this agent's store for `cwdAbs`? The
    // revive gate (a persisted id is validated before `--resume` spawns) and the ⚠️ popover's
    // manual bind (a nonexistent id is refused) both route here. Read-only.
    validateSession: 'agents.validateSession'
  },
  git: {
    // Wave 3
    isRepo: 'git.isRepo',
    fileDiff: 'git.fileDiff',
    // E-036 — repo discovery + per-repo status (git-state.ts), deleted-file view + restore.
    state: 'git.state',
    committedFile: 'git.committedFile',
    restoreFile: 'git.restoreFile',
    // E-037 — the Git panel's History and the commit-details tab (git-history.ts).
    log: 'git.log',
    unpushed: 'git.unpushed',
    mergeCommits: 'git.mergeCommits',
    commit: 'git.commit',
    fileAt: 'git.fileAt',
    // E-038 — one file's history for Document history.
    fileLog: 'git.fileLog',
    // E-039 — operations that change a repository (git-ops.ts): preview, then run.
    preview: 'git.preview',
    run: 'git.run',
    folderInfo: 'git.folderInfo',
    initRepo: 'git.initRepo',
    // E-040 — the conflict tab's reads (git-operator.ts): a stopped rebase, a conflicted file.
    rebase: 'git.rebase',
    conflictFile: 'git.conflictFile',
    // E-041 — the repo view's In progress and the branch tab (git-branches.ts).
    inProgress: 'git.inProgress',
    branch: 'git.branch',
    // E-042 — `pomade-git` runs (git-runs.ts): each repo's last run, "seen", Runner's jobs.
    runs: 'git.runs',
    runSeen: 'git.runSeen',
    scheduled: 'git.scheduled'
  },
  app: {
    version: 'app.version',
    openPath: 'app.openPath',
    // E-012 (final) — reveal an ABSOLUTE path in the OS file manager (Electron
    // shell.showItemInFolder). Unlike openPath (workspace-relative, opens the item), this
    // takes an absolute path so the symlink popover can reveal a target OUTSIDE the workspace.
    showItemInFolder: 'app.showItemInFolder',
    // E-020 (T-086) — open an http/https URL in the user's DEFAULT BROWSER (shell.openExternal).
    // Cmd+clicking a URL in a terminal routes here; nothing else in the app opens the web.
    openExternal: 'app.openExternal',
    flushed: 'app.flushed', // WAVE4 — renderer → main ack that pending state was flushed
    getSettings: 'app.getSettings', // E-002 (T-015) — read app-level editor settings
    setSettings: 'app.setSettings', // E-002 (T-015) — merge-patch app-level editor settings
    // E-001 (T-011) — clipboard via the Electron main process (no navigator.clipboard
    // permission prompts; deterministic for e2e). Cut/Copy/Paste in the editor route here.
    clipboardRead: 'app.clipboardRead',
    clipboardWrite: 'app.clipboardWrite',
    // T-083 — native spellchecker actions. Chromium owns the misspelling markers, so the
    // replacement must go through webContents.replaceMisspelling (the word under the last
    // right-click), and the personal dictionary through the session.
    replaceMisspelling: 'app.replaceMisspelling',
    addToDictionary: 'app.addToDictionary',
    // T-098 — the renderer's FINAL "yes, quit" (both confirmations accepted). Main flips its
    // quit gate and re-enters the normal shutdown pipeline (flush renderers →
    // flushPendingWrites → killAll). Nothing else may flip that gate.
    confirmQuit: 'app.confirmQuit'
  },
  // E-027 — app hosting: the app list and the host side of the Host API (docs/HOST-API.md). The
  // renderer owns each app frame and relays its protocol messages; main owns discovery, the
  // capability gate and every method.
  apps: {
    list: 'apps.list',
    refresh: 'apps.refresh',
    openFrame: 'apps.openFrame',
    closeFrame: 'apps.closeFrame',
    call: 'apps.call',
    // E-030 — the native folder picker behind a delegated `files.pickFolder`.
    pickFolder: 'apps.pickFolder',
    setRoute: 'apps.setRoute',
    // E-028 — the window's half of the socket channel: the active project, delegated calls.
    setActiveProject: 'apps.setActiveProject',
    delegatedResult: 'apps.delegatedResult',
    // E-028 — a frame answers a broker request.
    apiResponse: 'apps.apiResponse'
  },
  // E-031 — the event bus: platform events the renderer owns (Pomade ready, projects created /
  // renamed / opened, the active project) reach main's bus here.
  events: {
    platform: 'events.platform'
  },
  // E-032 — the closed-Pomade notice queue: the renderer attaches once it can show notices.
  notices: {
    attach: 'notices.attach'
  },
  // E-028 — the PATH line in the user's ~/.zprofile, added and removed only from Settings or
  // `pomade path` (docs/HOST-API.md §2 "Commands").
  commands: {
    pathLine: 'commands.pathLine',
    setPathLine: 'commands.setPathLine'
  },
  // E-034 — attached terminals: a tab follows a session an app's keeper holds.
  attached: {
    open: 'attached.open',
    close: 'attached.close',
    input: 'attached.input',
    paste: 'attached.paste',
    resize: 'attached.resize',
    stop: 'attached.stop',
    action: 'attached.action'
  }
} as const

// ─── Event channel names (main → renderer) ────────────────────────────────────
export const EV = {
  fsChanged: 'fs:changed', // Wave 2a
  // E-035 — a write landed on an open doc (any writer, any project): payload = the doc path as
  // declared in fs.watchDocs (ws-relative, or absolute for an outside doc).
  fsDocChanged: 'fs:doc-changed',
  // E-044 — a snapshot of a project file was kept: payload = its ws-relative path.
  localHistoryChanged: 'localHistory:changed',
  ptyData: 'pty:data', // Wave 2b
  ptyExit: 'pty:exit', // Wave 2b
  // T-044 — a terminal's foreground-busy state changed: {termId, busy}. Derived from the
  // shim's preexec/precmd markers (a command started/ended at the shell). Lets the renderer
  // keep a live busy flag so the close-guard can confirm before killing a running process.
  ptyBusy: 'pty:busy',
  // T-114 (E-022) — a terminal's working directory changed: {termId, cwd} (absolute). Read from
  // the SAME zsh-shim precmd marker as `pty:busy` (its payload carries `$PWD`, T-086), and
  // emitted ONLY when the reported directory actually DIFFERS from the last known one — a prompt
  // is drawn after every command, so an unfiltered event would be pure noise. The renderer
  // persists it onto the tab (`TerminalTab.cwd`), which is where a revived tab's fresh PTY starts.
  ptyCwd: 'pty:cwd',
  // T-115 (E-022) — a command was EXECUTED at a terminal's shell: {termId, command, agentLaunch}.
  // Read from the same zsh-shim preexec marker as `pty:busy` (its payload carries the command line,
  // capped at EXEC_MARKER_CAP bytes). Deliberately its OWN event rather than a payload on
  // `pty:busy`: busy is a boolean state with two edges, this is a one-shot fact about one command.
  // `agentLaunch` is main's roster verdict for that command line (the same match that raises
  // `pty:agent-start`), carried here so the renderer can skip the exec that IS an agent launch —
  // at that instant the tab is still a plain terminal, so no ordering rule could tell them apart.
  // The renderer persists non-agent execs as `TerminalTab.lastExec` (pre-typed on the next revive).
  ptyExec: 'pty:exec',
  appFlush: 'app:flush', // WAVE4 — main → renderer: flush pending debounced state before quit
  // E-005 (T-024) — the command typed into an agent pty exited back to the (still-alive)
  // host shell: {termId}. Distinct from pty:exit, which is the pty process itself dying.
  ptyAgentExit: 'pty:agent-exit',
  // E-005 (T-024, both ways) — a roster agent command started at the shell of a shimmed
  // pty: {termId, agentId, agentName, command}. Lets a downgraded (post-/exit) terminal
  // tab upgrade back to an agent tab when the user types `claude` etc. again.
  ptyAgentStart: 'pty:agent-start',
  // E-033 — what the agent running in a pty is doing (working · needs-you · idle), on every change,
  // from the agent's start until it ends: PtyAgentState. Read from its output by the kit's
  // AgentStateScanner; the renderer keeps it per term for `agentTabs.list` and `agentTab.changed`.
  ptyAgentState: 'pty:agent-state',
  // T-113 (E-022) — main captured the LIVE session id of the agent running in a pty:
  // {termId, sessionId, forkedFrom?}. Raised by `session-watcher.ts`; `forkedFrom` (T-327) is the
  // parent session a NEW transcript records — present only for a fork. E-025 reworked the mechanism: the
  // watcher is no longer a recency guesser — it confirms an id ONLY inside a prompt-gated
  // ±window opened by `pty.armSessionWindow` for that specific term (or an explicit
  // resume/claim). The renderer stamps `resumeSessionId` + `bindState: 'bound'` on the tab.
  ptySessionId: 'pty:session-id',
  // E-025 — a bind window closed with NO uniquely-attributable session id: {termId}. Either
  // nothing qualifying appeared in the ±window, or ≥2 AwaitingId tabs could not be separated by
  // submit order (a true sub-second tie) and the watcher REFUSED to bind on a coin-flip. The
  // renderer marks the tab `bindState: 'unbound'` (the ⚠️ affordance); the tab keeps working
  // and rebinds on the next (re)bind cycle or a manual id entry.
  ptySessionUnbound: 'pty:session-unbound',
  // T-036 — app-menu accelerators (main → renderer, no payload). Cmd+W asks the renderer
  // to close the ACTIVE tab through the normal close flow (guards + PTY reaper); Cmd+T asks
  // it to open a new terminal tab right of the active one. Menu-level handling means the
  // keystrokes never reach xterm/the pty.
  tabsCloseActive: 'tabs:close-active',
  tabsNewTerminal: 'tabs:new-terminal',
  // T-149 — Cmd+Shift+T app-menu accelerator (main → renderer, no payload). Asks the renderer to
  // reopen the ACTIVE project's most-recently closed tab (undo-close). Menu-level like Cmd+W, so
  // the keystroke never reaches a focused terminal/xterm.
  tabsReopenClosed: 'tabs:reopen-closed',
  // E-006 (T-026/T-027) — app-menu accelerators (main → renderer, no payload). Cmd+, opens
  // the unified Settings surface; "Change Workspace…" starts the workspace-switch flow.
  // Same menu-item → IPC event → renderer pattern as T-036 (menu handling beats focus).
  openSettings: 'app:open-settings',
  changeWorkspace: 'app:change-workspace',
  // E-001 (T-012) — Cmd+F app-menu accelerator (main → renderer, no payload). Routed to the
  // FOCUSED editor pane only (the renderer no-ops when the active tab isn't a doc), so the
  // keystroke never reaches xterm/terminal panes. Same menu-item → IPC event → renderer
  // pattern as the T-036 Cmd+W/Cmd+T accelerators.
  editorFind: 'editor:find',
  // E-007 (T-030) — Cmd+B app-menu accelerator (main → renderer, no payload). Toggles the
  // Projects panel between full and a collapsed rail. Routed at the menu level (like
  // Cmd+W) so the keystroke never reaches a focused terminal/xterm.
  toggleProjectsPanel: 'layout:toggle-projects-panel',
  // T-049 — Cmd+Shift+B app-menu accelerator (main → renderer, no payload). Toggles the
  // file-tree column between full and a collapsed rail. Menu-level like Cmd+B so the
  // keystroke never reaches a focused terminal/xterm.
  toggleFileTree: 'layout:toggle-filetree',
  // E-011 — a terminal wants attention: {termId}. Raised by pty-manager's output scanner on
  // a standalone BEL (0x07) or an OSC 9/99/777 notification sequence (NOT on OSC title
  // sequences, which also end in BEL, nor on the 7879 shim markers), and on a natural pty
  // exit. The renderer maps termId → project and increments that project's Projects panel counter
  // when it is NOT the active project. The raw BEL still passes through to xterm unchanged.
  ptyAttention: 'pty:attention',
  // T-081 — the machine woke from sleep / the screen unlocked (main → renderer, no payload).
  // TerminalPane re-fits and fully repaints the visible xterm from its buffer: a renderer
  // that spent hours rAF-throttled can otherwise show stale rows until the next write.
  appWake: 'app:wake',
  // T-098 — main asks the focused window to confirm a quit: {liveTerms, liveTermIds} (see
  // QuitRequest). Raised for EVERY quit path — Cmd+Q, app-menu Quit, the red traffic light,
  // Cmd+Shift+W — and re-sent on each further attempt while the dialogs are open (main keeps
  // no dialog state); the renderer ignores a repeat so dialogs never stack.
  confirmQuit: 'app:confirm-quit',
  // T-083 — spell context of the most recent right-click: {misspelledWord, suggestions}.
  // Fired by main's webContents 'context-menu' listener for EVERY right-click (empty word =
  // nothing misspelled), a beat after the renderer's own contextmenu event — the open editor
  // context menu merges the suggestions in when they arrive.
  spellContext: 'app:spell-context',
  // E-027 — the hosted-app list changed (install / update / remove / dev link): HostedApp[].
  appsChanged: 'apps:changed',
  // E-027 — a batch of file changes for one app frame's `files.watch`: AppFilesChanged.
  appsFilesChanged: 'apps:files-changed',
  // E-029 — an app set a strip icon's badge: AppBadge.
  appsBadge: 'apps:badge',
  // E-036 — a new git snapshot (every discovered repo's state): GitSnapshot.
  gitState: 'git:state',
  // E-042 — the `pomade-git` run log changed: Record<repo root, GitRunSummary>.
  gitRuns: 'git:runs',
  // E-042 — Runner's jobs may have changed (it started or stopped serving, or published `jobs.changed` or `runs.changed`): no payload.
  gitJobs: 'git:jobs',
  // E-027 — another frame of the same app set a state key: AppStateChanged (to that frame's webContents).
  appsStateChanged: 'apps:state-changed',
  // E-031 — a bus event for one app frame: AppBusEvent (to that frame's webContents).
  appsEvent: 'apps:event',
  // E-032 — notices drained from the closed-Pomade queue while Pomade runs: QueuedNotice[].
  noticesQueued: 'notices:queued',
  // E-028 — a socket client's delegated call for the window to serve: AppDelegatedServe.
  appsServeDelegated: 'apps:serve-delegated',
  // E-028 — a broker request for a frame that serves its app's API: AppApiRequest.
  appsApiRequest: 'apps:api-request',
  // E-034 — what the keeper sent for one attached tab: AttachedEventPayload.
  attachedEvent: 'attached:event',
  // E-047 (T-291) — a project's app scope folders changed: AppScopeFoldersChanged.
  appScopeFolders: 'state:app-scope-folders'
} as const

// ─── Diff payload (Wave 3 fills the impl; type pinned here) ────────────────────
export interface FileDiff {
  a: string
  b: string
  labelA: string
  labelB: string
}

export type DiffMode = 'working-vs-head' | 'head-vs-prev'

// ─── T-098 quit-confirmation payload (main → renderer) ─────────────────────────
/** Snapshot of main's LIVE ptys at the instant a quit was attempted. `ptyManager` is the
 *  authority on liveness; the renderer crosses `liveTermIds` with the tab kinds only it knows
 *  to split the number into agents vs terminals (dead/restored-dead tabs never count).
 *  `liveTerms` is that set's size — main's own total. */
export interface QuitRequest {
  liveTerms: number
  liveTermIds: string[]
}

// ─── The typed API exposed on window.pomade ───────────────────────────────────
// Wave 1 implements workspace / state / fs / app. pty / agents / git are declared
// so the renderer type-checks against the full surface; waves 2b/3 wire the impls.
export interface PomadeApi {
  workspace: {
    pick(): Promise<string | null>
    get(): Promise<{ root: string | null; config: WorkspaceConfig }>
    saveConfig(config: WorkspaceConfig): Promise<void>
    /** E-006 (T-027) — open an unconstrained native folder dialog; returns the chosen
     *  absolute path (or null if cancelled). Does NOT change the active workspace. */
    pickRoot(): Promise<string | null>
    /** E-006 (T-027) — commit a workspace switch: main tears down PTYs + fs watchers,
     *  sets + persists the new root, and returns the new workspace snapshot. The caller
     *  is responsible for flushing the OLD workspace's pending state first. */
    change(root: string): Promise<{ root: string | null; config: WorkspaceConfig }>
  }
  state: {
    load(projectId: string): Promise<ProjectState | null>
    /** E-026 — a PARTIAL patch: main merges it over the last-known ProjectState (see
     *  config-store.saveState). Callers send only the fields they own (tabs-store the tab
     *  fields, mounts-store `mounts`/`collapsedRoots`) so the two writers never clobber. */
    save(projectId: string, state: Partial<ProjectState>): Promise<void>
    /** E-047 (T-291) — main changed a project's `appScopeFolders` (an app added or removed one,
     *  or its app was removed). */
    onAppScopeFolders(cb: (change: AppScopeFoldersChanged) => void): () => void
    /** T-156 — delete a project's per-project state file (`.pomade/state/<projectId>.json`) when
     *  the project is torn down. Escape-checked in main (the id must be one path segment); a
     *  missing file resolves without error. Main also cancels any queued/in-flight debounced write
     *  to that path and drops its cache entry, so a save scheduled by the teardown's own tab-closes
     *  cannot resurrect the file after the delete. */
    remove(projectId: string): Promise<void>
  }
  /** E-026 (T-140 / T-141) — workspace-scoped, machine-local Projects panel UI state. */
  workspaceUi: {
    /** Read the current workspace's UI state (defaults filled: no workspace ⇒ empty state). */
    load(): Promise<WorkspaceUiState>
    /** A PARTIAL patch merged in main over the last-known state (config-store.saveWorkspaceUi),
     *  so the collapsed-groups writer and the last-active-project writer never clobber. */
    save(patch: Partial<WorkspaceUiState>): Promise<void>
  }
  fs: {
    /** With `{ includeIgnored: true }` entries matching the workspace's configured tree
     *  ignored items (T-019) come back marked `ignored: true` instead of being omitted —
     *  the default (omitted/false) keeps the pre-T-019 behavior of skipping them. */
    tree(rootRel: string, depth?: number, opts?: { includeIgnored?: boolean }): Promise<FileNode>
    read(rel: string): Promise<string>
    /** Write `content` to `rel` (creating parent dirs). With `{ exclusive: true }` a collision
     *  (the file already exists) resolves to `{ ok: false, code: 'EEXIST' }` instead of
     *  rejecting — a structured result for Save-As to branch on, not a message to grep. Any
     *  other failure (permissions, disk full, …) still rejects normally. A plain write (no
     *  `exclusive`) truncates as before and resolves `{ ok: true }`. */
    write(rel: string, content: string, opts?: { exclusive?: boolean }): Promise<WriteFileResult>
    createFile(rel: string): Promise<void>
    createDir(rel: string): Promise<void>
    exists(rel: string): Promise<boolean>
    copyDir(srcRel: string, destRel: string): Promise<void>
    // Wave 2a additions:
    watch(rootRel: string): Promise<void> // start a recursive fs watcher → EV.fsChanged({ root: rootRel, changes })
    unwatch(rootRel: string): Promise<void>
    onChanged(cb: (e: FsChangedEvent) => void): () => void // subscribe to EV.fsChanged; returns unsubscribe
    /** E-035 — replace the set of watched open docs (ws-relative or absolute paths; '' ignored). */
    watchDocs(paths: string[]): Promise<void>
    /** E-035 — subscribe to EV.fsDocChanged (a write to a watched doc); returns unsubscribe. */
    onDocChanged(cb: (path: string) => void): () => void
    /** Native picker constrained to the workspace; returns a workspace-relative path (or null). */
    pickPath(opts?: { directory?: boolean; defaultRel?: string; image?: boolean }): Promise<string | null>
    /** E-008 (T-033) — pick an image without the workspace constraint. An image chosen from
     *  OUTSIDE the workspace is copied into `.pomade/assets/<id>.<ext>` and the copy's
     *  workspace-relative path is returned; an inside-workspace pick is returned unchanged.
     *  Returns null if the dialog is cancelled. */
    pickImage(): Promise<string | null>
    /** Read a file (e.g. an image) as a data: URL for inline preview. */
    readDataUrl(rel: string): Promise<string>
    /** Byte-accurate size + mtime; rejects if the path does not exist. */
    stat(rel: string): Promise<FileStat>
    /** E-001 (T-010) — copy a file next to itself as "<name> copy.<ext>" (collision-safe:
     *  " copy 2", " copy 3", …). Returns the new file's workspace-relative path. */
    duplicate(srcRel: string): Promise<string>
    /** E-001 (T-010) — copy a file into `destDirRel`, keeping its name (collision-safe with
     *  the same " copy" suffixing). Returns the new file's workspace-relative path. */
    copyTo(srcRel: string, destDirRel: string): Promise<string>
    /** E-004 (T-020) — rename/move `srcRel` to `destRel` (both workspace-relative). Rejects
     *  if `destRel` already exists (no silent overwrite). Returns the new relative path. */
    rename(srcRel: string, destRel: string): Promise<string>
    /** E-012 — move a file OR directory to `destRel` (both workspace-relative). Collision-
     *  refusing (rejects with "already exists"); refuses moving a directory into itself or a
     *  descendant. A no-op move to the same path is allowed. Returns the new relative path.
     *  E-016 — `opts.onCollision` governs an existing destination (default: refuse, as before):
     *  `'rename'` moves to a collision-safe " copy" name (returns that path); `'overwrite'`
     *  replaces a destination FILE with a source FILE (the old file goes to the OS trash),
     *  refusing when either side is a directory. */
    move(
      srcRel: string,
      destRel: string,
      opts?: { onCollision?: 'rename' | 'overwrite' }
    ): Promise<string>
    /** E-012 — copy a file OR directory (recursive) to `destRel` (both workspace-relative).
     *  Collision-safe: if `destRel` exists the copy is renamed "<stem> copy<ext>" /
     *  "<stem> copy N<ext>" (directories: the whole name is the stem). Refuses copying a
     *  directory into itself/descendant. Returns the new relative path of the copy. */
    copy(srcRel: string, destRel: string): Promise<string>
    /** E-012 — move the file/dir at `rel` to the OS trash (Electron shell.trashItem;
     *  recoverable, never rm). Escape-checked. */
    trash(rel: string): Promise<void>
    /** E-012 (final) — resolve the target of the symbolic link at `rel`. `targetAbs` is the
     *  realpath of the FINAL target (chained links resolved once); a broken link returns
     *  exists:false with the raw readlink-resolved path. `targetRel` is workspace-relative when
     *  the target is inside the workspace, else null. */
    linkTarget(rel: string): Promise<LinkTarget>
    /** E-014 — a frequency index of frontmatter keys and (per list-typed key) values across all
     *  workspace .md files, for the properties-panel autocomplete. Cached per app run (rebuilt on
     *  a workspace switch); a stale result is acceptable — it only drives suggestions. */
    frontmatterIndex(): Promise<FrontmatterIndex>
    /** E-020 (T-086) — resolve + stat ONE path token for the terminal link provider.
     *  `input` may be absolute, `~/…`, or relative; a relative input is resolved against
     *  `baseAbs` (the terminal's cwd / project root / workspace root, tried in that order by
     *  the caller). Unlike the other `fs.*` helpers this deliberately accepts targets OUTSIDE
     *  the workspace (read-only: it only stats). Resolves to null when nothing is there —
     *  which is exactly how the provider avoids underlining dead links. */
    probePath(input: string, baseAbs?: string): Promise<PathProbe | null>
    /** E-020 (T-086) — workspace-relative paths of every file/dir whose BASENAME folds to `name`
     *  (T-188: case-INSENSITIVE — `Northwind` finds `northwind.md`; a plain locale-independent
     *  `toLowerCase()` fold). Backed by the eager, watcher-fresh basename index (T-091): built at
     *  boot / workspace switch via `warmNameIndex()`, kept fresh by one index-owned recursive
     *  `fs.watch` (~200 ms staleness; degrades to lazy + 30 s TTL only if `fs.watch` fails). Ignore
     *  rules = `fs.tree`'s list plus the hardcoded INDEX_IGNORE_NAMES. `projectRootAbs` (the active
     *  project's absolute root, when known) biases ranking toward the current project. Results are
     *  ranked EXACT-CASE-first, then current-project, then walk order. Zero matches ⇒ not a link;
     *  one ⇒ open it; many ⇒ the disambiguation picker. Capped at FIND_BY_NAME_MAX results. */
    findByName(name: string, projectRootAbs?: string): Promise<string[]>
    /** E-020 round 2 — workspace-relative paths of every file whose basename MINUS its last
     *  extension folds to `word` (`VISION` → `docs/VISION.md`), followed by files named exactly
     *  `word` (`LICENSE`, `Makefile`). Case-INSENSITIVE (T-188); same index/cap/ranking as
     *  `findByName` (stem hits before exact-basename hits within a rank tie); same 0 / 1 / many
     *  contract (no match ⇒ not a link). */
    findByStem(word: string, projectRootAbs?: string): Promise<string[]>
    /** E-020 round 4 — workspace-relative paths of DIRECTORIES whose path ends with `token`'s full
     *  trailing segment sequence, matched case-insensitively (`Docs/` → `docs`, `docs/superpowers/
     *  specs/` needs the whole suffix). The fallback for a slashed folder token that resolves
     *  against no probe base. Ranked exact-case-first, then current-project (T-188). Same 0 / 1 /
     *  many contract and cap as `findByName`. */
    findDirsBySuffix(token: string, projectRootAbs?: string): Promise<string[]>
    /** T-086 (Fix A) — workspace-relative paths of FILES whose path ends with `token`'s full
     *  trailing segment sequence, matched case-INSENSITIVELY on segment boundaries (T-188:
     *  `session-docs-reviewed/…-reviewed.md`; `docs-reviewed/x.md` does NOT match a path ending
     *  `session-docs-reviewed/x.md` — the boundary is a whole segment, never a substring). The
     *  fallback for a slashed FILE token that resolves against no probe base. Files only (directories
     *  are `findDirsBySuffix`'s job; a trailing slash returns none). Ranked exact-case-first, then
     *  current-project. Same 0 / 1 / many contract and cap as `findByName`. */
    findFilesBySuffix(token: string, projectRootAbs?: string): Promise<string[]>
    /** T-102 (E-021) — read ONE absolute path OUTSIDE the workspace as UTF-8. Rejects a
     *  relative path (the workspace escape-guard covers those). Backs the outside-workspace doc
     *  object class in the editor. */
    readOutside(absPath: string): Promise<string>
    /** T-102 (E-021) — write `content` to ONE absolute path outside the workspace (creating
     *  parent dirs). Rejects a relative path. */
    writeOutside(absPath: string, content: string): Promise<void>
    /** T-102 (E-021) — byte-accurate size + mtime + symlink for ONE absolute path outside the
     *  workspace; rejects if it does not exist (used to size-guard the load and to prune an
     *  unresolved outside tab on restore). */
    statOutside(absPath: string): Promise<FileStat>
    /** T-131 (E-026) — outside-workspace analogue of `tree`: read the directory tree at ONE
     *  ABSOLUTE mount root (requires an absolute path — the escape guard covers relative ones),
     *  `depth` levels deep, with the same symlink/sort logic as `tree`. Returned `FileNode.path`s
     *  are ABSOLUTE (there is no ws-relative form outside the workspace); the ignore-set is the
     *  hardcoded index-ignore superset. Rejects if the root no longer exists (drives the
     *  missing-root state). Tree-display only — no index/link/git follows an outside path. */
    treeOutside(absPath: string, depth: number): Promise<FileNode>
    /** T-131 (E-026) — start a bounded recursive watcher for ONE explicitly-mounted outside root
     *  (one native `fs.watch(recursive)` descriptor — never per-dir watchers). Change events
     *  arrive via `fs.onChanged` keyed by the ABSOLUTE root path; watching the root also detects
     *  its own deletion. Idempotent: watching the same path twice opens no second descriptor. */
    watchOutside(absPath: string): Promise<void>
    /** T-131 (E-026) — stop the outside-root watcher started by `watchOutside` (safe no-op if the
     *  path is not watched). Call on unmount / project switch / workspace teardown. */
    unwatchOutside(absPath: string): Promise<void>
    /** T-133 (E-026) — create a new empty file at ONE absolute path inside an outside mount
     *  (refuses to clobber an existing file). Outside analogue of `createFile`. */
    createFileOutside(absPath: string): Promise<void>
    /** T-133 (E-026) — create a directory at ONE absolute path inside an outside mount (recursive,
     *  idempotent). Outside analogue of `createDir`. */
    createDirOutside(absPath: string): Promise<void>
    /** T-133 (E-026) — rename the entry at `absPath` to a sibling `newName` (collision-refusing).
     *  Returns the new ABSOLUTE path. Outside analogue of `rename`. */
    renameOutside(absPath: string, newName: string): Promise<string>
    /** T-133 (E-026) — duplicate the FILE at `absPath` next to itself as "<name> copy<ext>"
     *  (collision-safe). Returns the new ABSOLUTE path. Outside analogue of `duplicate`. */
    duplicateOutside(absPath: string): Promise<string>
    /** T-133 (E-026) — move a file OR directory between two ABSOLUTE paths (collision-refusing,
     *  self/descendant-guarded). `onCollision` mirrors `move` for the collision-dialog
     *  resolutions. Returns the final ABSOLUTE path. Outside analogue of `move`. */
    moveOutside(
      srcAbs: string,
      destAbs: string,
      opts?: { onCollision?: 'rename' | 'overwrite' }
    ): Promise<string>
    /** T-133 (E-026) — copy a file OR directory (recursive) between two ABSOLUTE paths,
     *  collision-safe (" copy" suffixing). Returns the new copy's ABSOLUTE path. Outside
     *  analogue of `copy`. */
    copyOutside(srcAbs: string, destAbs: string): Promise<string>
    /** T-133 (E-026) — send the entry at `absPath` to the OS trash (recoverable — never rm).
     *  Outside analogue of `trash`. */
    trashOutside(absPath: string): Promise<void>
  }
  app: {
    version(): Promise<string>
    openPath(rel: string): Promise<void>
    /** E-012 (final) — reveal an ABSOLUTE path in the OS file manager (shell.showItemInFolder). */
    showItemInFolder(abs: string): Promise<void>
    /** E-020 (T-086) — open an http/https URL in the default browser (shell.openExternal).
     *  Non-http(s) schemes are refused in main, so a terminal can never talk the app into
     *  launching an arbitrary handler. */
    openExternal(url: string): Promise<void>
    /** WAVE4 — subscribe to the main-process flush-before-quit signal. Returns unsubscribe. */
    onFlush(cb: () => void): () => void
    /** WAVE4 — tell main this window has flushed its pending state (quit may continue). */
    flushAck(): void
    /** T-036 — subscribe to the Cmd+W app-menu accelerator (close the active tab). Returns unsubscribe. */
    onCloseActiveTab(cb: () => void): () => void
    /** T-036 — subscribe to the Cmd+T app-menu accelerator (new terminal tab right of active). Returns unsubscribe. */
    onNewTerminalTab(cb: () => void): () => void
    /** T-149 — subscribe to the Cmd+Shift+T app-menu accelerator (reopen the active project's most
     *  recently closed tab). Returns unsubscribe. */
    onReopenClosedTab(cb: () => void): () => void
    /** E-006 (T-026) — subscribe to the Cmd+, app-menu accelerator (open unified Settings). Returns unsubscribe. */
    onOpenSettings(cb: () => void): () => void
    /** E-006 (T-027) — subscribe to the "Change Workspace…" app-menu item. Returns unsubscribe. */
    onChangeWorkspace(cb: () => void): () => void
    /** E-002 (T-015) — read the app settings (the active workspace's .pomade/settings.json + state/view.json). */
    getSettings(): Promise<AppSettings>
    /** E-002 (T-015) — merge-patch app-level editor settings; returns the merged result. */
    setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
    /** E-001 (T-011) — read the system clipboard text (via Electron main; no permission prompt). */
    clipboardRead(): Promise<string>
    /** E-001 (T-011) — write text to the system clipboard (via Electron main). */
    clipboardWrite(text: string): Promise<void>
    /** E-001 (T-012) — subscribe to the Cmd+F app-menu accelerator (open in-document find in
     *  the focused editor). Returns unsubscribe. */
    onEditorFind(cb: () => void): () => void
    /** E-007 (T-030) — subscribe to the Cmd+B app-menu accelerator (toggle the Projects panel between
     *  full and collapsed rail). Returns unsubscribe. */
    onToggleProjectsPanel(cb: () => void): () => void
    /** T-049 — subscribe to the Cmd+Shift+B app-menu accelerator (toggle the file-tree column
     *  between full and collapsed rail). Returns unsubscribe. */
    onToggleFileTree(cb: () => void): () => void
    /** T-081 — subscribe to sleep-resume / screen-unlock (powerMonitor). TerminalPane re-fits
     *  and repaints the visible xterm so a throttled wake never shows stale rows. Returns
     *  unsubscribe. */
    onWake(cb: () => void): () => void
    /** T-083 — spell context of the most recent right-click (empty word = none). Returns
     *  unsubscribe. */
    onSpellContext(cb: (ctx: { misspelledWord: string; suggestions: string[] }) => void): () => void
    /** T-083 — replace the misspelled word under the last right-click with `suggestion`
     *  (Chromium's own replaceMisspelling — keeps undo history and marker bookkeeping). */
    replaceMisspelling(suggestion: string): Promise<void>
    /** T-083 — add a word to the OS/session personal dictionary. */
    addToDictionary(word: string): Promise<void>
    /** T-098 — subscribe to main's quit-confirmation request (every quit path is intercepted
     *  and asked here). The app CANNOT exit until `confirmQuit()` is called. Returns unsubscribe. */
    onConfirmQuit(cb: (req: QuitRequest) => void): () => void
    /** T-098 — both confirmations accepted: let main proceed with the orderly quit. */
    confirmQuit(): Promise<void>
  }
  // WAVE2B: `pty` and `agents` namespaces.
  pty: {
    /** `command` is SUBMITTED once the shell is up. T-115 — `presetInput` is TYPED into the fresh
     *  shell's line editor WITHOUT a trailing CR (gated on the shim's first prompt marker), so it
     *  waits there unsubmitted; mutually exclusive with `command`, which wins if both are passed.
     *  T-116 — `snapshotKey` (the TAB id) opts the term into scrollback persistence (plain
     *  terminals only); `replaySnapshot` additionally loads that key's saved scrollback so the
     *  attaching pane repaints it above the restore divider (set by a REVIVE only). */
    create(opts: {
      cwd: string
      /** E-033 — the tab the term runs in: its shell gets `POMADE_TAB_ID`. */
      tabId: string
      /** The project the tab belongs to (`__workspace__` for the Workspace project): its shell gets
       *  `POMADE_PROJECT_ID`. */
      projectId: string
      command?: string
      presetInput?: string
      snapshotKey?: string
      replaySnapshot?: boolean
    }): Promise<{ termId: string }>
    write(termId: string, data: string): Promise<void>
    resize(termId: string, cols: number, rows: number): Promise<void>
    kill(termId: string): Promise<void>
    sendExit(termId: string): Promise<void>
    buffer(termId: string): Promise<string>
    /** T-116 (E-022) — everything an attaching xterm must paint, in ONE atomic call: restored
     *  scrollback + the `── session restored ──` divider + this pty's ring buffer (just the ring
     *  when there is nothing to restore). '' for an unknown term. */
    replay(termId: string): Promise<string>
    /** T-116 (E-022) — forget a tab's scrollback snapshot (key = TAB id). Idempotent. */
    forgetSnapshot(key: string): Promise<void>
    /** E-025 — open this agent term's prompt-gated bind window (see CH.pty.armSessionWindow).
     *  `submitAt` is the renderer's submit timestamp — the window is BIDIRECTIONAL around it
     *  (±SESSION_BIND_WINDOW_MS). `resumeId` (adopt-existing only) is the explicit
     *  `/resume <id>` argument, validated on disk and adopted without waiting. */
    armSessionWindow(
      termId: string,
      opts: { mode: 'await-new' | 'adopt-existing'; submitAt: number; resumeId?: string }
    ): Promise<void>
    /** E-025 — seed session-id ownership for a term (the ⚠️ popover's manual bind). The
     *  renderer validates the id on disk FIRST (agents.validateSession) — claiming a
     *  nonexistent id would arm a resume that must fail. */
    claimSession(termId: string, sessionId: string): Promise<void>
    /** E-031 — the tab a term runs in (sent on every change: creation, hydration, a relaunch's
     *  termId swap, a cross-project move); main names it in `agentTab.exited`. */
    setTab(termId: string, tab: PtyTabRef): Promise<void>
    /** T-044: `busy` = a foreground command is currently running at this pty's shell.
     *  E-020: `cwd` = the shell's last reported working directory ('' until its first prompt). */
    list(): Promise<{ termId: string; alive: boolean; busy: boolean; cwd: string }[]>
    /** E-020 (T-086) — the shell's CURRENT working directory (absolute), or '' when no prompt
     *  marker has been seen yet (very early startup) / the term is unknown. Tracked from the zsh
     *  shim's precmd marker, so it follows every `cd` without polling the process table. */
    cwd(termId: string): Promise<string>
    /** Subscribe to a terminal's output. Returns an unsubscribe fn. */
    onData(termId: string, cb: (data: string) => void): () => void
    /** T-044 — subscribe to this terminal's foreground-busy changes. Returns unsubscribe. */
    onBusy(termId: string, cb: (busy: boolean) => void): () => void
    /** T-114 (E-022) — subscribe to this terminal's working-directory CHANGES (absolute path).
     *  Fires on the first prompt and after every `cd`, never for a prompt that reports the same
     *  directory. Returns unsubscribe. */
    onCwd(termId: string, cb: (cwd: string) => void): () => void
    /** T-115 (E-022) — subscribe to "a command was executed at this pty's shell". `command` is the
     *  preexec payload (capped at EXEC_MARKER_CAP bytes); `agentLaunch` is true when that command
     *  line matched the agent roster, i.e. this exec is the one that also upgrades the tab to an
     *  agent — the renderer must not record it as the terminal's `lastExec`. Returns unsubscribe. */
    onExec(
      termId: string,
      cb: (payload: { command: string; agentLaunch: boolean }) => void
    ): () => void
    /** Subscribe to a terminal's exit. Returns an unsubscribe fn. */
    onExit(termId: string, cb: (exitCode: number) => void): () => void
    /** E-005 (T-024) — subscribe to "the agent command ended, shell lives on". Returns unsubscribe. */
    onAgentExit(termId: string, cb: () => void): () => void
    /** E-005 (T-024, both ways) — subscribe to "a roster agent command started at this
     *  pty's shell". E-025 appends `cwd` to the payload: the shell's working directory at the
     *  exec marker — the agent CLI's cwd-AT-LAUNCH, which the renderer persists as
     *  `TerminalTab.cwdAtLaunch` (the store-resolution key). Returns unsubscribe. */
    onAgentStart(
      termId: string,
      cb: (payload: { agentId: string; agentName: string; command: string; cwd: string }) => void
    ): () => void
    /** E-011 — subscribe to "this terminal wants attention" (turn-end BEL / OSC 9·99·777
     *  notification, or a natural pty exit). Returns unsubscribe. */
    onAttention(termId: string, cb: () => void): () => void
    /** T-113 (E-022) — subscribe to "main learned the LIVE session id of the agent running in
     *  this pty". Fires for a fresh-started session as soon as its transcript appears (~a second
     *  after the first submission) and again whenever the id changes mid-session (`/clear`,
     *  in-session `/resume`). T-327 — `forkedFrom` is the parent session the new transcript
     *  records (a fork: claude `forkedFrom.sessionId`, codex `session_meta.forked_from_id`), or
     *  null. Returns unsubscribe. */
    onSessionId(termId: string, cb: (sessionId: string, forkedFrom: string | null) => void): () => void
    /** E-025 — subscribe to "a bind window for this term closed with no uniquely-attributable
     *  id" (nothing appeared, or a submit-order tie forced a refusal). Returns unsubscribe. */
    onSessionUnbound(termId: string, cb: () => void): () => void
    /** E-033 — every agent state change of every term (working · needs-you · idle). Returns unsubscribe. */
    onAgentState(cb: (payload: PtyAgentState) => void): () => void
  }
  agents: {
    roster(): Promise<AgentInfo[]>
    setCommand(agentId: string, command: string): Promise<AgentInfo>
    sessions(agentId: string, cwdAbs: string): Promise<SessionRecord[]>
    /** E-025 — true iff `sessionId`'s transcript exists in this agent's store for `cwdAbs`
     *  (claude: `projects/<encoded-cwd>/<id>.jsonl`; codex: a rollout whose session_meta
     *  matches id + cwd). The revive gate and the ⚠️ popover's manual bind validate here. */
    validateSession(agentId: string, cwdAbs: string, sessionId: string): Promise<boolean>
  }
  // WAVE3: `git` namespace.
  git: {
    /** True iff `rel` is inside a git repo that lives within the workspace. */
    isRepo(rel: string): Promise<boolean>
    /** Two sides of a diff for a workspace-relative file, plus revision labels. */
    fileDiff(rel: string, mode: DiffMode): Promise<FileDiff>
    /** E-036 — every discovered repo and its status; resolves after the first discovery. */
    state(): Promise<GitSnapshot>
    /** E-036 — a file's version in the last commit (a deleted file's read-only view). */
    committedFile(rel: string): Promise<CommittedFile>
    /** E-036 — write a deleted file back from the last commit; rejects when the path exists. */
    restoreFile(rel: string): Promise<void>
    /** E-037 — one History page of the repo at `repo` (a discovered root, ws-relative): the
     *  branch's first-parent line, or every commit with `all`, without the commits its upstream
     *  lacks. `skip` = commits already shown. */
    log(repo: string, opts: { all: boolean; skip: number }): Promise<LogPage>
    /** E-037 — the commits on the branch its upstream lacks (`@{upstream}..HEAD`), newest first,
     *  capped at `UNPUSHED_LIMIT`; none without an upstream. */
    unpushed(repo: string): Promise<LogPage>
    /** E-037 — the commits a merge brought in (its row's expansion), newest first, capped. */
    mergeCommits(repo: string, hash: string): Promise<LogPage>
    /** E-037 — a commit's header, full message and files changed against its first parent. */
    commit(repo: string, hash: string): Promise<CommitDetails>
    /** E-037 — the comparison tab's revision side: `path` (ws-relative, inside `repo`) at `rev`
     *  (a hash or `HEAD`); absent / binary / over 2 MB / unknown revision come back as kinds. */
    fileAt(repo: string, rev: string, path: string): Promise<RevisionFile>
    /** E-038 — the commits that touched `path` (ws-relative, inside `repo`), newest first, renames
     *  followed: first-parent, or every commit with `all`. Each commit's `path` is the file's
     *  ws-relative path at that commit. `skip` = commits already shown. `via` reads the history of
     *  that committed path instead (git's own rename source, or the `renamedFrom` an earlier page
     *  answered); `candidates` (paths deleted in the working tree) let the first page find where a
     *  file moved without git knowing came from — see `FileLogPage.renamedFrom`. */
    fileLog(
      repo: string,
      path: string,
      opts: { all: boolean; skip: number; via?: string; candidates?: string[] }
    ): Promise<FileLogPage>
    /** E-039 — what an operation on `repo` (a discovered root) will do, or why it cannot
     *  (`blocked`). Read-only; `connect-remote` asks the remote (`ls-remote`). */
    preview(repo: string, req: GitOpRequest): Promise<GitOpPreview>
    /** E-039 — run it: only while the repo is as the preview saw it (`token`), one operation per
     *  repo at a time. Failures come back as `{ ok: false, failure }`, in plain words. */
    run(repo: string, req: GitOpRequest, opts: GitOpRun): Promise<GitOpResult>
    /** E-039 — a folder's relation to git, for the project dialog's "Track with git". */
    folderInfo(rel: string): Promise<FolderGitInfo>
    /** E-039 — `git init` in a project folder + its first commit (`message`). */
    initRepo(rel: string, message: string): Promise<InitRepoResult>
    /** E-040 — the rebase stopped in `repo` (a discovered root): branch, onto, the commit being
     *  replayed, open conflicts; null when no rebase is stopped there. Read-only. */
    rebase(repo: string): Promise<RebaseState | null>
    /** E-040 — one conflicted file's three versions (theirs, base, yours) and, for text, the
     *  line-by-line segments. Rejects when `path` has no open conflict. Read-only. */
    conflictFile(repo: string, path: string): Promise<ConflictFile>
    /** E-041 — `repo`'s In progress: its worktrees, local branches main lacks, then remote-only
     *  branches main lacks, with counts, last activity and the agents live there. Read-only. */
    inProgress(repo: string): Promise<InProgress>
    /** E-041 — a branch tab: `main..branch` and the total change against the merge base.
     *  `branch` = `feature` or `origin/feature`. Rejects when it no longer exists. Read-only. */
    branch(repo: string, branch: string): Promise<BranchDetails>
    /** E-042 — each discovered repo's last `pomade-git` run (by root), with whether it failed
     *  unseen; starts watching the run log (`onRuns`). */
    runs(): Promise<Record<string, GitRunSummary>>
    /** E-042 — the user opened `repo`: its failed run is seen (the mark goes, for good). */
    runSeen(repo: string): Promise<void>
    /** E-042 — `pomade-runner`'s jobs that target `repo`; null when Runner is absent or not
     *  responding (rule 7 — no Scheduled line then). */
    scheduled(repo: string): Promise<RepoJob[] | null>
    onState(cb: (snapshot: GitSnapshot) => void): () => void
    onRuns(cb: (runs: Record<string, GitRunSummary>) => void): () => void
    /** E-042 — Runner started or stopped serving, or published `jobs.changed` or `runs.changed`: ask `scheduled` again. */
    onJobs(cb: () => void): () => void
  }
  /** E-027 — app hosting (docs/HOST-API.md; docs/contracts/host-api-frames.md). */
  apps: {
    /** Every hostable app (installed + dev-linked), unavailable ones included with a reason. */
    list(): Promise<HostedApp[]>
    /** Rescan installs and links now (re-fetches dev-server manifests); returns the new list. */
    refresh(): Promise<HostedApp[]>
    /** Open a Host API session for a frame the renderer created for `appId`, answering the
     *  frame's `hello` (its `hostApi`). `frameId` is renderer-minted, one per handshake. */
    openFrame(frameId: string, appId: string, appHostApi: unknown, request: AppFrameRequest): Promise<AppFrameOpen>
    /** End a frame's session (reload, close, app update) and drop its watches. */
    closeFrame(frameId: string): Promise<void>
    /** Run one Host API call for a frame; main enforces the manifest's capabilities. */
    call(frameId: string, method: unknown, params: unknown, ctx: AppCallContext): Promise<AppCallResult>
    /** E-030 — the native folder picker for a frame's `files.pickFolder`, bounded by `root`
     *  (workspace-relative, '' = the workspace) and starting at `initial`. Main re-checks the
     *  frame's `files.read` capability and both paths; the answer is the Host API result. */
    pickFolder(frameId: string, root: string, initial: string | undefined): Promise<AppCallOutcome>
    /** E-027 — the frame's tab was navigated to `route`: `host.info` answers it from now on. */
    setRoute(frameId: string, route: string): Promise<void>
    onChanged(cb: (apps: HostedApp[]) => void): () => void
    onFilesChanged(cb: (batch: AppFilesChanged) => void): () => void
    /** E-029 — an app set one of its strip icons' badge (`strip.setBadge`, validated in main). */
    onBadge(cb: (badge: AppBadge) => void): () => void
    /** E-027 — another frame of the same app set a state key (`state.set`). */
    onStateChanged(cb: (change: AppStateChanged) => void): () => void
    /** E-031 — a bus event for one frame (to that frame's webContents). */
    onEvent(cb: (event: AppBusEvent) => void): () => void
    /** E-028 — the active project changed (the first report also says the window is ready):
     *  socket clients get `project.changed` and `project.getActive` answers it. */
    setActiveProject(ref: ProjectRef): Promise<void>
    /** E-028 — the answer to an `onServeDelegated` request. */
    delegatedResult(requestId: string, outcome: AppCallOutcome): Promise<void>
    /** E-028 — a backend's or command's call whose work is renderer-owned state. */
    onServeDelegated(cb: (serve: AppDelegatedServe) => void): () => void
    /** E-028 — a frame's answer to a broker request (`AppApiRequest`). */
    apiResponse(frameId: string, requestId: string, outcome: AppCallOutcome): Promise<void>
    /** E-028 — another app's call for a frame that serves its app's API. */
    onApiRequest(cb: (req: AppApiRequest) => void): () => void
  }
  /** E-031 — the event bus (docs/HOST-API.md §4 `events`). */
  events: {
    /** A platform event the renderer owns, for main's bus; a name that is not a platform event
     *  is ignored. `to` = one app id: only that app's subscribers get it (`project.updated` for a
     *  settings change). */
    platform(name: string, payload: unknown, to?: string): Promise<void>
  }
  /** E-032 — the closed-Pomade notice queue (`<userData>/notices/queue/`). */
  notices: {
    /** Start serving the queue: resolves with what was queued so far (drained, in posting order);
     *  later arrivals come through `onQueued`. */
    attach(): Promise<QueuedNotice[]>
    onQueued(cb: (notices: QueuedNotice[]) => void): () => void
  }
  /** E-028 — the PATH line that puts this Pomade's command folder on PATH for shells it did not
   *  start (docs/HOST-API.md §2 "Commands"). Null when commands are off (tests without the hooks). */
  commands: {
    /** Where the line goes and what folder it names now. */
    pathLine(): Promise<PathLineStatus | null>
    /** Add the line for this Pomade's folder (`true`, repointing another Pomade's line) or remove
     *  Pomade's line (`false`). */
    setPathLine(on: boolean): Promise<PathLineStatus | null>
  },
  /** E-034 — attached terminals (docs/modules/terminal/attached-terminals.md): a tab follows a
   *  session an app's keeper holds, over the keeper's socket `<userData>/run/keepers/<app>.sock`. */
  attached: {
    /** Follow `session` for the tab `tabId`: attach at this size, reconnect after keeper updates
     *  and restarts. What the keeper sends arrives through `onEvent`, a snapshot first. A tab
     *  already followed is attached again (a fresh snapshot). */
    open(tabId: Id, session: SessionRef, cols: number, rows: number): Promise<void>
    /** Stop following (the tab closed): detach; the session keeps running. */
    close(tabId: Id): Promise<void>
    /** Keystrokes and the terminal reports the user caused (mouse, focus) — never the terminal's
     *  answers to the program's queries; the keeper answers those. */
    input(tabId: Id, data: string): Promise<void>
    /** Pasted text; the keeper brackets it when the program asked for bracketed paste. */
    paste(tabId: Id, text: string): Promise<void>
    resize(tabId: Id, cols: number, rows: number): Promise<void>
    /** Stop the session (`stopped-by-you`). */
    stop(tabId: Id): Promise<void>
    /** A header action the owner contributed was clicked: publishes `attachedTab.action` to the
     *  owning app only. */
    action(session: SessionRef, action: string, projectId: Id): Promise<void>
    onEvent(tabId: Id, cb: (event: AttachedEvent) => void): () => void
  }
  /** E-035 — unsaved-doc recovery (user data only). A doc is keyed by the current workspace +
   *  its path, or `untitled:<tabId>` for an Untitled doc (path ''). */
  recovery: {
    /** Store (replace) the doc's recovery copy. */
    put(rec: RecoveryPut): Promise<void>
    /** The doc's recovery copy, or null. */
    get(path: string, tabId: string): Promise<RecoveryRecord | null>
    /** Delete the doc's recovery copy (saved, reloaded, or edits undone). */
    remove(path: string, tabId: string): Promise<void>
    /** Keep a discarded draft (kept 7 days) and delete the doc's recovery copy. */
    keepDraft(draft: DraftPut): Promise<void>
    /** The current workspace's discarded drafts, newest first; `path` narrows to one doc. */
    drafts(path?: string): Promise<DiscardedDraft[]>
    /** T-310 — the Git panel's Discarded rows: files with kept git-discard copies that are not
     *  back (see `discardedRowShown`), newest discard first. */
    discardedFiles(): Promise<DiscardedFile[]>
    /** T-310 — the document at `path` was restored from Document history (its discard rows hide
     *  once the file is saved). */
    markRestored(path: string): Promise<void>
    /** T-310 — Forget: delete the kept git-discard copies of `path`. */
    forgetDiscarded(path: string): Promise<void>
  }
  /** E-044 — local history: a project file's snapshots, kept 7 days in the workspace's store. */
  localHistory: {
    /** The current workspace's snapshots of the ws-relative `path`, newest first. */
    list(path: string): Promise<SnapshotRef[]>
    /** One snapshot's text; null when it is no longer kept. */
    read(path: string, id: string): Promise<string | null>
    /** T-226 — keep the file's current content as a snapshot now (no quiet window). True when that
     *  content is the path's newest snapshot afterwards; false when local history does not keep
     *  this file (not trackable, ignored by git, empty, missing, outside the workspace). */
    keep(path: string): Promise<boolean>
    /** T-234 — what Settings' Delete would remove now: the current workspace's versions of `group`
     *  kept more than `olderThanDays` days ago (0 = all of them). */
    previewPurge(group: PurgeGroup, olderThanDays: number): Promise<PurgePreview>
    /** T-234 — delete the current workspace's versions of `group` kept before `before` (a
     *  preview's own `before`, so exactly what it counted goes). Resolves what went. */
    purge(group: PurgeGroup, before: number): Promise<RemovalSize>
    /** T-234 — what the store's prune would remove now under a cap of `capMb` MB. */
    previewCap(capMb: number): Promise<RemovalSize>
    /** Subscribe to EV.localHistoryChanged (a path's snapshots changed: one kept, or some removed by
     *  a prune or a purge); returns unsubscribe. */
    onChanged(cb: (path: string) => void): () => void
  }
  /** T-101 (E-021) — synchronous, non-IPC environment values snapshotted at preload time (no
   *  channel; contextIsolation-safe copies exposed on the bridge). */
  env: {
    /** The user's home directory (absolute), used to render `~`-relative paths for out-of-project
     *  docs in the editor header. Empty string only if the OS reports no home. */
    home: string
  }
}

// ─── T-164: typed IPC boundary ────────────────────────────────────────────────
// `PomadeApi` above is the single source of truth for every channel's signature.
// `ChannelMap` flattens it to `{ 'namespace.method': signature }` — keyed by the
// exact `namespace.method` string the `CH` constants hold — so the preload wiring
// (`invoke`/`makeEvent`/`makeTermEvent`) and main handlers (`defineHandler`) DERIVE
// their types from it. A handler whose parameter list or return type disagrees with
// `PomadeApi` is then a compile error, not a runtime surprise.

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I
) => void
  ? I
  : never

/** `PomadeApi` flattened to `{ 'namespace.method': signature }`. The subscription
 *  methods (`on*` → `() => void`) and `env.home` (a value, not a method) are present
 *  too; only the invoke methods are ever looked up by `invoke`/`defineHandler`. */
export type ChannelMap = UnionToIntersection<
  {
    [N in keyof PomadeApi]: {
      [M in keyof PomadeApi[N] as `${N & string}.${M & string}`]: PomadeApi[N][M]
    }
  }[keyof PomadeApi]
>

// Ambient global so the renderer sees window.pomade everywhere.
declare global {
  interface Window {
    pomade: PomadeApi
  }
}
