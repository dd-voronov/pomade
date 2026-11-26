// Pomade — GitService (main process). Wave 3.
// Talks to the system `git` binary via execFile (argv arrays — paths are NEVER passed
// through a shell, so spaces / special chars are safe). Provides:
//   - isRepo(rel)         walk up to find the owning repo within the workspace
//   - fileDiff(rel)       HEAD↔working and previous↔HEAD side-by-side content
//   - committedFile(rel)  the file's version in the last commit (a deleted file's ghost row)
//   - restoreFile(rel)    write a deleted file back from the last commit
//   - log / unpushed / mergeCommits / commit / fileAt   the Git panel's History and Not pushed,
//                         commit details and the comparison tab's revision side (E-037,
//                         git-history.ts), for a discovered repo root only
//   - fileLog             one file's commits for Document history (E-038)
//   - preview / run / folderInfo / initRepo   operations that change a repo (E-039, git-ops.ts)
//   - rebase / conflictFile                    the conflict tab's reads (E-040, git-operator.ts)
//   - inProgress / branch                       the repo view's In progress and the branch tab
//                                               (E-041, git-branches.ts)
// Repo discovery and per-repo status live in git-state.ts (E-036).

import { app, ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { relative, isAbsolute, join, dirname, sep, basename } from 'node:path'

import { CH, type DiffMode, type FileDiff } from '@shared/ipc-api'
import { isWithin, joinRel, type CommittedFile } from '@shared/git-state'

import { abs, requireRoot, pathExists } from './ws-path'
import { defineHandler } from './ipc'
import { GIT_READ_ENV, gitState, registerGitState, runGit, runGitBuffer } from './git-state'
import { folderInfo, initRepo, preview, runOp } from './git-ops'
import { readConflictFile, readRebase } from './git-operator'
import { readBranch, readInProgress, setLiveAgentsCheck, setSessionLookup, setWorktreesRoot } from './git-branches'
import { agentsLiveIn } from './agents-live'
import { branchSession } from './agent-sessions'
import { pomadeHome } from './app-commands'
import { refusedUnderTest } from './owner-paths'
import { readCommit, readFileLog, readLog, readMergeInner, readRevisionFile, readUnpushed } from './git-history'

const execFileP = promisify(execFile)
const GIT_MAX_BUFFER = 64 * 1024 * 1024 // large files / long logs
/** Bytes sniffed for a NUL to call a committed file binary (git's own heuristic window). */
const BINARY_SNIFF = 8000

class GitService {
  /** Run git in `cwd` with an argv array. Returns stdout; throws on a non-zero exit. */
  private async git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileP('git', args, {
      cwd,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: 'utf8'
    })
    return stdout
  }

  /** Same, raw bytes. */
  private async gitBuffer(cwd: string, args: string[]): Promise<Buffer> {
    const { stdout } = await execFileP('git', args, {
      cwd,
      env: GIT_READ_ENV,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: 'buffer'
    })
    return stdout
  }

  /** The owning repo of a workspace-relative file and the file's path inside it. */
  private async locate(rel: string): Promise<{ repoRoot: string; pathInRepo: string; absPath: string }> {
    const absPath = abs(rel)
    const repoRoot = await this.findRepoRoot(absPath)
    if (!repoRoot) throw new Error('This file is not inside a git repository.')
    return { repoRoot, pathInRepo: relative(repoRoot, absPath).split(sep).join('/'), absPath }
  }

  async committedFile(rel: string): Promise<CommittedFile> {
    const { repoRoot, pathInRepo } = await this.locate(rel)
    const commit = await this.shortSha(repoRoot, 'HEAD')
    if (!commit) throw new Error('This repository has no commits yet.')
    let bytes: Buffer
    try {
      bytes = await this.gitBuffer(repoRoot, ['show', `HEAD:${pathInRepo}`])
    } catch {
      throw new Error(`${basename(rel)} is not in the last commit.`)
    }
    if (bytes.subarray(0, BINARY_SNIFF).includes(0)) return { kind: 'binary', size: bytes.length, commit }
    return { kind: 'text', content: bytes.toString('utf8'), commit }
  }

  async restoreFile(rel: string): Promise<void> {
    const { repoRoot, pathInRepo, absPath } = await this.locate(rel)
    // Rule 8: the file on disk is the truth — never overwrite something that is there now.
    if (await pathExists(absPath)) throw new Error(`${basename(rel)} already exists on disk.`)
    // Index and working tree back to the last commit: an unstaged or a staged deletion alike.
    await this.git(repoRoot, ['restore', '--source=HEAD', '--staged', '--worktree', '--', pathInRepo])
    gitState.refreshPath(rel)
  }

  /** Same, but never throws — returns null when git exits non-zero (path/ref absent). */
  private async gitSoft(cwd: string, args: string[]): Promise<string | null> {
    try {
      return await this.git(cwd, args)
    } catch {
      return null
    }
  }

  /** Walk up from `absPath` to the nearest dir containing `.git`, bounded by the workspace. */
  private async findRepoRoot(absPath: string): Promise<string | null> {
    const rootAbs = requireRoot()
    let dir = absPath
    for (;;) {
      const relToRoot = relative(rootAbs, dir)
      if (relToRoot.startsWith('..') || isAbsolute(relToRoot)) return null
      if (await pathExists(join(dir, '.git'))) return dir
      if (dir === rootAbs) return null
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  }

  async isRepo(rel: string): Promise<boolean> {
    return (await this.findRepoRoot(abs(rel))) !== null
  }

  private assertText(content: string, label: string): void {
    if (content.includes('\u0000')) {
      throw new Error(`Cannot diff “${label}”: it looks like a binary file.`)
    }
  }

  /** Short SHA for a rev (e.g. 'HEAD', 'HEAD~1'); null if the rev does not resolve. */
  private async shortSha(repoRoot: string, rev: string): Promise<string | null> {
    const out = await this.gitSoft(repoRoot, ['rev-parse', '--short', rev])
    return out ? out.trim() : null
  }

  /** Content of `<ref>:<path>` at a revision; '' if the path did not exist there. */
  private async showFile(repoRoot: string, ref: string): Promise<string> {
    const out = await this.gitSoft(repoRoot, ['show', ref])
    return out ?? ''
  }

  /** Working-tree content; '' if the file is absent (e.g. deleted). */
  private async readWorking(absPath: string): Promise<string> {
    try {
      return await fs.readFile(absPath, 'utf8')
    } catch {
      return ''
    }
  }

  async fileDiff(rel: string, mode: DiffMode): Promise<FileDiff> {
    const { repoRoot, pathInRepo, absPath } = await this.locate(rel)
    const headSha = await this.shortSha(repoRoot, 'HEAD')

    if (mode === 'working-vs-head') {
      const a = headSha ? await this.showFile(repoRoot, `HEAD:${pathInRepo}`) : ''
      const b = await this.readWorking(absPath)
      this.assertText(a, 'HEAD version')
      this.assertText(b, 'working tree')
      return {
        a,
        b,
        labelA: headSha ? `HEAD (${headSha})` : 'HEAD (no commits)',
        labelB: 'Working tree'
      }
    }

    // head-vs-prev
    const prevSha = await this.shortSha(repoRoot, 'HEAD~1')
    const a = prevSha ? await this.showFile(repoRoot, `HEAD~1:${pathInRepo}`) : ''
    const b = headSha ? await this.showFile(repoRoot, `HEAD:${pathInRepo}`) : ''
    this.assertText(a, 'previous version')
    this.assertText(b, 'HEAD version')
    return {
      a,
      b,
      labelA: prevSha ? `Previous (${prevSha})` : 'Previous (none)',
      labelB: headSha ? `HEAD (${headSha})` : 'HEAD (no commits)'
    }
  }
}

export const gitService = new GitService()

/** The absolute working-tree root of a repo the renderer names by its ws-relative root. Only a
 *  repo the git-state service discovered is accepted. */
async function repoCwd(repo: unknown): Promise<string> {
  if (typeof repo !== 'string' || !(await gitState.hasRepo(repo))) throw new Error('Not a repository in this workspace.')
  return join(requireRoot(), repo)
}

/** Where Check out to a worktree puts its folders: `POMADE_WORKTREES_DIR`, else `worktrees/` in
 *  this Pomade's home (`~/.pomade`, `~/.pomade-dev`) — outside every repository and outside the
 *  workspace. A test run never uses the Owner's real home (`owner-paths.ts`): without a test home
 *  its worktrees go in the test's user data folder, which the test removes. */
export function worktreesRoot(): string {
  const env = process.env.POMADE_WORKTREES_DIR?.trim()
  if (env && !refusedUnderTest(process.env, 'POMADE_WORKTREES_DIR', env, homedir())) return env
  const home = pomadeHome()
  if (home) return join(home, 'worktrees')
  if (process.env.NODE_ENV === 'test') return join(app.getPath('userData'), 'worktrees')
  return join(homedir(), '.pomade', 'worktrees')
}

export function registerGitService(ipc: typeof ipcMain): void {
  setLiveAgentsCheck(agentsLiveIn)
  setSessionLookup(branchSession)
  setWorktreesRoot(worktreesRoot)
  defineHandler(ipc, CH.git.isRepo, (_e, rel) => gitService.isRepo(rel))
  defineHandler(ipc, CH.git.fileDiff, (_e, rel, mode) => gitService.fileDiff(rel, mode))
  defineHandler(ipc, CH.git.state, () => gitState.current())
  defineHandler(ipc, CH.git.committedFile, (_e, rel) => gitService.committedFile(rel))
  defineHandler(ipc, CH.git.restoreFile, (_e, rel) => gitService.restoreFile(rel))
  defineHandler(ipc, CH.git.log, async (_e, repo, opts) =>
    readLog(runGit, await repoCwd(repo), { all: opts?.all === true, skip: Number(opts?.skip) || 0 })
  )
  defineHandler(ipc, CH.git.unpushed, async (_e, repo) => readUnpushed(runGit, await repoCwd(repo)))
  defineHandler(ipc, CH.git.mergeCommits, async (_e, repo, hash) => readMergeInner(runGit, await repoCwd(repo), hash))
  defineHandler(ipc, CH.git.commit, async (_e, repo, hash) => readCommit(runGit, await repoCwd(repo), hash))
  defineHandler(ipc, CH.git.fileAt, async (_e, repo, rev, path) => {
    const cwd = await repoCwd(repo)
    if (typeof path !== 'string' || typeof rev !== 'string' || !isWithin(path, repo) || path === repo) {
      throw new Error('Not a path in this repository.')
    }
    return readRevisionFile(runGit, runGitBuffer, cwd, rev, repo === '' ? path : path.slice(repo.length + 1))
  })
  defineHandler(ipc, CH.git.fileLog, async (_e, repo, path, opts) => {
    const cwd = await repoCwd(repo)
    const inRepo = (p: unknown): string => {
      if (typeof p !== 'string' || !isWithin(p, repo) || p === repo) throw new Error('Not a path in this repository.')
      return repo === '' ? p : p.slice(repo.length + 1)
    }
    const own = inRepo(path)
    const page = await readFileLog(runGit, runGitBuffer, cwd, own, {
      all: opts?.all === true,
      skip: Number(opts?.skip) || 0,
      via: opts?.via === undefined ? undefined : inRepo(opts.via),
      candidates: Array.isArray(opts?.candidates) ? opts.candidates.map(inRepo) : undefined,
      readWorking: () => fs.readFile(join(cwd, own), 'utf8').catch(() => null)
    })
    return {
      ...page,
      commits: page.commits.map((c) => ({ ...c, path: joinRel(repo, c.path) })),
      ...(page.renamedFrom === undefined ? {} : { renamedFrom: joinRel(repo, page.renamedFrom) })
    }
  })
  defineHandler(ipc, CH.git.preview, (_e, repo, req) => preview(repo, req))
  defineHandler(ipc, CH.git.run, (_e, repo, req, opts) => runOp(repo, req, opts))
  defineHandler(ipc, CH.git.folderInfo, (_e, rel) => folderInfo(rel))
  defineHandler(ipc, CH.git.initRepo, (_e, rel, message) => initRepo(rel, message))
  defineHandler(ipc, CH.git.rebase, (_e, repo) => readRebase(repo))
  defineHandler(ipc, CH.git.conflictFile, (_e, repo, path) => readConflictFile(repo, path))
  defineHandler(ipc, CH.git.inProgress, (_e, repo) => readInProgress(repo))
  defineHandler(ipc, CH.git.branch, (_e, repo, branch) => readBranch(repo, branch))
  registerGitState()
}
