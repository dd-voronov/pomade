// Pomade — preload. Exposes the typed window.pomade bridge (contextIsolation on).
// T-164 — the wiring is DERIVED from PomadeApi via three helpers, so the preload no
// longer restates each channel's signature by hand:
//   invoke(channel)          — a bound `ipcRenderer.invoke` caller typed as the channel's method
//   makeEvent(event)         — a broadcast subscription (main → all renderers); returns unsubscribe
//   makeTermEvent(event, …)  — a per-terminal subscription filtered by termId; returns unsubscribe
// A signature that disagrees with PomadeApi is a compile error (see ipc-api.ts ChannelMap).

import { homedir } from 'node:os'

import { contextBridge, ipcRenderer } from 'electron'

import { CH, EV } from '@shared/ipc-api'
import type { ChannelMap, PomadeApi, QuitRequest } from '@shared/ipc-api'
import type { GitSnapshot } from '@shared/git-state'
import type { GitRunSummary } from '@shared/git-runs'
import type { QueuedNotice } from 'pomade-kit/protocol'
import type {
  AppApiRequest,
  AppBadge,
  AppBusEvent,
  AppDelegatedServe,
  AppFilesChanged,
  AppScopeFoldersChanged,
  AppStateChanged,
  AttachedEvent,
  AttachedEventPayload,
  FsChangedEvent,
  HostedApp,
  PtyAgentState
} from '@shared/types'

// ─── Typed IPC helpers (T-164) ────────────────────────────────────────────────

/** A bound caller for invoke `channel`, typed as PomadeApi's method for it. */
function invoke<K extends keyof ChannelMap>(
  channel: K
): ChannelMap[K] extends (...args: infer A) => infer R ? (...args: A) => R : never {
  return ((...args: unknown[]) => ipcRenderer.invoke(channel, ...args)) as never
}

/** Subscribe to a broadcast event (main → every renderer). The callback receives the
 *  event's payload args verbatim; returns an unsubscribe fn. Same on/removeListener
 *  bookkeeping as the hand-rolled wrappers it replaces (one listener per subscription). */
function makeEvent<A extends unknown[] = []>(
  event: string
): (cb: (...args: A) => void) => () => void {
  return (cb) => {
    const handler = (_e: unknown, ...args: A): void => cb(...args)
    ipcRenderer.on(event, handler as (...a: unknown[]) => void)
    return () => ipcRenderer.removeListener(event, handler as (...a: unknown[]) => void)
  }
}

/** Subscribe to a per-terminal event, filtered to `termId`. `project` maps the wire
 *  payload (which carries `termId`) to the callback's args, so each event's shape lives
 *  in exactly one place. Returns an unsubscribe fn.
 *
 *  T-168 — ONE shared `ipcRenderer.on` listener per channel, registered here at
 *  api-construction time (makeTermEvent is called exactly once per pty channel), dispatching
 *  over a per-`termId` callback set. Because the listener count is fixed at one-per-channel,
 *  N per-terminal subscriptions no longer add N `ipcRenderer.on` listeners: >10 terminals
 *  never trip MaxListenersExceededWarning, and one `pty:data` chunk runs a single Map lookup
 *  instead of N termId-comparing filter closures. The call sites and `project` adaptors are
 *  unchanged, and the observable subscription semantics are preserved: an emit reaches exactly
 *  the callbacks subscribed for its `termId`, and an unsubscribe removes exactly its own
 *  callback (dropping the whole set for a termId once its last callback leaves). */
function makeTermEvent<P extends { termId: string }, A extends unknown[]>(
  event: string,
  project: (payload: P) => A
): (termId: string, cb: (...args: A) => void) => () => void {
  const byTerm = new Map<string, Set<(...args: A) => void>>()
  ipcRenderer.on(event, ((_e: unknown, payload: P): void => {
    const cbs = byTerm.get(payload.termId)
    if (!cbs) return
    const args = project(payload)
    // Iterate a snapshot so a callback that unsubscribes (or subscribes) mid-dispatch cannot
    // perturb THIS emit's delivery — the pre-T-168 model (one EventEmitter listener each) had
    // that for free, since EventEmitter emits over a copy of its listener array.
    for (const cb of [...cbs]) cb(...args)
  }) as (...a: unknown[]) => void)
  return (termId, cb) => {
    let cbs = byTerm.get(termId)
    if (!cbs) {
      cbs = new Set()
      byTerm.set(termId, cbs)
    }
    cbs.add(cb)
    return () => {
      const set = byTerm.get(termId)
      if (!set) return
      set.delete(cb)
      if (set.size === 0) byTerm.delete(termId)
    }
  }
}

// ─── The bridge ───────────────────────────────────────────────────────────────

/** E-034 — attached-tab events: one `ipcRenderer` listener, dispatched by tab id (as makeTermEvent
 *  does for terminals). */
const attachedListeners = new Map<string, Set<(event: AttachedEvent) => void>>()
ipcRenderer.on(EV.attachedEvent, (_e, payload: AttachedEventPayload) => {
  for (const cb of [...(attachedListeners.get(payload.tabId) ?? [])]) cb(payload.event)
})
function onAttachedEvent(tabId: string, cb: (event: AttachedEvent) => void): () => void {
  let set = attachedListeners.get(tabId)
  if (!set) {
    set = new Set()
    attachedListeners.set(tabId, set)
  }
  set.add(cb)
  return () => {
    const current = attachedListeners.get(tabId)
    if (!current) return
    current.delete(cb)
    if (current.size === 0) attachedListeners.delete(tabId)
  }
}

const api: PomadeApi = {
  workspace: {
    pick: invoke(CH.workspace.pick),
    get: invoke(CH.workspace.get),
    saveConfig: invoke(CH.workspace.saveConfig),
    // E-006 (T-027) — pickRoot only RETURNS a path; change commits the switch.
    pickRoot: invoke(CH.workspace.pickRoot),
    change: invoke(CH.workspace.change)
  },
  state: {
    load: invoke(CH.state.load),
    save: invoke(CH.state.save),
    // T-156 — delete a project's per-project state file on teardown.
    remove: invoke(CH.state.remove),
    onAppScopeFolders: makeEvent<[change: AppScopeFoldersChanged]>(EV.appScopeFolders)
  },
  workspaceUi: {
    load: invoke(CH.workspaceUi.load),
    save: invoke(CH.workspaceUi.save)
  },
  fs: {
    tree: invoke(CH.fs.tree),
    read: invoke(CH.fs.read),
    write: invoke(CH.fs.write),
    createFile: invoke(CH.fs.createFile),
    createDir: invoke(CH.fs.createDir),
    exists: invoke(CH.fs.exists),
    copyDir: invoke(CH.fs.copyDir),
    // Wave 2a additions
    watch: invoke(CH.fs.watch),
    unwatch: invoke(CH.fs.unwatch),
    onChanged: makeEvent<[e: FsChangedEvent]>(EV.fsChanged),
    pickPath: invoke(CH.fs.pickPath),
    // E-008 (T-033) — unconstrained image picker; copies external images into .pomade/assets.
    pickImage: invoke(CH.fs.pickImage),
    readDataUrl: invoke(CH.fs.readDataUrl),
    stat: invoke(CH.fs.stat),
    // E-001 (T-010) — collision-safe file copies.
    duplicate: invoke(CH.fs.duplicate),
    copyTo: invoke(CH.fs.copyTo),
    // E-004 (T-020) — collision-refusing rename/move.
    rename: invoke(CH.fs.rename),
    // E-012 — file-manager move / copy / trash for the tree.
    move: invoke(CH.fs.move),
    copy: invoke(CH.fs.copy),
    trash: invoke(CH.fs.trash),
    // E-012 (final) — resolve a symlink target for the popover.
    linkTarget: invoke(CH.fs.linkTarget),
    // E-014 — workspace frontmatter index for the properties-panel autocomplete.
    frontmatterIndex: invoke(CH.fs.frontmatterIndex),
    // E-020 (T-086) — terminal file-link resolution.
    probePath: invoke(CH.fs.probePath),
    findByName: invoke(CH.fs.findByName),
    findByStem: invoke(CH.fs.findByStem),
    findDirsBySuffix: invoke(CH.fs.findDirsBySuffix),
    findFilesBySuffix: invoke(CH.fs.findFilesBySuffix),
    // T-102 (E-021) — outside-workspace read / write / stat for one absolute path.
    readOutside: invoke(CH.fs.readOutside),
    writeOutside: invoke(CH.fs.writeOutside),
    statOutside: invoke(CH.fs.statOutside),
    // T-131 (E-026) — outside-workspace mount door: tree read + bounded recursive watcher.
    // Watch events arrive on the same fs.onChanged subscription, keyed by the absolute root path.
    treeOutside: invoke(CH.fs.treeOutside),
    watchOutside: invoke(CH.fs.watchOutside),
    unwatchOutside: invoke(CH.fs.unwatchOutside),
    // T-133 (E-026) — outside-workspace write doors (each on absolute path(s)).
    createFileOutside: invoke(CH.fs.createFileOutside),
    createDirOutside: invoke(CH.fs.createDirOutside),
    renameOutside: invoke(CH.fs.renameOutside),
    duplicateOutside: invoke(CH.fs.duplicateOutside),
    moveOutside: invoke(CH.fs.moveOutside),
    copyOutside: invoke(CH.fs.copyOutside),
    trashOutside: invoke(CH.fs.trashOutside),
    // E-035 — the open-doc watcher (rule 8).
    watchDocs: invoke(CH.fs.watchDocs),
    onDocChanged: makeEvent<[path: string]>(EV.fsDocChanged)
  },
  // E-035 — unsaved-doc recovery copies + discarded drafts.
  recovery: {
    put: invoke(CH.recovery.put),
    get: invoke(CH.recovery.get),
    remove: invoke(CH.recovery.remove),
    keepDraft: invoke(CH.recovery.keepDraft),
    drafts: invoke(CH.recovery.drafts),
    discardedFiles: invoke(CH.recovery.discardedFiles),
    markRestored: invoke(CH.recovery.markRestored),
    forgetDiscarded: invoke(CH.recovery.forgetDiscarded)
  },
  // E-044 — local history snapshots.
  localHistory: {
    list: invoke(CH.localHistory.list),
    read: invoke(CH.localHistory.read),
    keep: invoke(CH.localHistory.keep),
    previewPurge: invoke(CH.localHistory.previewPurge),
    purge: invoke(CH.localHistory.purge),
    previewCap: invoke(CH.localHistory.previewCap),
    onChanged: makeEvent<[path: string]>(EV.localHistoryChanged)
  },
  app: {
    version: invoke(CH.app.version),
    openPath: invoke(CH.app.openPath),
    // E-012 (final) — reveal an absolute path in the OS file manager.
    showItemInFolder: invoke(CH.app.showItemInFolder),
    // E-020 (T-086) — open an http/https URL in the default browser.
    openExternal: invoke(CH.app.openExternal),
    onFlush: makeEvent(EV.appFlush),
    // WAVE4 — renderer → main ack (a send, not an invoke).
    flushAck: () => ipcRenderer.send(CH.app.flushed),
    // T-036 — app-menu accelerator events (Cmd+W / Cmd+T).
    onCloseActiveTab: makeEvent(EV.tabsCloseActive),
    onNewTerminalTab: makeEvent(EV.tabsNewTerminal),
    // T-149 — Cmd+Shift+T app-menu accelerator (reopen closed tab).
    onReopenClosedTab: makeEvent(EV.tabsReopenClosed),
    // E-006 (T-026/T-027) — app-menu events (Cmd+, / Change Workspace…).
    onOpenSettings: makeEvent(EV.openSettings),
    onChangeWorkspace: makeEvent(EV.changeWorkspace),
    // E-002 (T-015) — app-level editor settings.
    getSettings: invoke(CH.app.getSettings),
    setSettings: invoke(CH.app.setSettings),
    // E-001 (T-011) — clipboard via Electron main.
    clipboardRead: invoke(CH.app.clipboardRead),
    clipboardWrite: invoke(CH.app.clipboardWrite),
    // E-001 (T-012) — Cmd+F app-menu accelerator (open in-document find).
    onEditorFind: makeEvent(EV.editorFind),
    // T-081 — sleep-resume / screen-unlock from powerMonitor.
    onWake: makeEvent(EV.appWake),
    // T-083 — spell context of the most recent right-click + native spellchecker actions.
    onSpellContext: makeEvent<[ctx: { misspelledWord: string; suggestions: string[] }]>(
      EV.spellContext
    ),
    replaceMisspelling: invoke(CH.app.replaceMisspelling),
    addToDictionary: invoke(CH.app.addToDictionary),
    // E-007 (T-030) — Cmd+B app-menu accelerator (toggle the Projects panel).
    onToggleProjectsPanel: makeEvent(EV.toggleProjectsPanel),
    // T-049 — Cmd+Shift+B app-menu accelerator (toggle the file-tree column).
    onToggleFileTree: makeEvent(EV.toggleFileTree),
    // T-098 — quit confirmation: main asks, the renderer's dialogs answer.
    onConfirmQuit: makeEvent<[req: QuitRequest]>(EV.confirmQuit),
    confirmQuit: invoke(CH.app.confirmQuit)
  },
  // WAVE2B: `pty` and `agents` namespaces.
  pty: {
    // T-115 — `presetInput` rides along: text pre-typed into the fresh shell without a CR.
    // T-116 — `snapshotKey` (tab id) opts into scrollback persistence; `replaySnapshot` asks main
    // to load that snapshot for the attach paint (revive only).
    create: invoke(CH.pty.create),
    write: invoke(CH.pty.write),
    resize: invoke(CH.pty.resize),
    kill: invoke(CH.pty.kill),
    sendExit: invoke(CH.pty.sendExit),
    buffer: invoke(CH.pty.buffer),
    // T-116 (E-022) — the attach paint (restored scrollback + divider + ring buffer).
    replay: invoke(CH.pty.replay),
    // T-116 (E-022) — forget one TAB's scrollback snapshot (tab id, not termId).
    forgetSnapshot: invoke(CH.pty.forgetSnapshot),
    list: invoke(CH.pty.list),
    // E-020 (T-086) — the shell's current working directory (link-resolution base).
    cwd: invoke(CH.pty.cwd),
    onData: makeTermEvent(EV.ptyData, (p: { termId: string; data: string }): [string] => [p.data]),
    onExit: makeTermEvent(
      EV.ptyExit,
      (p: { termId: string; exitCode: number }): [number] => [p.exitCode]
    ),
    // T-044 — foreground-busy state changes for a terminal.
    onBusy: makeTermEvent(
      EV.ptyBusy,
      (p: { termId: string; busy: boolean }): [boolean] => [p.busy]
    ),
    // T-114 (E-022) — working-directory changes for a terminal.
    onCwd: makeTermEvent(EV.ptyCwd, (p: { termId: string; cwd: string }): [string] => [p.cwd]),
    // T-115 (E-022) — a command was executed at this pty's shell, with main's roster verdict.
    onExec: makeTermEvent(
      EV.ptyExec,
      (p: {
        termId: string
        command: string
        agentLaunch: boolean
      }): [{ command: string; agentLaunch: boolean }] => [
        { command: p.command, agentLaunch: p.agentLaunch }
      ]
    ),
    // E-005 (T-024)
    onAgentExit: makeTermEvent(EV.ptyAgentExit, (_p: { termId: string }): [] => []),
    // E-005 (T-024, both ways). E-025 — the payload also carries `cwd` (the agent CLI's
    // cwd-at-launch, the session-store key).
    onAgentStart: makeTermEvent(
      EV.ptyAgentStart,
      (p: {
        termId: string
        agentId: string
        agentName: string
        command: string
        cwd: string
      }): [{ agentId: string; agentName: string; command: string; cwd: string }] => [
        { agentId: p.agentId, agentName: p.agentName, command: p.command, cwd: p.cwd }
      ]
    ),
    // E-011 — a terminal wants attention (turn-end bell/OSC-9·99·777 or a natural exit).
    onAttention: makeTermEvent(EV.ptyAttention, (_p: { termId: string }): [] => []),
    // T-113 (E-022) — the LIVE session id of the agent running in this pty. T-327 — and the parent
    // its new transcript records (a fork), or null.
    onSessionId: makeTermEvent(
      EV.ptySessionId,
      (p: { termId: string; sessionId: string; forkedFrom?: string }): [string, string | null] => [
        p.sessionId,
        p.forkedFrom ?? null
      ]
    ),
    // E-025 — a bind window for this term closed with no uniquely-attributable id.
    onSessionUnbound: makeTermEvent(EV.ptySessionUnbound, (_p: { termId: string }): [] => []),
    // E-025 — prompt-gated bind window + manual-bind ownership claim.
    armSessionWindow: invoke(CH.pty.armSessionWindow),
    claimSession: invoke(CH.pty.claimSession),
    // E-031 — the tab a term runs in (for `agentTab.exited`).
    setTab: invoke(CH.pty.setTab),
    // E-033 — every term's agent state changes (one global stream).
    onAgentState: makeEvent<[PtyAgentState]>(EV.ptyAgentState)
  },
  agents: {
    roster: invoke(CH.agents.roster),
    setCommand: invoke(CH.agents.setCommand),
    sessions: invoke(CH.agents.sessions),
    // E-025 — session-id validation (revive gate + the ⚠️ popover's manual bind).
    validateSession: invoke(CH.agents.validateSession)
  },
  // WAVE3: `git` namespace.
  git: {
    isRepo: invoke(CH.git.isRepo),
    fileDiff: invoke(CH.git.fileDiff),
    // E-036 — git state + deleted-file view/restore.
    state: invoke(CH.git.state),
    committedFile: invoke(CH.git.committedFile),
    restoreFile: invoke(CH.git.restoreFile),
    // E-037 — History pages, merge expansion, commit details.
    log: invoke(CH.git.log),
    unpushed: invoke(CH.git.unpushed),
    mergeCommits: invoke(CH.git.mergeCommits),
    commit: invoke(CH.git.commit),
    fileAt: invoke(CH.git.fileAt),
    fileLog: invoke(CH.git.fileLog),
    // E-039 — operations with safety rails.
    preview: invoke(CH.git.preview),
    run: invoke(CH.git.run),
    folderInfo: invoke(CH.git.folderInfo),
    initRepo: invoke(CH.git.initRepo),
    // E-040 — the conflict tab's reads.
    rebase: invoke(CH.git.rebase),
    conflictFile: invoke(CH.git.conflictFile),
    // E-041 — In progress and the branch tab.
    inProgress: invoke(CH.git.inProgress),
    branch: invoke(CH.git.branch),
    // E-042 — pomade-git runs and Runner's jobs.
    runs: invoke(CH.git.runs),
    runSeen: invoke(CH.git.runSeen),
    scheduled: invoke(CH.git.scheduled),
    onState: makeEvent<[snapshot: GitSnapshot]>(EV.gitState),
    onRuns: makeEvent<[runs: Record<string, GitRunSummary>]>(EV.gitRuns),
    onJobs: makeEvent(EV.gitJobs)
  },
  // E-027 — app hosting.
  apps: {
    list: invoke(CH.apps.list),
    refresh: invoke(CH.apps.refresh),
    openFrame: invoke(CH.apps.openFrame),
    closeFrame: invoke(CH.apps.closeFrame),
    call: invoke(CH.apps.call),
    pickFolder: invoke(CH.apps.pickFolder),
    setRoute: invoke(CH.apps.setRoute),
    onChanged: makeEvent<[apps: HostedApp[]]>(EV.appsChanged),
    onFilesChanged: makeEvent<[batch: AppFilesChanged]>(EV.appsFilesChanged),
    onBadge: makeEvent<[badge: AppBadge]>(EV.appsBadge),
    onStateChanged: makeEvent<[change: AppStateChanged]>(EV.appsStateChanged),
    onEvent: makeEvent<[event: AppBusEvent]>(EV.appsEvent),
    setActiveProject: invoke(CH.apps.setActiveProject),
    delegatedResult: invoke(CH.apps.delegatedResult),
    onServeDelegated: makeEvent<[serve: AppDelegatedServe]>(EV.appsServeDelegated),
    apiResponse: invoke(CH.apps.apiResponse),
    onApiRequest: makeEvent<[req: AppApiRequest]>(EV.appsApiRequest)
  },
  // E-031 — the event bus.
  events: {
    platform: invoke(CH.events.platform)
  },
  // E-032 — the closed-Pomade notice queue.
  attached: {
    open: invoke(CH.attached.open),
    close: invoke(CH.attached.close),
    input: invoke(CH.attached.input),
    paste: invoke(CH.attached.paste),
    resize: invoke(CH.attached.resize),
    stop: invoke(CH.attached.stop),
    action: invoke(CH.attached.action),
    onEvent: onAttachedEvent
  },
  notices: {
    attach: invoke(CH.notices.attach),
    onQueued: makeEvent<[notices: QueuedNotice[]]>(EV.noticesQueued)
  },
  // E-028 — the PATH line (Settings ▸ General).
  commands: {
    pathLine: invoke(CH.commands.pathLine),
    setPathLine: invoke(CH.commands.setPathLine)
  },
  // T-101 (E-021) — synchronous env snapshot (no IPC): the home dir, for `~`-relative header paths.
  env: {
    home: homedir()
  }
}

contextBridge.exposeInMainWorld('pomade', api)
