// Pomade — git-core: getting their changes under this branch's own commits (a rebase onto the
// upstream), on a repository with nothing uncommitted, so that a conflict can always be aborted
// back to exactly the state before — and that is checked. The `pomade-git` command's pull runs it
// (an agent has no conflict tab); the Git panel stops a conflict for its conflict tab instead
// (main/git-operator.ts `rebaseOnto`).

import { GIT_LOCAL_TIMEOUT_MS, lastGitLine } from '@shared/git-ops'

import { conflictedPaths, fingerprint, ignoredOverwrites, inProgress, raw, readOk, sameFingerprint } from './rails'

export type CatchUp =
  /** `theirs` commits came in (0: nothing new). */
  | { ok: true; theirs: number }
  /** Refused before touching anything: their changes would overwrite ignored files here. */
  | { ok: false; blocked: string }
  /** The rebase failed and was aborted. `files`: the conflicting files (repo-relative; empty when
   *  the rebase failed for another reason); `diffs`: how the repository differs from before the
   *  rebase (empty = exactly as before); `line`: git's last line. */
  | { ok: false; files: string[]; diffs: string[]; line: string }

/** Rebase this branch onto `rev` (the upstream, already fetched). */
export async function catchUp(cwd: string, env: NodeJS.ProcessEnv, rev = '@{u}'): Promise<CatchUp> {
  const theirs = Number((await readOk(cwd, ['rev-list', '--count', `HEAD..${rev}`]))?.trim()) || 0
  if (theirs === 0) return { ok: true, theirs }
  // git overwrites ignored files without asking when it checks out a file at their path: refuse
  // when their changes would land on an ignored file here.
  const ignored = await ignoredOverwrites(cwd, [`HEAD...${rev}`])
  if (ignored) return { ok: false, blocked: ignored }
  const before = await fingerprint(cwd)
  const rebase = await raw(cwd, ['rebase', '--rebase-merges', '--no-autostash', '--no-update-refs', rev], { env, timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  if (rebase.code === 0 && !rebase.timedOut) return { ok: true, theirs }
  const files = await conflictedPaths(cwd)
  if (await inProgress(cwd)) await raw(cwd, ['rebase', '--abort'], { env, timeoutMs: GIT_LOCAL_TIMEOUT_MS })
  const diffs = sameFingerprint(before, await fingerprint(cwd))
  return { ok: false, files, diffs, line: lastGitLine(rebase.stderr) }
}

/** "in a.md, b.md, c.md and 2 more" — the conflicting files in a sentence ('' for none). */
export function inFiles(files: readonly string[]): string {
  if (files.length === 0) return ''
  return ` in ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''}`
}
