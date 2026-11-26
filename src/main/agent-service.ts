// Pomade — AgentService (main process). Wave 2b.
// Owns the agent roster, the command check (one `zsh -ilc` per roster build; agent-check-core),
// command overrides (.pomade/agents.json), and session-history scanning of each agent's own storage.
//
// E-033 — the roster comes from the installed agents app (`pomade-agents`' `roster.list`, through
// the broker) when it answers, and from Pomade's own folder scan otherwise (PLATFORM rule 7): the
// built-ins claude + codex, plus one per <workspace>/Agents/<name>/ with a CLAUDE.md, excluding
// _shared and *template*. The overrides apply to either source.

import { app, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { join, basename, dirname } from 'node:path'
import { homedir } from 'node:os'

import { CH } from '@shared/ipc-api'
import {
  checkRosterList,
  providerModes,
  ROSTER_APP_ID,
  ROSTER_METHOD,
  type AgentProvider,
  type RosterAgent
} from 'pomade-kit/protocol'

import type { AgentInfo, AgentOverrides, SessionRecord } from '@shared/types'
import { callAppApi, isServing } from './app-broker'
import { configStore } from './config-store'
import { writeJsonAtomic } from './atomic-write'
import { createCommandChecker, isResolved, type ShellRun } from './agent-check-core'
import { parseCodexMeta, readCodexMeta } from './codex-rollout'
import { defineHandler } from './ipc'

// ─── command check (agent-check-core) ─────────────────────────────────────────
/** How long the check's shell may run before it is killed (its words are then `unknown`). */
const CHECK_TIMEOUT_MS = 30_000
/** How long a roster build waits for the check before it answers with the words still unknown. */
const ROSTER_CHECK_WAIT_MS = 1500

/** Live check shells, killed with the app. */
const checkShells = new Set<ChildProcess>()

/** Kill a check shell with everything its startup files started (an interactive zsh ignores
 *  SIGTERM, and a `sleep` in a .zshrc would outlive it), via its own process group. */
function killCheckShell(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

function runCheckShell(script: string, words: string[]): Promise<ShellRun> {
  return new Promise<ShellRun>((resolve) => {
    const child = spawn('zsh', ['-ilc', script, 'pomade-agent-check', ...words], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    checkShells.add(child)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    const timer = setTimeout(() => {
      timedOut = true
      killCheckShell(child)
    }, CHECK_TIMEOUT_MS)
    const done = (run: Omit<ShellRun, 'stdout' | 'stderr' | 'timedOut'>): void => {
      clearTimeout(timer)
      checkShells.delete(child)
      resolve({ stdout, stderr, timedOut, ...run })
    }
    child.on('error', (err) => done({ code: null, signal: null, error: err.message }))
    child.on('close', (code, signal) => done({ code, signal }))
  })
}

const commandChecker = createCommandChecker({
  run: runCheckShell,
  log: (line) => console.warn(line),
  timeoutMs: CHECK_TIMEOUT_MS
})

// ─── overrides (.pomade/agents.json) ──────────────────────────────────────────
function overridesPath(): string {
  const root = configStore.getRoot()
  if (!root) throw new Error('No workspace open')
  return join(root, '.pomade', 'agents.json')
}

async function writeOverrides(next: AgentOverrides): Promise<void> {
  const target = overridesPath()
  await fs.mkdir(dirname(target), { recursive: true })
  await writeJsonAtomic(target, next)
}

// ─── roster ───────────────────────────────────────────────────────────────────
/** A roster agent before its command check. */
type RosterEntry = Omit<AgentInfo, 'resolved'>

async function scanAgentFolders(): Promise<{ id: string; name: string }[]> {
  const root = configStore.getRoot()
  if (!root) return []
  const agentsDir = join(root, 'Agents')
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(agentsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const found: { id: string; name: string }[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const name = entry.name
    if (name === '_shared') continue
    if (name.toLowerCase().includes('template')) continue
    try {
      await fs.access(join(agentsDir, name, 'CLAUDE.md'))
    } catch {
      continue
    }
    found.push({ id: name, name })
  }
  return found
}

/** How long the "+" menu waits for the agents app before it falls back to the scan (rule 7). */
const APP_ROSTER_TIMEOUT_MS = 1500

/** The agents app's last good roster; null when it is absent, not responding or answered badly. */
let appRoster: RosterAgent[] | null = null

/** E-033 — ask the agents app for its roster (rule 7). Remembers the answer for the pty data path
 *  (`baseRoster`), which never waits on an app; a failure forgets it. */
async function refreshAppRoster(): Promise<RosterAgent[] | null> {
  if (!isServing(ROSTER_APP_ID)) {
    appRoster = null
    return null
  }
  const answer = await callAppApi(ROSTER_APP_ID, ROSTER_METHOD, {}, APP_ROSTER_TIMEOUT_MS)
  const checked = answer === null ? null : checkRosterList(answer)
  appRoster = checked?.ok ? checked.agents : null
  return appRoster
}

function defaultConfigDir(provider: AgentProvider): string {
  return provider === 'codex'
    ? (process.env.CODEX_HOME ?? join(homedir(), '.codex'))
    : (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'))
}

/** The agents app's roster as roster entries. Its provider decides the session store; a codex
 *  agent other than the built-in keeps kind `codex` (its resume flag and store shape). */
function fromAppRoster(agents: RosterAgent[], overrides: AgentOverrides): RosterEntry[] {
  return agents
    .map((a) => ({
      id: a.id,
      name: a.name,
      command: overrides.commands[a.id] ?? a.command,
      kind: a.provider === 'codex' ? ('codex' as const) : a.id === 'claude' ? ('claude' as const) : ('custom' as const),
      configDir: a.configDir ?? defaultConfigDir(a.provider),
      modes: a.modes ?? providerModes(a.provider)
    }))
    .filter((a) => !overrides.hidden.includes(a.id))
}

async function baseRoster(): Promise<RosterEntry[]> {
  const overrides = await configStore.getAgentOverrides()
  if (appRoster && isServing(ROSTER_APP_ID)) return fromAppRoster(appRoster, overrides)
  return scannedRoster(overrides)
}

/** Pomade's own roster: the built-ins and the agent folders. */
async function scannedRoster(overrides: AgentOverrides): Promise<RosterEntry[]> {
  const home = homedir()

  const base: RosterEntry[] = [
    {
      id: 'claude',
      name: 'Claude',
      command: overrides.commands['claude'] ?? 'claude',
      kind: 'claude',
      // T-113 follow-up (the Owner's review) — honour claude's OWN config-dir env var, symmetric to
      // CODEX_HOME below. `childEnv` deliberately passes CLAUDE_CONFIG_DIR through to pty
      // children (T-025: user config is kept), so a Pomade launched from an environment that
      // exports it (e.g. `npm run dev` inside a folder-agent session, which sets it) has the
      // BUILT-IN claude writing its sessions there while main scanned ~/.claude — Session history,
      // resume and the E-022 session watcher all silently found nothing. Folder agents are
      // unaffected: their configDir is pinned to Agents/<name>/ explicitly below.
      configDir: process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'),
      modes: providerModes('claude')
    },
    {
      id: 'codex',
      name: 'Codex',
      command: overrides.commands['codex'] ?? 'codex',
      kind: 'codex',
      // T-113 — honour codex's OWN config-dir env var. `childEnv` (pty-manager) deliberately
      // passes CODEX_HOME through to our pty children, so a user who exports it has the CLI
      // writing its rollouts there while main was still scanning ~/.codex — Session history, resume and
      // the E-022 session watcher all silently found nothing.
      configDir: process.env.CODEX_HOME ?? join(home, '.codex'),
      modes: providerModes('codex')
    }
  ]

  const root = configStore.getRoot()
  const folders = await scanAgentFolders()
  for (const f of folders) {
    if (f.id === 'claude' || f.id === 'codex') continue
    base.push({
      id: f.id,
      name: f.name,
      command: overrides.commands[f.id] ?? f.id,
      kind: 'custom',
      // A specialised instance is Claude Code run with CLAUDE_CONFIG_DIR = Agents/<name>/,
      // so its session store lives here. Set it for Session history scanning + resume.
      ...(root ? { configDir: join(root, 'Agents', f.id) } : {}),
      modes: providerModes('claude')
    })
  }

  return base.filter((a) => !overrides.hidden.includes(a.id))
}

/** The roster the "+" menu and launches use: the agents app's when it answers now, else the scan. */
async function buildRoster(): Promise<AgentInfo[]> {
  await refreshAppRoster()
  const visible = await baseRoster()
  const outcomes = await commandChecker.check(
    visible.map((a) => a.command),
    ROSTER_CHECK_WAIT_MS
  )
  return visible.map((a) => ({ ...a, resolved: isResolved(outcomes.get(a.command) ?? 'unknown') }))
}

/** E-043 — an agent's name in the roster (no command check, never waits on an app); its id when
 *  the roster does not list it. */
export async function rosterName(agentId: string): Promise<string> {
  return (await baseRoster()).find((a) => a.id === agentId)?.name ?? agentId
}

async function agentById(agentId: string): Promise<AgentInfo | undefined> {
  return (await buildRoster()).find((a) => a.id === agentId)
}

/** A roster agent without the command check — for reading its session store. */
async function rosterAgent(agentId: string): Promise<RosterEntry | undefined> {
  return (await baseRoster()).find((a) => a.id === agentId)
}

/** E-005 (T-024, both ways): match a command line typed into a shimmed pty against the
 *  visible roster by first word (`claude --resume x` ⇒ `claude`). Used by pty-manager's
 *  exec-marker scanner to detect an agent starting inside an existing shell. Deliberately
 *  skips the command check — no zsh probing on the pty data path. */
export async function matchAgentCommand(
  commandLine: string
): Promise<{ id: string; name: string } | null> {
  const word = commandLine.trim().split(/\s+/)[0]
  if (!word) return null
  const visible = await baseRoster()
  const hit = visible.find((a) => a.command.trim().split(/\s+/)[0] === word)
  return hit ? { id: hit.id, name: hit.name } : null
}

/** T-113 (E-022) — the SHAPE of an agent's on-disk session store, for the live session-id
 *  watcher (`session-watcher.ts`). Routed on the roster `kind`, deliberately NOT on
 *  `hasClaudeStore`'s structural probe: at agent-LAUNCH time nothing exists on disk yet — not
 *  even `<configDir>/projects/` (T-112) — so a probe would answer "no store" for every fresh
 *  session. A folder agent IS Claude Code run with CLAUDE_CONFIG_DIR pointed at its folder,
 *  hence claude-shaped. Reads `baseRoster()` (no `zsh` validation) — same "never probe zsh on
 *  the pty data path" rule as `matchAgentCommand`. */
export type SessionStoreKind = 'claude' | 'codex'

export async function agentSessionStore(
  agentId: string
): Promise<{ kind: SessionStoreKind; configDir: string } | null> {
  const agent = (await baseRoster()).find((a) => a.id === agentId)
  if (!agent?.configDir) return null
  return { kind: agent.kind === 'codex' ? 'codex' : 'claude', configDir: agent.configDir }
}

/** E-033 — the provider an agent is (which CLI, so which output the state scanner reads): codex
 *  for a codex-kind entry, claude for everything else (folder agents are Claude Code). */
export async function agentProvider(agentId: string): Promise<AgentProvider> {
  const agent = (await baseRoster()).find((a) => a.id === agentId)
  return agent?.kind === 'codex' ? 'codex' : 'claude'
}

/** E-025 (slice 4) — does `sessionId`'s transcript EXIST in this agent's store for `cwdAbs`?
 *  Two callers, one rule ("never trust an id the disk can't back"): the revive path validates a
 *  persisted id before spawning `--resume` (a stale/foreign id becomes an honest dead pane
 *  instead of a CLI error — or worse, a mis-keyed store); the ⚠️ popover validates a manually
 *  entered id before binding (binding a nonexistent id would arm a resume that must fail).
 *  Claude-style: one stat of `projects/<encoded-cwd>/<id>.jsonl`. Codex: a bounded walk of the
 *  date-nested store matching `session_meta` id + cwd (the only key codex has). Read-only. */
export async function validateSession(
  agentId: string,
  cwdAbs: string,
  sessionId: string
): Promise<boolean> {
  if (!sessionId || !cwdAbs) return false
  const store = await agentSessionStore(agentId)
  if (!store) return false
  if (store.kind === 'codex') {
    const files: string[] = []
    await walkJsonl(join(store.configDir, 'sessions'), files)
    for (const file of files) {
      const meta = await readCodexMeta(file)
      if (meta && meta.sessionId === sessionId && meta.cwd === cwdAbs) return true
    }
    return false
  }
  try {
    await fs.access(join(store.configDir, 'projects', encodeCwd(cwdAbs), `${sessionId}.jsonl`))
    return true
  } catch {
    return false
  }
}

// ─── Session history ───────────────────────────────────────────────────────────
/** Claude Code encodes a project's cwd into a folder name by replacing EVERY
 *  non-alphanumeric character with '-' (verified against real ~/.claude/projects dirs:
 *  spaces, underscores, dots, and parens all become '-').
 *  Exported since T-113: the session watcher needs the same encoding to find a live store. */
export function encodeCwd(abs: string): string {
  return abs.replace(/[^a-zA-Z0-9]/g, '-')
}

function firstTimestamp(lines: string[]): string | null {
  for (const line of lines) {
    try {
      const o = JSON.parse(line) as { timestamp?: string }
      if (o.timestamp) return o.timestamp
    } catch {
      /* skip */
    }
  }
  return null
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const p of content) {
      if (p && typeof p === 'object' && 'text' in p && typeof (p as { text: unknown }).text === 'string') {
        parts.push((p as { text: string }).text)
      }
    }
    return parts.join(' ')
  }
  return ''
}

function looksInjected(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('#') || t.startsWith('<') || t.startsWith('Caveat:')
}

function claudePreview(lines: string[]): string {
  for (const line of lines) {
    try {
      const o = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } }
      if (o.type === 'user' && o.message?.role === 'user') {
        const text = textFromContent(o.message.content).trim()
        if (text && !looksInjected(text)) return text.slice(0, 160)
      }
    } catch {
      /* skip */
    }
  }
  return '(no preview)'
}

function codexPreview(lines: string[]): string {
  for (const line of lines) {
    try {
      const o = JSON.parse(line) as {
        type?: string
        payload?: { type?: string; role?: string; message?: string; content?: unknown }
      }
      const p = o.payload
      if (o.type === 'event_msg' && p?.type === 'user_message' && typeof p.message === 'string') {
        const text = p.message.trim()
        if (text && !looksInjected(text)) return text.slice(0, 160)
      }
      if (o.type === 'response_item' && p?.type === 'message' && p.role === 'user') {
        const text = textFromContent(p.content).trim()
        if (text && !looksInjected(text)) return text.slice(0, 160)
      }
    } catch {
      /* skip */
    }
  }
  return '(no preview)'
}

async function readLines(file: string): Promise<string[]> {
  const raw = await fs.readFile(file, 'utf8')
  return raw.split('\n').filter((l) => l.trim().length > 0)
}

async function claudeSessions(agent: RosterEntry, cwdAbs: string): Promise<SessionRecord[]> {
  if (!agent.configDir) return []
  const dir = join(agent.configDir, 'projects', encodeCwd(cwdAbs))
  let files: string[]
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }
  const records: SessionRecord[] = []
  for (const file of files) {
    const full = join(dir, file)
    try {
      const lines = await readLines(full)
      const stat = await fs.stat(full)
      records.push({
        sessionId: basename(file, '.jsonl'),
        agentId: agent.id,
        startedAt: firstTimestamp(lines) ?? stat.mtime.toISOString(),
        preview: claudePreview(lines),
        cwd: cwdAbs
      })
    } catch {
      /* unreadable file — skip */
    }
  }
  return records
}

/** A claude-style store is any agent whose configDir holds a `projects/` directory
 *  (built-in claude AND specialised folder agents). Routing on this — not the roster
 *  `kind` string — lets custom agents surface their Session history + resume. */
async function hasClaudeStore(agent: RosterEntry): Promise<boolean> {
  if (!agent.configDir) return false
  try {
    await fs.access(join(agent.configDir, 'projects'))
    return true
  } catch {
    return false
  }
}

async function walkJsonl(dir: string, out: string[]): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walkJsonl(full, out)
    else if (entry.name.endsWith('.jsonl')) out.push(full)
  }
}

async function codexSessions(agent: RosterEntry, cwdAbs: string): Promise<SessionRecord[]> {
  const base = agent.configDir ? join(agent.configDir, 'sessions') : join(homedir(), '.codex', 'sessions')
  const files: string[] = []
  await walkJsonl(base, files)
  const records: SessionRecord[] = []
  for (const file of files) {
    try {
      const lines = await readLines(file)
      if (lines.length === 0) continue
      // Line 0 is the rollout's own identity (`codex-rollout.ts`); a sub-agent's rollout is part
      // of its parent's session, not one of its own.
      const meta = parseCodexMeta(lines[0])
      if (!meta || meta.subagent || meta.cwd !== cwdAbs) continue
      records.push({
        sessionId: meta.sessionId,
        agentId: agent.id,
        startedAt: meta.startedAt ?? firstTimestamp(lines) ?? '',
        preview: codexPreview(lines),
        cwd: cwdAbs
      })
    } catch {
      /* skip */
    }
  }
  return records
}

async function sessions(agentId: string, cwdAbs: string): Promise<SessionRecord[]> {
  const agent = await rosterAgent(agentId)
  if (!agent) return []
  let records: SessionRecord[]
  if (agent.kind === 'codex') records = await codexSessions(agent, cwdAbs)
  else if (await hasClaudeStore(agent)) records = await claudeSessions(agent, cwdAbs)
  else records = []
  return records.sort((a, b) => (b.startedAt < a.startedAt ? -1 : b.startedAt > a.startedAt ? 1 : 0))
}

async function setCommand(agentId: string, command: string): Promise<AgentInfo> {
  const current = await configStore.getAgentOverrides()
  const next: AgentOverrides = {
    commands: { ...current.commands, [agentId]: command },
    hidden: current.hidden
  }
  await writeOverrides(next)
  commandChecker.forget(command)
  const agent = await agentById(agentId)
  if (agent) return agent
  // Agent no longer in roster (e.g. folder removed): synthesize a minimal record.
  const outcome = (await commandChecker.check([command], ROSTER_CHECK_WAIT_MS)).get(command) ?? 'unknown'
  return { id: agentId, name: agentId, command, kind: 'custom', resolved: isResolved(outcome), modes: providerModes('claude') }
}

export function registerAgentService(ipc: typeof ipcMain): void {
  app.on('will-quit', () => checkShells.forEach(killCheckShell))
  defineHandler(ipc, CH.agents.roster, () => buildRoster())
  defineHandler(ipc, CH.agents.setCommand, (_e, agentId, command) => setCommand(agentId, command))
  defineHandler(ipc, CH.agents.sessions, (_e, agentId, cwdAbs) => sessions(agentId, cwdAbs))
  // E-025 — session-id validation (revive gate + the ⚠️ popover's manual bind).
  defineHandler(ipc, CH.agents.validateSession, (_e, agentId, cwdAbs, sessionId) =>
    validateSession(agentId, cwdAbs, sessionId)
  )
}
