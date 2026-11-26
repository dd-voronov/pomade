// Pomade — E-041: branches and worktrees — the shared model. Main (main/git-branches.ts) reads the
// In progress list and a branch's details; the Git panel and the branch tab show them. Pure: no I/O,
// no Electron, no React; pinned by git-branches.unit.test.ts.
//
//   pullRequestUrl(remoteUrl, branch, base)   the GitHub compare / GitLab new-merge-request page
//   worktreeSlug(branch)                      a branch name as one folder name
//   squashMessage(branch, subjects)           the merge message box's prefill
//   rowKindLabel / tildePath                  wording shared by the panel and the branch tab
//   pickBranchSession(sessions)               the session a row links to (E-043)
//   readAgentState(state)                     a terminal agent's scanner reading as `agents.liveIn` says it
//   joinLiveAgents(app, own)                  "is an agent live here?": the agents app's answer and
//                                             Pomade's own terminals, each agent and folder once

import type { LiveAgentEntry, LiveAgentState, LiveSession, RepoSession, SessionLiveState } from 'pomade-kit/protocol'

import type { AgentState } from 'pomade-kit/scanners'

import type { CommitFile, CommitSummary } from './git-history'
import { remoteHost } from './git-ops'

/** What an In progress row is: a linked worktree (any branch, or detached), a local branch not
 *  checked out in a worktree, or a branch only on a remote. */
export type InProgressKind = 'worktree' | 'branch' | 'remote'

/** An agent live in a folder, by its folder at launch (absolute): one running in a Pomade terminal,
 *  or one the agents app reports (an agent tab, a Runner run) — `agents.liveIn`'s entry, with what
 *  it is doing when known and the shells of the Pomade terminals it runs in. The Git panel counts
 *  every one, idle or not; `pomade-git` skips only for one that works or waits. */
export type LiveAgent = LiveAgentEntry

/** E-043 — the agent session behind an In progress row, as the agents app (`sessions.forRepo`)
 *  reports it. */
export interface BranchSession {
  /** The provider's session id. */
  id: string
  agentId: string
  /** The agent's name in the roster; its id when the roster does not list it. */
  agentName: string
  /** The session's name; null = unnamed. */
  name: string | null
  live: SessionLiveState
  /** Its start folder (absolute) — where a resume runs. */
  cwd: string
  /** Its project (stable id); null = the Workspace project. */
  projectId: string | null
}

/** Where a branch's pull / merge request is made. `url` is null while the branch is not on that
 *  remote yet (publish it first). */
export interface PullRequestLink {
  host: 'GitHub' | 'GitLab'
  url: string | null
}

export interface InProgressRow {
  kind: InProgressKind
  /** `feature` (local), `origin/feature` (remote); null for a worktree on a detached HEAD. */
  branch: string | null
  /** The tip commit (full hash). */
  tip: string
  /** A worktree's folder (absolute); null for the others. */
  path: string | null
  /** Commits on it that main does not have. */
  ahead: number
  /** Commits on main it does not have. */
  behind: number
  /** Last activity (ms): its newest commit, or a newer uncommitted change in a worktree. */
  activity: number
  /** Its newest commit's subject. */
  subject: string
  /** Uncommitted changes in a worktree (untracked files included). */
  uncommitted: number
  /** The repository's own checkout is on this branch. */
  current: boolean
  /** Agents live in the checkout that holds it (the worktree, or the repository's own checkout
   *  for `current`) — merge, rebase and removal wait while any is. */
  agents: LiveAgent[]
  /** The agent session working on it (E-043): the live one, else the latest. Null without the
   *  agents app, for a remote row, or when no session worked there. */
  session: BranchSession | null
  /** A local branch's upstream (`origin/feature`), else null. */
  upstream: string | null
  pr: PullRequestLink | null
  /** Its work is in main: the tip is reachable from main, or Pomade squash-merged exactly this
   *  tip into main and that commit is still there. Only then can it be removed. */
  landed: boolean
}

export interface InProgress {
  repo: string
  /** The branch work lands on: `main`, else `master`; null when the repository has neither. */
  main: string | null
  /** Local rows (worktrees and branches), then remote rows; each group most recent first. */
  rows: InProgressRow[]
}

/** A branch tab's content. */
export interface BranchDetails {
  repo: string
  /** As the row names it: `feature` or `origin/feature`. */
  branch: string
  main: string | null
  tip: string
  /** Where it left main (null without a main or a common commit). */
  base: string | null
  /** `main..branch`, newest first (at most BRANCH_COMMITS_LIMIT). */
  commits: CommitSummary[]
  /** Commits past the listed ones. */
  more: number
  /** The total change against the merge base (ws-relative paths; a rename's `from` too). */
  files: CommitFile[]
  totalFiles?: number
}

export const BRANCH_COMMITS_LIMIT = 200

/** How a branch lands on main: its commits squashed into one new commit (default), or a merge
 *  commit that keeps them. */
export type LandMode = 'squash' | 'merge'

/** `owner/repo` (or a GitLab group path) from a remote URL on GitHub or GitLab; null otherwise. */
function projectPath(url: string): { host: string; path: string } | null {
  const u = url.trim()
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(u)
  const proto = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u)
  const m = proto ?? (u.startsWith('/') || u.startsWith('.') ? null : scp)
  if (!m) return null
  const path = m[2].replace(/\/+$/, '').replace(/\.git$/, '').replace(/^\/+/, '')
  if (!path.includes('/')) return null
  return { host: m[1].toLowerCase(), path }
}

/** The page that starts a pull request (GitHub) or merge request (GitLab) of `branch` into `base`,
 *  from the remote's URL (ssh `git@host:owner/repo.git`, `ssh://`, or https). Null for any other
 *  host or a URL it cannot read. */
export function pullRequestUrl(remoteUrl: string, branch: string, base: string): string | null {
  const host = remoteHost(remoteUrl)
  if (host.kind !== 'github' && host.kind !== 'gitlab') return null
  const p = projectPath(remoteUrl)
  if (!p) return null
  const enc = (s: string): string => s.split('/').map(encodeURIComponent).join('/')
  if (host.kind === 'github') return `https://${p.host}/${p.path}/compare/${enc(base)}...${enc(branch)}?expand=1`
  const q = `merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}&merge_request%5Btarget_branch%5D=${encodeURIComponent(base)}`
  return `https://${p.host}/${p.path}/-/merge_requests/new?${q}`
}

/** A branch name as one folder name: `feature/login` → `feature-login`. */
export function worktreeSlug(branch: string): string {
  const s = branch
    .replace(/[/\\]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/-+$/, '')
  return s || 'worktree'
}

/** The message box's prefill: the branch's name, then its commit subjects (oldest first). */
export function squashMessage(branch: string, subjects: readonly string[]): string {
  if (subjects.length === 0) return branch
  return `${branch}\n\n${subjects.map((s) => `- ${s}`).join('\n')}\n`
}

export function rowKindLabel(row: Pick<InProgressRow, 'kind' | 'current'>): string {
  if (row.kind === 'worktree') return 'worktree'
  if (row.kind === 'remote') return 'remote'
  return row.current ? 'branch · checked out here' : 'branch'
}

/** The session a row links to: a live one before a closed one, then the latest activity. */
export function pickBranchSession(sessions: readonly RepoSession[]): RepoSession | null {
  let best: RepoSession | null = null
  for (const s of sessions) {
    if (!best) {
      best = s
      continue
    }
    const live = s.live !== 'closed'
    const bestLive = best.live !== 'closed'
    if (live !== bestLive ? live : Date.parse(s.lastActiveAt) > Date.parse(best.lastActiveAt)) best = s
  }
  return best
}

/** What `agents.liveIn` says of an agent in a Pomade terminal, from its scanner's last reading:
 *  `idle` only when the scanner saw the agent's empty prompt; before its first reading nothing is
 *  known (counted as working) — unlike the tab's dot, which starts idle. */
export function readAgentState(state: AgentState | undefined): LiveAgentState | undefined {
  if (!state || state.kind === 'unknown') return undefined
  return state.kind === 'working' ? 'working' : state.kind === 'waiting' ? 'needs-you' : 'idle'
}

/** How busy a state is; `unknown` = not known, which counts as working. */
const BUSY: Record<LiveAgentState | 'unknown', number> = { idle: 0, 'needs-you': 1, unknown: 2, working: 3 }

/** The agents app's live sessions (null = no answer) and Pomade's own terminals' agents, each agent
 *  and folder once. Entries for the same agent and folder are one entry with the busiest state:
 *  working, then not known, then needs-you, then idle — so an idle tab never hides a busy one. A
 *  state the app does not give for a tab defers to Pomade's own reading of its terminals when there
 *  is one; a run's missing state is not known, and a run's `idle` is not taken (a run is never idle).
 *  `terminalPids` gathers every terminal shell behind the entry. */
export function joinLiveAgents(app: readonly LiveSession[] | null, own: readonly LiveAgent[]): LiveAgent[] {
  interface Group {
    agentId: string
    cwd: string
    states: (LiveAgentState | 'unknown')[]
    appTabUnknown: boolean
    own: number
    pids: number[]
  }
  const groups = new Map<string, Group>()
  const group = (agentId: string, cwd: string): Group => {
    const key = `${agentId}\0${cwd}`
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { agentId, cwd, states: [], appTabUnknown: false, own: 0, pids: [] }))
    return g
  }
  for (const s of app ?? []) {
    const g = group(s.agent, s.cwd)
    const state = s.source === 'run' && s.state === 'idle' ? undefined : s.state
    if (state) g.states.push(state)
    else if (s.source === 'tab') g.appTabUnknown = true
    else g.states.push('unknown')
  }
  for (const a of own) {
    const g = group(a.agentId, a.cwd)
    g.own++
    g.states.push(a.state ?? 'unknown')
    for (const pid of a.terminalPids ?? []) if (!g.pids.includes(pid)) g.pids.push(pid)
  }
  return [...groups.values()].map((g) => {
    if (g.appTabUnknown && g.own === 0) g.states.push('unknown')
    const busiest = g.states.reduce<LiveAgentState | 'unknown' | null>((a, b) => (a === null || BUSY[b] > BUSY[a] ? b : a), null)
    const out: LiveAgent = { agentId: g.agentId, cwd: g.cwd }
    if (busiest !== null && busiest !== 'unknown') out.state = busiest
    if (g.pids.length > 0) out.terminalPids = g.pids
    return out
  })
}

/** `~/…` for a folder under the home folder. */
export function tildePath(path: string, home: string): string {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
}

/** One entry of `git worktree list --porcelain`. */
export interface WorktreeEntry {
  path: string
  head: string
  /** `feature` (from `branch refs/heads/feature`); null when detached. */
  branch: string | null
  bare: boolean
  locked: boolean
  prunable: boolean
}

/** Parse `git worktree list --porcelain` (blank-line separated records; the first is the main
 *  working tree). */
export function parseWorktrees(text: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = []
  let cur: WorktreeEntry | null = null
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), head: '', branch: null, bare: false, locked: false, prunable: false }
      out.push(cur)
    } else if (!cur) continue
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5).trim()
    else if (line.startsWith('branch ')) {
      const ref = line.slice(7).trim()
      cur.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    } else if (line === 'bare') cur.bare = true
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true
    else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true
  }
  return out
}

/** Entries of `git status --porcelain=v1 -z` (a rename or copy counts once). */
export function countStatusEntries(z: string): number {
  const parts = z.split('\0').filter(Boolean)
  let n = 0
  for (let i = 0; i < parts.length; i++) {
    n++
    if (/^[RC]/.test(parts[i])) i++
  }
  return n
}

/** Changed paths in `git status --porcelain=v1 -z` (the new name of a rename). */
export function statusPaths(z: string): string[] {
  const parts = z.split('\0').filter(Boolean)
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    out.push(parts[i].slice(3))
    if (/^[RC]/.test(parts[i])) i++
  }
  return out
}
