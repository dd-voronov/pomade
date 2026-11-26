// Pomade — git-core: which repos a workspace holds and each repo's state (no Electron). The
// main process's git-state service (main/git-state.ts) refreshes and broadcasts these; the
// `pomade-git` command reads them once per run.
//
//   Discovery   a bounded walk (DISCOVERY_MAX_DEPTH levels) for `.git` entries — nested repos
//               included (the workspace-root repo, Knowledge, every Projects/*), skipping
//               node_modules, .pomade, build/vendor trees and every dot-directory.
//   Status      one `git status --porcelain=v2 -z --branch` per repo (no optional locks, so it
//               never writes the index under an agent's feet), nearest-repo scoped.
//   Remotes     one `git config --get-regexp` per repo.

import { execFile } from 'node:child_process'
import { promises as fs, type Dirent } from 'node:fs'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'

import {
  REMOTES_ARGS,
  STATUS_ARGS,
  isWithin,
  parseRemotes,
  parseStatusV2,
  pickRemoteUrl,
  scopeRepoChanges,
  type GitRemote,
  type RepoOperation,
  type RepoState
} from '@shared/git-state'
import { INDEX_IGNORE_NAMES, INDEX_WALK_CONCURRENCY } from '@shared/ignore-names'

const execFileP = promisify(execFile)

/** Directory levels below the workspace root searched for repos (git-base: root 0, Knowledge 1,
 *  Projects/<repo> 2, one level of slack below that). */
export const DISCOVERY_MAX_DEPTH = 3
const DISCOVERY_SKIP = new Set(INDEX_IGNORE_NAMES)
const STATUS_TIMEOUT_MS = 30_000
const GIT_MAX_BUFFER = 64 * 1024 * 1024

/** Environment for every read-only git call: never take optional locks, never prompt. */
export const GIT_READ_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0'
}

/** One read-only git call in `cwd` (no optional locks, never prompts, bounded in time). */
export async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileP('git', args as string[], {
    cwd,
    env: GIT_READ_ENV,
    maxBuffer: GIT_MAX_BUFFER,
    timeout: STATUS_TIMEOUT_MS,
    encoding: 'utf8'
  })
  return stdout
}

/** Same, raw bytes (file contents at a revision). */
export async function runGitBuffer(cwd: string, args: readonly string[]): Promise<Buffer> {
  const { stdout } = await execFileP('git', args as string[], {
    cwd,
    env: GIT_READ_ENV,
    maxBuffer: GIT_MAX_BUFFER,
    timeout: STATUS_TIMEOUT_MS,
    encoding: 'buffer'
  })
  return stdout
}

/** Every repo root (ws-relative) at most DISCOVERY_MAX_DEPTH levels below `rootAbs`. A repo's
 *  working tree is searched too — nested repos are the point. Symlinked directories are never
 *  followed (Dirent is lstat-based). */
export async function discoverRepos(rootAbs: string): Promise<string[]> {
  const found: string[] = []
  let level: { abs: string; depth: number }[] = [{ abs: rootAbs, depth: 0 }]
  while (level.length > 0) {
    const next: { abs: string; depth: number }[] = []
    const reads: (Dirent[] | null)[] = []
    // Bounded concurrency, like the index walk: a level can hold thousands of folders.
    for (let i = 0; i < level.length; i += INDEX_WALK_CONCURRENCY) {
      const batch = level.slice(i, i + INDEX_WALK_CONCURRENCY)
      reads.push(
        ...(await Promise.all(
          batch.map(async (d) => {
            try {
              return await fs.readdir(d.abs, { withFileTypes: true })
            } catch {
              return null
            }
          })
        ))
      )
    }
    for (let i = 0; i < level.length; i++) {
      const entries = reads[i]
      if (!entries) continue
      const { abs, depth } = level[i]
      if (entries.some((e) => e.name === '.git')) found.push(relative(rootAbs, abs).split(sep).join('/'))
      if (depth >= DISCOVERY_MAX_DEPTH) continue
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || DISCOVERY_SKIP.has(e.name)) continue
        next.push({ abs: join(abs, e.name), depth: depth + 1 })
      }
    }
    level = next
  }
  return found.sort()
}

/** A repo's remotes. Never throws: no remote (git exits 1) or a failing read is `[]`. */
export async function readRemotes(rootAbs: string, repoRoot: string): Promise<GitRemote[]> {
  try {
    return parseRemotes(await runGit(join(rootAbs, repoRoot), REMOTES_ARGS))
  } catch {
    return []
  }
}

/** A working tree's git directory: `.git` itself, or the one a `.git` file points to (a linked
 *  worktree, a submodule). Null when there is none. */
export async function gitDirOf(cwd: string): Promise<string | null> {
  const dotGit = join(cwd, '.git')
  try {
    const st = await fs.stat(dotGit)
    if (st.isDirectory()) return dotGit
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(await fs.readFile(dotGit, 'utf8'))
    return m ? (isAbsolute(m[1]) ? m[1] : join(cwd, m[1])) : null
  } catch {
    return null
  }
}

const OPERATION_MARKERS: readonly [string, RepoOperation][] = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert']
]

/** The git operation stopped half-way in the repo at `cwd` (git's state files), or null. */
export async function operationOf(cwd: string): Promise<RepoOperation | null> {
  const gitDir = await gitDirOf(cwd)
  if (!gitDir) return null
  for (const [entry, op] of OPERATION_MARKERS) {
    try {
      await fs.access(join(gitDir, entry))
      return op
    } catch {
      // not this one
    }
  }
  return null
}

/** One repo's state, its remote URL picked from `remotes` (read alongside the status; must not
 *  reject). Never throws: a failing `git status` yields an empty state with `error`. */
export async function readRepoState(
  rootAbs: string,
  repoRoot: string,
  allRoots: readonly string[],
  remotes: Promise<readonly GitRemote[]>
): Promise<RepoState> {
  const cwd = join(rootAbs, repoRoot)
  const name = repoRoot === '' ? basename(rootAbs) : basename(repoRoot)
  const nested = allRoots.filter((r) => r !== repoRoot && isWithin(r, repoRoot))
  try {
    const [stdout, repoRemotes, operation] = await Promise.all([runGit(cwd, STATUS_ARGS), remotes, operationOf(cwd)])
    const parsed = parseStatusV2(stdout, repoRoot)
    const scoped = scopeRepoChanges(parsed, nested)
    const changes = scoped.changes
    if (scoped.expand.length > 0) {
      // Untracked directories that hold a nested repo: list their files one by one (bounded to
      // those directories) so the nested repo's files stay its own.
      const prefix = repoRoot === '' ? 0 : repoRoot.length + 1
      const out = await runGit(cwd, [
        '--no-optional-locks',
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
        '--',
        ...scoped.expand.map((p) => p.slice(prefix))
      ])
      const inner = scopeRepoChanges(parseStatusV2(out, repoRoot), nested)
      changes.push(...inner.changes.filter((c) => scoped.expand.some((d) => isWithin(c.path, d))))
    }
    return {
      root: repoRoot,
      name,
      absPath: cwd,
      remoteUrl: pickRemoteUrl(repoRemotes, parsed.upstream),
      branch: parsed.branch,
      head: parsed.head,
      upstream: parsed.upstream,
      ahead: parsed.upstream === null ? 0 : parsed.ahead,
      behind: parsed.upstream === null ? 0 : parsed.behind,
      hasCommits: parsed.hasCommits,
      changes,
      ignored: scoped.ignored,
      ignoredHolders: scoped.ignoredHolders,
      ...(operation ? { operation } : {})
    }
  } catch (err) {
    const msg = ((err as { stderr?: string }).stderr || (err as Error).message || 'git status failed').trim()
    return {
      root: repoRoot,
      name,
      absPath: cwd,
      remoteUrl: pickRemoteUrl(await remotes, null),
      branch: null,
      head: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      hasCommits: false,
      changes: [],
      ignored: [],
      ignoredHolders: [],
      error: msg.split('\n').slice(-1)[0]
    }
  }
}
