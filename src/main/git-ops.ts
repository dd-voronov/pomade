// Pomade — E-039: git operations that change a repository (main process). The model, the wording
// and the limits live in shared/git-ops.ts; the rails every operation runs on in git-run.ts; E-040's
// operator layer (staging, branches, fetch, pull, publish, rebase, conflicts) in git-operator.ts.
// This module is the one entry: `preview` and `runOp` dispatch every operation.
//
//   preview(repo, request)       read-only: exactly what `run` will do, or why it cannot (`blocked`)
//   run(repo, request, {token})  does it — only while the repo is as the preview saw it
//   folderInfo(rel) / initRepo   the project dialog's "Track with git"
//
// Safety rails, all enforced here:
//   - One operation at a time per repo (`withRepoLock`); a second one is refused in plain words.
//     The quiet background fetch is the exception: it gives way to any operation the user asks for.
//   - Never force, never `reset --hard`, never delete a branch that has not landed, never `clean`.
//     The only history change is Undo last commit on an UNPUSHED commit (`reset --soft`: only the branch pointer
//     moves; index and files stay byte-identical). A pushed commit is reverted instead.
//   - git never waits for a password or a prompt: GIT_TERMINAL_PROMPT=0, ssh in BatchMode (the
//     user's own ssh command and ~/.ssh/config are kept), every step bounded in time, stdin closed.
//     Pomade stores no credentials; the system git uses whatever auth works in a terminal.
//   - "Get their changes, then push" runs only on a clean working tree, so a conflict can always be
//     aborted back to exactly the state before (HEAD, branch, index, status) — and that is checked.
//   - Discard keeps what it removes as discarded drafts (7 days, E-035's store) BEFORE touching a
//     file; when keeping fails, nothing is discarded.

import { createHash, randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

import {
  DISCARD_MAX_BYTES,
  DISCARD_MAX_FILES,
  GIT_LOCAL_TIMEOUT_MS,
  GIT_NET_TIMEOUT_MS,
  GIT_OP_TITLE,
  classifyGitError,
  discardDoneMessage,
  identityBlock,
  identityFailure,
  opTitle,
  remoteHost,
  remoteUrlProblem,
  targetLabel,
  timeoutFailure,
  type CommitPushPreview,
  type ConnectPreview,
  type DiscardItem,
  type DiscardPreview,
  type DiscardSkip,
  type ErrorContext,
  type FolderGitInfo,
  type GitBlock,
  type GitOpPreview,
  type GitOpRequest,
  type GitOpResult,
  type GitOpRun,
  type InitRepoResult,
  type SyncPreview,
  type UndoPreview
} from '@shared/git-ops'
import { isWithin, joinRel, pickRemoteUrl, type RepoState } from '@shared/git-state'
import type { DraftPut } from '@shared/recovery'

import {
  CHANGED,
  StepFailure,
  hasIdentity,
  inProgress,
  inProgressBlock,
  inRepo,
  isBlock,
  opsEnv,
  pathspecs,
  pushPlan,
  pushTargetOf,
  pushTo,
  raw,
  rawBytes,
  readOk,
  remotesOf,
  repoToken,
  shortHead,
  stateOf,
  step,
  withRepoLock
} from './git-run'
import { branchesPreview, branchesRun, isBranchRequest } from './git-branches'
import { commitAll } from '../git-core/commit'
import { operatorPreview, operatorRun, rebaseOnto } from './git-operator'
import { gitState, readRemotes } from './git-state'
import { dropDiscardedFiles, keepDiscardedFiles } from './recovery-store'
import { abs, pathExists, requireRoot } from './ws-path'

// ── Previews ────────────────────────────────────────────────────────────────

async function previewCommitPush(state: RepoState, wantPush: boolean): Promise<CommitPushPreview> {
  const cwd = state.absPath
  const { target, ahead } = await pushPlan(state)
  const push = isBlock(target) ? null : target
  const files = state.changes.length
  const pushes = wantPush && push !== null
  const base = {
    op: 'commit-push' as const,
    repo: state.root,
    files,
    branch: state.branch,
    push,
    pushes,
    pushCommits: ahead + (files > 0 ? 1 : 0),
    behind: push && !push.setUpstream ? state.behind : 0
  }
  const token = await repoToken(cwd, `${state.upstream ?? ''}\0${push ? `${push.remote}\0${push.url}` : ''}`)
  const blocked = await (async (): Promise<GitBlock | null> => {
    if (state.error) return { message: state.error, copy: state.error }
    const busy = await inProgress(cwd)
    if (busy) return inProgressBlock(busy)
    if (state.branch === null) {
      return {
        message: 'This repository is not on a branch (detached HEAD) — Pomade commits only on a branch. Switch to one in a terminal, e.g. git switch main.',
        copy: 'git switch main'
      }
    }
    if (isBlock(target) && wantPush) return target
    if (files === 0 && (!pushes || base.pushCommits === 0)) return { message: pushes ? 'Nothing to commit or push — everything is on the remote.' : 'Nothing to commit.' }
    if (files === 0 && base.behind > 0 && push) {
      return {
        message: `${push.remote}/${push.branch} has ${base.behind === 1 ? '1 commit' : `${base.behind} commits`} you don’t have yet — get their changes first, or the push is turned down.`
      }
    }
    if (files > 0 && !(await hasIdentity(cwd))) return identityBlock()
    return null
  })()
  return { ...base, token, blocked }
}

async function previewSync(state: RepoState): Promise<SyncPreview> {
  const cwd = state.absPath
  const remotes = await remotesOf(cwd)
  const target = pushTargetOf(state, remotes)
  const push = isBlock(target) ? null : target
  const token = await repoToken(cwd, state.upstream ?? '')
  const blocked = await (async (): Promise<GitBlock | null> => {
    if (state.error) return { message: state.error, copy: state.error }
    const busy = await inProgress(cwd)
    if (busy) return inProgressBlock(busy)
    if (state.branch === null) return { message: 'This repository is not on a branch (detached HEAD).' }
    if (isBlock(target)) return target
    if (!push) return { message: 'No remote — there is nothing to get changes from.' }
    if (push.setUpstream) return { message: 'This branch is not on the remote yet — Commit & push puts it there.' }
    if (state.ahead === 0) return { message: 'Nothing of yours to push — Pull gets their changes.' }
    if (state.changes.length > 0) {
      return {
        message:
          'There are uncommitted changes. Commit or discard them first — Pomade gets their changes only into a repository with nothing uncommitted, so it can always put everything back exactly.'
      }
    }
    if (!(await hasIdentity(cwd))) return identityBlock()
    return null
  })()
  return { op: 'sync-push', repo: state.root, token, push, local: state.ahead, blocked }
}

async function previewUndo(state: RepoState): Promise<UndoPreview> {
  const cwd = state.absPath
  const remotes = await remotesOf(cwd)
  const target = pushTargetOf(state, remotes)
  const push = isBlock(target) ? null : target
  const token = await repoToken(cwd, state.upstream ?? '')
  let commit: UndoPreview['commit'] = null
  let merge = false
  let root = false
  let pushed = false
  if (state.hasCommits) {
    const line = (await readOk(cwd, ['log', '-1', '--format=%H%x00%P%x00%s', 'HEAD']))?.replace(/\n$/, '') ?? ''
    const [hash, parents, subject] = line.split('\0')
    if (hash) {
      commit = { hash, subject: subject ?? '' }
      const ps = (parents ?? '').split(' ').filter(Boolean)
      merge = ps.length > 1
      root = ps.length === 0
      // Pushed = some remote-tracking branch holds it. A commit made here reaches a remote only by
      // a push from this clone (which moves the tracking ref), so no fetch is needed to know.
      const contains = (await readOk(cwd, ['branch', '-r', '--contains', hash, '--format=%(refname)'])) ?? ''
      pushed = contains.split('\n').some((l) => l.trim().length > 0)
    }
  }
  const mode: UndoPreview['mode'] = pushed ? 'revert' : 'undo'
  const blocked = await (async (): Promise<GitBlock | null> => {
    if (state.error) return { message: state.error, copy: state.error }
    if (!commit) return { message: 'There is no commit to undo yet.' }
    const busy = await inProgress(cwd)
    if (busy) return inProgressBlock(busy)
    if (state.branch === null) return { message: 'This repository is not on a branch (detached HEAD) — there is no “last commit” of a branch to undo.' }
    if (root) {
      return { message: 'This is the repository’s first commit — there is no earlier state to go back to, so it cannot be undone.' }
    }
    if (mode === 'revert') {
      if (state.changes.length > 0) {
        return { message: 'There are uncommitted changes. Commit or discard them first, so the cancelling commit holds only the undo.' }
      }
      if (isBlock(target)) return target
      if (!push) return { message: 'The commit is on a remote, but this branch has nowhere to push the cancelling commit.' }
      if (!(await hasIdentity(cwd))) return identityBlock()
    }
    return null
  })()
  return { op: 'undo-commit', repo: state.root, token, mode, commit, merge, push, blocked }
}

/** A planned discard: the preview's items plus what `run` needs. */
interface DiscardPlan {
  items: DiscardItem[]
  skipped: DiscardSkip[]
  /** Paths (repo-relative) whose disk content is kept, then removed or replaced. */
  keep: string[]
  /** Paths whose staged version is kept too. */
  keepStaged: string[]
  /** `git rm --cached` + delete from disk. */
  remove: string[]
  /** `git restore --source=HEAD --staged --worktree`. */
  restore: string[]
  /** Folders (repo-relative) emptied by removing their untracked files. */
  folders: string[]
}

type Readable = { ok: true; bytes: Buffer } | { ok: false; reason: DiscardSkip['reason'] } | { ok: true; bytes: null }

/** A file as a discard can keep it: text up to the bound, exactly representable as UTF-8. */
async function readKeepable(absPath: string): Promise<Readable> {
  let st
  try {
    st = await fsp.lstat(absPath)
  } catch {
    return { ok: true, bytes: null }
  }
  if (!st.isFile()) return { ok: false, reason: 'binary' }
  if (st.size > DISCARD_MAX_BYTES) return { ok: false, reason: 'too-big' }
  const bytes = await fsp.readFile(absPath)
  return keepableBytes(bytes)
}

function keepableBytes(bytes: Buffer): Readable {
  if (bytes.length > DISCARD_MAX_BYTES) return { ok: false, reason: 'too-big' }
  if (bytes.includes(0)) return { ok: false, reason: 'binary' }
  if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) return { ok: false, reason: 'not-utf8' }
  return { ok: true, bytes }
}

async function planDiscard(state: RepoState, paths: readonly string[] | null): Promise<DiscardPlan & { blocked: GitBlock | null }> {
  const cwd = state.absPath
  const repo = state.root
  const plan: DiscardPlan = { items: [], skipped: [], keep: [], keepStaged: [], remove: [], restore: [], folders: [] }
  const empty = (blocked: GitBlock): DiscardPlan & { blocked: GitBlock } => ({ ...plan, blocked })
  if (state.error) return empty({ message: state.error, copy: state.error })
  const busy = await inProgress(cwd)
  if (busy) return empty(inProgressBlock(busy))
  const wanted = paths === null ? state.changes : state.changes.filter((c) => paths.includes(c.path))
  if (wanted.length === 0) return empty({ message: 'Nothing to discard — no uncommitted changes there any more.' })
  if (wanted.some((c) => c.status === 'conflict')) {
    return empty({ message: 'A file has a conflict — resolve or abort the merge in a terminal first.', copy: 'git status' })
  }

  // Untracked folders reported as one entry: their files, one by one (a nested repo's stay out).
  const nested = (await gitState.current()).repos.map((r) => r.root).filter((r) => r !== repo && isWithin(r, repo))
  type Entry = { path: string; status: 'modified' | 'new' | 'deleted' | 'renamed'; from?: string; folder?: string }
  const entries: Entry[] = []
  for (const c of wanted) {
    if (c.status === 'conflict') continue
    if (!c.dir) {
      entries.push({ path: c.path, status: c.status, from: c.from })
      continue
    }
    const out = (await readOk(cwd, ['ls-files', '-o', '--exclude-standard', '-z', '--', `:(literal)${inRepo(repo, c.path)}`])) ?? ''
    for (const f of out.split('\0').filter(Boolean)) {
      const ws = joinRel(repo, f)
      if (nested.some((n) => isWithin(ws, n))) continue
      entries.push({ path: ws, status: 'new', folder: c.path })
    }
    plan.folders.push(inRepo(repo, c.path))
  }
  if (entries.length > DISCARD_MAX_FILES) {
    return empty({ message: `That is ${entries.length} files — Pomade discards at most ${DISCARD_MAX_FILES} at a time, keeping a copy of each.` })
  }

  // Files whose staged version differs from both the last commit and the file on disk.
  const unstaged = new Set(((await readOk(cwd, ['diff', '--name-only', '-z'])) ?? '').split('\0').filter(Boolean))
  const staged = new Set(((await readOk(cwd, ['diff', '--cached', '--name-only', '-z', '--no-renames'])) ?? '').split('\0').filter(Boolean))
  const tracked = new Set(((await readOk(cwd, ['ls-files', '-z'])) ?? '').split('\0').filter(Boolean))

  for (const e of entries) {
    const p = inRepo(repo, e.path)
    const keepHere: string[] = []
    let keepStaged = false
    let item: DiscardItem
    if (e.status === 'deleted') {
      item = { path: e.path, action: 'bring-back' }
      keepHere.push(p) // a file put back at that path meanwhile is kept before it is replaced
    } else if (e.status === 'modified') {
      item = { path: e.path, action: 'restore' }
      keepHere.push(p)
      keepStaged = unstaged.has(p) && staged.has(p)
    } else if (e.status === 'renamed' && e.from) {
      item = { path: e.path, action: 'unrename', from: e.from }
      keepHere.push(p, inRepo(repo, e.from))
      keepStaged = unstaged.has(p) && staged.has(p)
    } else {
      item = { path: e.path, action: 'delete' }
      keepHere.push(p)
      keepStaged = tracked.has(p) && unstaged.has(p)
    }
    let skip: DiscardSkip['reason'] | null = null
    for (const k of keepHere) {
      const r = await readKeepable(join(cwd, k))
      if (!r.ok) skip = r.reason
    }
    if (!skip && keepStaged) {
      const blob = await rawBytes(cwd, ['show', `:${p}`], process.env)
      const r = blob ? keepableBytes(blob) : ({ ok: false, reason: 'binary' } as const)
      if (!r.ok) skip = r.reason
    }
    if (skip) {
      plan.skipped.push({ path: e.path, reason: skip })
      continue
    }
    if (keepStaged) {
      item.staged = true
      plan.keepStaged.push(p)
    }
    plan.items.push(item)
    plan.keep.push(...keepHere)
    if (item.action === 'delete') plan.remove.push(p)
    else if (item.action === 'unrename') {
      plan.remove.push(p)
      plan.restore.push(inRepo(repo, e.from!))
    } else plan.restore.push(p)
  }
  if (plan.items.length === 0) {
    return { ...plan, blocked: { message: 'None of these files can be discarded — Pomade could not keep a copy of them (see below).' } }
  }
  return { ...plan, blocked: null }
}

async function previewDiscard(state: RepoState, paths: string[] | null): Promise<DiscardPreview> {
  const plan = await planDiscard(state, paths)
  const token = await repoToken(state.absPath, JSON.stringify(paths))
  return { op: 'discard', repo: state.root, token, items: plan.items, skipped: plan.skipped, blocked: plan.blocked }
}

async function previewConnect(state: RepoState, url: string): Promise<ConnectPreview> {
  const cwd = state.absPath
  const clean = url.trim()
  const host = remoteHost(clean)
  const remotes = await remotesOf(cwd)
  const token = createHash('sha1').update(`${JSON.stringify(remotes)}\0${clean}`).digest('hex')
  const base = { op: 'connect-remote' as const, repo: state.root, token, url: clean, host, branches: 0, name: 'origin' }
  if (remotes.length > 0) {
    return { ...base, blocked: { message: `This repository already has a remote (${remotes.map((r) => r.name).join(', ')}).` } }
  }
  const problem = remoteUrlProblem(clean)
  if (problem) return { ...base, blocked: { message: problem } }
  // Checked against the remote before anything is added: is a repository there, can we read it?
  const env = await opsEnv(cwd)
  const r = await raw(cwd, ['ls-remote', '--heads', clean], { env, timeoutMs: GIT_NET_TIMEOUT_MS })
  const ctx: ErrorContext = { action: 'check', host, url: clean }
  if (r.timedOut) return { ...base, blocked: { message: timeoutFailure(ctx, GIT_NET_TIMEOUT_MS / 1000).message } }
  if (r.code !== 0) {
    const f = classifyGitError(`${r.stderr}\n${r.stdout}`, ctx)
    return { ...base, blocked: { message: f.message, copy: f.copy } }
  }
  return { ...base, branches: r.stdout.split('\n').filter((l) => l.trim()).length, blocked: null }
}

export async function preview(repo: unknown, req: GitOpRequest): Promise<GitOpPreview> {
  const state = await stateOf(repo)
  switch (req?.op) {
    case 'commit-push':
      return previewCommitPush(state, req.push !== false)
    case 'sync-push':
      return previewSync(state)
    case 'undo-commit':
      return previewUndo(state)
    case 'discard':
      return previewDiscard(state, Array.isArray(req.paths) ? req.paths.filter((p): p is string => typeof p === 'string') : null)
    case 'connect-remote':
      return previewConnect(state, typeof req.url === 'string' ? req.url : '')
    default:
      return req && isBranchRequest(req) ? branchesPreview(state, req) : operatorPreview(state, req)
  }
}

// ── Runs ────────────────────────────────────────────────────────────────────

async function runCommitPush(state: RepoState, wantPush: boolean, opts: GitOpRun): Promise<GitOpResult> {
  const message = (opts.message ?? '').trim()
  const p = await previewCommitPush(state, wantPush)
  if (p.token !== opts.token) return { ok: false, failure: CHANGED }
  if (p.blocked) return { ok: false, failure: { kind: 'blocked', ...p.blocked } }
  // Only a commit needs a message; with nothing to commit the operation is the push alone.
  if (p.files > 0 && !message) return { ok: false, failure: { kind: 'blocked', message: 'Write a message saying what changed.' } }
  const cwd = state.absPath
  const env = await opsEnv(cwd)
  let commit: string | undefined
  if (p.files > 0) commit = await commitAll(state, env, opts.message ?? message)
  if (!p.push) return { ok: true, message: `Committed ${commit} — it stays on this Mac (no remote).`, commit }
  if (!p.pushes) return { ok: true, message: `Committed ${commit} — not pushed.`, commit }
  await pushTo(cwd, env, state.branch!, p.push, commit)
  const where = targetLabel(p.push)
  return {
    ok: true,
    message: commit
      ? `Committed ${commit} and pushed to ${where}.`
      : `Pushed ${p.pushCommits} commit${p.pushCommits === 1 ? '' : 's'} to ${where}.`,
    commit
  }
}

async function runSync(state: RepoState, opts: GitOpRun): Promise<GitOpResult> {
  const p = await previewSync(state)
  if (p.token !== opts.token) return { ok: false, failure: CHANGED }
  if (p.blocked || !p.push) return { ok: false, failure: { kind: 'blocked', ...(p.blocked ?? { message: 'No remote.' }) } }
  const cwd = state.absPath
  const env = await opsEnv(cwd)
  const target = p.push
  const net: ErrorContext = { action: 'get', host: target.host, url: target.url }
  await step(cwd, env, ['fetch', '--no-write-fetch-head', target.remote], { net })
  const theirs = Number((await readOk(cwd, ['rev-list', '--count', 'HEAD..@{u}']))?.trim()) || 0
  if (theirs > 0) {
    // A conflict stops the rebase for the conflict tab; it pushes once that rebase finishes.
    const r = await rebaseOnto(state, env, '@{u}', `${target.remote}/${target.branch}`, target)
    if (!r.ok || r.paused) return r
  }
  await pushTo(cwd, env, state.branch!, target)
  return {
    ok: true,
    message: theirs > 0 ? `Got ${theirs} commit${theirs === 1 ? '' : 's'} from ${targetLabel(target)} and pushed yours.` : `Nothing new there — pushed yours to ${targetLabel(target)}.`
  }
}

async function runUndo(state: RepoState, opts: GitOpRun): Promise<GitOpResult> {
  const p = await previewUndo(state)
  if (p.token !== opts.token) return { ok: false, failure: CHANGED }
  if (p.blocked || !p.commit) return { ok: false, failure: { kind: 'blocked', ...(p.blocked ?? { message: 'Nothing to undo.' }) } }
  const cwd = state.absPath
  const env = await opsEnv(cwd)
  const subject = p.commit.subject
  if (p.mode === 'undo') {
    // `--soft`: only the branch pointer moves back to the first parent. The index and every file
    // stay byte-identical, so the commit's changes show as uncommitted and nothing else moves.
    await step(cwd, env, ['reset', '-q', '--soft', `${p.commit.hash}^1`])
    return { ok: true, message: `Undid “${subject}” — its changes are back in Changes.` }
  }
  const args = ['revert', '--no-edit']
  if (p.merge) args.push('-m', '1')
  args.push(p.commit.hash)
  const r = await raw(cwd, args, { env, timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (r.code !== 0 || r.timedOut) {
    if (await inProgress(cwd)) await raw(cwd, ['revert', '--abort'], { env, timeoutMs: GIT_LOCAL_TIMEOUT_MS })
    const f = classifyGitError(r.stderr, { action: 'push', host: remoteHost(''), url: '' })
    return { ok: false, failure: { ...f, message: `Could not make the cancelling commit: ${f.message} Nothing was changed.` } }
  }
  const commit = await shortHead(cwd)
  await pushTo(cwd, env, state.branch!, p.push!, commit)
  return { ok: true, message: `Added ${commit}, which cancels “${subject}”, and pushed it to ${targetLabel(p.push!)}.`, commit }
}

async function runDiscard(state: RepoState, paths: string[] | null, opts: GitOpRun): Promise<GitOpResult> {
  const cwd = state.absPath
  const token = await repoToken(cwd, JSON.stringify(paths))
  if (token !== opts.token) return { ok: false, failure: CHANGED }
  const plan = await planDiscard(state, paths)
  if (plan.blocked) return { ok: false, failure: { kind: 'blocked', ...plan.blocked } }
  const env = await opsEnv(cwd)

  // 1. Keep a copy of everything that is about to be removed or replaced.
  const stamp = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
  const drafts: DraftPut[] = []
  const seen = new Map<string, Buffer>()
  const add = (p: string, bytes: Buffer, reason: DraftPut['reason']): void => {
    const ws = joinRel(state.root, p)
    drafts.push({ id: `gd-${stamp}-${drafts.length}`, path: ws, tabId: '', title: ws.slice(ws.lastIndexOf('/') + 1), content: bytes.toString('utf8'), reason })
  }
  for (const p of plan.keep) {
    const r = await readKeepable(join(cwd, p))
    if (!r.ok) return { ok: false, failure: CHANGED }
    if (r.bytes === null) continue
    seen.set(p, r.bytes)
    add(p, r.bytes, 'git-discard')
  }
  for (const p of plan.keepStaged) {
    const blob = await rawBytes(cwd, ['show', `:${p}`], env)
    if (!blob) return { ok: false, failure: CHANGED }
    add(p, blob, 'git-discard-staged')
  }
  try {
    await keepDiscardedFiles(drafts)
  } catch (err) {
    return {
      ok: false,
      failure: {
        kind: 'other',
        message: `Pomade could not keep a copy of the files (${(err as Error).message}) — nothing was discarded.`
      }
    }
  }
  // 2. Nothing changed between reading and keeping (an agent writing right now)?
  for (const [p, bytes] of seen) {
    const now = await fsp.readFile(join(cwd, p)).catch(() => null)
    if (!now || !now.equals(bytes)) {
      await dropDiscardedFiles(drafts.map((d) => d.id))
      return { ok: false, failure: CHANGED }
    }
  }
  // 3. Discard: untrack + delete the new files, restore the tracked ones from the last commit.
  try {
    if (plan.remove.length > 0) {
      await step(cwd, env, ['--literal-pathspecs', 'rm', '--cached', '-q', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        input: pathspecs(plan.remove)
      })
      for (const p of plan.remove) await fsp.rm(join(cwd, p), { force: true })
    }
    if (plan.restore.length > 0) {
      await step(cwd, env, ['--literal-pathspecs', 'restore', '--source=HEAD', '--staged', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        input: pathspecs(plan.restore)
      })
    }
    for (const f of plan.folders) await removeEmptyDirs(join(cwd, f))
  } catch (err) {
    const msg = err instanceof StepFailure ? err.failure.message : (err as Error).message
    return {
      ok: false,
      failure: {
        kind: 'other',
        message: `Discarding stopped part-way: ${msg} Everything already discarded is kept in Document history.`,
        copy: msg
      }
    }
  }
  return { ok: true, message: discardDoneMessage(plan.items.length, plan.skipped.length) }
}

/** Remove `dir` and the folders inside it that are empty (bottom-up); anything with a file stays. */
async function removeEmptyDirs(dir: string): Promise<void> {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) if (e.isDirectory()) await removeEmptyDirs(join(dir, e.name))
  await fsp.rmdir(dir).catch(() => {})
}

async function runConnect(state: RepoState, url: string, opts: GitOpRun): Promise<GitOpResult> {
  const cwd = state.absPath
  const remotes = await remotesOf(cwd)
  const clean = url.trim()
  const token = createHash('sha1').update(`${JSON.stringify(remotes)}\0${clean}`).digest('hex')
  if (token !== opts.token) return { ok: false, failure: CHANGED }
  if (remotes.length > 0 || remoteUrlProblem(clean)) return { ok: false, failure: CHANGED }
  const env = await opsEnv(cwd)
  await step(cwd, env, ['remote', 'add', 'origin', clean])
  const host = remoteHost(clean)
  return { ok: true, message: `Connected to ${host.kind === 'local' ? clean : host.name} as “origin”. Commit & push sends your commits there.` }
}

export async function runOp(repo: unknown, req: GitOpRequest, opts: GitOpRun): Promise<GitOpResult> {
  const state = await stateOf(repo)
  const op = req?.op
  if (!op || !(op in GIT_OP_TITLE)) throw new Error('Unknown git operation.')
  const token = typeof opts?.token === 'string' ? opts.token : ''
  const run: GitOpRun = { token, message: typeof opts?.message === 'string' ? opts.message : undefined }
  // Only a fetch runs in the background: it changes nothing but remote-tracking refs, so stopping it
  // part-way loses nothing.
  const background = opts?.background === true && op === 'fetch'
  return withRepoLock(state.root, opTitle(req), async (yielded) => {
    // Re-read inside the lock: nothing Pomade runs can interleave from here on.
    const fresh = (await gitState.freshState(state.root)) ?? state
    switch (req.op) {
      case 'commit-push':
        return runCommitPush(fresh, req.push !== false, run)
      case 'sync-push':
        return runSync(fresh, run)
      case 'undo-commit':
        return runUndo(fresh, run)
      case 'discard':
        return runDiscard(fresh, Array.isArray(req.paths) ? req.paths.filter((p): p is string => typeof p === 'string') : null, run)
      case 'connect-remote':
        return runConnect(fresh, typeof req.url === 'string' ? req.url : '', run)
      default:
        return isBranchRequest(req) ? branchesRun(fresh, req, run) : operatorRun(fresh, req, run, yielded)
    }
  }, { background })
}

// ── New projects ────────────────────────────────────────────────────────────

/** A folder's relation to git: its own repository (and remote), inside one that tracks it, or
 *  none (an enclosing repository that ignores it counts as none). */
export async function folderInfo(rel: unknown): Promise<FolderGitInfo> {
  if (typeof rel !== 'string') return { kind: 'missing' }
  const dir = abs(rel)
  try {
    if (!(await fsp.stat(dir)).isDirectory()) return { kind: 'missing' }
  } catch {
    return { kind: 'missing' }
  }
  if (await pathExists(join(dir, '.git'))) {
    const remotes = await readRemotes(requireRoot(), rel)
    const upstream = (await readOk(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']))?.trim() ?? null
    return { kind: 'repo', remoteUrl: pickRemoteUrl(remotes, upstream) }
  }
  const top = (await readOk(dir, ['rev-parse', '--show-toplevel']))?.trim()
  if (!top) return { kind: 'none' }
  const ignored = await raw(top, ['check-ignore', '-q', '--', dir], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
  if (ignored.code === 0) return { kind: 'none' }
  const remotes = await remotesOf(top)
  return {
    kind: 'inside',
    repoName: top.slice(top.lastIndexOf('/') + 1),
    remoteUrl: (remotes.find((r) => r.name === 'origin') ?? remotes[0])?.url ?? null
  }
}

/** `git init` in a project folder and its first commit (everything in it). A missing identity
 *  leaves the repository without a commit and says what to run. */
export async function initRepo(rel: unknown, message: unknown): Promise<InitRepoResult> {
  if (typeof rel !== 'string' || typeof message !== 'string' || !message.trim()) throw new Error('Not a folder to track.')
  const dir = abs(rel)
  if (!(await fsp.stat(dir)).isDirectory()) throw new Error(`${rel} is not a folder.`)
  if (await pathExists(join(dir, '.git'))) return { commit: (await shortHead(dir)) || null }
  const env = await opsEnv(dir)
  try {
    await step(dir, env, ['init', '-q'])
    gitState.rediscover()
    if (!(await hasIdentity(dir))) return { commit: null, failure: identityFailure() }
    await step(dir, env, ['add', '-A'])
    const staged = (await readOk(dir, ['ls-files', '-z'])) ?? ''
    const args = ['commit', '-q', '--cleanup=whitespace', '-F', '-']
    if (!staged) args.push('--allow-empty')
    await step(dir, env, args, { input: message.trim() })
    return { commit: await shortHead(dir) }
  } catch (err) {
    if (err instanceof StepFailure) return { commit: null, failure: err.failure }
    throw err
  } finally {
    gitState.rediscover()
  }
}
