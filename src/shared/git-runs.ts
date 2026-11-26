// Pomade — E-042: the `pomade-git` command's model, shared by the command (git-core/command.ts),
// the main process (main/git-runs.ts) and the renderer (the repo row, History). Pure.
//
//   run log        `<userData>/git/runs.jsonl`, one GitRunLogEntry per line (append-only), rotated
//                  to `runs.1.jsonl` past GIT_RUN_LOG_MAX_BYTES; `summarizeRuns` reads it back
//   job wording    the automatic commit's message and its `Pomade-Job:` trailer
//
// The cross-repo contract — the operations, `GitRunResult` / `GitRunOutput` (what `--json` prints
// and the run log keeps) and `pomade-runner`'s `jobs.forRepo` (`RepoJob`) — lives in
// `pomade-kit/protocol` (git-runs).

import { isGitRunResult, type GitRunOp, type GitRunResult } from 'pomade-kit/protocol'

export const GIT_RUN_TITLE: Record<GitRunOp, string> = {
  'commit-push': 'Commit & push',
  pull: 'Pull',
  push: 'Push',
  fetch: 'Fetch'
}

// ── Exit codes ────────────────────────────────────────────────────────────────

/** Every repo done or skipped. */
export const EXIT_OK = 0
/** At least one repo failed. */
export const EXIT_FAILED = 1
/** The command line was wrong (unknown operation, no repo, a bad option); nothing ran. */
export const EXIT_USAGE = 2

// ── The run log ───────────────────────────────────────────────────────────────

export const GIT_RUN_LOG_DIR = 'git'
export const GIT_RUN_LOG_FILE = 'runs.jsonl'
export const GIT_RUN_LOG_PREVIOUS = 'runs.1.jsonl'
export const GIT_RUN_LOG_MAX_BYTES = 1024 * 1024

export type GitRunLogEntry =
  /** A run's result for one repo. `at`: epoch ms. */
  | { kind: 'run'; at: number; job: string | null; result: GitRunResult }
  /** The user looked at the repo in Pomade (opened it): failures before `at` are seen. */
  | { kind: 'seen'; at: number; path: string }

/** One log line, or null when it is not a valid entry (a torn or foreign line is skipped). */
export function parseRunLogLine(line: string): GitRunLogEntry | null {
  let x: unknown
  try {
    x = JSON.parse(line)
  } catch {
    return null
  }
  const e = x as GitRunLogEntry
  if (!e || typeof e.at !== 'number') return null
  if (e.kind === 'seen') return typeof e.path === 'string' ? { kind: 'seen', at: e.at, path: e.path } : null
  if (e.kind === 'run' && (e.job === null || typeof e.job === 'string') && isGitRunResult(e.result)) {
    return { kind: 'run', at: e.at, job: e.job, result: e.result }
  }
  return null
}

/** A repo's last run, and whether it failed without the user having opened the repo since. */
export interface GitRunSummary {
  at: number
  job: string | null
  result: GitRunResult
  unseenFailure: boolean
}

/** The log's text (older file first) → the last run per repo path. */
export function summarizeRuns(text: string): Map<string, GitRunSummary> {
  const last = new Map<string, GitRunSummary>()
  const seen = new Map<string, number>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const e = parseRunLogLine(line)
    if (!e) continue
    if (e.kind === 'seen') seen.set(e.path, Math.max(seen.get(e.path) ?? 0, e.at))
    else {
      const prev = last.get(e.result.path)
      if (!prev || prev.at <= e.at) last.set(e.result.path, { at: e.at, job: e.job, result: e.result, unseenFailure: false })
    }
  }
  for (const [path, s] of last) s.unseenFailure = s.result.status === 'failed' && (seen.get(path) ?? 0) < s.at
  return last
}

// ── Job wording ───────────────────────────────────────────────────────────────

/** The trailer naming the job that made an automatic commit. */
export const JOB_TRAILER = 'Pomade-Job'
export const JOB_NAME_MAX_LENGTH = 100

/** A job name as `--job` takes it: one line, trimmed, 1–100 characters; null when it is not one. */
export function cleanJobName(raw: string): string | null {
  const name = raw.trim()
  if (!name || name.length > JOB_NAME_MAX_LENGTH || /[\r\n\u0000]/.test(name)) return null
  return name
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** "13:00" — local time. */
export function clockLabel(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "2026-11-09 13:00" — local time. */
export function stampLabel(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clockLabel(ms)}`
}

/** The message of a commit the command makes: `Committed automatically · job "<name>" · <stamp>`
 *  with the `Pomade-Job:` trailer, or `Committed automatically · <stamp>` without a job. */
export function autoCommitMessage(job: string | null, at: number): string {
  if (job === null) return `Committed automatically · ${stampLabel(at)}\n`
  return `Committed automatically · job "${job}" · ${stampLabel(at)}\n\n${JOB_TRAILER}: ${job}\n`
}

/** How History shows a commit carrying the trailer: `Committed automatically · job "<name>" · 13:00`. */
export function jobCommitLabel(job: string, at: number): string {
  return `Committed automatically · job "${job}" · ${clockLabel(at)}`
}
