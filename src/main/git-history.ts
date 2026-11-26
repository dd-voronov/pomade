// Pomade — E-037: read-only history queries for the Git panel and the commit-details tab. Every
// call is one bounded git invocation through the injected runner (`runGit`: no optional locks,
// never prompts, timeout) — History is paged, so no call ever walks the whole log.
//
//   readLog(run, cwd, { all, skip })   one page of the branch's line: `--first-parent` (one row per
//                                      landed piece of work) or every commit — from where the branch
//                                      meets its upstream, so commits not pushed yet are left out
//   readUnpushed(run, cwd)             the commits the upstream lacks (`@{upstream}..HEAD`), capped
//   readMergeInner(run, cwd, hash)     the commits a merge brought in (`<hash>^@ ^<hash>^1`)
//   readCommit(run, cwd, hash)         header, full message and changed files vs the first parent
//   readFileLog(run, cwd, path, opts) one file's history for Document history: the commits that touched
//                                      it (renames followed), first-parent or every commit
//   readRevisionFile(run, runBuf, …)   a file at a revision for the comparison tab — absent, binary
//                                      and over-2-MB answered without reading the content

import { COMPARE_MAX_BYTES, type RevisionFile } from '@shared/compare'
import {
  COMMIT_FILES_LIMIT,
  DETAILS_FORMAT,
  FILE_LOG_FORMAT,
  LOG_FORMAT,
  LOG_PAGE_SIZE,
  MERGE_INNER_LIMIT,
  UNPUSHED_LIMIT,
  parseCommitFiles,
  parseCommitHeader,
  parseFileLog,
  parseLog,
  RENAME_SIMILARITY,
  textSimilarity,
  type CommitDetails,
  type FileLogPage,
  type LogPage
} from '@shared/git-history'

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<string>
export type GitBufferRunner = (cwd: string, args: readonly string[]) => Promise<Buffer>

/** Bytes sniffed for a NUL to call a file binary (git's own heuristic window). */
const BINARY_SNIFF = 8000

/** A full or abbreviated object name — the only revision form these queries accept. */
export function isCommitHash(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{7,64}$/.test(s)
}

/** Ask for one more than a page: its presence is the "more" answer, without a count query. */
async function page(run: GitRunner, cwd: string, args: readonly string[], limit: number): Promise<LogPage> {
  const commits = parseLog(await run(cwd, ['log', LOG_FORMAT, '-n', String(limit + 1), ...args]))
  return { commits: commits.slice(0, limit), more: commits.length > limit }
}

/** Where History starts. A branch with an upstream: the merge bases of HEAD and the upstream —
 *  exactly the commits both have, so the ones not pushed yet (their own group) are left out; [] when
 *  the two share no commit. No upstream (or a detached HEAD): HEAD. */
async function historyStarts(run: GitRunner, cwd: string): Promise<string[]> {
  try {
    await run(cwd, ['rev-parse', '--verify', '--quiet', '@{upstream}'])
  } catch {
    return ['HEAD']
  }
  try {
    return (await run(cwd, ['merge-base', '--all', 'HEAD', '@{upstream}'])).split('\n').filter((h) => isCommitHash(h))
  } catch {
    return []
  }
}

export async function readLog(
  run: GitRunner,
  cwd: string,
  opts: { all: boolean; skip: number }
): Promise<LogPage> {
  const skip = Math.max(0, Math.floor(opts.skip))
  const starts = await historyStarts(run, cwd)
  if (starts.length === 0) return { commits: [], more: false }
  return page(run, cwd, [...(opts.all ? [] : ['--first-parent']), `--skip=${skip}`, ...starts, '--'], LOG_PAGE_SIZE)
}

/** The commits on the branch its upstream does not have, newest first, every commit (merges
 *  included — the count matches the head's ↑n), capped at `UNPUSHED_LIMIT`. No upstream: none. */
export async function readUnpushed(run: GitRunner, cwd: string): Promise<LogPage> {
  try {
    await run(cwd, ['rev-parse', '--verify', '--quiet', '@{upstream}'])
  } catch {
    return { commits: [], more: false }
  }
  return page(run, cwd, ['@{upstream}..HEAD', '--'], UNPUSHED_LIMIT)
}

/** A path inside the repo: relative, no `..` segment. */
function checkRepoPath(pathInRepo: string): void {
  if (!pathInRepo || pathInRepo.startsWith('/') || pathInRepo.split('/').includes('..')) {
    throw new Error('Not a path in this repository.')
  }
}

/** Candidates compared and the largest one read when looking for where a moved file came from. */
const RENAME_CANDIDATES = 50
const RENAME_MAX_BYTES = 512 * 1024

/** The committed path (of `candidates`, files deleted in the working tree) that `working` was moved
 *  from: the most similar HEAD version, if at least `RENAME_SIMILARITY` of it is unchanged. */
async function findRenameSource(
  run: GitRunner,
  runBuf: GitBufferRunner,
  cwd: string,
  working: string,
  candidates: readonly string[]
): Promise<string | null> {
  let best: { path: string; score: number } | null = null
  for (const path of candidates.slice(0, RENAME_CANDIDATES)) {
    try {
      const spec = `HEAD:${path}`
      if (Number((await run(cwd, ['cat-file', '-s', spec])).trim()) > RENAME_MAX_BYTES) continue
      const bytes = await runBuf(cwd, ['cat-file', 'blob', spec])
      if (bytes.subarray(0, BINARY_SNIFF).includes(0)) continue
      const score = textSimilarity(bytes.toString('utf8'), working)
      if (score >= RENAME_SIMILARITY && (!best || score > best.score)) best = { path, score }
    } catch {
      /* not in HEAD: no candidate */
    }
  }
  return best?.path ?? null
}

export interface FileLogOptions {
  all: boolean
  skip: number
  /** Read the history of this committed path instead (a file moved without git knowing; the
   *  answer to the first page's `renamedFrom`, or git's own rename source). */
  via?: string
  /** Repo-relative paths deleted in the working tree: when the file has no history of its own,
   *  the one it was moved from is looked for among them. */
  candidates?: readonly string[]
  /** The file's current text (for the similarity check); null when it cannot be read. */
  readWorking?: () => Promise<string | null>
}

/** One page of the commits that touched `pathInRepo`, newest first, following the file across
 *  renames. A file git does not know as renamed (moved by a plain rename) has no history under its
 *  new name; its first page then looks for the committed path it was moved from. A repository with
 *  no commits yet has no history. */
export async function readFileLog(
  run: GitRunner,
  runBuf: GitBufferRunner,
  cwd: string,
  pathInRepo: string,
  opts: FileLogOptions
): Promise<FileLogPage> {
  checkRepoPath(pathInRepo)
  if (opts.via !== undefined) checkRepoPath(opts.via)
  const skip = Math.max(0, Math.floor(opts.skip))
  const pageOf = async (path: string): Promise<FileLogPage> => {
    const args = [
      'log',
      FILE_LOG_FORMAT,
      '--follow',
      '--name-status',
      '-z',
      ...(opts.all ? [] : ['--first-parent']),
      `--skip=${skip}`,
      '-n',
      String(LOG_PAGE_SIZE + 1),
      'HEAD',
      '--',
      path
    ]
    let stdout: string
    try {
      stdout = await run(cwd, args)
    } catch {
      return { commits: [], more: false }
    }
    const commits = parseFileLog(stdout, path)
    return { commits: commits.slice(0, LOG_PAGE_SIZE), more: commits.length > LOG_PAGE_SIZE }
  }
  if (opts.via !== undefined) return { ...(await pageOf(opts.via)), renamedFrom: opts.via }
  const own = await pageOf(pathInRepo)
  if (own.commits.length > 0 || skip > 0 || !opts.candidates?.length || !opts.readWorking) return own
  const working = await opts.readWorking()
  if (working === null) return own
  const from = await findRenameSource(run, runBuf, cwd, working, opts.candidates)
  return from === null ? own : { ...(await pageOf(from)), renamedFrom: from }
}

export async function readMergeInner(run: GitRunner, cwd: string, hash: string): Promise<LogPage> {
  if (!isCommitHash(hash)) throw new Error('Not a commit.')
  return page(run, cwd, [`${hash}^@`, `^${hash}^1`, '--'], MERGE_INNER_LIMIT)
}

export async function readCommit(run: GitRunner, cwd: string, hash: string): Promise<CommitDetails> {
  if (!isCommitHash(hash)) throw new Error('Not a commit.')
  let header: ReturnType<typeof parseCommitHeader>
  try {
    header = parseCommitHeader(await run(cwd, ['show', '-s', DETAILS_FORMAT, hash, '--']))
  } catch {
    header = null
  }
  if (!header) throw new Error(`Commit ${hash.slice(0, 7)} is not in this repository.`)
  const range = header.parents.length > 0 ? [header.parents[0], header.hash] : ['--root', header.hash]
  const base = ['diff-tree', '-r', '-z', '-M', '--no-commit-id']
  const [nameStatus, numstat] = await Promise.all([
    run(cwd, [...base, '--name-status', ...range]),
    run(cwd, [...base, '--numstat', ...range])
  ])
  const files = parseCommitFiles(nameStatus, numstat)
  return files.length > COMMIT_FILES_LIMIT
    ? { ...header, files: files.slice(0, COMMIT_FILES_LIMIT), totalFiles: files.length }
    : { ...header, files }
}

/** `rev` (a hash or `HEAD`) and a repo-relative path → the file's content at that revision. */
export async function readRevisionFile(
  run: GitRunner,
  runBuf: GitBufferRunner,
  cwd: string,
  rev: string,
  pathInRepo: string
): Promise<RevisionFile> {
  if (rev !== 'HEAD' && !isCommitHash(rev)) return { kind: 'no-revision' }
  checkRepoPath(pathInRepo)
  let commit: ReturnType<typeof parseLog>[number] | undefined
  try {
    commit = parseLog(await run(cwd, ['log', LOG_FORMAT, '-n', '1', rev, '--']))[0]
  } catch {
    commit = undefined
  }
  if (!commit) return { kind: 'no-revision' }
  const info = { hash: commit.hash, date: commit.date, subject: commit.subject }
  const spec = `${commit.hash}:${pathInRepo}`
  let size: number
  try {
    size = Number((await run(cwd, ['cat-file', '-s', spec])).trim())
  } catch {
    return { kind: 'absent', commit: info }
  }
  if (!Number.isFinite(size)) return { kind: 'absent', commit: info }
  if (size > COMPARE_MAX_BYTES) return { kind: 'too-big', size, commit: info }
  const bytes = await runBuf(cwd, ['cat-file', 'blob', spec])
  if (bytes.subarray(0, BINARY_SNIFF).includes(0)) return { kind: 'binary', size: bytes.length, commit: info }
  return { kind: 'text', content: bytes.toString('utf8'), commit: info }
}
