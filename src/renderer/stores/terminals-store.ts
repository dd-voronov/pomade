// Pomade — terminals-store (renderer). Wave 2b.
// Orchestration layer over the pty IPC + tabs-store. It NEVER owns tab arrays itself —
// it creates/relaunches PTYs and syncs the resulting TerminalTab metadata (termId, cwd,
// agentId, status, lastCommand, resumeSessionId) into tabs-store so .pomade/state restore
// works.
//
// T-114 (E-022) — RESTORE semantics. A restored tab whose PTY is gone is no longer flipped to a
// persisted 'dead' on pane mount: it becomes a REVIVE CANDIDATE (runtime-only `pendingRevive`)
// and its project's next OPEN either brings it back live (agent → resume command, terminal →
// fresh shell at its last known cwd) or persists an honest 'dead' (agent with no session id, a
// vanished roster agent, a spawn failure). A tab whose persisted status is already 'dead' never
// revives. See "Revive" below and docs/modules/terminal/panes-and-lifecycle.md.

import { create } from 'zustand'
import { nanoid } from 'nanoid'

import {
  AGENT_SESSION_COMMANDS,
  EXEC_MARKER_CAPS,
  type AgentInfo,
  type Id,
  type Project,
  type TerminalTab
} from '@shared/types'
import { useTabsStore } from './tabs-store'
import { useWorkspaceStore } from './workspace-store'
import { useUnboundStore } from './unbound-store'
import { useAgentLiveStore } from './agent-live-store'
import { useToastStore } from '../hooks/useToast'
import { DEFAULT_AGENT_MODE } from 'pomade-kit/protocol'

import { buildAgentCommand, matchSessionCommand, parseResumeId } from '../modules/terminal/agent-commands'
import {
  bindCause,
  forgetSessionCause,
  noteSessionCause,
  type BindTrigger
} from '../modules/agents/session-cause'

// termIds we asked to /exit — closed once their process actually ends.
const closeOnExit = new Set<string>()

// ─── E-025 — per-tab (re)bind cycle, renderer side ──────────────────────────────────
// The RUNTIME leg of the Spawned → AwaitingId → Bound/Unbound machine (the persisted leg is
// `TerminalTab.bindState` + `resumeSessionId` + `cwdAtLaunch`). A `bindPhase` entry means "this
// tab's NEXT first-prompt submit must open a bind window" — set at a fresh (id-less) agent
// launch and by the session commands (clear · fork · resume, slice 3), consumed by
// `handleSubmit`, dropped on a bind or an agent exit. Two structurally distinct modes (locked
// with the Owner 2026-08-19): 'await-new' WAITS for a NEW transcript to appear; 'adopt-existing'
// TAKES an existing one (in-session `/resume` — a known id validated on disk, or the existing
// file that starts growing). An 'await-new' phase remembers what asked for it (the launch, a
// clear or a fork command) — the evidence for the cause an app hears (T-327). Runtime-only,
// per-run — exactly like `pendingRevive` below.
type BindPhase = { kind: 'await-new'; trigger: 'launch' | 'clear' | 'fork' } | { kind: 'adopt-existing'; resumeId?: string }
const bindPhase = new Map<Id, BindPhase>()
// T-327 — what opened each tab's current bind window, read when the window binds.
const windowTrigger = new Map<Id, BindTrigger>()

// termIds created by THIS renderer session (new terminal / agent / relaunch). A fresh PTY
// is live by construction — its create() was awaited before the tab ever mounted — so
// reconcile must never consult the (possibly stale) liveness snapshot for it. This keeps
// the dead state reachable ONLY for tabs restored from a previous app run (T-023).
const sessionTermIds = new Set<string>()

// T-114 (E-022) — tabIds of tabs RESTORED with persisted `status: 'live'` whose PTY is gone
// (the app was restarted / the workspace was switched). Waiting for their project to be opened.
//
// This is deliberately RUNTIME-ONLY state — a module-level Set, exactly like `sessionTermIds`
// above, and NOT a field on the tab. The epic's sticky-payload invariant is what forces it: the
// persisted `status` must stay `'live'` until revive actually RESOLVES, because
//   (a) persisted status is the revive DISCRIMINATOR ("dead at quit stays dead" reads it), so
//       writing 'dead' on mount would destroy the very signal revive keys on, and
//   (b) a project that is never opened must round-trip its payloads byte-for-byte, and a
//       reconcile-to-dead write is exactly such a mutation (PaneHost mounts EVERY project's
//       panes at boot, so the old reconcile touched every restored tab of every project).
// Consequence: the marks are per-RUN. They are dropped on a workspace switch (its ptys are
// disposed and the tab caches are cleared — see the subscription at the bottom of this file).
const pendingRevive = new Set<Id>()

// Short-lived cache of pty.list() so a burst of pane mounts on startup doesn't spam IPC.
let listCache: { at: number; p: Promise<{ termId: string; alive: boolean }[]> } | null = null
function livenessList(): Promise<{ termId: string; alive: boolean }[]> {
  if (!listCache || Date.now() - listCache.at > 400) {
    listCache = { at: Date.now(), p: window.pomade.pty.list() }
  }
  return listCache.p
}

// E-005 user-test round 1 — tab-lifecycle PTY reaper. PTY reaping is driven by TABS, not
// by pane (un)mounts: React StrictMode (dev builds) unmounts+remounts every pane right
// after mount, so a kill-on-unmount effect in TerminalPane killed every freshly created
// PTY in `npm run dev` — all new terminals/agents opened dead (e2e drives the prod build,
// where StrictMode never double-invokes, so it stayed green). A PTY is reaped exactly when
// no tab references its termId any more: tab closed (any path), or termId swapped by a
// relaunch. A live→dead status flip keeps the termId, so the ring buffer survives for the
// dead pane; killing an already-dead entry just drops it from the main-process map.
let reapKnownTermIds = new Set<string>()
useTabsStore.subscribe((state) => {
  const now = new Set<string>()
  for (const tabs of Object.values(state.tabsByProject)) {
    for (const t of tabs) {
      if (t.kind === 'terminal' || t.kind === 'agent') now.add(t.termId)
    }
  }
  for (const termId of reapKnownTermIds) {
    if (!now.has(termId)) void window.pomade.pty.kill(termId)
  }
  reapKnownTermIds = now
})

// T-116 (E-022) — "when I close it, we forget about the state": the SNAPSHOT forgetter, the
// tab-lifecycle twin of the PTY reaper above. It has to be keyed on TAB ids (that is what a
// snapshot file is named after), which is also why it cannot ride on the reaper's termId diff: a
// relaunch swaps the termId while the tab — and its scrollback — lives on.
//
// One diff covers every close path (×, Cmd+W, context Close/Close others/Close to the right,
// bulk Stop all terminals, a batch close, a project deletion), and a cross-project MOVE keeps the
// tab id, so a moved tab's snapshot simply follows it — no special case.
//
// The `hydratedProjects` guard is the load-bearing part. A tab id also "disappears" when a
// project's tab cache is dropped WHOLESALE — a workspace switch clears `tabsByProject` **and**
// `hydratedProjects` in one atomic set (workspace-store) — and deleting files then would destroy
// the snapshots of tabs that are still very much open in the workspace we just left (main's root
// has already moved on, so the delete would even target the wrong workspace). A cache drop
// therefore forgets nothing; only a tab vanishing from a project that is STILL hydrated is a
// close.
//
// T-149 — DEFERRED forget. A closed tab's id no longer leaves the world the instant it leaves
// openTabs: it sits on its project's reopen stack, and its snapshot is the scrollback a reopen
// REPLAYS. So the "still protected" set is the UNION of (a) every terminal/agent tab in openTabs
// and (b) every terminal/agent entry on any hydrated project's reopen stack. A snapshot is
// forgotten exactly when its id leaves that union in a still-hydrated project — which is precisely
// the moment the entry permanently leaves the stack (cap eviction at REOPEN_STACK_CAP, a
// vanished-doc drop — a no-op for a doc, which owns no snapshot — or any future explicit clear),
// AND the tab is not open. Reopen (stack → openTabs) keeps the id in the union, so the snapshot
// survives for the replay. `knownProtected` tracks the previous union so a departure is detectable
// even for an id that left openTabs many ticks ago (the evicted-from-stack case).
let knownProtected = new Map<Id, Id>() // tabId → projectId
useTabsStore.subscribe((state) => {
  const now = new Map<Id, Id>()
  for (const [projectId, tabs] of Object.entries(state.tabsByProject)) {
    for (const t of tabs) {
      if (t.kind === 'terminal' || t.kind === 'agent') now.set(t.id, projectId)
    }
  }
  for (const [projectId, stack] of Object.entries(state.reopenStackByProject)) {
    for (const e of stack) {
      if (e.tab.kind === 'terminal' || e.tab.kind === 'agent') now.set(e.tab.id, projectId)
    }
  }
  for (const [tabId, projectId] of knownProtected) {
    if (now.has(tabId)) continue
    // The hydratedProjects guard stays load-bearing: a WHOLESALE cache drop (workspace switch)
    // clears tabsByProject AND reopenStackByProject AND hydratedProjects in one atomic set, so an
    // id that vanished because its project is no longer hydrated forgets nothing (main's root has
    // moved on — a delete would even target the wrong workspace).
    if (!state.hydratedProjects[projectId]) continue
    void window.pomade.pty.forgetSnapshot(tabId)
  }
  knownProtected = now
})

function tabsOf(projectId: Id): TerminalTab[] {
  return (useTabsStore.getState().tabsByProject[projectId] ?? []).filter(
    (t): t is TerminalTab => t.kind === 'terminal' || t.kind === 'agent'
  )
}

/** T-299 — a bulk close waiting on the user: which action, in which project, and the busy tabs it
 *  would close (their titles feed the confirm's copy). */
export interface BulkCloseRequest {
  action: 'stop-terminals' | 'exit-agents'
  projectId: Id
  busyTitles: string[]
}

/** T-299 — the tabs a bulk action would close that hold work in progress, by the same rule the
 *  per-tab close guard uses: a live plain terminal is busy while a foreground command runs (main's
 *  shell-integration flag, `pty.list()`); a live agent is busy while it is mid-turn — working, or
 *  waiting at a permission prompt (`agent-live-store`). An idle agent at its prompt is not busy:
 *  `/exit` is exactly the clean end the action asks for. */
async function busyTargets(projectId: Id, action: BulkCloseRequest['action']): Promise<TerminalTab[]> {
  if (action === 'exit-agents') {
    const states = useAgentLiveStore.getState().states
    return tabsOf(projectId).filter((t) => {
      if (t.kind !== 'agent' || t.status !== 'live') return false
      const state = states[t.termId]
      return state === 'working' || state === 'needs-you'
    })
  }
  const candidates = tabsOf(projectId).filter((t) => t.kind === 'terminal' && t.status === 'live')
  if (candidates.length === 0) return []
  const busy = new Set((await window.pomade.pty.list()).filter((e) => e.alive && e.busy).map((e) => e.termId))
  return candidates.filter((t) => busy.has(t.termId))
}

async function killAllTerminals(projectId: Id): Promise<void> {
  const tabsStore = useTabsStore.getState()
  for (const tab of tabsOf(projectId)) {
    if (tab.kind !== 'terminal') continue
    await window.pomade.pty.kill(tab.termId)
    tabsStore.closeTab(projectId, tab.id)
  }
  useToastStore.getState().push('Stopped all terminals')
}

async function exitLiveAgents(projectId: Id): Promise<void> {
  for (const tab of tabsOf(projectId)) {
    if (tab.kind !== 'agent' || tab.status !== 'live') continue
    const { termId } = tab
    closeOnExit.add(termId)
    await window.pomade.pty.sendExit(termId)
    // `/exit` quits the agent CLI but returns control to the host zsh (still alive).
    // Give the agent time to shut down cleanly, then reap the leftover shell so the
    // tab closes ("...then closes when the process ends").
    setTimeout(() => {
      if (closeOnExit.has(termId)) void window.pomade.pty.kill(termId)
    }, 1200)
  }
  useToastStore.getState().push('Sent /exit to all agents')
}

const runBulkClose = (action: BulkCloseRequest['action'], projectId: Id): Promise<void> =>
  action === 'stop-terminals' ? killAllTerminals(projectId) : exitLiveAgents(projectId)

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** T-114 — where a revived tab's fresh PTY starts.
 *
 *  `TerminalTab.cwd` is the tab's LAST KNOWN working directory: workspace-relative at creation
 *  (the project's `rootPath`), absolute once the shell's prompt marker has reported a `$PWD`
 *  (T-086 + this task's `pty:cwd` persistence). Both forms are accepted — `fs.probePath` resolves
 *  a relative input against the workspace root, which is the same base `pty.create` would use.
 *
 *  A directory that VANISHED since the previous run falls back to the PROJECT root, so deleting a
 *  folder can never make a tab unrevivable. (main's `resolveCwd` has its own statSync net so
 *  `pty.create` cannot fail on a stale cwd at all; this probe is what makes the fallback land on
 *  the project root rather than main's generic workspace-root fallback.) */
async function reviveCwd(tab: TerminalTab, project: Project | undefined): Promise<string> {
  const wsRoot = useWorkspaceStore.getState().root ?? ''
  const fallback = project?.rootPath ? `${wsRoot}/${project.rootPath}` : wsRoot
  if (!tab.cwd) return fallback
  try {
    const probe = await window.pomade.fs.probePath(tab.cwd, wsRoot)
    if (probe && !probe.isFile) return probe.abs // isFile === false ⇒ a directory
  } catch {
    /* probe failed (no workspace root yet) — use the project root */
  }
  return fallback
}

/** E-025 (slice 4) — where a revived AGENT tab's resume must run: the tab's cwd-AT-LAUNCH, not
 *  its live last-known cwd. The provider's session store is keyed on the directory the CLI ran
 *  in — a `cd` after launch moves `tab.cwd` but NOT the store, so resuming at the live cwd made
 *  the CLI (and the E-025 watcher) look in the WRONG store whenever the two diverged (the
 *  subfolder capture-miss, T-127 §subfolder). Pre-E-025 tabs have no `cwdAtLaunch` and fall back
 *  to the live-cwd chain (their two values were rarely apart — best available information). */
async function agentReviveCwd(tab: TerminalTab, project: Project | undefined): Promise<string> {
  if (tab.cwdAtLaunch) {
    const wsRoot = useWorkspaceStore.getState().root ?? ''
    try {
      const probe = await window.pomade.fs.probePath(tab.cwdAtLaunch, wsRoot)
      if (probe && !probe.isFile) return probe.abs
    } catch {
      /* vanished launch dir — fall through to the live-cwd chain */
    }
  }
  return reviveCwd(tab, project)
}

/** T-115 (E-022) — the text a revived shell may safely be handed, or `undefined`.
 *
 *  TRUNCATION GUARD. The shim's preexec payload is capped (`printf '%.Ns'`), so a command line
 *  whose byte length equals a cap EXACTLY was probably cut mid-word — and pre-typing half a command
 *  invites the user to press Enter on a corrupted line (`rm -rf /some/pa`). Such a payload is still
 *  captured and persisted (it is the honest record of what ran); it is simply never pre-typed, and
 *  silently so: an explanation the user cannot act on is noise. Both known caps are rejected —
 *  a STALE shim from an older app run keeps emitting the old 160 (see `EXEC_MARKER_CAPS`).
 *
 *  A payload containing CR/LF is rejected for a harder reason: `preexec` reports a MULTI-LINE
 *  command verbatim, and typing a newline into a line editor SUBMITS it. "Never run it" outranks
 *  "restore it", so a multi-line command is captured and dropped at pre-type time too. */
function pretypeableExec(lastExec: string | undefined): string | undefined {
  if (!lastExec) return undefined
  if (/[\r\n]/.test(lastExec)) return undefined
  if (EXEC_MARKER_CAPS.includes(new TextEncoder().encode(lastExec).length)) return undefined
  return lastExec
}

/** T-114 — bring ONE pending tab back, or persist the honest 'dead'. Carries every restore
 *  payload forward untouched (`resumeSessionId`, `cwd`, `lastExec`, title, color, `renamed`,
 *  `attention`…): revive only swaps `termId`, confirms `status`, and — for an agent — records the
 *  resume command it actually launched in `lastCommand` (same as the dead pane's Resume button
 *  does). T-115: a terminal's `lastExec` is READ here to pre-type it, and deliberately not written —
 *  pre-typed text is never executed, so it is never re-captured, which is what makes the field
 *  survive any number of reloads that don't run anything. */
async function reviveTab(
  projectId: Id,
  tab: TerminalTab,
  roster: AgentInfo[],
  project: Project | undefined
): Promise<void> {
  const markDead = (): void => {
    useTabsStore.getState().updateTab(projectId, tab.id, { status: 'dead' })
  }
  let command: string | undefined
  let agentCwd: string | undefined
  if (tab.kind === 'agent') {
    const agent = roster.find((a) => a.id === tab.agentId)
    // Grooming decision (E-022): an agent tab with NO captured session id — or whose roster entry
    // has since disappeared — becomes a dead pane, exactly as before this task. Auto-starting a
    // FRESH agent would look resumed while carrying empty context: silently misleading. This is
    // the moment the honest, persisted 'dead' is finally written; the session id is KEPT (a stale
    // one is harmless to retry — `--resume` of a live store appends to the same id, T-112).
    if (!agent || !tab.resumeSessionId) {
      markDead()
      return
    }
    // E-025 (slice 4) — resume runs at the tab's cwd-AT-LAUNCH (the store key), and the known
    // id is VALIDATED against that store before anything spawns: a transcript the disk can't
    // back (cleaned store, `.pomade` synced from another machine, a mis-keyed legacy bind)
    // becomes an honest dead pane — with the id KEPT, so the Resume button still offers the
    // retry — instead of a CLI resume error dressed up as a live session.
    agentCwd = await agentReviveCwd(tab, project)
    let exists = false
    try {
      exists = await window.pomade.agents.validateSession(
        tab.agentId ?? '',
        agentCwd,
        tab.resumeSessionId
      )
    } catch {
      /* validation unavailable — treat as missing (never trust an id the disk can't back) */
    }
    if (!exists) {
      markDead()
      return
    }
    command = buildAgentCommand(agent, tab.resumeSessionId)
  }
  // A terminal tab gets a PLAIN shell — its `lastCommand` (if any) is NOT re-run. Re-running a
  // build or a test suite because the app restarted is not what "restore my state" means.
  // T-115 — instead, its last EXECUTED command is pre-typed into the fresh shell, unsubmitted, so
  // the user decides whether it runs. Terminals only: an agent tab's input belongs to its CLI (and
  // its shell is busy running the resume command anyway), so `presetInput` is never sent for one.
  const presetInput = tab.kind === 'terminal' ? pretypeableExec(tab.lastExec) : undefined
  const cwd = agentCwd ?? (await reviveCwd(tab, project))
  try {
    const { termId } = await window.pomade.pty.create({
      cwd,
      tabId: tab.id,
      projectId,
      ...(command ? { command } : {}),
      ...(presetInput ? { presetInput } : {}),
      // T-116 (E-022) — this is THE replay moment: a revived plain terminal repaints its persisted
      // scrollback above a `── session restored ──` divider, then the fresh shell's own output
      // (and T-115's pre-typed command) land below it. Agent tabs pass neither flag — they never
      // snapshot and never replay (the CLI's own `--resume` redraw IS their restore).
      ...(tab.kind === 'terminal' ? { snapshotKey: tab.id, replaySnapshot: true } : {})
    })
    // T-023 — a freshly created PTY is live by construction and must never be reconciled.
    sessionTermIds.add(termId)
    // ONE updateTab: the tab-lifecycle reaper diffs the termId SET, so the swap reaps the old
    // (already-gone) termId in the same tick, exactly as a Relaunch does.
    useTabsStore.getState().updateTab(projectId, tab.id, {
      termId,
      status: 'live',
      ...(command ? { lastCommand: command } : {})
    })
  } catch {
    // Spawn refused (no shell, unreadable cwd chain, …) — the tab is honestly dead.
    markDead()
  }
}

// E-001 (T-010/T-011) — after launching an agent pty, wait until it's actually accepting
// input (the interactive zsh has drawn output and the agent CLI has had a beat to grab
// stdin), then SUBMIT the file-context instruction. When `typeText` is given, TYPE it into
// the agent's input WITHOUT a trailing CR so it sits there unsubmitted (the selection the
// user can then edit and send). Best-effort timing — the marker-based readiness signals are
// agent-specific; a fixed settle after first output is robust enough for this hand-off.
async function sendAgentContext(
  termId: string,
  instruction: string,
  typeText?: string
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < 15000) {
    const buf = await window.pomade.pty.buffer(termId)
    if (buf && buf.length > 0) break
    await delay(150)
  }
  await delay(700)
  await window.pomade.pty.write(termId, `${instruction}\r`)
  if (typeText) {
    await delay(250)
    await window.pomade.pty.write(termId, typeText) // no trailing CR — unsubmitted
  }
}

/** E-033 — submit a launch prompt as the agent's first prompt, once it is accepting input (the
 *  same readiness wait as `sendAgentContext`). A multi-line prompt is sent as one bracketed paste,
 *  so its line breaks do not submit it early. Pomade typed it into this tab, so it arms the tab's
 *  session binding exactly like a prompt the user submits (`handleSubmit`). */
async function sendAgentPrompt(termId: string, prompt: string): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < 15000) {
    const buf = await window.pomade.pty.buffer(termId)
    if (buf && buf.length > 0) break
    await delay(150)
  }
  await delay(700)
  const multiline = /[\r\n]/.test(prompt)
  await window.pomade.pty.write(termId, multiline ? `\x1b[200~${prompt}\x1b[201~` : prompt)
  if (multiline) await delay(100)
  await window.pomade.pty.write(termId, '\r')
  const loc = tabLocByTermId(termId)
  if (loc) useTerminalsStore.getState().handleSubmit(loc.projectId, loc.tabId, prompt.split(/\r?\n/)[0].trim())
}

/** E-033 — true for a term this run created (a launch, relaunch or revive): its agent tab is live
 *  from the start. A restored tab whose term is from an earlier run has no agent process yet. */
export function isRunTerm(termId: string): boolean {
  return sessionTermIds.has(termId)
}

interface TerminalsState {
  /** Open a plain interactive-zsh terminal at the project root. T-036: `opts.afterTabId`
   * inserts the new tab immediately right of that tab (Cmd+T) instead of appending. */
  newTerminal: (project: Project, opts?: { afterTabId?: Id }) => Promise<void>
  /** E-030 — a plain terminal in `cwd` (workspace-relative) that types and runs `command` once
   *  the shell is ready (Relaunch re-runs it). Opens right of the active tab; titled `title`,
   *  else the command, else the shell's numbered title. */
  newCommandTerminal: (
    projectId: Id,
    opts: { cwd: string; command?: string; title?: string }
  ) => Promise<void>
  /** Start an agent (pty.create with the agent command); optionally resuming a session. E-033 —
   *  `opts.cwd` (workspace-relative; default the project's folder), a roster `mode` (default
   *  normal; a resume runs normal), and a first `prompt` submitted once the agent is ready.
   *  Resolves with the new tab's id. */
  startAgent: (
    project: Project,
    agent: AgentInfo,
    resumeSessionId?: string,
    opts?: { cwd?: string; mode?: string; prompt?: string }
  ) => Promise<Id>
  /** E-001 (T-010/T-011) — start an agent, then submit a file-context instruction and,
   *  optionally, type `typeText` into its input WITHOUT submitting it. */
  startAgentWithContext: (
    project: Project,
    agent: AgentInfo,
    opts: { instruction: string; typeText?: string }
  ) => Promise<void>
  /** Re-run a dead tab's shell/agent command in a fresh PTY, in place. */
  relaunch: (projectId: Id, tabId: Id) => Promise<void>
  /** Bulk: kill + close every plain terminal in the project. When any of them is busy it asks
   *  first instead (T-299): sets `bulkClose` and closes nothing until `confirmBulkClose`. */
  stopAllTerminals: (projectId: Id) => Promise<void>
  /** Bulk: /exit every live agent in the project (closes each when its process ends). When any
   *  of them is mid-turn it asks first instead (T-299), like `stopAllTerminals`. */
  exitAllAgents: (projectId: Id) => Promise<void>
  /** T-299 — the bulk close the confirm is asking about; null when none is pending. */
  bulkClose: BulkCloseRequest | null
  /** T-299 — run the pending bulk close (re-reading the project's tabs now) and clear it. */
  confirmBulkClose: () => Promise<void>
  /** T-299 — drop the pending bulk close; nothing closes. */
  cancelBulkClose: () => void
  /** A tab's PTY exited: mark it dead, and close it if it was a pending /exit. */
  handlePtyExit: (projectId: Id, tabId: Id, termId: string) => void
  /** T-024 — the agent CLI exited back to the (still-live) host shell: downgrade the tab
   * to a plain terminal, restoring shell naming unless the user renamed it. */
  handleAgentExit: (projectId: Id, tabId: Id) => void
  /** T-024, both ways — a roster agent command was typed into the tab's (shimmed) shell:
   * upgrade the tab back to an agent tab, keeping a user-set title ([[T-021]] flag).
   * E-025 — the payload's `cwd` (the shell's directory at the exec marker = the CLI's
   * cwd-AT-LAUNCH) is persisted as `cwdAtLaunch` on BOTH launch paths: the event fires for a
   * button-launched agent tab too (previously a pure no-op there) and stamps the triple. */
  handleAgentStart: (
    projectId: Id,
    tabId: Id,
    agent: { agentId: string; agentName: string; command: string; cwd: string }
  ) => void
  /** T-113 (E-022) — main captured the LIVE session id of the agent running in this tab's pty.
   * E-025: this is now the BIND outcome of a prompt-gated window (or an explicit resume/claim)
   * — never a recency guess. Stamps `resumeSessionId` + `bindState: 'bound'`. */
  handleSessionId: (projectId: Id, tabId: Id, sessionId: string, forkedFrom?: string | null) => void
  /** E-025 — a bind window for this tab closed with NO uniquely-attributable id (nothing
   * appeared, or a submit-order tie forced a refusal). Marks the tab `bindState: 'unbound'`
   * (the ⚠️ affordance); the tab keeps working and rebinds on the next (re)bind cycle. */
  handleSessionUnbound: (projectId: Id, tabId: Id) => void
  /** E-025 — a first-prompt SUBMIT in this tab (genuine-input signal: xterm onKey Enter on a
   * non-empty since-last-submit line, NEVER onData/pty output — T-123). The load-bearing
   * signal of the whole attribution design: it names the tab AND bounds the id search. Opens
   * the tab's bind window when one is due; recognizes the per-agent rebind commands. */
  handleSubmit: (projectId: Id, tabId: Id, line: string) => void
  /** E-025 slice 5 — the ⚠️ popover's MANUAL bind: validate `sessionId` against the tab's
   * expected store (cwd-at-launch keyed) and bind ONLY if the transcript exists there — a
   * nonexistent id is refused (resolves false), never bound (its resume would fail). On
   * success the id is claimed in main (ownership) and the tab becomes Bound. */
  bindSessionManually: (projectId: Id, tabId: Id, sessionId: string) => Promise<boolean>
  /** E-025 slice 5 — the ⚠️ popover's "Ignore": silence the mark for THIS unbound session
   * only. The tab STAYS in the state machine (a later /clear / exit-restart / retry submit
   * rebinds it); the only consequence of staying unbound is no auto-resume after a restart. */
  silenceUnbound: (projectId: Id, tabId: Id) => void
  /** T-114 (E-022) — the shell in this tab's pty reported a NEW working directory (a `cd`, or its
   *  very first prompt). Persists it onto the tab so a revive after a reload starts where the user
   *  left off. Live tabs only, and only on an actual change — like `handleSessionId`, this is a
   *  LIVE-PTY signal, the only kind allowed to overwrite a restore payload (sticky invariant). */
  handleCwd: (projectId: Id, tabId: Id, cwd: string) => void
  /** T-115 (E-022) — the shell in this tab's pty EXECUTED a command (the shim's preexec marker).
   *  Stamps it as `lastExec` so the next revive pre-types it, unsubmitted. PLAIN TERMINAL tabs
   *  only, and never the agent-launch command itself (`agentLaunch` is main's roster verdict —
   *  see the guard). A live-PTY signal, the only class allowed to overwrite a restore payload. */
  handleExec: (projectId: Id, tabId: Id, payload: { command: string; agentLaunch: boolean }) => void
  /** T-056 / T-151 — this tab's pty raised an attention event (turn-end bell / OSC-9·99·777
   *  notification, or a natural pty exit). Sets the tab's unread dot (persisted via updateTab),
   *  which the Projects panel tallies live. The dot is NOT set on the active tab of the active project,
   *  and a repeat on an already-dotted tab stays a single unread (the dot IS the count). */
  handleAttention: (projectId: Id, tabId: Id) => void
  /** On (re)mount of a supposedly-live tab, verify its PTY still exists; if it's gone the tab
   *  becomes a REVIVE CANDIDATE (T-114) instead of being flipped to a persisted 'dead'. */
  reconcile: (projectId: Id, tab: TerminalTab) => Promise<void>
  /** T-114 (E-022) — the revive engine, triggered by a PROJECT OPEN (the boot-time active project
   *  counts as opened at boot). Brings every pending tab of `projectId` back: an agent with a
   *  captured session id re-enters its conversation via the provider's resume command, a terminal
   *  gets a fresh shell at its last known cwd, and an agent without an id (or a failed spawn)
   *  becomes an honest dead pane. Idempotent — the pending marks are CLAIMED synchronously, so
   *  re-opening the project later is a no-op and a concurrent reconcile can never double-spawn. */
  reviveProject: (projectId: Id) => Promise<void>
  /** T-149 — reopen the most-recently closed tab of `projectId` (undo-close). Pops the reopen
   *  stack, re-inserting the tab at its ORIGINAL index (clamped) and making it active, and brings
   *  it back with the SAME app-restart revive semantics — reusing `reviveTab` unchanged:
   *    • doc     — re-added from disk (mode/richView/color kept). An OUTSIDE-workspace doc whose
   *                file has vanished is silently DROPPED and the next entry is tried, matching
   *                hydration's prune; an in-workspace doc is always re-added (the editor shows its
   *                own "no longer exists" notice, as hydration leaves it).
   *    • terminal — a fresh shell at the old cwd, scrollback REPLAYED (snapshotKey = tab.id), the
   *                last command pre-typed.
   *    • agent   — `--resume` via the roster + `resumeSessionId` + `validateSession`; on failure an
   *                honest dead pane, tab kept (exactly `reviveTab`'s markDead).
   *  A no-op when the stack is empty. The reopened tab keeps its original id (the snapshot key). */
  reopenClosedTab: (projectId: Id) => Promise<void>
}

export const useTerminalsStore = create<TerminalsState>((set, get) => ({
  newTerminal: async (project, opts) => {
    const seq = tabsOf(project.id).filter((t) => t.kind === 'terminal').length + 1
    // T-116 (E-022) — the tab id is minted BEFORE the pty so it can be handed over as the
    // `snapshotKey`: scrollback is persisted per TAB (stable across relaunches and revives),
    // never per termId (which changes every time a shell is respawned). No `replaySnapshot` — a
    // brand-new tab has no history, and its id cannot collide with a forgotten one.
    const tabId = nanoid()
    const { termId } = await window.pomade.pty.create({
      cwd: project.rootPath,
      tabId,
      projectId: project.id,
      snapshotKey: tabId
    })
    sessionTermIds.add(termId)
    const tab: TerminalTab = {
      id: tabId,
      projectId: project.id,
      kind: 'terminal',
      title: `zsh ${seq}`,
      termId,
      cwd: project.rootPath,
      status: 'live'
    }
    useTabsStore.getState().openTab(tab, opts)
  },

  newCommandTerminal: async (projectId, { cwd, command, title }) => {
    const seq = tabsOf(projectId).filter((t) => t.kind === 'terminal').length + 1
    const tabId = nanoid()
    const { termId } = await window.pomade.pty.create({
      cwd,
      tabId,
      projectId,
      ...(command ? { command } : {}),
      snapshotKey: tabId
    })
    sessionTermIds.add(termId)
    const tab: TerminalTab = {
      id: tabId,
      projectId,
      kind: 'terminal',
      title: title ?? command ?? `zsh ${seq}`,
      termId,
      cwd,
      status: 'live',
      ...(command ? { lastCommand: command } : {}),
      ...(title ? { renamed: true } : {})
    }
    useTabsStore.getState().openTab(tab)
  },

  startAgent: async (project, agent, resumeSessionId, opts = {}) => {
    const mode = agent.modes.find((m) => m.id === (opts.mode ?? DEFAULT_AGENT_MODE))
    const command = buildAgentCommand(agent, resumeSessionId, resumeSessionId ? [] : (mode?.args ?? []))
    const cwd = opts.cwd ?? project.rootPath
    // T-128 — a BUTTON-launched agent tab hands over its `snapshotKey` too (tab id minted first,
    // exactly as `newTerminal` does). It does NOT snapshot while the agent runs — main starts a
    // term spawned with a launch `command` non-snapshotting — but the `/exit` downgrade's
    // `resumeSnapshot` now has a key to work with, so the farewell + post-exit shell era survive a
    // reload just like a typed-launch tab's do. `replaySnapshot` is deliberately NOT passed: a
    // brand-new tab has no history to replay (and an AGENT tab never replays at all — the CLI owns
    // its own restore). Before this, `startAgent` passed no key and the T-116 "documented limit"
    // silently ate the farewell line E-025 made the manual-recovery copy source.
    const tabId = nanoid()
    const { termId } = await window.pomade.pty.create({
      cwd,
      tabId,
      projectId: project.id,
      command,
      snapshotKey: tabId
    })
    sessionTermIds.add(termId)
    const tab: TerminalTab = {
      id: tabId,
      projectId: project.id,
      kind: 'agent',
      title: agent.name,
      termId,
      agentId: agent.id,
      cwd,
      status: 'live',
      lastCommand: command,
      // E-025 — a resume launch is Bound by construction (main claims the id at the exec
      // marker); a fresh launch enters the (re)bind cycle when its exec marker fires.
      ...(resumeSessionId ? { resumeSessionId, bindState: 'bound' as const } : {})
    }
    useTabsStore.getState().openTab(tab)
    // E-033 — a launch prompt is submitted once the agent is ready, as the tab's first prompt.
    if (opts.prompt) void sendAgentPrompt(termId, opts.prompt)
    return tabId
  },

  startAgentWithContext: async (project, agent, opts) => {
    const command = buildAgentCommand(agent)
    // T-128 — same as `startAgent`: a key so the post-`/exit` shell era can be persisted.
    const tabId = nanoid()
    const { termId } = await window.pomade.pty.create({
      cwd: project.rootPath,
      tabId,
      projectId: project.id,
      command,
      snapshotKey: tabId
    })
    sessionTermIds.add(termId)
    const tab: TerminalTab = {
      id: tabId,
      projectId: project.id,
      kind: 'agent',
      title: agent.name,
      termId,
      agentId: agent.id,
      cwd: project.rootPath,
      status: 'live',
      lastCommand: command
    }
    useTabsStore.getState().openTab(tab)
    void sendAgentContext(termId, opts.instruction, opts.typeText)
  },

  relaunch: async (projectId, tabId) => {
    const tab = tabsOf(projectId).find((t) => t.id === tabId)
    if (!tab) return
    // T-116 — a relaunched PLAIN terminal keeps snapshotting under the same tab key, but it does
    // NOT replay: Relaunch is "start this shell over", and its snapshot therefore starts over
    // too (T-116 restores across app RESTARTS, not across an in-run relaunch). Agent tabs never
    // snapshot at all.
    const { termId } = await window.pomade.pty.create({
      cwd: tab.cwd,
      tabId: tab.id,
      projectId,
      ...(tab.lastCommand ? { command: tab.lastCommand } : {}),
      ...(tab.kind === 'terminal' ? { snapshotKey: tab.id } : {})
    })
    sessionTermIds.add(termId)
    useTabsStore.getState().updateTab(projectId, tabId, { termId, status: 'live' })
  },

  stopAllTerminals: async (projectId) => {
    const busy = await busyTargets(projectId, 'stop-terminals')
    if (busy.length > 0) set({ bulkClose: { action: 'stop-terminals', projectId, busyTitles: busy.map((t) => t.title) } })
    else await killAllTerminals(projectId)
  },

  exitAllAgents: async (projectId) => {
    const busy = await busyTargets(projectId, 'exit-agents')
    if (busy.length > 0) set({ bulkClose: { action: 'exit-agents', projectId, busyTitles: busy.map((t) => t.title) } })
    else await exitLiveAgents(projectId)
  },

  bulkClose: null,

  confirmBulkClose: async () => {
    const pending = get().bulkClose
    if (!pending) return
    set({ bulkClose: null })
    await runBulkClose(pending.action, pending.projectId)
  },

  cancelBulkClose: () => set({ bulkClose: null }),

  handlePtyExit: (projectId, tabId, termId) => {
    useTabsStore.getState().updateTab(projectId, tabId, { status: 'dead' })
    if (closeOnExit.has(termId)) {
      closeOnExit.delete(termId)
      useTabsStore.getState().closeTab(projectId, tabId)
    }
  },

  handleAgentExit: (projectId, tabId) => {
    const tab = tabsOf(projectId).find((t) => t.id === tabId)
    if (!tab || tab.kind !== 'agent' || tab.status !== 'live') return
    const seq = tabsOf(projectId).filter((t) => t.kind === 'terminal').length + 1
    // T-115 — `lastExec` is deliberately NOT cleared here (unlike `lastCommand`/`resumeSessionId`).
    // Those two are AGENT facts, meaningless once the agent is gone. `lastExec` is a SHELL fact —
    // the last command this very zsh process ran, from before the agent was launched — and the shell
    // is the same process throughout the agent's life. Clearing it would delete the user's own last
    // command on `/exit` for no gain; keeping it is also what the epic's sticky rule says (only a
    // real preexec overwrites it). So after a downgrade the tab still pre-types the pre-agent
    // command on the next revive, until something new actually runs.
    // E-025 — session end via process lifecycle: the tab reverts to a plain terminal and its
    // agent TRIPLE is cleared (`cwdAtLaunch`/`bindState` alongside the pre-existing clears).
    bindPhase.delete(tabId)
    windowTrigger.delete(tabId)
    forgetSessionCause(tabId)
    useUnboundStore.getState().unsilence(tabId)
    useTabsStore.getState().updateTab(projectId, tabId, {
      kind: 'terminal',
      agentId: undefined,
      lastCommand: undefined, // a relaunch of what is now a shell must open a shell
      resumeSessionId: undefined,
      cwdAtLaunch: undefined,
      bindState: undefined,
      // E-033 — the session's title and unnamed mark belong to the agent, not the shell.
      launchedAt: undefined,
      appTitled: undefined,
      unnamed: undefined,
      ...(tab.renamed ? {} : { title: `zsh ${seq}` })
    })
  },

  handleAgentStart: (projectId, tabId, { agentId, agentName, command, cwd }) => {
    const tab = tabsOf(projectId).find((t) => t.id === tabId)
    if (!tab || tab.status !== 'live') return
    const resumeId = parseResumeId(command)
    // E-025 — a launch WITHOUT a resume id enters the (re)bind cycle: the next first-prompt
    // submit opens this tab's bind window. A resume launch is Bound by construction (main
    // claimed the id at the exec marker — deterministic, no window).
    if (resumeId) bindPhase.delete(tabId)
    else bindPhase.set(tabId, { kind: 'await-new', trigger: 'launch' })
    if (tab.kind === 'agent') {
      // A resume launch in an agent tab (a revive, a relaunch) binds the session it names.
      if (resumeId) noteSessionCause(tabId, resumeId, 'resume')
      // The initial typed launch of an agent tab's own command (button launch, relaunch,
      // revive). Pre-E-025 this was a pure no-op; now it stamps the launch leg of the triple:
      // `cwdAtLaunch` (the store key — the shell's PHYSICAL cwd, which is what the CLI encodes)
      // and, for a resume launch, `bindState: 'bound'`. A live-PTY signal — allowed to write.
      useTabsStore.getState().updateTab(projectId, tabId, {
        cwdAtLaunch: cwd,
        launchedAt: new Date().toISOString(),
        ...(resumeId || tab.resumeSessionId ? { bindState: 'bound' as const } : {})
      })
      return
    }
    // A live plain terminal upgrades to an agent tab (hand-typed launch).
    useTabsStore.getState().updateTab(projectId, tabId, {
      kind: 'agent',
      agentId,
      lastCommand: command,
      cwdAtLaunch: cwd,
      launchedAt: new Date().toISOString(),
      ...(resumeId ? { resumeSessionId: resumeId, bindState: 'bound' as const } : {}),
      ...(tab.renamed ? {} : { title: agentName })
    })
  },

  handleSessionId: (projectId, tabId, sessionId, forkedFrom = null) => {
    const tab = tabsOf(projectId).find((t) => t.id === tabId)
    // Only a LIVE agent tab carries a resume id: a plain terminal has no session, and a dead
    // tab's field is FROZEN. E-022's sticky invariant — `resumeSessionId` is written by exactly
    // two things, this live signal and handleAgentExit's downgrade (which clears it) — is what
    // lets a restored, never-revived tab round-trip the field untouched.
    if (!tab || tab.kind !== 'agent' || tab.status !== 'live') return
    // E-025 — a bind resolves the cycle: the runtime phase is consumed and a silenced ⚠️ is
    // re-armed (a LATER unbound is a new unbound session and must surface again).
    bindPhase.delete(tabId)
    const trigger = windowTrigger.get(tabId) ?? 'retry'
    windowTrigger.delete(tabId)
    useUnboundStore.getState().unsilence(tabId)
    if (tab.resumeSessionId === sessionId && tab.bindState === 'bound') return // re-confirmation
    noteSessionCause(tabId, sessionId, bindCause(trigger, forkedFrom, !!tab.resumeSessionId))
    useTabsStore
      .getState()
      .updateTab(projectId, tabId, { resumeSessionId: sessionId, bindState: 'bound' })
  },

  handleSessionUnbound: (projectId, tabId) => {
    const tab = tabsOf(projectId).find((t) => t.id === tabId)
    if (!tab || tab.kind !== 'agent' || tab.status !== 'live') return
    // The last-known id is deliberately KEPT (the Owner 2026-08-19: "if we closed before finding
    // the new session id — keep the last known"); only a successful rebind overwrites it. The
    // 'unbound' state is what withholds auto-resume trust and shows the ⚠️ mark.
    if (tab.bindState === 'unbound') return
    useTabsStore.getState().updateTab(projectId, tabId, { bindState: 'unbound' })
  },

  handleSubmit: (projectId, tabId, line) => {
    const tab = tabsOf(projectId).find((t) => t.id === tabId)
    if (!tab || tab.kind !== 'agent' || tab.status !== 'live') return
    // E-025 slice 3 — the per-agent command vocabulary (data table; built-in codex is the only
    // codex-family agent, folder agents are Claude Code under a pinned config dir).
    const command = matchSessionCommand(AGENT_SESSION_COMMANDS[tab.agentId === 'codex' ? 'codex' : 'claude'], line)
    if (command === 'clear' || command === 'fork') {
      // A clear or a fork — "a new session is being created in this tab": re-enter AwaitingId
      // at the NEXT first-prompt submit. The last-known id is deliberately KEPT until the
      // rebind succeeds (ratified post-/clear-gap semantics — an app restart in the gap
      // resumes the pre-clear session, which is the best-known state).
      bindPhase.set(tabId, { kind: 'await-new', trigger: command })
      return
    }
    if (command === 'resume') {
      // In-session `/resume` — its OWN handler (never a flag on rebind): the tab does not hunt
      // for a new id, it ADOPTS an existing one. With an explicit `<id>` argument the switch
      // happens on THIS submit — arm immediately (main validates the id on disk; a nonexistent
      // id is never bound and the window resolves to Unbound). Bare `/resume` opens the
      // interactive picker: the adopted transcript starts GROWING at the next real submit, so
      // the adopt-existing window is deferred to it.
      const arg = line.includes(' ') ? line.slice(line.indexOf(' ') + 1).trim() : ''
      bindPhase.delete(tabId)
      if (arg) {
        windowTrigger.set(tabId, 'resume')
        void window.pomade.pty.armSessionWindow(tab.termId, {
          mode: 'adopt-existing',
          submitAt: Date.now(),
          resumeId: arg
        })
      } else {
        bindPhase.set(tabId, { kind: 'adopt-existing' })
      }
      return
    }
    const phase = bindPhase.get(tabId)
    // A bind window is due when the (re)bind cycle asked for one (fresh launch, a clear, a fork,
    // `/resume`) — or as a RETRY while the tab has no trusted id (an earlier window expired
    // Unbound, or nothing ever bound): re-entering AwaitingId on a later submit costs nothing (a
    // false window is harmless — nothing qualifying appears) and raises the capture rate the
    // spec's ±window exists for.
    const needsBind = phase !== undefined || !tab.resumeSessionId || tab.bindState === 'unbound'
    if (!needsBind) return
    bindPhase.delete(tabId)
    windowTrigger.set(tabId, phase === undefined ? 'retry' : phase.kind === 'adopt-existing' ? 'resume' : phase.trigger)
    void window.pomade.pty.armSessionWindow(tab.termId, {
      mode: phase?.kind === 'adopt-existing' ? 'adopt-existing' : 'await-new',
      submitAt: Date.now(),
      ...(phase?.kind === 'adopt-existing' && phase.resumeId ? { resumeId: phase.resumeId } : {})
    })
  },

  bindSessionManually: async (projectId, tabId, sessionId) => {
    const id = sessionId.trim()
    const tab = tabsOf(projectId).find((t) => t.id === tabId)
    if (!id || !tab || tab.kind !== 'agent' || tab.status !== 'live' || !tab.agentId) return false
    // Validate against the tab's EXPECTED store — the same cwd-at-launch key the revive gate
    // uses. Never bind an id the disk can't back: its resume would fail.
    const project = useWorkspaceStore.getState().projectById(projectId)
    const cwdKey = await agentReviveCwd(tab, project)
    let exists = false
    try {
      exists = await window.pomade.agents.validateSession(tab.agentId, cwdKey, id)
    } catch {
      exists = false
    }
    if (!exists) return false
    // Claim ownership in main FIRST (an owned id is never a bind candidate for any other tab),
    // then stamp the tab. handleSessionId's bookkeeping is mirrored here (phase + silence).
    void window.pomade.pty.claimSession(tab.termId, id)
    bindPhase.delete(tabId)
    windowTrigger.delete(tabId)
    forgetSessionCause(tabId) // the user names the session; Pomade cannot say why it changed
    useUnboundStore.getState().unsilence(tabId)
    useTabsStore.getState().updateTab(projectId, tabId, { resumeSessionId: id, bindState: 'bound' })
    return true
  },

  silenceUnbound: (projectId, tabId) => {
    const tab = tabsOf(projectId).find((t) => t.id === tabId)
    if (!tab || tab.kind !== 'agent') return
    useUnboundStore.getState().silence(tabId)
  },

  handleCwd: (projectId, tabId, cwd) => {
    const tab = tabsOf(projectId).find((t) => t.id === tabId)
    // A dead tab's cwd is FROZEN (it is the directory to revive/relaunch INTO). An empty report is
    // ignored rather than blanking a known directory — same rule main applies to `term.cwd`.
    if (!tab || tab.status !== 'live' || !cwd) return
    if (tab.cwd === cwd) return
    useTabsStore.getState().updateTab(projectId, tabId, { cwd })
  },

  handleExec: (projectId, tabId, { command, agentLaunch }) => {
    // The AGENT-LAUNCH GUARD, and why it lives in the payload rather than in a kind check: the exec
    // that starts an agent (`claude`, a folder agent's script) fires this event AND upgrades the tab
    // — and it fires FIRST, while the tab is still `kind: 'terminal'`. So `kind` alone would happily
    // record `claude --resume <id>` as the terminal's last command, and the very next revive would
    // pre-type an agent launch into a plain shell. Main already computed the roster match for the
    // upgrade, so it simply tells us: `agentLaunch` ⇒ not a terminal command, ignore it.
    if (agentLaunch || !command) return
    const tab = tabsOf(projectId).find((t) => t.id === tabId)
    // Plain terminals only (an agent tab's shell belongs to the CLI — a command run "inside" it is
    // the agent's business, not a shell command to restore), live only (a dead tab's field is
    // FROZEN: it is the text to pre-type when it comes back).
    if (!tab || tab.kind !== 'terminal' || tab.status !== 'live') return
    if (tab.lastExec === command) return // re-running the same command changes nothing
    useTabsStore.getState().updateTab(projectId, tabId, { lastExec: command })
  },

  handleAttention: (projectId, tabId) => {
    // The dot is not set on the active tab of the active project (the active tab never accumulates
    // a dot; opening a project alone doesn't set it), and a repeat on an already-dotted tab stays
    // a single unread. Guarded here (not in a pane effect) so a hidden — or, under an invariant
    // violation, never-mounted — project's terminal still records its attention.
    const activeProject = useWorkspaceStore.getState().activeProjectId
    const tabs = useTabsStore.getState()
    const isActiveTab =
      activeProject === projectId && tabs.activeTabByProject[projectId] === tabId
    const current = (tabs.tabsByProject[projectId] ?? []).find((t) => t.id === tabId)
    const already = current && current.kind !== 'doc' ? current.attention : false
    if (!isActiveTab && !already) {
      tabs.updateTab(projectId, tabId, { attention: true })
    }
  },

  reconcile: async (projectId, tab) => {
    if (tab.status !== 'live' || sessionTermIds.has(tab.termId)) return
    const alive = (await livenessList()).some((t) => t.termId === tab.termId && t.alive)
    if (alive) return
    // T-114 — this used to write `status: 'dead'` (persisted). It now records a RUNTIME-ONLY
    // revive candidate and leaves every persisted payload — including `status: 'live'` — exactly
    // as the previous run left it. The flip to 'dead' happens (if at all) inside revive.
    pendingRevive.add(tab.id)
    // The project may ALREADY be open — at boot the active project's panes mount while it is
    // active, and a project opened before its panes mounted takes this path too. The activation
    // subscription at the bottom of this file covers the opposite order.
    if (useWorkspaceStore.getState().activeProjectId === projectId) {
      await useTerminalsStore.getState().reviveProject(projectId)
    }
  },

  reviveProject: async (projectId) => {
    if (pendingRevive.size === 0) return
    const targets = tabsOf(projectId).filter((t) => pendingRevive.has(t.id))
    if (targets.length === 0) return
    // Claim the marks SYNCHRONOUSLY (before the first await): a reconcile racing an activation,
    // or two reconciles landing in the same tick, must never spawn two PTYs for one tab — and
    // re-opening the project later must find nothing left to do.
    for (const t of targets) pendingRevive.delete(t.id)
    const roster = targets.some((t) => t.kind === 'agent')
      ? await window.pomade.agents.roster()
      : []
    const project = useWorkspaceStore.getState().projectById(projectId)
    // In parallel — PTY spawns are cheap and independent, and each tab's updateTab is its own
    // atomic patch (the reaper only ever sees termId sets that reference every live pty).
    await Promise.all(targets.map((tab) => reviveTab(projectId, tab, roster, project)))
  },

  reopenClosedTab: async (projectId) => {
    // Pop-loop over the top of the stack: skip an entry only when it is an OUTSIDE-workspace doc
    // whose file has vanished (the one case hydration prunes). The single yield point is the fs
    // stat for such a doc; everything else runs synchronously.
    for (;;) {
      const stack = useTabsStore.getState().reopenStackFor(projectId)
      const entry = stack[stack.length - 1]
      if (!entry) return
      const tab = entry.tab
      if (tab.kind === 'doc' && typeof tab.path === 'string' && tab.path.startsWith('/')) {
        let exists = false
        try {
          await window.pomade.fs.statOutside(tab.path)
          exists = true
        } catch {
          exists = false
        }
        if (!exists) {
          useTabsStore.getState().dropReopenEntry(projectId, entry)
          continue
        }
      }
      // Re-insert at the original index (clamped) and activate; the entry leaves the stack. The
      // tab keeps its id — so its snapshot key is unchanged and, for a terminal, replay just works.
      useTabsStore.getState().restoreClosedTab(projectId, entry)
      // A live terminal/agent revives through the SAME machinery as an app restart: mark it a
      // revive candidate and run the project's revive. `reviveProject` claims the mark
      // synchronously, so the pane's own reconcile-on-mount can never double-spawn. A doc needs
      // nothing (its EditorPane loads from disk); a persisted-DEAD terminal/agent comes back as a
      // dead pane (dead-at-close stays dead, like a restore), so it is not marked for revive.
      if ((tab.kind === 'terminal' || tab.kind === 'agent') && tab.status === 'live') {
        pendingRevive.add(tab.id)
        await useTerminalsStore.getState().reviveProject(projectId)
      }
      return
    }
  }
}))

// T-168 — STORE-OWNED per-terminal event subscriptions (the state-transition leg of the pty
// event routing). The STATE-TRANSITION pty events — agent start/exit, session-id/unbound, exec,
// cwd persistence, attention — used to be subscribed from each TerminalPane's mount effect, so a
// transition landed only while that pane was mounted. Correctness rode entirely on the
// hidden-not-unmounted invariant (PaneHost keeps every project's panes mounted, display:none), and
// any violation of it was INVISIBLE data loss — e.g. a session-id bind silently skipped for a tab
// whose pane wasn't there to hear it.
//
// They now live HERE, keyed by termId and diffed off tabsByProject exactly like the reaper above:
// a term's handlers attach when its tab enters the store (creation / hydration / a relaunch or
// revive termId swap) and dispose when it leaves (any close path, or the old termId of a swap).
// Panes keep ONLY xterm-facing wiring (data / exit / fit / replay, the link-base `cwdRef`, and the
// close-guard `busyRef`).
//
// Each handler re-resolves termId → the tab's CURRENT { projectId, tabId } at fire time: a tab's
// projectId can change under a cross-project move (T-097) while its termId is stable for the pty's
// life and globally unique, so this matches the pane effects' fresh-projectId behaviour (their
// deps re-subscribed on a projectId change). The store methods own every guard (kind / status /
// bind phase), so attaching for EVERY live termId — plain terminals included — is a no-op wherever
// it doesn't apply, exactly as the panes' per-kind subscribe conditions were.
function tabLocByTermId(termId: string): { projectId: Id; tabId: Id } | null {
  for (const [projectId, tabs] of Object.entries(useTabsStore.getState().tabsByProject)) {
    for (const t of tabs) {
      if ((t.kind === 'terminal' || t.kind === 'agent') && t.termId === termId) {
        return { projectId, tabId: t.id }
      }
    }
  }
  return null
}

function subscribeTermEvents(termId: string): () => void {
  const s = (): TerminalsState => useTerminalsStore.getState()
  const offs: (() => void)[] = [
    // T-024 — the agent CLI exited back to its (still-live) host shell: downgrade the tab.
    window.pomade.pty.onAgentExit(termId, () => {
      const loc = tabLocByTermId(termId)
      if (loc) s().handleAgentExit(loc.projectId, loc.tabId)
    }),
    // T-024, both ways — a roster agent command ran in this shell: upgrade the tab (and stamp the
    // E-025 launch leg on a button-launched agent tab too).
    window.pomade.pty.onAgentStart(termId, (payload) => {
      const loc = tabLocByTermId(termId)
      if (loc) s().handleAgentStart(loc.projectId, loc.tabId, payload)
    }),
    // T-113 (E-022) / E-025 — the prompt-gated bind outcome: the LIVE session id of this pty's agent.
    window.pomade.pty.onSessionId(termId, (sessionId, forkedFrom) => {
      const loc = tabLocByTermId(termId)
      if (loc) s().handleSessionId(loc.projectId, loc.tabId, sessionId, forkedFrom)
    }),
    // E-025 — a bind window closed with no uniquely-attributable id (the ⚠️ affordance).
    window.pomade.pty.onSessionUnbound(termId, () => {
      const loc = tabLocByTermId(termId)
      if (loc) s().handleSessionUnbound(loc.projectId, loc.tabId)
    }),
    // T-115 (E-022) — a command executed at this pty's shell; persisted as `lastExec`.
    window.pomade.pty.onExec(termId, (payload) => {
      const loc = tabLocByTermId(termId)
      if (loc) s().handleExec(loc.projectId, loc.tabId, payload)
    }),
    // T-114 (E-022) — this pty reported a new working directory; PERSISTED onto the tab (the pane
    // keeps its own onCwd for the link-resolution `cwdRef`, an xterm-facing concern).
    window.pomade.pty.onCwd(termId, (cwd) => {
      const loc = tabLocByTermId(termId)
      if (loc) s().handleCwd(loc.projectId, loc.tabId, cwd)
    }),
    // T-056 / T-151 — a turn-end / notification attention event; sets the tab's unread dot.
    window.pomade.pty.onAttention(termId, () => {
      const loc = tabLocByTermId(termId)
      if (loc) s().handleAttention(loc.projectId, loc.tabId)
    })
  ]
  return () => {
    for (const off of offs) off()
  }
}

// The tab-lifecycle subscription diff, twin of the PTY reaper: attach on a termId's first
// appearance, dispose on its departure. A workspace switch clears tabsByProject wholesale, so
// every term's handlers are disposed with it — no special case.
const subscribedTermIds = new Map<string, () => void>()
useTabsStore.subscribe((state) => {
  const now = new Set<string>()
  for (const tabs of Object.values(state.tabsByProject)) {
    for (const t of tabs) {
      if (t.kind === 'terminal' || t.kind === 'agent') now.add(t.termId)
    }
  }
  for (const termId of now) {
    if (!subscribedTermIds.has(termId)) subscribedTermIds.set(termId, subscribeTermEvents(termId))
  }
  for (const [termId, off] of subscribedTermIds) {
    if (!now.has(termId)) {
      off()
      subscribedTermIds.delete(termId)
    }
  }
})

// T-114 (E-022) — revive trigger: PROJECT OPEN.
//
// The boot-time active project is handled by `reconcile` itself (it fires the revive when the tab's
// project is already the active one), which also covers "opened before its panes mounted". This
// subscription covers the other direction: a project opened LATER, whose pending marks were
// recorded at boot. Opening it again is a no-op (the marks are consumed).
//
// A WORKSPACE SWITCH (`root` changes) drops every pending mark: those tabIds belong to the old
// workspace, whose ptys were disposed and whose tab caches workspace-store clears. The new
// workspace's restored tabs are then marked afresh by their own pane mounts and follow the same
// rules from the new boot-active project onwards.
let lastActiveProjectId = useWorkspaceStore.getState().activeProjectId
let lastWorkspaceRoot = useWorkspaceStore.getState().root
useWorkspaceStore.subscribe((state) => {
  if (state.root !== lastWorkspaceRoot) {
    lastWorkspaceRoot = state.root
    pendingRevive.clear()
  }
  if (state.activeProjectId !== lastActiveProjectId) {
    lastActiveProjectId = state.activeProjectId
    void useTerminalsStore.getState().reviveProject(state.activeProjectId)
  }
})
