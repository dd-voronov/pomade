// Pomade — E-042: the `pomade-git` runs in Pomade (main process). The command appends every run's
// result to the run log in this Pomade's user data (git-core/run-log.ts) — with Pomade open or
// closed — and this module serves it to the Git panel: each repo's last run, and whether it failed
// unseen (the attention mark, which therefore survives a closed Pomade and shows at the next
// launch). Opening the repo writes a `seen` line. It also reads `pomade-runner`'s "which jobs
// target repo X" through the broker for the repo row's Scheduled line (PLATFORM rule 7: Runner
// absent or not responding → no line).

import { mkdirSync, promises as fs, watch, type FSWatcher } from 'node:fs'

import { app, type IpcMain } from 'electron'

import { CH, EV } from '@shared/ipc-api'
import { PLATFORM_CLIENT_ID, REPO_JOBS_APP_ID, REPO_JOBS_METHOD, checkRepoJobs, type RepoJob } from 'pomade-kit/protocol'

import { summarizeRuns, type GitRunSummary } from '@shared/git-runs'

import { appendRunLog, readRunLog, runLogDir } from '../git-core/run-log'
import { callAppApi, isServing, onServingChange } from './app-broker'
import { openBusConnection } from './event-bus'
import { gitState } from './git-state'
import { defineHandler } from './ipc'
import { safeBroadcast } from './windows'

/** A burst of appends (one run over several repos) is read once. */
const READ_DEBOUNCE_MS = 150
/** Runner's own events (`<appId>:<event>` on the bus): its jobs changed, or a run ended — either
 *  moves a job's "Next run" / "Last run". */
const RUNNER_JOB_EVENTS = [`${REPO_JOBS_APP_ID}:jobs.changed`, `${REPO_JOBS_APP_ID}:runs.changed`]
/** How long the Scheduled line waits for Runner (rule 7). */
const JOBS_TIMEOUT_MS = 1500

let watcher: FSWatcher | null = null
let timer: NodeJS.Timeout | null = null
let lastRoots = ''
let watchingJobs = false

function userData(): string {
  return app.getPath('userData')
}

async function real(p: string): Promise<string> {
  return fs.realpath(p).catch(() => p)
}

/** Each discovered repo's last run, by its workspace root. */
async function runsByRoot(): Promise<Record<string, GitRunSummary>> {
  const byPath = summarizeRuns(await readRunLog(userData()))
  if (byPath.size === 0) return {}
  const out: Record<string, GitRunSummary> = {}
  for (const repo of (await gitState.current()).repos) {
    const s = byPath.get(await real(repo.absPath))
    if (s) out[repo.root] = s
  }
  return out
}

function scheduleBroadcast(): void {
  timer ??= setTimeout(() => {
    timer = null
    void runsByRoot().then(
      (runs) => safeBroadcast(EV.gitRuns, runs),
      () => {}
    )
  }, READ_DEBOUNCE_MS)
}

function startWatching(): void {
  if (watcher) return
  const dir = runLogDir(userData())
  mkdirSync(dir, { recursive: true })
  watcher = watch(dir, scheduleBroadcast)
  watcher.on('error', () => {
    watcher?.close()
    watcher = null
  })
  // A repo discovered (or gone) changes which runs the panel can place.
  gitState.subscribe((snap) => {
    const roots = snap.repos.map((r) => r.root).join('\0')
    if (roots === lastRoots) return
    lastRoots = roots
    scheduleBroadcast()
  })
}

/** The user opened the repo: its failed run is seen. */
async function markSeen(root: unknown): Promise<void> {
  if (typeof root !== 'string' || !(await gitState.hasRepo(root))) return
  const repo = (await gitState.current()).repos.find((r) => r.root === root)
  if (!repo) return
  await appendRunLog(userData(), { kind: 'seen', at: Date.now(), path: await real(repo.absPath) })
}

/** One listener for the whole panel: Runner starting or stopping to serve, or publishing
 *  `jobs.changed` or `runs.changed`, tells every row to ask again (`git:jobs`). */
function startWatchingJobs(): void {
  if (watchingJobs) return
  watchingJobs = true
  const changed = (): void => safeBroadcast(EV.gitJobs)
  openBusConnection({ appId: PLATFORM_CLIENT_ID, deliver: (name) => RUNNER_JOB_EVENTS.includes(name) && changed() }, RUNNER_JOB_EVENTS)
  onServingChange((appId) => appId === REPO_JOBS_APP_ID && changed())
}

/** Runner's jobs that target the repo; null when Runner is absent, not responding or answered
 *  something else — the row shows nothing then. */
async function scheduled(root: unknown): Promise<RepoJob[] | null> {
  startWatchingJobs()
  if (typeof root !== 'string' || !isServing(REPO_JOBS_APP_ID)) return null
  const repo = (await gitState.current()).repos.find((r) => r.root === root)
  if (!repo) return null
  const answer = await callAppApi(REPO_JOBS_APP_ID, REPO_JOBS_METHOD, { repo: { name: repo.name, path: await real(repo.absPath) } }, JOBS_TIMEOUT_MS)
  return answer === null ? null : checkRepoJobs(answer)
}

export function registerGitRuns(ipc: IpcMain): void {
  defineHandler(ipc, CH.git.runs, async () => {
    startWatching()
    return runsByRoot()
  })
  defineHandler(ipc, CH.git.runSeen, (_e, root) => markSeen(root))
  defineHandler(ipc, CH.git.scheduled, (_e, root) => scheduled(root))
  app.on('will-quit', () => {
    watcher?.close()
    watcher = null
  })
}
