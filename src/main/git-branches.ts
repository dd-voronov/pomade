// Pomade — E-041: branches and worktrees (main process; no Electron). The Git panel's In progress
// list and the branch tab's reads, and the operations on a branch: Check out to a worktree, Merge
// into main (squash or merge) with its Continue and Abort, Remove a landed branch and its
// worktree, Rebase a branch onto main. Every operation is previewed and run through git-ops.ts
// (`preview` / `runOp`) on the rails of git-run.ts: the token, the per-repo lock, git that never
// prompts.
//
// Safety rails of this layer:
//   - The repository's own checkout is touched only by a merge, and only when it is on main with
//     nothing uncommitted: the state before is recorded (git-run.ts `fingerprint`) and a merge
//     that stops is ended by finishing it (the conflict tab) or `merge --abort`, checked against it.
//   - A branch is removed only after a verified landing: its tip is reachable from main, or Pomade
//     squash-merged exactly that tip and its commit is still on main. The ref is deleted against
//     that exact tip (`update-ref -d <ref> <tip>`); the worktree with `git worktree remove` — never
//     --force, so git refuses a dirty one too. An unmerged branch is never deleted.
//   - Merge, rebase and removal wait while an agent is live in the checkout that holds the branch
//     (`agents-live.ts`, injected by git-service.ts).
//
// Each local row also names the agent session working on it, when the agents app answers
// (E-043, `agent-sessions.ts`, injected): a worktree by its folder, a branch by the repository's
// folder and its name.
//   - Never force, `reset --hard`, `clean` or `stash`.
//
//   readInProgress(repo) / readBranch(repo, branch)          the panel's list, the branch tab
//   branchesPreview(state, req) / branchesRun(state, req, run) the operations, for git-ops.ts
//   readMerge(state) / finishMerge(state, env)                the conflict tab, for git-operator.ts

import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  BRANCH_COMMITS_LIMIT,
  countStatusEntries,
  parseWorktrees,
  pullRequestUrl,
  statusPaths,
  worktreeSlug,
  type BranchDetails,
  type BranchSession,
  type InProgress,
  type InProgressRow,
  type LandMode,
  type LiveAgent,
  type PullRequestLink,
  type WorktreeEntry
} from '@shared/git-branches'
import type { RebaseState } from '@shared/git-conflict'
import { COMMIT_FILES_LIMIT, LOG_FORMAT, parseCommitFiles, parseLog, remoteLabel } from '@shared/git-history'
import {
  GIT_LOCAL_TIMEOUT_MS,
  identityBlock,
  lastGitLine,
  remoteHost,
  type GitBlock,
  type GitOpPreview,
  type GitOpRequest,
  type GitOpResult,
  type GitOpRun,
  type MergeAbortPreview,
  type MergeBranchPreview,
  type MergeContinuePreview,
  type RebaseBranchPreview,
  type RemoveLandedPreview,
  type WorktreeAddPreview
} from '@shared/git-ops'
import { joinRel, type RepoState } from '@shared/git-state'

import {
  CHANGED,
  conflictedPaths,
  fingerprint,
  hasIdentity,
  ignoredOverwrites,
  inProgress,
  inProgressBlock,
  opsEnv,
  raw,
  readOk,
  remotesOf,
  repoToken,
  sameFingerprint,
  shortHead,
  stateOf,
  step,
  type Fingerprint
} from './git-run'
import { operationOf } from './git-state'

type BranchRequest = Extract<
  GitOpRequest,
  { op: 'worktree-add' | 'merge-branch' | 'merge-continue' | 'merge-abort' | 'remove-landed' | 'rebase-branch' }
>

export const BRANCH_OPS: ReadonlySet<string> = new Set(['worktree-add', 'merge-branch', 'merge-continue', 'merge-abort', 'remove-landed', 'rebase-branch'])

// ── What the Electron side hands in ────────────────────────────────────────────

let liveCheck: (folder: string) => Promise<LiveAgent[]> = async () => []
let sessionLookup: (folder: string, branch: string | null) => Promise<BranchSession | null> = async () => null
let worktreesRoot: () => string = () => join(tmpdir(), 'pomade-worktrees')

/** "Is an agent live in this folder?" — `agents-live.ts` `agentsLiveIn`. */
export function setLiveAgentsCheck(fn: (folder: string) => Promise<LiveAgent[]>): void {
  liveCheck = fn
}

/** "Which agent session works here?" — `agent-sessions.ts` `branchSession`. */
export function setSessionLookup(fn: (folder: string, branch: string | null) => Promise<BranchSession | null>): void {
  sessionLookup = fn
}

/** Where Check out to a worktree makes its folders: `<root>/<repo name>/<branch>`. */
export function setWorktreesRoot(fn: () => string): void {
  worktreesRoot = fn
}

// ── Records kept in memory ─────────────────────────────────────────────────────

interface MergeRecord {
  fp: Fingerprint
  mode: LandMode
  branch: string
  /** A remote branch (`origin/fix`): nothing local to remove afterwards. */
  remote: boolean
  message: string
}

/** Per repo: the merge Pomade started there, until it ends. Abort is checked against `fp`; Continue
 *  commits it as `mode` with `message`. A merge started elsewhere (a terminal) has none. */
const merges = new Map<string, MergeRecord>()

/** Per repo and branch: the squash commit that landed exactly `tip`. What lets a squash-merged
 *  branch be removed (its tip is not reachable from main). */
const landings = new Map<string, { commit: string; tip: string }>()

function landingKey(root: string, branch: string): string {
  return `${root}\0${branch}`
}

// ── Small facts ────────────────────────────────────────────────────────────────

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function base(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function list(paths: readonly string[]): string {
  const names = paths.map(base)
  return `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`
}

async function revOf(cwd: string, ref: string): Promise<string | null> {
  return (await readOk(cwd, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]))?.trim() || null
}

async function count(cwd: string, range: string): Promise<number> {
  return Number((await readOk(cwd, ['rev-list', '--count', range]))?.trim()) || 0
}

async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  return (await raw(cwd, ['merge-base', '--is-ancestor', a, b], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).code === 0
}

/** The branch work lands on: `main`, else `master`. */
async function mainOf(cwd: string): Promise<string | null> {
  for (const name of ['main', 'master']) if (await revOf(cwd, `refs/heads/${name}`)) return name
  return null
}

async function realpathOr(p: string): Promise<string> {
  return fsp.realpath(p).catch(() => p)
}

/** The repository's linked worktrees (its own checkout, bare entries and ones whose folder is gone
 *  left out). */
async function worktreesOf(cwd: string): Promise<WorktreeEntry[]> {
  const all = parseWorktrees((await readOk(cwd, ['worktree', 'list', '--porcelain'])) ?? '')
  const own = await realpathOr(cwd)
  const out: WorktreeEntry[] = []
  for (const w of all) {
    if (w.bare || w.prunable) continue
    if ((await realpathOr(w.path)) === own) continue
    out.push(w)
  }
  return out
}

/** A checkout's uncommitted changes (untracked files included), as `status --porcelain -z`. */
async function checkoutStatus(path: string): Promise<string> {
  return (await readOk(path, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'])) ?? ''
}

/** What a checkout looks like now, for a token: HEAD and its full status. */
async function checkoutKey(path: string): Promise<string> {
  const head = (await readOk(path, ['rev-parse', '-q', '--verify', 'HEAD']))?.trim() ?? ''
  const status = (await readOk(path, ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'])) ?? ''
  return createHash('sha1').update(`${head}\0${status}`).digest('hex')
}

/** A ref the request names: a local branch (`feature`) or a remote one (`origin/feature`). */
async function resolveBranch(cwd: string, branch: string): Promise<{ ref: string; tip: string; remote: boolean } | null> {
  if (!branch || branch.startsWith('-')) return null
  const local = await revOf(cwd, `refs/heads/${branch}`)
  if (local) return { ref: `refs/heads/${branch}`, tip: local, remote: false }
  const remote = await revOf(cwd, `refs/remotes/${branch}`)
  if (remote) return { ref: `refs/remotes/${branch}`, tip: remote, remote: true }
  return null
}

/** Agents live in the repository's own checkout, not counting those inside one of its worktrees
 *  (an agent's worktree under `.claude/worktrees/` is its own place). */
async function agentsInOwnCheckout(cwd: string, worktrees: readonly WorktreeEntry[]): Promise<LiveAgent[]> {
  const inside = await liveCheck(cwd)
  if (inside.length === 0) return inside
  const wtReal = await Promise.all(worktrees.map((w) => realpathOr(w.path)))
  const out: LiveAgent[] = []
  for (const a of inside) {
    const cwdReal = await realpathOr(a.cwd)
    if (!wtReal.some((w) => cwdReal === w || cwdReal.startsWith(`${w}/`))) out.push(a)
  }
  return out
}

function agentBlock(agents: readonly LiveAgent[], where: string): GitBlock {
  const who = agents.map((a) => a.agentId).filter((v, i, all) => all.indexOf(v) === i)
  return {
    message: `An agent is working here (${who.join(', ')} in ${where}) — this waits until it ends, so nothing changes under its feet.`
  }
}

/** The remote a branch would be on: its upstream's remote, else `origin`, else the only one. */
async function prLink(
  cwd: string,
  branch: string,
  upstream: string | null,
  remoteRow: string | null,
  main: string
): Promise<PullRequestLink | null> {
  const remotes = await remotesOf(cwd)
  if (remotes.length === 0) return null
  let remote = remotes.find((r) => remoteRow?.startsWith(`${r.name}/`)) ?? null
  let onRemote: string | null = remoteRow ? remoteRow.slice((remote?.name.length ?? 0) + 1) : null
  if (!remote && upstream) {
    remote = remotes.filter((r) => upstream.startsWith(`${r.name}/`)).sort((a, z) => z.name.length - a.name.length)[0] ?? null
    if (remote) onRemote = upstream.slice(remote.name.length + 1)
  }
  if (!remote) {
    remote = remotes.find((r) => r.name === 'origin') ?? remotes[0]
    if (await revOf(cwd, `refs/remotes/${remote.name}/${branch}`)) onRemote = branch
  }
  const host = remoteHost(remote.url)
  if (host.kind !== 'github' && host.kind !== 'gitlab') return null
  if (!pullRequestUrl(remote.url, 'b', main)) return null
  return { host: host.kind === 'github' ? 'GitHub' : 'GitLab', url: onRemote ? pullRequestUrl(remote.url, onRemote, main) : null }
}

/** How a branch's landing on main is verified, or null when it has not landed. */
async function landedOf(
  cwd: string,
  root: string,
  branch: string,
  tip: string,
  mainRev: string | null
): Promise<{ by: 'reachable' } | { by: 'squash'; commit: string } | null> {
  if (!mainRev) return null
  if (await isAncestor(cwd, tip, mainRev)) return { by: 'reachable' }
  const rec = landings.get(landingKey(root, branch))
  if (rec && rec.tip === tip && (await isAncestor(cwd, rec.commit, mainRev))) return { by: 'squash', commit: rec.commit.slice(0, 7) }
  return null
}

async function lastCommit(cwd: string, rev: string): Promise<{ date: number; subject: string }> {
  const out = ((await readOk(cwd, ['log', '-1', '--format=%ct%x00%s', rev, '--'])) ?? '').trim()
  const [date, subject] = out.split('\0')
  return { date: Number(date) * 1000 || 0, subject: subject ?? '' }
}

/** The newest modification time among a worktree's changed files (at most 50 looked at). */
async function newestChange(path: string, status: string): Promise<number> {
  let newest = 0
  for (const rel of statusPaths(status).slice(0, 50)) {
    const st = await fsp.stat(join(path, rel)).catch(() => null)
    if (st && st.mtimeMs > newest) newest = st.mtimeMs
  }
  return newest
}

async function aheadBehind(cwd: string, mainRev: string | null, tip: string): Promise<{ ahead: number; behind: number }> {
  if (!mainRev) return { ahead: await count(cwd, tip), behind: 0 }
  const out = ((await readOk(cwd, ['rev-list', '--left-right', '--count', `${mainRev}...${tip}`])) ?? '').trim().split(/\s+/)
  return { behind: Number(out[0]) || 0, ahead: Number(out[1]) || 0 }
}

// ── In progress ────────────────────────────────────────────────────────────────

/** The repo view's In progress: every linked worktree, every local branch main does not have
 *  (except those a worktree holds — their worktree's row stands for them), then every branch only
 *  on a remote that main does not have. */
export async function readInProgress(repo: unknown): Promise<InProgress> {
  const state = await stateOf(repo)
  const cwd = state.absPath
  const main = await mainOf(cwd)
  const mainRev = main ? await revOf(cwd, `refs/heads/${main}`) : null
  const worktrees = await worktreesOf(cwd)
  const inWorktree = new Set(worktrees.map((w) => w.branch).filter((b): b is string => b !== null))
  const local: InProgressRow[] = []
  const remoteRows: InProgressRow[] = []

  for (const w of worktrees) {
    const tip = w.head
    if (!tip) continue
    const status = await checkoutStatus(w.path)
    const uncommitted = countStatusEntries(status)
    const last = await lastCommit(cwd, tip)
    const changed = uncommitted > 0 ? await newestChange(w.path, status) : 0
    const { ahead, behind } = await aheadBehind(cwd, mainRev, tip)
    const upstream = w.branch ? ((await readOk(cwd, ['rev-parse', '--abbrev-ref', `${w.branch}@{u}`]))?.trim() || null) : null
    local.push({
      kind: 'worktree',
      branch: w.branch,
      tip,
      path: w.path,
      ahead,
      behind,
      activity: Math.max(last.date, changed),
      subject: last.subject,
      uncommitted,
      current: false,
      agents: await liveCheck(w.path),
      session: null,
      upstream,
      pr: w.branch && main ? await prLink(cwd, w.branch, upstream, null, main) : null,
      landed: w.branch ? (await landedOf(cwd, state.root, w.branch, tip, mainRev)) !== null : false
    })
  }

  const fmt = '--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(subject)%00%(upstream:short)'
  const refs = ((await readOk(cwd, ['for-each-ref', fmt, 'refs/heads', 'refs/remotes'])) ?? '')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ref, tip, date, subject, upstream] = l.split('\0')
      return { ref, tip, date: Number(date) * 1000 || 0, subject: subject ?? '', upstream: upstream || null }
    })
  const localNames = new Set(refs.filter((r) => r.ref.startsWith('refs/heads/')).map((r) => r.ref.slice('refs/heads/'.length)))
  const remotes = (await remotesOf(cwd)).map((r) => r.name)

  for (const r of refs) {
    if (r.ref.startsWith('refs/heads/')) {
      const name = r.ref.slice('refs/heads/'.length)
      if (name === main || inWorktree.has(name)) continue
      const landing = await landedOf(cwd, state.root, name, r.tip, mainRev)
      const { ahead, behind } = await aheadBehind(cwd, mainRev, r.tip)
      // Merged into main (nothing it has that main lacks) is not in progress. A squash-landed one
      // still is (its commits are not on main) — with `landed`, so it can be removed.
      if (ahead === 0) continue
      const current = name === state.branch
      local.push({
        kind: 'branch',
        branch: name,
        tip: r.tip,
        path: null,
        ahead,
        behind,
        activity: r.date,
        subject: r.subject,
        uncommitted: current ? state.changes.length : 0,
        current,
        agents: current ? await agentsInOwnCheckout(cwd, worktrees) : [],
        session: null,
        upstream: r.upstream,
        pr: main ? await prLink(cwd, name, r.upstream, null, main) : null,
        landed: landing !== null
      })
      continue
    }
    const name = r.ref.slice('refs/remotes/'.length)
    if (name.endsWith('/HEAD')) continue
    const remote = remotes.filter((x) => name.startsWith(`${x}/`)).sort((a, z) => z.length - a.length)[0]
    if (!remote) continue
    const short = name.slice(remote.length + 1)
    if (short === main || localNames.has(short)) continue
    const { ahead, behind } = await aheadBehind(cwd, mainRev, r.tip)
    if (ahead === 0) continue
    remoteRows.push({
      kind: 'remote',
      branch: name,
      tip: r.tip,
      path: null,
      ahead,
      behind,
      activity: r.date,
      subject: r.subject,
      uncommitted: 0,
      current: false,
      agents: [],
      session: null,
      upstream: null,
      pr: main ? await prLink(cwd, short, null, name, main) : null,
      landed: false
    })
  }
  await Promise.all(
    local.map(async (row) => {
      if (row.kind === 'worktree' && row.path) row.session = await sessionLookup(row.path, null)
      else if (row.kind === 'branch' && row.branch) row.session = await sessionLookup(cwd, row.branch)
    })
  )
  const newest = (a: InProgressRow, z: InProgressRow): number => z.activity - a.activity
  return { repo: state.root, main, rows: [...local.sort(newest), ...remoteRows.sort(newest)] }
}

/** The branch tab: `main..branch` and the total change against where it left main. */
export async function readBranch(repo: unknown, branch: unknown): Promise<BranchDetails> {
  const state = await stateOf(repo)
  const cwd = state.absPath
  const name = typeof branch === 'string' ? branch : ''
  const target = await resolveBranch(cwd, name)
  if (!target) throw new Error(`There is no branch “${name}” here any more.`)
  const main = await mainOf(cwd)
  const mainRev = main ? await revOf(cwd, `refs/heads/${main}`) : null
  const mergeBase = mainRev ? ((await readOk(cwd, ['merge-base', mainRev, target.tip]))?.trim() || null) : null
  const range = mainRev ? [target.tip, `^${mainRev}`] : [target.tip]
  const total = await count(cwd, mainRev ? `${mainRev}..${target.tip}` : target.tip)
  const commits = parseLog((await readOk(cwd, ['log', LOG_FORMAT, `--max-count=${BRANCH_COMMITS_LIMIT}`, ...range, '--'])) ?? '')
  let files: BranchDetails['files'] = []
  let totalFiles: number | undefined
  if (mergeBase) {
    const args = ['diff', '-z', '-M', mergeBase, target.tip]
    const [nameStatus, numstat] = await Promise.all([readOk(cwd, [...args, '--name-status']), readOk(cwd, [...args, '--numstat'])])
    const all = parseCommitFiles(nameStatus ?? '', numstat ?? '').map((f) => ({
      ...f,
      path: joinRel(state.root, f.path),
      ...(f.from ? { from: joinRel(state.root, f.from) } : {})
    }))
    files = all.slice(0, COMMIT_FILES_LIMIT)
    if (all.length > COMMIT_FILES_LIMIT) totalFiles = all.length
  }
  return {
    repo: state.root,
    branch: name,
    main,
    tip: target.tip,
    base: mergeBase,
    commits,
    more: Math.max(0, total - commits.length),
    files,
    ...(totalFiles === undefined ? {} : { totalFiles })
  }
}

// ── Check out to a worktree ────────────────────────────────────────────────────

/** A folder that does not exist yet: `<root>/<repo>/<slug>`, `-2`, `-3`… when taken. */
async function freeFolder(repoName: string, branch: string): Promise<string> {
  const parent = join(worktreesRoot(), worktreeSlug(repoName))
  const slug = worktreeSlug(branch)
  for (let i = 1; ; i++) {
    const p = join(parent, i === 1 ? slug : `${slug}-${i}`)
    if (!(await fsp.lstat(p).then(() => true, () => false))) return p
  }
}

async function previewWorktreeAdd(state: RepoState, branch: string): Promise<WorktreeAddPreview> {
  const cwd = state.absPath
  const target = await resolveBranch(cwd, branch)
  let local: string | null = null
  if (target?.remote) {
    const remote = (await remotesOf(cwd))
      .map((r) => r.name)
      .filter((r) => branch.startsWith(`${r}/`))
      .sort((a, z) => z.length - a.length)[0]
    local = remote ? branch.slice(remote.length + 1) : null
  }
  const path = await freeFolder(state.name, local ?? branch)
  const token = await repoToken(cwd, `worktree\0${branch}\0${target?.tip ?? ''}\0${path}`)
  const blocked = await (async (): Promise<GitBlock | null> => {
    if (state.error) return { message: state.error, copy: state.error }
    if (!target) return { message: `There is no branch “${branch}” here.` }
    if (target.remote && !local) return { message: `“${branch}” is not a branch of a remote here.` }
    if (local && (await revOf(cwd, `refs/heads/${local}`))) return { message: `A local “${local}” exists already — check out that one.` }
    const name = local ?? branch
    if (state.branch === name) return { message: `“${name}” is this checkout’s branch already — it is open right here.` }
    const holder = (await worktreesOf(cwd)).find((w) => w.branch === name)
    if (holder) return { message: `“${name}” is checked out already in ${holder.path} — Open folder goes there.` }
    return null
  })()
  return { op: 'worktree-add', repo: state.root, token, branch, local, path, blocked }
}

async function runWorktreeAdd(state: RepoState, branch: string, opts: GitOpRun): Promise<GitOpResult> {
  const p = await previewWorktreeAdd(state, branch)
  if (p.token !== opts.token) return { ok: false, failure: CHANGED }
  if (p.blocked) return { ok: false, failure: { kind: 'blocked', ...p.blocked } }
  const cwd = state.absPath
  await fsp.mkdir(dirname(p.path), { recursive: true })
  const env = await opsEnv(cwd)
  if (p.local) await step(cwd, env, ['worktree', 'add', '-q', '--track', '-b', p.local, p.path, `refs/remotes/${p.branch}`])
  else await step(cwd, env, ['worktree', 'add', '-q', p.path, p.branch])
  const name = p.local ?? p.branch
  return { ok: true, message: `Checked out “${name}” in ${p.path}.`, worktree: p.path }
}

// ── Merge into main ────────────────────────────────────────────────────────────

/** The worktree a local branch is checked out in, if any. */
async function worktreeOf(cwd: string, branch: string): Promise<WorktreeEntry | null> {
  return (await worktreesOf(cwd)).find((w) => w.branch === branch) ?? null
}

async function previewMerge(state: RepoState, branch: string, mode: LandMode): Promise<MergeBranchPreview> {
  const cwd = state.absPath
  const main = await mainOf(cwd)
  const target = await resolveBranch(cwd, branch)
  const mainRev = main ? await revOf(cwd, `refs/heads/${main}`) : null
  const wt = target && !target.remote ? await worktreeOf(cwd, branch) : null
  const wtStatus = wt ? await checkoutStatus(wt.path) : ''
  const agents = wt ? await liveCheck(wt.path) : []
  const commits = target && mainRev ? await count(cwd, `${mainRev}..${target.tip}`) : 0
  const subjects =
    target && mainRev
      ? ((await readOk(cwd, ['log', '--reverse', '--format=%s', `--max-count=${BRANCH_COMMITS_LIMIT}`, `${mainRev}..${target.tip}`, '--'])) ?? '')
          .split('\n')
          .filter(Boolean)
      : []
  const files =
    target && mainRev
      ? ((await readOk(cwd, ['diff', '--name-only', '-z', `${mainRev}...${target.tip}`])) ?? '').split('\0').filter(Boolean).length
      : 0
  const token = await repoToken(cwd, `merge\0${branch}\0${mode}\0${target?.tip ?? ''}\0${wt ? await checkoutKey(wt.path) : ''}\0${agents.length}`)
  const blocked = await (async (): Promise<GitBlock | null> => {
    if (state.error) return { message: state.error, copy: state.error }
    const busy = await inProgress(cwd)
    if (busy) return inProgressBlock(busy)
    if (!main || !mainRev) return { message: 'There is no main branch here to land on.' }
    if (!target) return { message: `There is no branch “${branch}” here any more.` }
    if (branch === main) return { message: `That is ${main} itself.` }
    if (state.branch !== main) {
      return {
        message: `This checkout is on “${state.branch ?? 'a detached commit'}” — a merge lands on ${main} here, so switch it to ${main} first (⋯ › Switch branch…).`
      }
    }
    if (commits === 0) return { message: `“${branch}” has nothing ${main} doesn’t have — nothing to merge.` }
    if (agents.length > 0 && wt) return agentBlock(agents, wt.path)
    if (wt && wtStatus) {
      const n = countStatusEntries(wtStatus)
      return {
        message: `“${branch}” has ${plural(n, 'uncommitted change', 'uncommitted changes')} in its worktree (${wt.path}) — they would not land. Commit or discard them there first.`
      }
    }
    if (state.changes.length > 0) {
      return {
        message: `There are uncommitted changes on ${main} here. Commit or discard them first — Pomade merges only into a checkout with nothing uncommitted, so Abort can always put everything back exactly.`
      }
    }
    if (!(await hasIdentity(cwd))) return identityBlock()
    const ignored = await ignoredOverwrites(cwd, [`HEAD...${target.tip}`], `Merging “${branch}”`)
    if (ignored) return { message: ignored }
    return null
  })()
  return {
    op: 'merge-branch',
    repo: state.root,
    token,
    branch,
    mode,
    into: main,
    commits,
    subjects,
    files,
    worktree: wt?.path ?? null,
    agents,
    blocked
  }
}

async function runMerge(state: RepoState, branch: string, mode: LandMode, opts: GitOpRun): Promise<GitOpResult> {
  const message = (opts.message ?? '').trim()
  if (!message) return { ok: false, failure: { kind: 'blocked', message: 'Write the message of the commit that lands it.' } }
  const p = await previewMerge(state, branch, mode)
  if (p.token !== opts.token) return { ok: false, failure: CHANGED }
  if (p.blocked) return { ok: false, failure: { kind: 'blocked', ...p.blocked } }
  const cwd = state.absPath
  const env = await opsEnv(cwd)
  const target = (await resolveBranch(cwd, branch))!
  const fp = await fingerprint(cwd)
  const rec: MergeRecord = { fp, mode, branch, remote: target.remote, message: opts.message ?? message }
  merges.set(state.root, rec)
  // Always a real merge in progress (MERGE_HEAD): a conflict then stops in the conflict tab with
  // git's own `merge --abort` behind Abort; a squash becomes one commit when it is finished.
  const r = await raw(cwd, ['merge', '--no-ff', '--no-commit', '--no-edit', target.ref], { env, timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (r.code === 0 && !r.timedOut) return finishMerge(state, env)
  const conflicts = await conflictedPaths(cwd)
  if (conflicts.length > 0 && (await operationOf(cwd)) === 'merge') {
    const files = conflicts.map((c) => joinRel(state.root, c))
    return {
      ok: true,
      paused: { files },
      message: `“${branch}” and ${p.into} changed the same lines in ${list(files)}. Combine them in the conflict tab — or abort, back to before.`
    }
  }
  const line = r.timedOut ? 'git did not finish in time.' : lastGitLine(`${r.stderr}\n${r.stdout}`)
  return abortMergeChecked(state, env, fp, `Merging “${branch}” failed (${line})`, line)
}

/** `merge --abort`, then the repository compared with the state before. */
async function abortMergeChecked(state: RepoState, env: NodeJS.ProcessEnv, fp: Fingerprint, what: string, detail: string): Promise<GitOpResult> {
  const cwd = state.absPath
  if ((await operationOf(cwd)) === 'merge') await raw(cwd, ['merge', '--abort'], { env, timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  merges.delete(state.root)
  const diffs = sameFingerprint(fp, await fingerprint(cwd))
  if (diffs.length === 0) {
    return { ok: false, failure: { kind: 'conflict', restored: true, message: `${what}. Nothing was changed — the repository is exactly as before.`, detail, copy: detail } }
  }
  return {
    ok: false,
    failure: {
      kind: 'conflict',
      restored: false,
      message: `${what}, and Pomade could NOT put everything back exactly (${diffs.join(', ')}). Look at the repository in a terminal before doing anything else: git status.`,
      copy: 'git status',
      detail
    }
  }
}

/** Commit the merge in progress: one commit (squash) or a merge commit, with the message typed
 *  when Pomade started it — git's own merge message otherwise. Hooks run. */
export async function finishMerge(state: RepoState, env: NodeJS.ProcessEnv): Promise<GitOpResult> {
  const cwd = state.absPath
  const rec = merges.get(state.root) ?? null
  const mergeHead = await revOf(cwd, 'MERGE_HEAD')
  if (rec?.mode === 'squash') {
    // One parent: forget the merge (index and files stay as combined), then commit them.
    await step(cwd, env, ['merge', '--quit'])
    merges.delete(state.root)
    const r = await raw(cwd, ['commit', '-q', '--cleanup=whitespace', '-F', '-'], { env, input: rec.message, timeoutMs: GIT_LOCAL_TIMEOUT_MS })
    if (r.code !== 0 || r.timedOut) {
      const line = r.timedOut ? 'git did not finish in time.' : lastGitLine(`${r.stderr}\n${r.stdout}`)
      return {
        ok: false,
        failure: {
          kind: 'other',
          message: `The changes of “${rec.branch}” are combined and staged on main, but the commit failed: ${line} Nothing is lost — commit them (Commit staged), or discard them to go back.`,
          detail: line,
          copy: line
        }
      }
    }
    const commit = (await readOk(cwd, ['rev-parse', 'HEAD']))?.trim() ?? ''
    if (mergeHead && !rec.remote) landings.set(landingKey(state.root, rec.branch), { commit, tip: mergeHead })
    const short = commit.slice(0, 7)
    return {
      ok: true,
      message: `Landed “${rec.branch}” on main as 1 commit (${short}).`,
      commit: short,
      ...(rec.remote ? {} : { landed: { branch: rec.branch } })
    }
  }
  const args = rec ? ['commit', '-q', '--cleanup=whitespace', '-F', '-'] : ['commit', '-q', '--no-edit']
  const r = await raw(cwd, args, { env, input: rec?.message, timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (r.code !== 0 || r.timedOut) {
    const line = r.timedOut ? 'git did not finish in time.' : lastGitLine(`${r.stderr}\n${r.stdout}`)
    return {
      ok: false,
      failure: { kind: 'other', message: `The merge could not be committed: ${line} It is still in progress — fix it, or abort, back to before.`, detail: line, copy: line }
    }
  }
  merges.delete(state.root)
  const short = await shortHead(cwd)
  if (!rec) return { ok: true, message: `Merge committed (${short}).`, commit: short }
  return {
    ok: true,
    message: `Landed “${rec.branch}” on main with a merge commit (${short}).`,
    commit: short,
    ...(rec.remote ? {} : { landed: { branch: rec.branch } })
  }
}

/** The merge in progress, for the conflict tab: what lands (the branch) and where (main). */
export async function readMerge(state: RepoState): Promise<RebaseState | null> {
  const cwd = state.absPath
  const mergeHead = await revOf(cwd, 'MERGE_HEAD')
  if (!mergeHead) return null
  const rec = merges.get(state.root)
  let branch = rec?.branch ?? null
  if (!branch) {
    const dir = (await readOk(cwd, ['rev-parse', '--absolute-git-dir']))?.trim()
    const msg = dir ? await fsp.readFile(join(dir, 'MERGE_MSG'), 'utf8').catch(() => '') : ''
    branch = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(msg)?.[1] ?? null
  }
  const subject = ((await readOk(cwd, ['log', '-1', '--format=%s', mergeHead])) ?? '').trim()
  return {
    kind: 'merge',
    repo: state.root,
    branch,
    onto: state.branch ?? 'main',
    commit: { hash: mergeHead, subject },
    step: 1,
    total: 1,
    conflicts: (await conflictedPaths(cwd)).map((p) => joinRel(state.root, p)).sort(),
    recorded: !!rec
  }
}

async function previewMergeContinue(state: RepoState): Promise<MergeContinuePreview> {
  const cwd = state.absPath
  const info = state.operation === 'merge' ? await readMerge(state) : null
  const conflicts = info?.conflicts ?? []
  const rec = merges.get(state.root)
  const token = await repoToken(cwd, 'merge-continue')
  const blocked = await (async (): Promise<GitBlock | null> => {
    if (state.error) return { message: state.error, copy: state.error }
    if (!info) return { message: 'No merge is in progress here any more.' }
    if (conflicts.length > 0) return { message: `Resolve every conflict first: ${list(conflicts)}.` }
    if (!(await hasIdentity(cwd))) return identityBlock()
    return null
  })()
  return { op: 'merge-continue', repo: state.root, token, branch: info?.branch ?? null, mode: rec?.mode ?? null, conflicts, blocked }
}

async function previewMergeAbort(state: RepoState): Promise<MergeAbortPreview> {
  const info = state.operation === 'merge' ? await readMerge(state) : null
  const token = await repoToken(state.absPath, 'merge-abort')
  return {
    op: 'merge-abort',
    repo: state.root,
    token,
    branch: info?.branch ?? null,
    recorded: merges.has(state.root),
    blocked: state.error ? { message: state.error, copy: state.error } : info ? null : { message: 'No merge is in progress here any more.' }
  }
}

async function runMergeAbort(state: RepoState, opts: GitOpRun): Promise<GitOpResult> {
  const p = await previewMergeAbort(state)
  if (p.token !== opts.token) return { ok: false, failure: CHANGED }
  if (p.blocked) return { ok: false, failure: { kind: 'blocked', ...p.blocked } }
  const cwd = state.absPath
  const rec = merges.get(state.root)
  const r = await raw(cwd, ['merge', '--abort'], { env: await opsEnv(cwd), timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (r.code !== 0 || r.timedOut) {
    const line = r.timedOut ? 'git did not finish in time.' : lastGitLine(r.stderr)
    return { ok: false, failure: { kind: 'other', message: `git could not abort the merge: ${line}`, detail: line, copy: 'git merge --abort' } }
  }
  merges.delete(state.root)
  const what = p.branch ? `“${p.branch}” did not land` : 'The merge is undone'
  if (!rec) return { ok: true, message: `Back to before — ${what}; git put main back as it was.` }
  const diffs = sameFingerprint(rec.fp, await fingerprint(cwd))
  if (diffs.length === 0) return { ok: true, message: `Back to before — ${what}; main is exactly as it was (checked).` }
  return {
    ok: false,
    failure: {
      kind: 'other',
      message: `The merge was aborted, but the repository is NOT exactly as before it (${diffs.join(', ')}) — something changed it while the merge was stopped. Look at it in a terminal: git status.`,
      copy: 'git status'
    }
  }
}

// ── Remove a landed branch ─────────────────────────────────────────────────────

async function previewRemove(state: RepoState, branch: string): Promise<RemoveLandedPreview> {
  const cwd = state.absPath
  const tip = branch && !branch.startsWith('-') ? await revOf(cwd, `refs/heads/${branch}`) : null
  const main = await mainOf(cwd)
  const mainRev = main ? await revOf(cwd, `refs/heads/${main}`) : null
  const wt = tip ? await worktreeOf(cwd, branch) : null
  const wtStatus = wt ? await checkoutStatus(wt.path) : ''
  const agents = wt ? await liveCheck(wt.path) : []
  const landed = tip ? await landedOf(cwd, state.root, branch, tip, mainRev) : null
  let remoteStays: string | null = null
  let remoteWhere: string | null = null
  for (const r of await remotesOf(cwd)) {
    if (await revOf(cwd, `refs/remotes/${r.name}/${branch}`)) {
      remoteStays = `${r.name}/${branch}`
      const host = remoteHost(r.url)
      remoteWhere = host.kind === 'local' ? remoteLabel(r.url) : host.name
      break
    }
  }
  const token = await repoToken(cwd, `remove\0${branch}\0${tip ?? ''}\0${wt ? await checkoutKey(wt.path) : ''}\0${agents.length}\0${landed?.by ?? ''}`)
  const blocked = await (async (): Promise<GitBlock | null> => {
    if (state.error) return { message: state.error, copy: state.error }
    if (!tip) return { message: `There is no local branch “${branch}” here any more.` }
    if (branch === main) return { message: `That is ${main} itself.` }
    if (!landed) return { message: `“${branch}” has not landed on ${main ?? 'main'} — Pomade removes a branch only when its work is in main.` }
    if (state.branch === branch) return { message: `This checkout is on “${branch}” — switch it to ${main} first.` }
    if (wt && agents.length > 0) return agentBlock(agents, wt.path)
    if (wt?.locked) return { message: `Its worktree is locked (git worktree lock) — unlock it in a terminal first.`, copy: `git worktree unlock ${wt.path}` }
    if (wt && wtStatus) {
      const n = countStatusEntries(wtStatus)
      return {
        message: `Its worktree (${wt.path}) has ${plural(n, 'uncommitted change', 'uncommitted changes')} — commit or discard ${n === 1 ? 'it' : 'them'} there first. Pomade removes only a clean worktree.`
      }
    }
    return null
  })()
  return { op: 'remove-landed', repo: state.root, token, branch, worktree: wt?.path ?? null, landed, remoteStays, remoteWhere, blocked }
}

async function runRemove(state: RepoState, branch: string, opts: GitOpRun): Promise<GitOpResult> {
  const p = await previewRemove(state, branch)
  if (p.token !== opts.token) return { ok: false, failure: CHANGED }
  if (p.blocked) return { ok: false, failure: { kind: 'blocked', ...p.blocked } }
  const cwd = state.absPath
  const env = await opsEnv(cwd)
  const tip = (await revOf(cwd, `refs/heads/${branch}`))!
  // Never --force: git itself refuses a worktree with changes or untracked files.
  if (p.worktree) await step(cwd, env, ['worktree', 'remove', p.worktree])
  // Deleted only at the verified tip: a branch that moved since is left alone.
  await step(cwd, env, ['update-ref', '-m', 'pomade: remove landed branch', '-d', `refs/heads/${branch}`, tip])
  await raw(cwd, ['config', '--remove-section', `branch.${branch}`], { env })
  landings.delete(landingKey(state.root, branch))
  const stays = p.remoteStays ? ` ${p.remoteStays} stays on ${p.remoteWhere ?? 'the remote'}.` : ''
  return { ok: true, message: `Removed “${branch}”${p.worktree ? ' and its worktree' : ''} — its work is in main.${stays}` }
}

// ── Rebase a branch onto main ──────────────────────────────────────────────────

async function previewRebaseBranch(state: RepoState, branch: string): Promise<RebaseBranchPreview> {
  const cwd = state.absPath
  const tip = branch && !branch.startsWith('-') ? await revOf(cwd, `refs/heads/${branch}`) : null
  const main = await mainOf(cwd)
  const mainRev = main ? await revOf(cwd, `refs/heads/${main}`) : null
  const wt = tip ? await worktreeOf(cwd, branch) : null
  const agents = wt ? await liveCheck(wt.path) : []
  const theirs = tip && mainRev ? await count(cwd, `${tip}..${mainRev}`) : 0
  const mine = tip && mainRev ? await count(cwd, `${mainRev}..${tip}`) : 0
  const token = await repoToken(cwd, `rebase-branch\0${branch}\0${tip ?? ''}\0${mainRev ?? ''}\0${wt ? await checkoutKey(wt.path) : ''}\0${agents.length}`)
  const blocked = await (async (): Promise<GitBlock | null> => {
    if (state.error) return { message: state.error, copy: state.error }
    if (!main || !mainRev) return { message: 'There is no main branch here to rebase onto.' }
    if (!tip) return { message: `There is no local branch “${branch}” here.` }
    if (branch === main) return { message: `That is ${main} itself.` }
    if (state.branch === branch) return { message: `“${branch}” is this checkout’s branch — use ⋯ › Rebase onto main.` }
    if (theirs === 0) return { message: `“${branch}” is on top of ${main} already — nothing to rebase.` }
    if (wt && agents.length > 0) return agentBlock(agents, wt.path)
    if (wt) {
      const busy = await inProgress(wt.path)
      if (busy) return inProgressBlock(busy)
      const n = countStatusEntries(await checkoutStatus(wt.path))
      if (n > 0) {
        return {
          message: `Its worktree (${wt.path}) has ${plural(n, 'uncommitted change', 'uncommitted changes')}. Commit or discard them there first — Pomade rebases only with nothing uncommitted, so it can always put everything back exactly.`
        }
      }
    }
    if (mine > 0 && !(await hasIdentity(cwd))) return identityBlock()
    return null
  })()
  return { op: 'rebase-branch', repo: state.root, token, branch, target: main, theirs, mine, worktree: wt?.path ?? null, blocked }
}

async function runRebaseBranch(state: RepoState, branch: string, opts: GitOpRun): Promise<GitOpResult> {
  const p = await previewRebaseBranch(state, branch)
  if (p.token !== opts.token) return { ok: false, failure: CHANGED }
  if (p.blocked || !p.target) return { ok: false, failure: { kind: 'blocked', ...(p.blocked ?? { message: 'Nothing to rebase onto.' }) } }
  const cwd = state.absPath
  const env = await opsEnv(cwd)
  // No worktree: a temporary one outside the repository, removed afterwards — this checkout and
  // every other stay as they are.
  let temp: string | null = null
  let where = p.worktree
  if (!where) {
    temp = await fsp.mkdtemp(join(tmpdir(), 'pomade-rebase-'))
    where = join(temp, worktreeSlug(branch))
  }
  try {
    if (temp) await step(cwd, env, ['worktree', 'add', '-q', where, branch])
    const fp = await fingerprint(where)
    const ignored = await ignoredOverwrites(where, [`HEAD...refs/heads/${p.target}`], `Rebasing “${branch}”`)
    if (ignored) return { ok: false, failure: { kind: 'blocked', message: ignored } }
    const r = await raw(where, ['rebase', '--rebase-merges', '--no-autostash', '--no-update-refs', `refs/heads/${p.target}`], {
      env,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS
    })
    if (r.code === 0 && !r.timedOut) {
      return { ok: true, message: `Put “${branch}”’s ${plural(p.mine, 'commit', 'commits')} on top of ${p.target} (${plural(p.theirs, 'new commit', 'new commits')}).` }
    }
    const conflicts = await conflictedPaths(where)
    const line = r.timedOut ? 'git did not finish in time.' : lastGitLine(`${r.stderr}\n${r.stdout}`)
    if ((await operationOf(where)) === 'rebase') await raw(where, ['rebase', '--abort'], { env, timeoutMs: GIT_LOCAL_TIMEOUT_MS })
    const diffs = sameFingerprint(fp, await fingerprint(where))
    const what =
      conflicts.length > 0
        ? `${p.target}’s changes conflict with “${branch}”’s in ${list(conflicts)}`
        : `Rebasing “${branch}” failed (${line})`
    if (diffs.length > 0) {
      return {
        ok: false,
        failure: {
          kind: 'conflict',
          restored: false,
          message: `${what}, and Pomade could NOT put everything back exactly (${diffs.join(', ')}). Look at it in a terminal: git -C ${where} status.`,
          copy: `git -C ${where} status`,
          detail: line
        }
      }
    }
    return {
      ok: false,
      failure: {
        kind: 'conflict',
        restored: true,
        message:
          conflicts.length > 0
            ? `${what}. Nothing was changed — “${branch}” is exactly as before. Merge it into ${p.target} instead (a merge conflict opens the conflict tab), or rebase it in a terminal there.`
            : `${what}. Nothing was changed — “${branch}” is exactly as before.`,
        detail: line,
        copy: line
      }
    }
  } finally {
    if (temp) {
      await raw(cwd, ['worktree', 'remove', where], { env })
      await fsp.rm(temp, { recursive: true, force: true })
      await raw(cwd, ['worktree', 'prune'], { env })
    }
  }
}

// ── Dispatch ───────────────────────────────────────────────────────────────────

function str(x: unknown): string {
  return typeof x === 'string' ? x.trim() : ''
}

function modeOf(x: unknown): LandMode {
  return x === 'merge' ? 'merge' : 'squash'
}

export async function branchesPreview(state: RepoState, req: BranchRequest): Promise<GitOpPreview> {
  switch (req.op) {
    case 'worktree-add':
      return previewWorktreeAdd(state, str(req.branch))
    case 'merge-branch':
      return previewMerge(state, str(req.branch), modeOf(req.mode))
    case 'merge-continue':
      return previewMergeContinue(state)
    case 'merge-abort':
      return previewMergeAbort(state)
    case 'remove-landed':
      return previewRemove(state, str(req.branch))
    case 'rebase-branch':
      return previewRebaseBranch(state, str(req.branch))
  }
}

export async function branchesRun(state: RepoState, req: BranchRequest, run: GitOpRun): Promise<GitOpResult> {
  switch (req.op) {
    case 'worktree-add':
      return runWorktreeAdd(state, str(req.branch), run)
    case 'merge-branch':
      return runMerge(state, str(req.branch), modeOf(req.mode), run)
    case 'merge-continue': {
      const p = await previewMergeContinue(state)
      if (p.token !== run.token) return { ok: false, failure: CHANGED }
      if (p.blocked) return { ok: false, failure: { kind: 'blocked', ...p.blocked } }
      return finishMerge(state, await opsEnv(state.absPath))
    }
    case 'merge-abort':
      return runMergeAbort(state, run)
    case 'remove-landed':
      return runRemove(state, str(req.branch), run)
    case 'rebase-branch':
      return runRebaseBranch(state, str(req.branch), run)
  }
}

export function isBranchRequest(req: { op: string }): req is BranchRequest {
  return BRANCH_OPS.has(req.op)
}
