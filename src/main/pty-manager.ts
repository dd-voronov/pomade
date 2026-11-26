// Pomade — PtyManager (main process). Wave 2b.
// Spawns interactive login zsh (`zsh -il`) per terminal, keyed by termId (nanoid).
// PTYs live entirely in the main process: they survive ANY renderer action (project
// switch, tab hide) and are killed ONLY via kill()/sendExit-triggered exit or app quit.
// A per-terminal ring buffer of recent output lets a (re)mounting xterm repaint scrollback.

import { ipcMain, app } from 'electron'
import { spawn as ptySpawn, type IPty } from 'node-pty'
import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  promises as fsp
} from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'

import { AgentStateScanner, AttentionScanner, MarkerScanner, type AgentState } from 'pomade-kit/scanners'

import type { AgentExitReason, LiveAgentState } from 'pomade-kit/protocol'

import { CH, EV } from '@shared/ipc-api'
import { readAgentState } from '@shared/git-branches'
import { EXEC_MARKER_CAP, type PtyAgentState, type PtyTabRef } from '@shared/types'
import { configStore } from './config-store'
import { commandTerminalEnv } from './app-commands'
import { defineHandler } from './ipc'
import { agentProvider, matchAgentCommand } from './agent-service'
import { tunedMs } from './test-tuning'
import { sessionWatcher } from './session-watcher'
import { writeFileAtomic, writeFileAtomicSync } from './atomic-write'
import { safeBroadcast, setShuttingDown } from './windows'
import { publishPlatformEvent } from './event-bus'

// Keep the last ~200KB of output per terminal so a re-attaching xterm repaints scrollback.
const RING_MAX = 200 * 1024

// ─── T-116 (E-022): scrollback snapshots ──────────────────────────────────────────────
// A plain terminal's ring buffer is PERSISTED, so "reload the app" no longer means "lose the
// terminal I was working in". The file lives at
// `<workspace>/.pomade/state/scrollback/<snapshotKey>` (raw bytes — the buffer is ANSI text,
// not JSON) and rides the existing `state/` gitignore.
//
// The key is the TAB id, handed to `create()` by the renderer (`snapshotKey`), because the
// termId changes on every relaunch/revive while the tab id is exactly what "this terminal"
// means across restarts. An agent tab never REPLAYS (grooming decision: an agent controls its
// own restore via `--resume`; replaying stale TUI frames above it would garble the redraw) — but
// T-128 gives a button-launched agent tab a KEY anyway: it snapshots nothing while the agent runs
// and everything after the `/exit` downgrade, so its farewell line survives a reload exactly like
// a typed-launch tab's. Key ⇒ "this tab may persist a SHELL era", never "this tab replays".
const SNAPSHOT_DIR = 'scrollback'
// Debounce: the buffer is written ~2 s after output stops… (e2e shrinks the window via
// POMADE_TEST_SNAPSHOT_IDLE_MS — docs/contracts/test-hooks.md; unset ⇒ production value.)
const SNAPSHOT_IDLE_MS = tunedMs('POMADE_TEST_SNAPSHOT_IDLE_MS', 2000)
// …but never later than this after the FIRST unsaved byte, so an output storm (a build, a
// test suite, `yes`) still lands snapshots on disk instead of starving the idle timer. Crash
// resilience is the point: quit-only persistence loses everything to a kill -9 or a panic.
const SNAPSHOT_MAX_MS = 12_000
/** The dim rule a revived pane shows between restored scrollback and the live session.
 *  Plain text + SGR only — no BEL, no OSC — so it can never trip the attention scanner
 *  (it is painted by the renderer, but the same bytes also travel through `pty.replay`). */
const RESTORE_DIVIDER = `\r\n\x1b[2m──────────────── session restored ────────────────\x1b[0m\r\n`

// ─── T-147: strip zsh's transient partial-line (PROMPT_EOL_MARK) marker on replay ─────────
// Before drawing each prompt, zsh's line editor emits a "partial line" marker: a reverse-video
// glyph (a `%` for a normal user, `#` for root — from PROMPT_EOL_MARK), PADDED WITH SPACES out to
// the terminal's width at that moment, then `\r ␠\r` (CR, space, CR) that overwrites the glyph
// cell. It is pure transient chrome: the prompt redraw that immediately follows (`\r … \x1b[J`)
// always erases it, so it is invisible LIVE — the recording it leaves behind is the only place it
// is ever "seen".
//
// The bug (T-147): those padding spaces are sized to the CAPTURE width. A revive replays the
// snapshot into an xterm that is only 80 cols wide until its FitAddon runs, and the fit races (and
// usually loses) the async replay — so the wide padding OVERFLOWS 80, auto-wraps to the next row,
// and the marker's own `\r … \x1b[J` self-erase then lands on the WRONG row. The reverse-`%` and
// its padding survive as a stray line — one per restored prompt — which is the "restored block is
// double-spaced with a %/box glyph above every prompt" a user saw after a reload. Live it was
// clean because it was parsed at the width it was written for.
//
// Fix at the REPLAY boundary (never at capture — the on-disk snapshot stays a byte-exact recording,
// which the T-116 byte-stability guarantee relies on): drop the marker from the restored scrollback
// so there is no width-sized padding left to wrap. This is render-equivalent to keeping it (the
// following prompt redraw erased it either way) and robust at ANY width, hidden pane, or fit timing
// — not a race patch. Applied ONLY to the restored base, never to the live ring below the divider
// (that fresh shell is drawing at the current width and needs no help).
//
// The pattern is anchored tightly so it can only match the marker idiom, never real output: an SGR
// run that turns standout/reverse ON (code 7 as a whole `;`-separated param, so `[27m` "reverse
// OFF" is NOT matched), one glyph, an SGR run, optional padding spaces, then the `\r ␠\r` erase.
const ZSH_EOL_MARK =
  /(?:\x1b\[[\d;]*m)*\x1b\[(?:\d+;)*7(?:;\d+)*m(?:\x1b\[[\d;]*m)*[^\x1b\r\n](?:\x1b\[[\d;]*m)* *\r \r/g

/** T-147 — remove the transient zsh partial-line markers from restored scrollback (see above). */
function stripEolMarkers(scrollback: string): string {
  return scrollback.replace(ZSH_EOL_MARK, '')
}

/** A snapshot key must be ONE path segment. The key comes from the renderer (a nanoid tab id in
 *  practice), and a `../` in it would let a compromised/buggy renderer write or delete outside
 *  `state/scrollback/` — so anything but the nanoid alphabet is refused outright (no snapshot
 *  rather than a sanitized guess, which could collide with another tab's file). */
function isValidSnapshotKey(key: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(key)
}

/** The snapshot directory of the ACTIVE workspace, or null when no workspace is open.
 *  Resolved per call, never cached: a workspace switch changes it mid-run. */
function snapshotDir(): string | null {
  const root = configStore.getRoot()
  return root ? join(root, '.pomade', 'state', SNAPSHOT_DIR) : null
}

function snapshotPath(key: string): string | null {
  const dir = snapshotDir()
  return dir && isValidSnapshotKey(key) ? join(dir, key) : null
}

// E-005 (T-025): host-terminal identity that must not leak into our children. Pomade
// launched from a VS Code terminal inherits TERM_PROGRAM=vscode / VSCODE_* — CLIs inside
// our ptys (Claude Code) then mis-detect VS Code as their host IDE. ELECTRON_RUN_AS_NODE
// would likewise corrupt any Electron-based child.
// User-test round 1: VSCODE_* alone is NOT enough. A real `npm run dev` from a VS Code
// terminal (inside a claude session) also carries non-prefixed leakage — audited on the
// actual env: CLAUDE_CODE_SSE_PORT (the VS Code Claude-extension SSE port `claude` uses to
// auto-connect to the IDE), CLAUDECODE / CLAUDE_CODE_* / CLAUDE_EFFORT / AI_AGENT (make a
// nested claude think it's a child session of the launching one), __CFBundleIdentifier
// (macOS parent-bundle id = com.microsoft.VSCode), USER_ZDOTDIR (VS Code shell-integration
// injection) and COPILOT_DEBUG_NONCE. Auth/config vars a user legitimately exports
// (ANTHROPIC_*, CLAUDE_CONFIG_DIR, …) are deliberately NOT touched.
const STRIP_ENV = new Set([
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ORIGINAL_XDG_CURRENT_DESKTOP',
  'CHROME_DESKTOP',
  'CLAUDECODE',
  'CLAUDE_EFFORT',
  'AI_AGENT',
  '__CFBundleIdentifier',
  'USER_ZDOTDIR',
  'COPILOT_DEBUG_NONCE',
  // E-033 — set per pty (its own tab and project); never inherited from a Pomade run inside a Pomade terminal.
  'POMADE_TAB_ID',
  'POMADE_PROJECT_ID',
  // A Terminal.app tab's session id (Pomade started from Terminal). Under the Apple_Terminal
  // identity `/etc/zshrc_Apple_Terminal` would give every pty that tab's saved session — its
  // restore file and its per-session history file in place of the user's HISTFILE.
  'TERM_SESSION_ID'
])

const STRIP_ENV_PREFIXES = ['VSCODE_', 'CLAUDE_CODE_']

/** The env our pty children get: the inherited env minus host-IDE / parent-claude-session
 *  leakage, masquerading as Apple Terminal (P-018) with the real identity in POMADE=1. */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (STRIP_ENV.has(key) || STRIP_ENV_PREFIXES.some((p) => key.startsWith(p))) continue
    // VS Code points git at its own askpass helper; that path dies with the VS Code session.
    // A VS Code-shim ZDOTDIR would likewise leak the IDE's shell integration into our zsh.
    if ((key === 'GIT_ASKPASS' || key === 'ZDOTDIR') && /vscode|visual studio code/i.test(value))
      continue
    // A parent claude session exports GIT_EDITOR=true (a no-op editor for automation) —
    // inside a real interactive terminal it would silently break `git commit`.
    if (key === 'GIT_EDITOR' && value === 'true') continue
    env[key] = value
  }
  env.TERM = 'xterm-256color'
  // P-018 — masquerade as Apple Terminal. Under TERM_PROGRAM=Pomade agent CLIs treated us
  // as an unknown terminal and claude's `auto` notification channel emitted NOTHING at turn
  // end, forcing E-011 to inject per-provider flags + zsh wrapper functions. Under
  // Apple_Terminal claude's `auto` channel emits a standalone BEL at turn end and codex
  // (≥0.145) bells flag-free while unfocused (both pty-probe-verified, 2026-07-24; truecolor
  // unaffected — CLIs key color depth off COLORTERM, which passes through untouched), so the
  // injected flags AND the manual-launch zsh wrappers are gone entirely. Apple Terminal is
  // the most conservative identity to claim: no cursor/clipboard/notification OSC extensions
  // a CLI would try to exploit. POMADE=1 keeps the real host detectable for anything that
  // cares. Per-provider signal details: docs/modules/agents/agent-providers.md.
  env.TERM_PROGRAM = 'Apple_Terminal'
  env.TERM_PROGRAM_VERSION = '453' // plausible Terminal.app build; version parsers expect digits
  env.POMADE = '1'
  env.LANG = env.LANG ?? 'en_US.UTF-8'
  // E-028 — Pomade's command folder on PATH, its home and the workspace root.
  Object.assign(env, commandTerminalEnv(env.PATH))
  return env
}

// ─── E-005 (T-024): zsh shell integration — prompt + exec markers ─────────────────────
// `/exit` ends an agent CLI but NOT the pty: zsh takes the prompt back, so no pty exit
// fires and (for short-lived commands) no poll can catch the transition. Instead we make
// the shell itself report its lifecycle: agent ptys start zsh with ZDOTDIR pointing at a
// generated shim that sources the user's real startup files and adds two hooks printing
// invisible OSC 7879 markers — precmd → `pomade:prompt` (a prompt was drawn), preexec →
// `pomade:exec;<cmdline>` (a command is about to run; payload capped at EXEC_MARKER_CAP bytes —
// originally 160, enough for first-word roster matching, raised to 500 by T-115 which now also
// PERSISTS the command line). Pairing them gives BOTH directions (user-test round 1):
// exec whose first word matches the agent roster → ptyAgentStart (a shell upgraded into an
// agent — or the initial typed launch, which the renderer no-ops); the prompt that follows
// a matched exec → ptyAgentExit (the agent handed the shell back). Deterministic (markers
// travel inside the pty's own data stream), invisible (xterm ignores unknown OSC).
// E-020 (T-086): the precmd marker now also carries the shell's `$PWD` —
// `pomade:prompt;<cwd>` — so a `cd` is reported by the shell itself, with no polling and no
// extra OSC (the same invisible 7879 marker the busy signal already rides on). The old
// payload-less `pomade:prompt` is still accepted: a pty spawned by a previous app version can
// outlive an upgrade only within a run, but the shim files are regenerated lazily and a
// user's own stale ZDOTDIR copy must not silently break the busy/agent signals.
// The OSC 7879 marker framing and the two chunk-split-safe output scanners (MarkerScanner,
// AttentionScanner) come from pomade-kit/scanners; create() wires their typed events.
// P-018 round-5 — a foreground command that ran at least this long raises ptyAttention when
// it finishes (busy→idle). Short enough to catch anything a user would switch away from,
// long enough that instant commands never fire.
const LONG_COMMAND_ATTENTION_MS = 2000

// Each stage keeps ZDOTDIR pointed at the shim (zsh re-reads it per file) while sourcing
// the user's real counterpart; .zlogin runs last and restores the user's environment.
const ZDOT_SOURCE_USER = (file: string): string =>
  `ZDOTDIR="$POMADE_USER_ZDOTDIR"\n[[ -f "$ZDOTDIR/${file}" ]] && builtin source "$ZDOTDIR/${file}"\nZDOTDIR="$POMADE_ZDOTDIR"\n`

// P-018 removed the E-011 claude/codex wrapper functions that used to be appended to the
// shim's .zshrc: under the Apple_Terminal masquerade (childEnv) both CLIs notify flag-free,
// so a manually typed `claude`/`codex` needs no injection any more — the shim is back to
// pure lifecycle markers. (The wrappers also had a real failure mode: a freshly opened
// terminal could miss them, silently losing notifications — round-4 user test.)

const ZDOT_FILES: Record<string, string> = {
  '.zshenv': `# Pomade zsh integration (generated; safe to delete — recreated on demand).\nPOMADE_ZDOTDIR="$ZDOTDIR"\n${ZDOT_SOURCE_USER('.zshenv')}`,
  '.zprofile': ZDOT_SOURCE_USER('.zprofile'),
  // E-020 — the precmd marker carries $PWD so main always knows each shell's cwd (T-086).
  // T-115 — the preexec payload cap is EXEC_MARKER_CAP (raised 160 → 500): the command line is no
  // longer only a first-word roster probe, it is the text a revived shell gets PRE-TYPED, so it
  // has to survive a realistic command (flags, paths, a quoted message) intact.
  // /etc/zshrc (between .zprofile and .zshrc) sets `HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history` while
  // ZDOTDIR is the shim; point it back at the user's own file before their .zshrc runs, so their
  // own HISTFILE setting still wins and Pomade terminals share the user's history.
  '.zshrc': `[[ "$HISTFILE" == "$POMADE_ZDOTDIR/.zsh_history" ]] && HISTFILE="$POMADE_USER_ZDOTDIR/.zsh_history"\n${ZDOT_SOURCE_USER('.zshrc')}autoload -Uz add-zsh-hook\n_pomade_prompt_mark() { builtin printf '\\033]7879;pomade:prompt;%s\\007' "$PWD" }\n_pomade_exec_mark() { builtin printf '\\033]7879;pomade:exec;%.${EXEC_MARKER_CAP}s\\007' "$1" }\nadd-zsh-hook precmd _pomade_prompt_mark\nadd-zsh-hook preexec _pomade_exec_mark\n_pomade_status_mark() { builtin printf '\\033]7879;pomade:status;%s\\007' "$?" }\nprecmd_functions=(_pomade_status_mark $precmd_functions)\n`,
  '.zlogin': `${ZDOT_SOURCE_USER('.zlogin')}# Startup chain done — stop advertising the shim to nested shells.\nif [[ "$POMADE_USER_ZDOTDIR" == "$HOME" ]]; then unset ZDOTDIR; else ZDOTDIR="$POMADE_USER_ZDOTDIR"; fi\nunset POMADE_ZDOTDIR POMADE_USER_ZDOTDIR\n`
}

/** T-114 — cheap "is this an existing directory?" guard for `resolveCwd`. Sync on purpose:
 *  `create()` is a synchronous IPC handler, and one `stat` per pty spawn is noise. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

let zdotDir: string | null = null
function ensureZshIntegration(): string {
  if (zdotDir) return zdotDir
  const dir = join(app.getPath('userData'), 'zsh-integration')
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(ZDOT_FILES)) writeFileSync(join(dir, name), content)
  zdotDir = dir
  return dir
}

interface Term {
  id: string
  pty: IPty
  buffer: string
  alive: boolean
  cols: number
  rows: number
  // Set when kill() was called on a live term (its tab is closing). On the subsequent
  // exit we drop the map entry, since no tab references it any more.
  killRequested: boolean
  // T-044 — true while a foreground command is running at the shell (an exec marker seen
  // with no following prompt marker). Drives the "close a busy terminal?" confirmation.
  // Reliable because every pty is a shimmed `zsh -il` (see ensureZshIntegration) that emits
  // precmd/preexec markers; starts false (an idle prompt is not busy).
  busy: boolean
  // E-020 (T-086) — the shell's last reported working directory (absolute), read from the
  // precmd marker's `$PWD` payload. Seeded with the spawn cwd so a link Cmd+clicked before the
  // very first prompt still resolves; every `cd` updates it. Same precedent as `busy`.
  cwd: string
  // ── T-116 (E-022) — scrollback snapshot state ───────────────────────────────────────
  // The TAB id this term's snapshot file is keyed on. Absent for an agent-kind relaunch/revive
  // (Resume session) and for a term created without a key (a pre-T-116 caller); T-128 — a
  // button-launched agent tab DOES carry one (it persists its post-`/exit` shell era).
  snapshotKey?: string
  // False while an AGENT is running in this shell: a launch `command` starts a keyed term
  // non-snapshotting (T-128) and a terminal→agent upgrade stops snapshotting (and drops the
  // file); the `/exit` downgrade turns it back on. Meaningless without a key.
  snapshotting: boolean
  // E-028 — the agent running in this shell now (its roster id and physical launch cwd), from the
  // agent-start marker to the prompt that ends it; null otherwise. Feeds "is an agent live in X?".
  agent: { id: string; cwd: string } | null
  // Scrollback RESTORED from disk at create (revive only), replayed above the divider. It is
  // NOT part of `buffer` (nothing re-broadcasts it) but IS re-persisted ahead of it, which is
  // what makes the history cumulative across restarts while the divider stays single: the
  // divider is injected at replay time and never written to disk.
  snapshotBase: string
  snapTimer?: NodeJS.Timeout
  // Wall-clock deadline for the bounded max interval (set when the first unsaved byte lands).
  snapDeadline?: number
  // Per-term write chain: snapshots are serialized so two in-flight renames can never land
  // out of order (which would persist an OLDER buffer over a newer one).
  snapChain: Promise<void>
  // E-031 — the tab this term runs in (`pty.setTab`), and the roster id of the agent running in
  // its shell right now (from the agent-start match until the agent ends). Together they make
  // `agentTab.exited`.
  tab?: PtyTabRef
  agentId?: string
  // E-033 — reads what the agent running in this shell is doing (the kit's AgentStateScanner),
  // from the agent-start match until the agent ends; broadcast as EV.ptyAgentState.
  stateScanner?: AgentStateScanner
}

/** E-033 — the scanner's reading as an agent tab's live state. */
function liveState(state: AgentState): PtyAgentState['state'] {
  return state.kind === 'working' ? 'working' : state.kind === 'waiting' ? 'needs-you' : 'idle'
}

class PtyManager {
  private terms = new Map<string, Term>()
  // T-037 — one-shot resolvers awaited by killAll() so the quit can wait for each child to
  // actually exit before app.exit() force-terminates the process.
  private drainWaiters = new Map<string, () => void>()

  constructor() {
    // T-113 (E-022) — the session watcher owns session-id capture but broadcasts through US, so
    // its events inherit the T-037 shutdown guard (a session id landing mid-teardown must not be
    // sent into a webContents Electron is disposing). E-025 adds the refusal channel: a bind
    // window closing with no uniquely-attributable id surfaces as `pty:session-unbound`.
    sessionWatcher.setEmitter((payload) => this.broadcast(EV.ptySessionId, payload))
    sessionWatcher.setUnboundEmitter((payload) => this.broadcast(EV.ptySessionUnbound, payload))
  }

  /** Resolve a (possibly workspace-relative) cwd to an absolute directory.
   *
   *  T-114 (E-022) — every candidate is existence-checked before it is handed to node-pty.
   *  `create()` is now called with a tab's PERSISTED last-known cwd (auto-revive on project
   *  open), which may have been deleted or renamed since the previous app run — and node-pty
   *  THROWS on a vanished cwd, which would make the tab permanently unrevivable. A stale
   *  directory therefore falls through the existing fallback chain (workspace root → home)
   *  instead of failing. `pty.create` never rejects because of a stale cwd. */
  private resolveCwd(cwd: string): string {
    const root = configStore.getRoot()
    if (cwd && isAbsolute(cwd) && isDirectory(cwd)) return cwd
    if (!root) return homedir()
    if (cwd && !isAbsolute(cwd)) {
      const joined = join(root, cwd)
      if (isDirectory(joined)) return joined
    }
    return isDirectory(root) ? root : homedir()
  }

  /** E-031 — the agent running in `term` ended: publish `agentTab.exited` once, naming the tab,
   *  its project, the session bound at this moment and why. Every end goes through here — the
   *  agent handing the shell back (exit / crash by its status), the shell dying under it (crash),
   *  a requested kill (tab-closed), quit and workspace teardown (quit). Unlike the attention
   *  scanner, a requested kill is an end like any other. */
  private agentEnded(term: Term, reason: AgentExitReason): void {
    const agentId = term.agentId
    term.agentId = undefined
    term.agent = null
    term.stateScanner?.dispose()
    term.stateScanner = undefined
    if (!agentId || !term.tab) return
    publishPlatformEvent('agentTab.exited', {
      tabId: term.tab.tabId,
      projectId: term.tab.projectId,
      agentId,
      sessionId: sessionWatcher.sessionOf(term.id),
      reason
    })
  }

  /** E-033 — start reading what the agent `agentId` in `term` is doing; it starts idle. Skipped
   *  when the agent already ended (its end disposes the scanner). */
  private async watchAgentState(term: Term, agentId: string): Promise<void> {
    const provider = await agentProvider(agentId)
    if (!term.alive || term.agentId !== agentId) return
    term.stateScanner?.dispose()
    const scanner = new AgentStateScanner({ agent: provider, cols: term.cols, rows: term.rows }, (state) => {
      if (term.stateScanner === scanner) this.broadcast(EV.ptyAgentState, { termId: term.id, state: liveState(state) })
    })
    term.stateScanner = scanner
    this.broadcast(EV.ptyAgentState, { termId: term.id, state: 'idle' })
  }

  /** E-031 — the tab (and project) `termId` runs in, as the renderer reports it. */
  setTab(termId: string, tab: PtyTabRef): void {
    const term = this.terms.get(termId)
    if (term) term.tab = { tabId: tab.tabId, projectId: tab.projectId }
  }

  private broadcast(channel: string, payload: unknown): void {
    // T-037 — once the app is quitting the windows are being destroyed; a pty exit/attention
    // event that fires mid-teardown must not send into a webContents Electron is disposing
    // (it throws "Object has been destroyed" as an error attributed to no test). safeBroadcast
    // drops broadcasts after shutdown begins (see `setShuttingDown` in killAll below) and
    // guards the check-then-send race defensively.
    safeBroadcast(channel, payload)
  }

  // ─── T-116 (E-022): scrollback snapshot persistence ─────────────────────────────────

  /** What this term's snapshot file should contain: the scrollback it was REVIVED with plus
   *  everything this run has produced, trimmed to the same RING_MAX the live buffer obeys.
   *
   *  Cumulative-with-a-single-divider is the deliberate shape (see `snapshotBase`): a run that
   *  revives a terminal and then does nothing must not erase the history it just restored, but a
   *  restore→quit→restore cycle must not stack dividers either. Persisting base + buffer (never
   *  the divider) gives both, and the RING_MAX trim makes the cycle converge instead of growing. */
  private snapshotBytes(term: Term): string {
    const all = term.snapshotBase + term.buffer
    return all.length > RING_MAX ? all.slice(all.length - RING_MAX) : all
  }

  /** Queue an atomic (tmp + rename) write of this term's snapshot. Async on purpose — this runs
   *  on the output path — and chained per term so writes land in order. */
  private writeSnapshot(term: Term): void {
    if (term.snapTimer) {
      clearTimeout(term.snapTimer)
      term.snapTimer = undefined
    }
    term.snapDeadline = undefined
    if (!term.snapshotKey || !term.snapshotting) return
    const target = snapshotPath(term.snapshotKey)
    if (!target) return
    const data = this.snapshotBytes(term)
    term.snapChain = term.snapChain.then(async () => {
      try {
        await fsp.mkdir(join(target, '..'), { recursive: true })
        await writeFileAtomic(target, data)
      } catch (err) {
        console.error('[pty-manager] scrollback snapshot failed', target, err)
      }
    })
  }

  /** Debounced-with-a-ceiling scheduling: ~2 s after output stops, but never more than
   *  SNAPSHOT_MAX_MS after the first unsaved byte (an output storm must not starve the timer). */
  private scheduleSnapshot(term: Term): void {
    if (!term.snapshotKey || !term.snapshotting) return
    const now = Date.now()
    if (term.snapDeadline === undefined) term.snapDeadline = now + SNAPSHOT_MAX_MS
    if (term.snapTimer) clearTimeout(term.snapTimer)
    const wait = Math.max(0, Math.min(SNAPSHOT_IDLE_MS, term.snapDeadline - now))
    term.snapTimer = setTimeout(() => this.writeSnapshot(term), wait)
  }

  /** Delete a snapshot file. Sync (one unlink) and ENOENT-tolerant: it is called from the tab
   *  lifecycle, where "there was nothing to forget" is the common case. */
  private dropSnapshotFile(key: string): void {
    const target = snapshotPath(key)
    if (!target) return
    try {
      unlinkSync(target)
    } catch {
      /* never written, already gone, or unreadable — nothing to forget either way */
    }
  }

  /** A terminal→agent UPGRADE: this shell now belongs to an agent CLI, so it stops snapshotting
   *  and its file goes away (an agent tab never replays, so keeping ~200 KB for it is dead
   *  weight; forget-on-close would drop it anyway). `snapshotBase` is KEPT so a later `/exit`
   *  downgrade rewrites the pre-agent history rather than losing it. */
  private stopSnapshot(term: Term): void {
    if (!term.snapshotKey || !term.snapshotting) return
    term.snapshotting = false
    if (term.snapTimer) {
      clearTimeout(term.snapTimer)
      term.snapTimer = undefined
    }
    term.snapDeadline = undefined
    this.dropSnapshotFile(term.snapshotKey)
  }

  /** The `/exit` DOWNGRADE — a plain shell again, so snapshotting resumes. Also (T-300) the
   *  moment a command-launched term's launch command turns out NOT to be an agent.
   *
   *  T-128 — this is now load-bearing for BUTTON-launched agent tabs too: `startAgent` /
   *  `startAgentWithContext` hand over a `snapshotKey`, and such a term starts NON-snapshotting
   *  (see `create`), so this call is the moment its scrollback — farewell line included — starts
   *  being persisted. (Before T-128 those tabs had no key at all and their farewell died with the
   *  app: the T-116 "only after its next relaunch/revive" limit, which E-025 turned into a real
   *  bug once the farewell became the manual-recovery copy source.) Still keyless, hence still
   *  limited: a term spawned by `relaunch`/`reviveTab` on an AGENT-kind tab (Resume session). */
  private resumeSnapshot(term: Term): void {
    if (!term.snapshotKey || term.snapshotting) return
    term.snapshotting = true
    this.scheduleSnapshot(term)
  }

  /** T-116 — the QUIT flush. Synchronous by necessity: the will-quit sequence kills (and reaps)
   *  every child right after this, and a `killRequested` exit drops the term entry — with its
   *  ring buffer — from the map, so an async write would race the teardown it is meant to
   *  precede. Called BEFORE `killAll(true)` (see main/index.ts) and by `disposeAll`. */
  flushSnapshots(): void {
    const dir = snapshotDir()
    if (!dir) return
    let dirReady = false
    for (const term of this.terms.values()) {
      if (term.snapTimer) {
        clearTimeout(term.snapTimer)
        term.snapTimer = undefined
      }
      term.snapDeadline = undefined
      if (!term.snapshotKey || !term.snapshotting) continue
      const target = snapshotPath(term.snapshotKey)
      if (!target) continue
      try {
        if (!dirReady) {
          mkdirSync(dir, { recursive: true })
          dirReady = true
        }
        writeFileAtomicSync(target, this.snapshotBytes(term))
      } catch (err) {
        console.error('[pty-manager] scrollback flush failed', target, err)
      }
    }
  }

  /** T-116 — forget one tab's snapshot ("when I close it, we forget about the state").
   *  Keyed by TAB id, so it is driven by the tab lifecycle in the renderer, not by pty death:
   *  a moved tab keeps its id (snapshot follows it), a relaunched tab keeps its id (snapshot
   *  survives the new termId), and only a real close forgets. */
  forgetSnapshot(key: string): void {
    for (const term of this.terms.values()) {
      if (term.snapshotKey !== key) continue
      // The tab is gone: stop writing (its pty is being reaped in the same tick) and make sure
      // no in-flight chained write re-creates the file after the unlink below. Dropping the key
      // makes it final — a roster verdict still in flight (`resumeSnapshot`) cannot turn it back on.
      term.snapshotting = false
      delete term.snapshotKey
      if (term.snapTimer) {
        clearTimeout(term.snapTimer)
        term.snapTimer = undefined
      }
      term.snapDeadline = undefined
      term.snapshotBase = ''
    }
    this.dropSnapshotFile(key)
  }

  /** T-116 — boot/workspace-ready GC: delete every `state/scrollback/<key>` whose key owns no
   *  tab in ANY `state/<projectId>.json`. Covers a crash between "tab closed" and "file
   *  deleted", a hand-edited state file, and a state file deleted wholesale.
   *
   *  Read straight off the state DIRECTORY in main rather than waiting for the renderer's
   *  per-project hydration: at this point no tab exists yet in memory, and the files on disk are
   *  the authoritative list of owners. Async and fire-and-forget — nothing waits on it. */
  async gcSnapshots(): Promise<void> {
    const root = configStore.getRoot()
    if (!root) return
    const stateDir = join(root, '.pomade', 'state')
    const dir = join(stateDir, SNAPSHOT_DIR)
    let files: string[]
    try {
      files = await fsp.readdir(dir)
    } catch {
      return // no snapshots yet — nothing to collect
    }
    if (files.length === 0) return
    const owned = new Set<string>()
    let stateFiles: string[] = []
    try {
      stateFiles = (await fsp.readdir(stateDir)).filter((f) => f.endsWith('.json'))
    } catch {
      /* no state dir (fresh workspace) — every snapshot is an orphan */
    }
    for (const name of stateFiles) {
      try {
        const raw = await fsp.readFile(join(stateDir, name), 'utf8')
        const parsed = JSON.parse(raw) as {
          openTabs?: { id?: string }[]
          reopenStack?: { tab?: { id?: string } }[]
        }
        // Every tab id, regardless of kind: a doc tab can never own a snapshot, and being
        // permissive here is the safe direction (a snapshot is only deleted when NOTHING claims
        // it). An unreadable/corrupt state file therefore protects nothing — accepted.
        for (const tab of parsed.openTabs ?? []) if (tab?.id) owned.add(tab.id)
        // T-149 — a tab sitting on the persisted reopen stack still OWNS its snapshot: a reopen
        // replays it. Without this the boot GC would delete the scrollback of every stacked tab,
        // and a reopen after an app restart would come back with an empty terminal (acceptance §5).
        for (const e of parsed.reopenStack ?? []) if (e?.tab?.id) owned.add(e.tab.id)
      } catch {
        /* unreadable or malformed state file — skip it */
      }
    }
    for (const name of files) {
      // Leave stray `.tmp` files from an interrupted atomic write to the same rule as any other
      // orphan: their key (with the suffix) owns no tab, so they are collected here too.
      if (owned.has(name)) continue
      try {
        rmSync(join(dir, name), { force: true })
      } catch {
        /* raced with something else — the next boot retries */
      }
    }
  }

  /** T-116 — the full paint a (re)attaching xterm needs, in ONE call: restored scrollback, the
   *  `── session restored ──` divider, then this pty's live ring buffer. Deliberately NOT folded
   *  into `buffer()`, which stays "what this pty has emitted" (its callers — the agent-context
   *  hand-off, e2e oracles — must not suddenly see a previous session's output). */
  replay(termId: string): string {
    const term = this.terms.get(termId)
    if (!term) return ''
    // T-147 — the restored base is sanitized of zsh's transient partial-line markers (see
    // stripEolMarkers) so a width mismatch on replay can't leave a stray reverse-`%` line per
    // prompt; the divider and the live ring below it are emitted verbatim.
    return term.snapshotBase
      ? stripEolMarkers(term.snapshotBase) + RESTORE_DIVIDER + term.buffer
      : term.buffer
  }

  /** Spawn a shimmed interactive zsh.
   *
   *  `command` is SUBMITTED (typed with a trailing CR) once the shell has drawn its first output.
   *  `presetInput` (T-115) is the opposite gesture: text typed into the fresh shell's line editor
   *  WITHOUT a CR, so it sits there unsubmitted for the user to press Enter on (or edit, or erase).
   *  The two are mutually exclusive by construction — `command` wins and `presetInput` is dropped
   *  (nothing passes both: a revived tab either re-enters an agent conversation or is a plain shell
   *  getting its last executed command back).
   *
   *  T-116 — `snapshotKey` (the TAB id) opts this term into scrollback persistence; the renderer
   *  passes it for plain terminals and (T-128) for button-launched AGENT tabs. A term with a
   *  launch `command` starts non-snapshotting and begins once that command is known not to be an
   *  agent (T-300), or at an agent's `/exit` downgrade. `replaySnapshot` additionally
   *  loads the key's file NOW,
   *  so the (re)attaching pane repaints it above the restore divider — set only by a revive, so a
   *  new terminal or an in-run Relaunch never resurrects an old session's screen. */
  create(opts: {
    cwd: string
    tabId?: string
    projectId?: string
    command?: string
    presetInput?: string
    snapshotKey?: string
    replaySnapshot?: boolean
  }): { termId: string } {
    const termId = randomUUID()
    const cwd = this.resolveCwd(opts.cwd)
    const cols = 80
    const rows = 24
    const env = childEnv()
    // E-033 — a command run in this shell (an agent's tool call, an app command) can name its tab.
    if (typeof opts.tabId === 'string' && opts.tabId !== '') env.POMADE_TAB_ID = opts.tabId
    // The project the tab was opened in: a command run here (an agent writing a project-bound job file)
    // knows its project's stable id without Pomade's help.
    if (typeof opts.projectId === 'string' && opts.projectId !== '') env.POMADE_PROJECT_ID = opts.projectId
    // T-044: EVERY pty now loads the prompt-marker shim (see ensureZshIntegration). It was
    // previously agent-only (to detect an agent CLI exiting); the busy signal below needs
    // preexec/precmd markers on plain terminals too. The shim sources the user's real
    // startup files first, so a plain terminal behaves identically — it just also emits the
    // invisible OSC 7879 markers (agent start/exit detection now works on any shell as well).
    env.POMADE_USER_ZDOTDIR = process.env.ZDOTDIR ?? homedir()
    env.ZDOTDIR = ensureZshIntegration()
    const pty = ptySpawn('zsh', ['-il'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env
    })

    // T-116 — an invalid key is refused rather than sanitized (see isValidSnapshotKey), which
    // simply means this term does not snapshot.
    const snapshotKey =
      opts.snapshotKey && isValidSnapshotKey(opts.snapshotKey) ? opts.snapshotKey : undefined
    // Read the restored scrollback SYNCHRONOUSLY: `create` is a sync IPC handler and the file is
    // at most RING_MAX (~200 KB), so this is one read of a small file on the revive path — worth
    // it to have the paint ready before the pane can even ask for it (no empty-then-fill flash).
    let snapshotBase = ''
    if (snapshotKey && opts.replaySnapshot) {
      const source = snapshotPath(snapshotKey)
      try {
        if (source) snapshotBase = readFileSync(source, 'utf8')
      } catch {
        /* no snapshot for this tab (first run with the feature, GC'd, deleted) — nothing to replay */
      }
    }

    const term: Term = {
      id: termId,
      pty,
      buffer: '',
      alive: true,
      cols,
      rows,
      killRequested: false,
      busy: false,
      cwd,
      ...(snapshotKey ? { snapshotKey } : {}),
      // T-128 — a term spawned WITH a launch `command` starts NON-snapshotting: the command may
      // be an agent (button-launched agent tab, a relaunch/revive re-running it), and the roster
      // match that would say so is async — a slow match must not let the debounced writer persist
      // an agent's opening TUI frames first. The launch command's own verdict decides (see
      // `launchPending`): an agent keeps it off until the `/exit` downgrade's `resumeSnapshot`; a
      // plain command (`echo`, a build, a dev server) turns it ON, buffered output included.
      // `stopSnapshot` stays the authority for a later terminal→agent UPGRADE.
      snapshotting: !!snapshotKey && !opts.command,
      agent: null,
      snapshotBase,
      snapChain: Promise.resolve()
    }
    this.terms.set(termId, term)

    const setBusy = (value: boolean): void => {
      if (term.busy === value) return
      term.busy = value
      this.broadcast(EV.ptyBusy, { termId, busy: value })
    }

    // Type the command once the interactive shell has drawn its first output (prompt),
    // so aliases/functions from ~/.zshrc are already loaded.
    let commandSent = !opts.command
    // T-300 — true until the launch command's exec marker has been matched against the roster.
    // The FIRST exec of a command-launched term is that command (it is typed at the first prompt).
    let launchPending = !!opts.command
    const sendCommand = (): void => {
      if (commandSent || !term.alive) return
      commandSent = true
      pty.write(`${opts.command}\r`)
    }

    // T-115 (E-022) — pre-type (never submit) a revived terminal's last executed command.
    // Deliberately NOT the `sendCommand` heuristic above (120ms after the first byte of output):
    // that fires while the startup chain may still be running, and a stray CR-less line left in a
    // half-initialized zle is exactly how text gets eaten. This is MARKER-driven — the shim's FIRST
    // prompt marker means "the startup files are done and zsh is about to read a command line" —
    // which is the same signal the busy/cwd logic already trusts. One-shot: only the first prompt.
    const presetInput = opts.command ? undefined : opts.presetInput
    let presetPending = !!presetInput
    const sendPresetInput = (): void => {
      if (!presetPending) return
      presetPending = false
      if (!term.alive || !presetInput) return
      pty.write(presetInput) // no trailing CR — the user decides whether this ever runs
    }

    // Marker scanner (shimmed ptys only): pairs exec/prompt markers into agent start/exit
    // events. `pendingExec` is the roster match of the command currently running at the
    // shell; the prompt that follows it means that command ended. The match is async
    // (roster read) — chaining both broadcasts off the SAME promise keeps start→exit order
    // even for commands that finish before the match resolves. The chunk-split-safe framing +
    // classification is the kit's MarkerScanner (pomade-kit/scanners); this callback wires its
    // typed events to the busy/cwd/agent/session side effects.
    let pendingExec: { matched: Promise<{ id: string; name: string } | null>; at: number } | null =
      null
    const markerScanner = new MarkerScanner((ev) => {
      if (ev.kind === 'exec') {
        // A command is about to run at the foreground shell → busy (T-044).
        setBusy(true)
        const command = ev.command
        const matched = matchAgentCommand(command)
        pendingExec = { matched, at: Date.now() }
        const isLaunch = launchPending
        launchPending = false
        void matched.then(async (agent) => {
          // E-031 — an agent runs in this shell from here on (set before any await, so an agent
          // that ends at once is still seen as running when its prompt is handled).
          if (agent && term.alive) term.agentId = agent.id
          // T-115 (E-022) — report the command line itself, so the renderer can persist it as the
          // tab's `lastExec` (pre-typed, unsubmitted, on the next revive). Chained off the SAME
          // roster promise as the agent-start broadcast below, which is what lets the payload carry
          // the verdict: `agentLaunch` is the ONLY robust way to keep an agent's own launch command
          // out of a terminal's `lastExec`. The renderer's kind guard cannot do it — at the instant
          // this exec fires the tab is still `'terminal'` by construction (the upgrade is caused by
          // this very command), so ordering alone can never distinguish the two.
          this.broadcast(EV.ptyExec, { termId, command, agentLaunch: !!agent })
          // T-116 — the terminal→agent UPGRADE reaches main HERE (the same roster match that
          // raises ptyAgentStart), so this is where snapshotting stops: from now on this tab is
          // an agent tab, which never replays. Guarded inside, and a no-op for a term with no key
          // (an agent tab's own launch command takes this branch too).
          if (agent) this.stopSnapshot(term)
          // T-300 — the launch command is NOT an agent: this is a plain command terminal, so it
          // snapshots like any plain shell from here on (its output so far is in the ring).
          // A tab closed before the match resolved has no key left (`forgetSnapshot`): a no-op.
          else if (isLaunch) this.resumeSnapshot(term)
          if (agent && term.alive) {
            // E-025 — the launch cwd is CANONICALIZED (realpath) here, once, for both consumers
            // below. The shim's prompt marker reports zsh's LOGICAL $PWD (symlinks preserved),
            // but the CLIs key their session stores on the PHYSICAL process.cwd() — claude
            // encodes it into `projects/<encoded>`, codex writes it into `session_meta.cwd` —
            // so a logical key would make the watcher scan (and validation stat) a store the
            // CLI never writes. Probed against a /var→/private/var tmpdir: logical $PWD,
            // physical store key, silent capture-miss.
            let launchCwd = term.cwd
            try {
              launchCwd = await fsp.realpath(term.cwd)
            } catch {
              /* the directory vanished mid-launch — keep the reported form */
            }
            // The payload carries the CLI's cwd-AT-LAUNCH, which the renderer persists as
            // `TerminalTab.cwdAtLaunch` (the store-resolution key; `tab.cwd` keeps moving with
            // every later `cd`).
            term.agent = { id: agent.id, cwd: launchCwd }
            this.broadcast(EV.ptyAgentStart, {
              termId,
              agentId: agent.id,
              agentName: agent.name,
              command,
              cwd: launchCwd
            })
            // T-113/E-025 — register this term with the session watcher (both launch paths
            // reach this: a Pomade-launched agent gets its command TYPED into the shell).
            // E-025: a launch command that carries a resume id CLAIMS that id immediately —
            // deterministic ownership, no window, no timing (T-127's pin; claim-known-first on
            // a concurrent project-open revive is inherited from this being at-spawn). Fresh
            // launches register unarmed: capture waits for the renderer's first-prompt submit.
            const resume = command.match(/(?:^\S+\s+resume|--resume)\s+(\S+)/)
            sessionWatcher.start(termId, agent.id, launchCwd, resume ? resume[1] : undefined)
            // E-033 — read the agent's live state from here on (a new agent starts idle).
            await this.watchAgentState(term, agent.id)
          }
        })
      } else {
        // ev.kind === 'prompt'
        // E-020 (T-086) — a prompt payload carries `$PWD`; a null one (the payload-less marker
        // form) leaves the last known cwd in place rather than blanking it (a link should never
        // lose its base).
        // T-114 (E-022) — broadcast a cwd CHANGE so the renderer can persist it onto the tab
        // (`TerminalTab.cwd`), which is where a revive after a reload spawns the fresh PTY.
        // Only on a real change: a prompt marker arrives after EVERY command, and an
        // unconditional event would be a per-keystroke-frequency no-op storm.
        if (ev.cwd && ev.cwd !== term.cwd) {
          term.cwd = ev.cwd
          this.broadcast(EV.ptyCwd, { termId, cwd: ev.cwd })
        }
        // T-115 — the shell is at a prompt for the FIRST time: the startup chain is done and zle is
        // about to read a command line, so this is the moment to pre-type the restored text.
        sendPresetInput()
        // The shell drew a fresh prompt → nothing running in the foreground → idle (T-044).
        setBusy(false)
        const exec = pendingExec
        pendingExec = null
        // E-031 — the ended command's exit status: 0, or 130 (Ctrl+C), is the agent quitting;
        // anything else is a crash. Unknown (an older shim) counts as a plain exit.
        const ended: AgentExitReason = ev.status === undefined || ev.status === 0 || ev.status === 130 ? 'exit' : 'crash'
        if (exec) {
          // P-018 round-5 — a LONG foreground command finishing is itself attention ("the
          // task you left running is done"): plain terminals otherwise emit no turn-end byte
          // at all (sleep/builds/tests end silently). The ≥2s floor keeps instant commands
          // (ls, printf in e2e) silent; the renderer's existing gating (active tab never
          // dots, active project never counts) hides events the user is already watching.
          if (Date.now() - exec.at >= LONG_COMMAND_ATTENTION_MS) {
            this.broadcast(EV.ptyAttention, { termId })
          }
          void exec.matched.then((agent) => {
            if (agent) {
              this.agentEnded(term, ended)
              this.broadcast(EV.ptyAgentExit, { termId })
              // T-116 — the `/exit` DOWNGRADE: a plain shell again, so it snapshots again (the
              // pre-agent history in `snapshotBase` is still there and gets rewritten with it).
              this.resumeSnapshot(term)
              // T-113 — the agent handed the shell back: stop watching its store. `/exit`
              // flushes a last-prompt write with no turn, which must never be attributed.
              sessionWatcher.stop(termId)
            }
          })
        }
      }
    })

    // E-011 — attention scanner (the kit's AttentionScanner, pomade-kit/scanners). A separate pass
    // over the SAME output stream as the 7879 marker scanner (they never interfere: it classifies
    // 7879 as an ignored OSC and recognises every OSC terminator, so the shim's own BELs are never
    // seen as standalone). Every recognised signal (standalone BEL, OSC 9/99/777 notification)
    // raises ptyAttention; OSC 0/1/2 titles and our OSC 7879 markers do not. The raw bytes are
    // broadcast on pty:data untouched, so the BEL still reaches xterm.js for its own bell.
    const attentionScanner = new AttentionScanner(() =>
      this.broadcast(EV.ptyAttention, { termId })
    )

    pty.onData((data) => {
      term.buffer += data
      if (term.buffer.length > RING_MAX) {
        term.buffer = term.buffer.slice(term.buffer.length - RING_MAX)
      }
      this.broadcast(EV.ptyData, { termId, data })
      // (T-113's `sessionWatcher.noteOutput` correlation call is GONE — E-025: pty output is
      // not a user signal (TUIs stream constantly), so it plays no part in attribution.)
      // T-116 — persist the scrollback, debounced (~2 s idle) with a bounded ceiling. A Map-free
      // guarded no-op for every term that doesn't snapshot (agents, keyless terms).
      this.scheduleSnapshot(term)
      markerScanner.push(data)
      attentionScanner.push(data)
      term.stateScanner?.push(data)
      if (!commandSent) setTimeout(sendCommand, 120)
    })

    pty.onExit(({ exitCode }) => {
      term.alive = false
      // T-116 — land the last scrollback of a shell that died on its own (`exit`, a crash): the
      // TAB survives as a dead pane and keeps its id, so its next Relaunch/revive still replays
      // this. A REQUESTED kill writes nothing: a closing tab is about to have its snapshot
      // forgotten, and quit/teardown already flushed synchronously before killing anything.
      if (term.killRequested) {
        if (term.snapTimer) {
          clearTimeout(term.snapTimer)
          term.snapTimer = undefined
        }
      } else {
        this.writeSnapshot(term)
      }
      // E-031 — an agent still running when its shell died on its own crashed with it (a
      // requested kill already reported its own end).
      this.agentEnded(term, 'crash')
      // T-113 — the pty is gone (natural exit, kill, tab close, quit): nothing to attribute
      // to this term any more.
      sessionWatcher.stop(termId)
      // E-011 — a natural exit (the process died / the user typed `exit`) counts as attention;
      // a requested kill (tab closing, bulk-stop, quit, workspace teardown) does not — that's a
      // user action on that terminal, not the terminal asking to be looked at.
      if (!term.killRequested) this.broadcast(EV.ptyAttention, { termId })
      this.broadcast(EV.ptyExit, { termId, exitCode })
      // If this exit was because the tab was closing (kill requested), no tab references
      // it any more — drop the entry so the map + ring buffer don't grow for the app's life.
      // A natural exit (no kill) keeps the entry so its dead pane / relaunch still works.
      if (term.killRequested) this.terms.delete(termId)
      // T-037 — wake any quit-time drain waiting on this child's actual exit.
      const waiter = this.drainWaiters.get(termId)
      if (waiter) {
        this.drainWaiters.delete(termId)
        waiter()
      }
    })

    return { termId }
  }

  write(termId: string, data: string): void {
    const term = this.terms.get(termId)
    if (term?.alive) term.pty.write(data)
  }

  resize(termId: string, cols: number, rows: number): void {
    const term = this.terms.get(termId)
    if (!term?.alive) return
    if (cols < 1 || rows < 1) return
    term.cols = cols
    term.rows = rows
    term.stateScanner?.resize(cols, rows)
    try {
      term.pty.resize(cols, rows)
    } catch {
      /* pty may have exited between checks */
    }
  }

  kill(termId: string): void {
    const term = this.terms.get(termId)
    if (!term) return
    // T-116 — a pending snapshot timer must not outlive the map entry (a relaunch drops a dead
    // entry, a close reaps a live one); the file's fate is decided by forgetSnapshot, not here.
    if (term.snapTimer) {
      clearTimeout(term.snapTimer)
      term.snapTimer = undefined
    }
    if (term.alive) {
      // Live term whose tab is closing: mark it so onExit reaps the map entry.
      term.killRequested = true
      this.agentEnded(term, 'tab-closed')
      try {
        term.pty.kill()
      } catch {
        /* already gone */
      }
    } else {
      // Already dead (e.g. the tab hosting a naturally-exited term is now closing, or a
      // dead entry is being relaunched under a new id) — drop it now; nothing references it.
      this.terms.delete(termId)
    }
  }

  /** Types `/exit` + Enter — the graceful "leave the agent" gesture. */
  sendExit(termId: string): void {
    this.write(termId, '/exit\r')
  }

  buffer(termId: string): string {
    return this.terms.get(termId)?.buffer ?? ''
  }

  list(): { termId: string; alive: boolean; busy: boolean; cwd: string }[] {
    return [...this.terms.values()].map((t) => ({
      termId: t.id,
      alive: t.alive,
      busy: t.busy,
      cwd: t.cwd
    }))
  }

  /** E-028 — agents running in live terminals now: roster id, physical launch cwd, what it is doing
   *  when the scanner has read it (T-323; absent = not known), and the terminal shell's pid. */
  liveAgents(): { termId: string; agentId: string; cwd: string; state?: LiveAgentState; pid: number }[] {
    return [...this.terms.values()]
      .filter((t) => t.alive && t.agent !== null)
      .map((t) => {
        const state = readAgentState(t.stateScanner?.state)
        return { termId: t.id, agentId: t.agent!.id, cwd: t.agent!.cwd, ...(state ? { state } : {}), pid: t.pty.pid }
      })
  }

  /** E-020 (T-086) — the shell's current working directory ('' for an unknown term). */
  cwd(termId: string): string {
    return this.terms.get(termId)?.cwd ?? ''
  }

  /** Kill every live pty. `finalShutdown` (app quit) additionally suppresses further
   *  broadcasts and *awaits* each child's real exit before resolving, so the quit sequence
   *  can hold off app.exit() until node-pty's children are actually reaped. Without this the
   *  process force-exited while children were still dying and a late exit event fired against
   *  a torn-down window — surfacing as the "error was not a part of any test" teardown flake
   *  (T-037). A workspace switch passes finalShutdown=false: the app keeps running, so
   *  broadcasts must resume and we don't block. Bounded so a wedged child can't hang the quit. */
  async killAll(finalShutdown = false): Promise<void> {
    if (finalShutdown) setShuttingDown()
    const drained: Promise<void>[] = []
    for (const term of this.terms.values()) {
      if (!term.alive) continue
      // E-011: mark as a requested kill so the resulting exit does NOT raise a spurious
      // attention event (mass teardown on quit / workspace switch is not "wants attention").
      term.killRequested = true
      // E-031 — reported now, before the windows go: Pomade quitting (or closing the workspace).
      this.agentEnded(term, 'quit')
      const waited = new Promise<void>((resolve) => this.drainWaiters.set(term.id, resolve))
      drained.push(waited)
      try {
        term.pty.kill()
      } catch {
        // Already gone — its onExit may never fire, so settle the waiter now.
        const w = this.drainWaiters.get(term.id)
        if (w) {
          this.drainWaiters.delete(term.id)
          w()
        }
      }
    }
    if (!finalShutdown || drained.length === 0) return
    await Promise.race([
      Promise.all(drained),
      new Promise<void>((resolve) => setTimeout(resolve, 2000))
    ])
  }

  /** E-006 (T-027) — full teardown for a workspace switch: kill every live pty AND drop
   *  the map so no dead entries (or their ring buffers) leak from the old workspace. PTYs
   *  are per-workspace, so a switch tears them down deliberately (documented exception to
   *  the "PTYs live for the app's life" invariant). The app stays alive, so this is NOT a
   *  final shutdown — broadcasts keep flowing and we don't block on the children. */
  disposeAll(): void {
    // T-116 — flush scrollback FIRST, synchronously: this runs as a workspace-teardown hook, so
    // the ring buffers are about to be dropped AND `configStore.getRoot()` is about to point at
    // the new workspace (changeRoot commits the root only after the hooks). Both make an async
    // write land too late, or in the wrong workspace.
    this.flushSnapshots()
    void this.killAll(false)
    this.terms.clear()
    // T-113 — session watches are per-term, so they die with the ptys. Dropping them here (one
    // teardown hook, not two) also stops the poll timer and releases the store snapshots.
    sessionWatcher.disposeAll()
  }
}

export const ptyManager = new PtyManager()

export function registerPtyManager(ipc: typeof ipcMain): void {
  // T-115 — `presetInput`: text typed into the fresh shell WITHOUT a CR (see `create`).
  // T-116 — `snapshotKey` / `replaySnapshot`: scrollback persistence + revive replay.
  defineHandler(ipc, CH.pty.create, (_e, opts) => ptyManager.create(opts))
  defineHandler(ipc, CH.pty.write, (_e, termId, data) => {
    ptyManager.write(termId, data)
  })
  defineHandler(ipc, CH.pty.resize, (_e, termId, cols, rows) => {
    ptyManager.resize(termId, cols, rows)
  })
  defineHandler(ipc, CH.pty.kill, (_e, termId) => {
    ptyManager.kill(termId)
  })
  defineHandler(ipc, CH.pty.sendExit, (_e, termId) => {
    ptyManager.sendExit(termId)
  })
  defineHandler(ipc, CH.pty.buffer, (_e, termId) => ptyManager.buffer(termId))
  // T-116 (E-022) — the attach paint: restored scrollback + divider + ring buffer, in one call.
  defineHandler(ipc, CH.pty.replay, (_e, termId) => ptyManager.replay(termId))
  // T-116 (E-022) — "when I close it, we forget about the state": drop a TAB's snapshot file.
  defineHandler(ipc, CH.pty.forgetSnapshot, (_e, key) => {
    ptyManager.forgetSnapshot(key)
  })
  // E-025 — prompt-gated session attribution: the renderer's first-prompt-submit signal opens a
  // bounded ±window on the term's session store; `claimSession` seeds ownership (manual bind).
  defineHandler(ipc, CH.pty.armSessionWindow, (_e, termId, opts) => {
    sessionWatcher.armWindow(termId, opts)
  })
  defineHandler(ipc, CH.pty.claimSession, (_e, termId, sessionId) => {
    sessionWatcher.claim(termId, sessionId)
  })
  defineHandler(ipc, CH.pty.list, () => ptyManager.list())
  // E-031 — the tab a term runs in, named by `agentTab.exited`.
  defineHandler(ipc, CH.pty.setTab, (_e, termId, tab) => {
    ptyManager.setTab(termId, tab)
  })
  // E-020 (T-086) — cwd surface for the terminal link provider's first resolution step.
  defineHandler(ipc, CH.pty.cwd, (_e, termId) => ptyManager.cwd(termId))

  // PTYs die with the app: children are killed AND drained on quit by the will-quit sequence
  // in index.ts (which awaits ptyManager.killAll(true) before app.exit), so no orphaned shells
  // linger and no late exit event races the teardown (T-037).
}
