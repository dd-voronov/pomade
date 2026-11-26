// Pomade — the one atomic (tmp + rename) writer, in its async, sync, and JSON-convenience forms.
// Every main-process module that persists a file (config-store's app.json/workspace.json/state,
// agent-service's agents.json, pty-manager's scrollback snapshots) writes through here instead of hand-rolling `${target}.<rand>.tmp` + rename: same
// tmp-name scheme, same tmp-cleanup-on-failure so a crashed write never leaves a stray `.tmp`
// sibling next to the file it was trying to replace.

import { promises as fsp, writeFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

function tmpPath(target: string): string {
  return `${target}.${randomBytes(6).toString('hex')}.tmp`
}

/** A conditional write found `target`'s mtime other than the one it was given: nothing was written. */
export class ChangedOnDiskError extends Error {
  constructor(
    readonly target: string,
    readonly mtimeMs: number
  ) {
    super(`${target} changed on disk`)
  }
}

/** Atomic write of raw text: write to a sibling `.tmp`, then rename over `target`. On failure
 *  (write OR rename) the tmp file is removed before the error is rethrown — a half-written
 *  temp file must never linger next to the real one. Caller is responsible for the parent
 *  directory existing (`fs.mkdir(..., { recursive: true })` first). `mode` sets the written
 *  file's permission bits (a replaced file keeps its own); default: the process umask's.
 *
 *  `ifMtime` makes the write conditional: `target` is replaced only while its mtime is exactly
 *  `ifMtime`, else `ChangedOnDiskError` and `target` is untouched. The check is a `stat` issued
 *  synchronously right before a synchronous `rename`, with every slow step (writing the tmp file)
 *  done before it: no JavaScript — so no other write of this process — runs between the check and
 *  the rename. Another process can still land a write in the gap between those two consecutive
 *  system calls; POSIX has no compare-and-rename, so that gap is as small as the filesystem allows. */
export async function writeFileAtomic(target: string, data: string, opts?: { mode?: number; ifMtime?: number }): Promise<void> {
  const tmp = tmpPath(target)
  try {
    await fsp.writeFile(tmp, data, 'utf8')
    if (opts?.mode !== undefined) await fsp.chmod(tmp, opts.mode)
    if (opts?.ifMtime === undefined) {
      await fsp.rename(tmp, target)
    } else {
      const { mtimeMs } = statSync(target)
      if (mtimeMs !== opts.ifMtime) throw new ChangedOnDiskError(target, mtimeMs)
      renameSync(tmp, target)
    }
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/** Atomic EXCLUSIVE create: write a sibling `.tmp`, then hard-link it to `target` — the link
 *  fails with EEXIST when anything exists there, so an existing file is never replaced and no
 *  reader ever sees a half-written file. The tmp name is removed either way. */
export async function createFileAtomic(target: string, data: string): Promise<void> {
  const tmp = tmpPath(target)
  try {
    await fsp.writeFile(tmp, data, 'utf8')
    await fsp.link(tmp, target)
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {})
  }
}

/** Synchronous counterpart, for the one caller that cannot await: the quit-time flush, which
 *  must complete before the child processes it guards are reaped. Same tmp-cleanup-on-failure. */
export function writeFileAtomicSync(target: string, data: string): void {
  const tmp = tmpPath(target)
  try {
    writeFileSync(tmp, data, 'utf8')
    renameSync(tmp, target)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* best-effort cleanup */
    }
    throw err
  }
}

/** The common case: atomically write `data` as pretty-printed JSON. */
export async function writeJsonAtomic(target: string, data: unknown): Promise<void> {
  await writeFileAtomic(target, JSON.stringify(data, null, 2))
}
