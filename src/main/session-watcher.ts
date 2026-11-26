// Pomade — SessionWatcher (main process). T-113 built it as a recency guesser; E-025 reworked
// it into a per-tab CONFIRMER.
//
// The defect this rework replaces (T-127, P1 data-integrity): attributing a new transcript to
// "whichever term produced pty output most recently" has nothing to do with which tab the USER
// acted in — with ≥2 agents in one cwd the pick was a coin-flip, the mis-pick persisted into
// `resumeSessionId`, and the next reload ran `claude --resume <other-id>`, appending the user's
// input to ANOTHER session's transcript on disk.
//
// E-025 principle: stop INFERRING the process→session link from timing; drive attribution from
// the signal Pomade owns — it routes every keystroke to a specific tab's pty, so it knows which
// tab the user prompted. The disk only FILLS IN the id value for a tab a user action already
// identified. When it's ambiguous, REFUSE and signal (`pty:session-unbound`) — never guess.
//
// Mechanism:
//   • `start()` registers an agent term (agent kind + cwd-at-launch → its ONE store directory).
//     A launch that carries an explicit resume id CLAIMS it immediately (T-127's pin): resume is
//     fully deterministic, no window, no timing.
//   • `armWindow()` — called on a first-prompt SUBMIT in that tab (renderer keystroke signal,
//     xterm onKey + paste; NEVER onData/pty output, T-123) — opens a bounded, BIDIRECTIONAL
//     ±SESSION_BIND_WINDOW_MS window on the term's store. Two structurally distinct modes:
//       'await-new'      — fresh session / a clear / a fork: a NEW transcript (birthtime
//                          inside the ±window) is expected. Its bind also reports the parent
//                          the transcript records (`forkedFrom` — claude-transcript.ts,
//                          codex-rollout.ts), the evidence an app's "this is a fork" rests on.
//                          A claude transcript of a background session (claude's `/fork`
//                          copy) is never a candidate: the tab keeps its own session.
//       'adopt-existing' — in-session `/resume`: an EXISTING transcript starts GROWING inside
//                          the window, or the explicit `/resume <id>` argument is validated on
//                          disk and adopted with no window at all.
//   • Polling (readdir + stat snapshots) runs ONLY while ≥1 window is open. There is no
//     always-on attribution any more: a transcript appearing with no window open belongs to
//     nobody Pomade can identify, and is deliberately ignored.
//
// Disambiguation (locked with the Owner 2026-08-19):
//   • Ownership invariant — an id bound to one term is NEVER a candidate for another while the
//     ownership stands; an appearing id that is already owned is ignored, not stolen.
//   • Submit-order pairing — the AwaitingId tabs of one store form a queue ordered by submit
//     time; a new file binds the EARLIEST still-open eligible window (a transcript is born at
//     the first submission, so file-creation order follows submission order — evidence, not a
//     guess). The later submitter KEEPS waiting for the next file in its own window.
//   • The ONLY refuse case: two submits closer than SUBMIT_TIE_MS (pairwise alignment would be
//     a coin-flip) → every tied tab goes Unbound. A window expiring with no bind → Unbound.
//
// READ-ONLY on the stores, always: this module opens and stats files, and never writes,
// renames, or deletes anything. A missing configDir / `projects/` / encoded-cwd dir is the
// NORMAL pre-first-message state (T-112), never an error.

import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'

import { SESSION_BIND_WINDOW_MS } from '@shared/types'
import { agentSessionStore, encodeCwd, type SessionStoreKind } from './agent-service'
import { readClaudeHead, type ClaudeTranscriptHead } from './claude-transcript'
import { readCodexMeta as readCodexLine0, type CodexRolloutMeta } from './codex-rollout'
import { tunedMs } from './test-tuning'

// e2e shrinks the tick via POMADE_TEST_POLL_MS (docs/contracts/test-hooks.md; unset ⇒
// production value). The tick only decides how SOON the watcher looks — every verdict compares
// submit/birth timestamps, so no tie/window semantics move with it.
const POLL_MS = tunedMs('POMADE_TEST_POLL_MS', 1000)
// Two first-prompt submits in ONE store closer than this cannot be ordered reliably (renderer
// timestamps, IPC jitter) — pairwise alignment would be a coin-flip, so both tabs are refused.
export const SUBMIT_TIE_MS = 750
// Codex rollouts live in nested date dirs (`sessions/<yyyy>/<mm>/<dd>/<file>.jsonl`). Bound the
// walk hard: a tick must never turn into an unbounded recursive crawl of a huge history.
const CODEX_MAX_DEPTH = 4
const CODEX_MAX_FILES = 5000

interface FileInfo {
  size: number
  /** Creation time (birthtime where the fs reports one, else mtime — a transcript's mtime only
   *  ever moves FORWARD from its birth, so the fallback can only shrink the pre-window reach). */
  bornAt: number
}

type WindowMode = 'await-new' | 'adopt-existing'

interface BindWindow {
  mode: WindowMode
  submitAt: number
  expiresAt: number
  /** Files present in the store when the window opened — the 'adopt-existing' candidate pool
   *  (a NEW file is never an in-session `/resume` target; it belongs to 'await-new' windows). */
  preexisting: Set<string>
  /** Unowned preexisting files seen GROWING while this window is open. */
  grown: Set<string>
}

interface AgentTerm {
  termId: string
  agentId: string
  /** The cwd the agent CLI is running in (cwd-AT-LAUNCH — the store key). */
  cwd: string
  storeKind: SessionStoreKind
  /** The single directory scanned for this term (claude: cwd-keyed; codex: the whole store). */
  scanDir: string
  /** The id this term OWNS (bound / claimed). Ownership is mirrored in `owners`. */
  sessionId?: string
  window?: BindWindow
}

const terms = new Map<string, AgentTerm>()
// termIds whose store is still being resolved (an async roster read): a stop() that lands
// during that window must win, so it removes the id from here and the resolver bails.
const starting = new Set<string>()
// An armWindow that arrives while start() is still resolving is queued and applied after.
const pendingArms = new Map<string, ArmOpts>()
// Per-scan-directory snapshot of the last listing (sizes + birth times). Refreshed on every
// window arm (fresh growth baseline) and on every poll tick while a window is open.
const dirFiles = new Map<string, Map<string, FileInfo>>()
// OWNERSHIP registry: `${scanDir}\u0000${sessionId}` → owning termId. An owned id is never a
// bind candidate for any other term while the owner's entry stands (tab live & bound).
const owners = new Map<string, string>()
// RETIRED ids: every id whose ownership was RELEASED this run (a clear or fork rebind
// orphaned its pre-clear transcript; a pty died holding its id). A retired id is NEVER an
// 'await-new' candidate: its file was born recently enough to sit inside another tab's
// bidirectional ±window, but it is a KNOWN previous session, not anybody's NEW one — adopting
// it would resurrect the T-127 wrong-bind hazard one step removed (surfaced by the /fork e2e:
// the pre-clear orphan out-paired the genuinely new transcript). It stays adoptable
// EXPLICITLY: an in-session `/resume` (argument or growth) and a launch claim re-own it,
// clearing the retirement.
const retired = new Set<string>()
// Codex rollout metas are immutable once written — cache the successful reads.
const codexMeta = new Map<string, CodexRolloutMeta>()
// Claude transcript heads (first message line) are immutable once written — cache the decided ones.
const claudeHeads = new Map<string, ClaudeTranscriptHead>()

let timer: NodeJS.Timeout | null = null
let ticking = false
/** A bind as main reports it: `forkedFrom` is the parent a NEW transcript records (a fork). */
export interface SessionBind {
  termId: string
  sessionId: string
  forkedFrom?: string
}

let emit: (payload: SessionBind) => void = () => {}
let emitUnbound: (payload: { termId: string }) => void = () => {}

export interface ArmOpts {
  mode: WindowMode
  submitAt: number
  resumeId?: string
}

function ownerKey(scanDir: string, sessionId: string): string {
  return `${scanDir}\u0000${sessionId}`
}

function releaseOwnership(term: AgentTerm): void {
  if (!term.sessionId) return
  const key = ownerKey(term.scanDir, term.sessionId)
  if (owners.get(key) === term.termId) {
    owners.delete(key)
    retired.add(key) // a once-bound id is never anybody's NEW session again (see `retired`)
  }
}

/** Bind/claim `sessionId` to `term`: releases (retires) the term's previous id (a rebind after
 *  `/clear` closes the old transcript, untouched), records ownership, closes any open window.
 *  True when the term's id changed. */
function adopt(term: AgentTerm, sessionId: string, broadcast: boolean): boolean {
  term.window = undefined
  if (term.sessionId === sessionId) return false // re-confirmation — nothing changed, nothing to emit
  releaseOwnership(term)
  term.sessionId = sessionId
  const key = ownerKey(term.scanDir, sessionId)
  owners.set(key, term.termId)
  retired.delete(key) // an explicit adoption (resume/claim) un-retires the id
  if (broadcast) emit({ termId: term.termId, sessionId })
  return true
}

/** A claude transcript's first message (claude-transcript.ts), cached once written. */
async function claudeHead(file: string): Promise<ClaudeTranscriptHead> {
  const cached = claudeHeads.get(file)
  if (cached) return cached
  const head = await readClaudeHead(file)
  if (head.decided) claudeHeads.set(file, head)
  return head
}

function closeUnbound(term: AgentTerm): void {
  term.window = undefined
  emitUnbound({ termId: term.termId })
}

// ─── store scans (read-only) ──────────────────────────────────────────────────
/** A directory that does not exist yet is an EMPTY store, not an unknown one: the store dir is
 *  normally ABSENT when the agent launches and appears carrying the very transcript we want to
 *  attribute. Any OTHER error (permissions, fd exhaustion) IS unknown — the tick is skipped. */
function absentMeansEmpty(err: unknown): Map<string, FileInfo> | null {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR' ? new Map() : null
}

function toInfo(st: import('node:fs').Stats): FileInfo {
  return { size: st.size, bornAt: st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs }
}

/** Claude-style: one flat directory of `<sessionId>.jsonl` transcripts. */
async function listClaude(dir: string): Promise<Map<string, FileInfo> | null> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    return absentMeansEmpty(err)
  }
  const out = new Map<string, FileInfo>()
  for (const entry of entries) {
    // T-112: the same folder can also hold `memory/` and per-session `<id>/` DIRECTORIES.
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const full = join(dir, entry.name)
    try {
      out.set(full, toInfo(await fs.stat(full)))
    } catch {
      /* vanished mid-scan — ignore */
    }
  }
  return out
}

/** Codex: `sessions/<nested date dirs>/*.jsonl`. Bounded by depth and file count. */
async function listCodex(root: string): Promise<Map<string, FileInfo> | null> {
  const out = new Map<string, FileInfo>()
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > CODEX_MAX_DEPTH || out.size >= CODEX_MAX_FILES) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.size >= CODEX_MAX_FILES) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          out.set(full, toInfo(await fs.stat(full)))
        } catch {
          /* vanished mid-scan — ignore */
        }
      }
    }
  }
  try {
    await fs.readdir(root)
  } catch (err) {
    return absentMeansEmpty(err)
  }
  await walk(root, 0)
  return out
}

/** A codex rollout's identity from its line 0 (`codex-rollout.ts`). Cached once read
 *  successfully (line 0 is immutable). */
async function readCodexMeta(file: string): Promise<CodexRolloutMeta | null> {
  const cached = codexMeta.get(file)
  if (cached) return cached
  const parsed = await readCodexLine0(file)
  if (parsed) codexMeta.set(file, parsed)
  return parsed // null: a partially flushed first line — the next tick re-reads it
}

async function listStore(dir: string, kind: SessionStoreKind): Promise<Map<string, FileInfo> | null> {
  return kind === 'codex' ? await listCodex(dir) : await listClaude(dir)
}

/** Does `sessionId`'s transcript exist in this term's store? (Explicit `/resume <id>` and
 *  launch-time claims validate before adopting — a nonexistent id must never bind.) */
async function sessionOnDisk(term: AgentTerm, sessionId: string): Promise<boolean> {
  if (term.storeKind === 'codex') {
    const files = await listCodex(term.scanDir)
    if (!files) return false
    for (const file of files.keys()) {
      const meta = await readCodexMeta(file)
      if (meta && meta.sessionId === sessionId && meta.cwd === term.cwd) return true
    }
    return false
  }
  try {
    await fs.access(join(term.scanDir, `${sessionId}.jsonl`))
    return true
  } catch {
    return false
  }
}

// ─── window resolution ────────────────────────────────────────────────────────
/** One scan-and-resolve pass over `dir` for every term whose window watches it. */
async function scanDirOnce(dir: string): Promise<void> {
  const holders = [...terms.values()].filter((t) => t.scanDir === dir)
  if (!holders.some((t) => t.window)) return
  const kind = holders[0].storeKind
  const now = await listStore(dir, kind)
  if (!now) return // genuinely unreadable (not merely absent) — retry next tick
  const prev = dirFiles.get(dir)
  dirFiles.set(dir, now)

  // Growth pass — feeds every open 'adopt-existing' window's candidate pool.
  if (prev) {
    for (const [file, info] of now) {
      const p = prev.get(file)
      if (!p || p.size === info.size) continue
      for (const t of holders) {
        const w = t.window
        if (w && w.mode === 'adopt-existing' && w.preexisting.has(file)) w.grown.add(file)
      }
    }
  }

  // Candidate pass — earliest-born file first, so pairing follows creation order (which follows
  // submission order: a transcript is born at the first submission).
  const candidates: { file: string; sessionId: string; bornAt: number; cwd?: string; forkedFrom?: string }[] = []
  for (const [file, info] of now) {
    if (kind === 'codex') {
      const meta = await readCodexMeta(file)
      // A sub-agent's rollout is born inside its parent's turn, in the same cwd — never a tab's.
      if (!meta || meta.subagent) continue
      candidates.push({
        file,
        sessionId: meta.sessionId,
        bornAt: info.bornAt,
        cwd: meta.cwd,
        ...(meta.forkedFrom ? { forkedFrom: meta.forkedFrom } : {})
      })
    } else {
      candidates.push({ file, sessionId: basename(file, '.jsonl'), bornAt: info.bornAt })
    }
  }
  candidates.sort((a, b) => a.bornAt - b.bornAt)

  for (const cand of candidates) {
    // Ownership invariant — an owned id is ignored, not stolen (self-owned included: a term
    // re-confirming its own transcript's growth has nothing to bind).
    if (owners.has(ownerKey(dir, cand.sessionId))) continue
    // A RETIRED id (once bound this run, since released) is a known PREVIOUS session: it can
    // never be an 'await-new' candidate, only an explicit 'adopt-existing' target.
    const isRetired = retired.has(ownerKey(dir, cand.sessionId))
    const eligibleNow = (): AgentTerm[] =>
      holders.filter((t) => {
        const w = t.window
        if (!w) return false
        // Codex rollouts carry no cwd in their path — session_meta.cwd is the only key.
        if (kind === 'codex' && cand.cwd !== t.cwd) return false
        return w.mode === 'await-new'
          ? !isRetired &&
              cand.bornAt >= w.submitAt - SESSION_BIND_WINDOW_MS &&
              cand.bornAt <= w.submitAt + SESSION_BIND_WINDOW_MS
          : w.grown.has(cand.file)
      })
    let eligible = eligibleNow()
    if (eligible.length === 0) continue
    // A new claude transcript's first message says whether it is a background session (claude's
    // `/fork` copy — never a tab's NEW session) and which session it was branched from (T-327).
    let forkedFrom = cand.forkedFrom
    if (kind !== 'codex' && eligible.some((t) => t.window!.mode === 'await-new')) {
      const first = await claudeHead(cand.file)
      forkedFrom = first.forkedFrom ?? undefined
      // Re-read the windows: they may have opened or closed during the read.
      eligible = eligibleNow().filter((t) => !first.background || t.window!.mode !== 'await-new')
      if (eligible.length === 0 || owners.has(ownerKey(dir, cand.sessionId))) continue
    }
    eligible.sort((a, b) => a.window!.submitAt - b.window!.submitAt)
    if (eligible.length > 1) {
      // Submit-order pairing: the earliest still-open submit takes this file; later submitters
      // KEEP waiting for the next file in their own windows. Refuse ONLY the true tie — submits
      // too close to order — and refuse every member of the tied leading cluster.
      const head = eligible[0].window!.submitAt
      const tied = eligible.filter((t) => t.window!.submitAt - head <= SUBMIT_TIE_MS)
      if (tied.length > 1) {
        for (const t of tied) closeUnbound(t)
        continue // the file stays unbound; remaining windows retry on the next candidates/ticks
      }
    }
    const winner = eligible[0]
    if (winner.window!.mode === 'adopt-existing') adopt(winner, cand.sessionId, true)
    else if (adopt(winner, cand.sessionId, false)) {
      emit({ termId: winner.termId, sessionId: cand.sessionId, ...(forkedFrom ? { forkedFrom } : {}) })
    }
  }

  // Expiry pass — a window past its bound with no bind resolves to Unbound (refuse, signal).
  const nowMs = Date.now()
  for (const t of holders) {
    if (t.window && nowMs > t.window.expiresAt) closeUnbound(t)
  }
}

async function tick(): Promise<void> {
  if (ticking) return // a slow store must never let ticks pile up on top of each other
  ticking = true
  try {
    const dirs = new Set<string>()
    for (const t of terms.values()) if (t.window) dirs.add(t.scanDir)
    for (const dir of dirs) await scanDirOnce(dir)
  } finally {
    ticking = false
  }
  stopTimerIfIdle()
}

function anyWindowOpen(): boolean {
  for (const t of terms.values()) if (t.window) return true
  return false
}

function ensureTimer(): void {
  if (timer || !anyWindowOpen()) return
  timer = setInterval(() => void tick(), POLL_MS)
  timer.unref() // never a reason for the process to stay alive
}

function stopTimerIfIdle(): void {
  if (anyWindowOpen() || !timer) return
  clearInterval(timer)
  timer = null
}

async function doArm(term: AgentTerm, opts: ArmOpts): Promise<void> {
  // Explicit `/resume <id>`: adopt-existing's no-window fast path — validate on disk, adopt.
  // A nonexistent id is NEVER bound (the CLI's resume would fail); fall through to a normal
  // adopt-existing window instead (its expiry surfaces the failure as Unbound).
  if (opts.mode === 'adopt-existing' && opts.resumeId) {
    if (await sessionOnDisk(term, opts.resumeId)) {
      const key = ownerKey(term.scanDir, opts.resumeId)
      const owner = owners.get(key)
      if (!owner || owner === term.termId) {
        adopt(term, opts.resumeId, true)
        return
      }
      // Owned by another live tab — refuse-don't-steal. The user resumed a transcript another
      // tab is bound to; surface it as Unbound rather than silently double-binding one id.
      closeUnbound(term)
      return
    }
  }
  // Fresh growth baseline + the 'adopt-existing' candidate pool: list the store NOW. (Also what
  // makes the ±window BIDIRECTIONAL for 'await-new': pre-existing files qualify by birthtime.)
  const snapshot = await listStore(term.scanDir, term.storeKind)
  if (snapshot) dirFiles.set(term.scanDir, snapshot)
  term.window = {
    mode: opts.mode,
    submitAt: opts.submitAt,
    expiresAt: opts.submitAt + SESSION_BIND_WINDOW_MS,
    preexisting: new Set((snapshot ?? dirFiles.get(term.scanDir) ?? new Map()).keys()),
    grown: new Set()
  }
  ensureTimer()
  void tick() // immediate pass — a pre-window transcript binds without waiting a poll interval
}

// ─── public surface (called from pty-manager) ─────────────────────────────────
export const sessionWatcher = {
  /** Route emitted binds out. `pty-manager` registers its own `broadcast` so a late session id
   *  inherits the T-037 shutdown guard instead of hitting a torn-down webContents. */
  setEmitter(fn: (payload: SessionBind) => void): void {
    emit = fn
  },

  /** Route window refusals out (same shutdown-guard reasoning as setEmitter). */
  setUnboundEmitter(fn: (payload: { termId: string }) => void): void {
    emitUnbound = fn
  },

  /** An agent command started at `termId`'s shell, in `cwd` (the cwd-AT-LAUNCH — the store
   *  key). `expectSessionId` is the resume id parsed from the launch command (`--resume <id>` /
   *  `codex resume <id>`): the term CLAIMS it immediately — deterministic, no window, no timing
   *  (T-127's pin; also what makes claim-known-first hold on a concurrent project-open revive:
   *  every known id is owned at spawn, before any prompt can open a listener). Idempotent. */
  start(termId: string, agentId: string, cwd: string, expectSessionId?: string): void {
    if (terms.has(termId) || starting.has(termId)) return
    starting.add(termId)
    void (async () => {
      const store = await agentSessionStore(agentId)
      // `delete` returns false when stop() already ran for this term while we resolved.
      if (!starting.delete(termId)) return
      if (!store || !cwd) return
      const scanDir =
        store.kind === 'codex'
          ? join(store.configDir, 'sessions')
          : join(store.configDir, 'projects', encodeCwd(cwd))
      const term: AgentTerm = { termId, agentId, cwd, storeKind: store.kind, scanDir }
      terms.set(termId, term)
      if (expectSessionId) adopt(term, expectSessionId, false) // claim — renderer already knows
      const queued = pendingArms.get(termId)
      if (queued) {
        pendingArms.delete(termId)
        await doArm(term, queued)
      }
    })()
  },

  /** A first-prompt SUBMIT happened in this term's tab: open its prompt-gated bind window
   *  (see the header for the two modes). One window per term — a re-arm replaces. */
  armWindow(termId: string, opts: ArmOpts): void {
    if (starting.has(termId)) {
      pendingArms.set(termId, opts) // start() is still resolving the store — apply after
      return
    }
    const term = terms.get(termId)
    if (!term) return
    void doArm(term, opts)
  },

  /** Seed ownership for a term (the ⚠️ popover's manual bind — validated by the renderer). */
  claim(termId: string, sessionId: string): void {
    const term = terms.get(termId)
    if (!term || !sessionId) return
    const owner = owners.get(ownerKey(term.scanDir, sessionId))
    if (owner && owner !== termId) return // ownership invariant — never steal
    adopt(term, sessionId, false)
  },

  /** E-031 — the session id `termId` owns right now (bound or claimed), or null. */
  sessionOf(termId: string): string | null {
    return terms.get(termId)?.sessionId ?? null
  },

  /** The agent exited back to its shell, or the pty died / was killed. Ownership is released:
   *  the tab either reverted to a plain terminal (triple cleared) or froze its persisted id,
   *  which a later revive re-claims via `start(expectSessionId)`. */
  stop(termId: string): void {
    starting.delete(termId)
    pendingArms.delete(termId)
    const term = terms.get(termId)
    if (!term) return
    releaseOwnership(term)
    terms.delete(termId)
    // Drop the snapshot once nothing scans that directory any more (bounded memory).
    if (![...terms.values()].some((t) => t.scanDir === term.scanDir)) {
      dirFiles.delete(term.scanDir)
    }
    stopTimerIfIdle()
  },

  /** Workspace teardown / app quit: forget everything and stop polling. */
  disposeAll(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    terms.clear()
    starting.clear()
    pendingArms.clear()
    dirFiles.clear()
    owners.clear()
    retired.clear()
    codexMeta.clear()
    claudeHeads.clear()
  }
}
