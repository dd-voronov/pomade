// Pomade — git-core: committing every change a repo's state lists, in one commit, and taking that
// commit back. The Git panel's Commit & push (main/git-ops.ts) and the `pomade-git` command both
// commit through it; the command takes its commit back when their changes conflict, so the
// repository ends exactly as it was before the run.

import { randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

import type { RepoState } from '@shared/git-state'

import { inRepo, pathspecs, readOk, shortHead, step } from './rails'

/** The index file's bytes as they were (null bytes: there was none). */
export interface IndexSnapshot {
  path: string | null
  bytes: Buffer | null
}

export async function indexSnapshot(cwd: string): Promise<IndexSnapshot> {
  const gitDir = (await readOk(cwd, ['rev-parse', '--absolute-git-dir']))?.trim()
  const path = gitDir ? join(gitDir, 'index') : null
  return { path, bytes: path ? await fsp.readFile(path).catch(() => null) : null }
}

/** Put the index file back exactly (written aside, then renamed into place). */
export async function restoreIndex(snap: IndexSnapshot): Promise<void> {
  if (!snap.path) return
  if (snap.bytes) {
    const tmp = `${snap.path}.pomade-${randomBytes(4).toString('hex')}`
    await fsp.writeFile(tmp, snap.bytes)
    await fsp.rename(tmp, snap.path)
  } else await fsp.rm(snap.path, { force: true })
}

/** Commit every previewed change with `message`. On a failed commit the index is put back as it
 *  was before the files were added (nothing staged by Pomade lingers). Resolves with the short hash. */
export async function commitAll(state: RepoState, env: NodeJS.ProcessEnv, message: string, snap?: IndexSnapshot): Promise<string> {
  const cwd = state.absPath
  const before = snap ?? (await indexSnapshot(cwd))
  const paths = new Set<string>()
  for (const c of state.changes) {
    paths.add(inRepo(state.root, c.path))
    if (c.from) paths.add(inRepo(state.root, c.from))
  }
  try {
    await step(cwd, env, ['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: pathspecs([...paths]) })
    await step(cwd, env, ['commit', '-q', '--cleanup=whitespace', '-F', '-'], { input: message })
  } catch (err) {
    await restoreIndex(before)
    throw err
  }
  return shortHead(cwd)
}

/** Take back the commit just made on top of `headBefore`: the branch moves back (`reset --soft` —
 *  no file is touched) and the index is put back as `snap` kept it. */
export async function takeBackCommit(cwd: string, env: NodeJS.ProcessEnv, headBefore: string, snap: IndexSnapshot): Promise<void> {
  await step(cwd, env, ['reset', '-q', '--soft', headBefore])
  await restoreIndex(snap)
}
