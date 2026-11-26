// Pomade — git-core: the `pomade-git` run log in Pomade's user data (`<userData>/git/runs.jsonl`,
// format in shared/git-runs.ts). The command appends one line per repo per run; Pomade appends a
// `seen` line when the user opens a repo, and reads the log back for the repo rows and the marks.
// Each line is written with one append, so concurrent writers never interleave inside a line.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import {
  GIT_RUN_LOG_DIR,
  GIT_RUN_LOG_FILE,
  GIT_RUN_LOG_MAX_BYTES,
  GIT_RUN_LOG_PREVIOUS,
  type GitRunLogEntry
} from '@shared/git-runs'

export function runLogDir(userData: string): string {
  return join(userData, GIT_RUN_LOG_DIR)
}

/** Append one entry. Past the size bound the log moves to `runs.1.jsonl` (replacing the one
 *  before) and a fresh log starts. */
export async function appendRunLog(userData: string, entry: GitRunLogEntry): Promise<void> {
  const dir = runLogDir(userData)
  await fs.mkdir(dir, { recursive: true })
  const file = join(dir, GIT_RUN_LOG_FILE)
  const size = (await fs.stat(file).catch(() => null))?.size ?? 0
  if (size > GIT_RUN_LOG_MAX_BYTES) await fs.rename(file, join(dir, GIT_RUN_LOG_PREVIOUS)).catch(() => {})
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
}

/** The log's text, the previous file first; '' when there is none. */
export async function readRunLog(userData: string): Promise<string> {
  const dir = runLogDir(userData)
  const read = (name: string): Promise<string> => fs.readFile(join(dir, name), 'utf8').catch(() => '')
  const [previous, current] = await Promise.all([read(GIT_RUN_LOG_PREVIOUS), read(GIT_RUN_LOG_FILE)])
  return previous && !previous.endsWith('\n') ? `${previous}\n${current}` : previous + current
}
