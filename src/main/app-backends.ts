// Pomade — E-028 with-Pomade app backends (docs/HOST-API.md §2 "Backends").
//
// An app whose manifest declares `backend: { mode: "with-pomade" }` gets its Node entry run while
// Pomade runs: started when Pomade starts and whenever the app appears (install, dev link), restarted
// when the app is updated and after a crash (back-off 1 s doubling to 30 s; a run that lasted 30 s
// resets it), stopped when the app goes away and when Pomade quits. The runtime is Pomade's own
// Electron binary in Node mode (`ELECTRON_RUN_AS_NODE=1`), so no system Node is needed. The process
// gets a clean environment with its identity for the Host API socket (`clientEnv`), its stdout and
// stderr go to `<userData>/app-logs/<id>/backend.log`, and its pid is recorded in
// `<userData>/run/backend-<id>.pid` so a backend a crashed Pomade left behind is stopped on the next
// start. Status (`HostedApp.backend`) is pushed with the app list.

import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promises as fs, openSync, closeSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import { app } from 'electron'

import { POMADE_ENV, type ClientRole } from 'pomade-kit/protocol'

import type { AppBackendStatus } from '@shared/types'
import { appKeyFile, ensureAppKey } from './app-keys'
import { ensureAppStateFolder } from './app-state'
import { appFolder, appManifest, appRevision, broadcastApps, knownAppIds, onAppsChanged, setBackendStatusProvider } from './app-registry'
import { configStore, onWorkspaceReady } from './config-store'
import { hostSocketPath, socketSessionsOf } from './host-socket'
import { alwaysOnStatus } from './app-launchd'
import { ensureKeeperSocketDir, keeperSocketFor } from './attached-terminals'

/** Crash back-off: 1 s, doubling, at most 30 s. */
const BACKOFF_MIN_MS = 1000
const BACKOFF_MAX_MS = 30000
/** A run at least this long resets the back-off. */
const HEALTHY_RUN_MS = 30000
/** How long a backend may take to exit after SIGTERM before it is killed. */
const STOP_GRACE_MS = 3000
/** A log grows to this size before it is rotated (`backend.log.1`). */
const LOG_MAX_BYTES = 2 * 1024 * 1024

/** Inherited from Pomade into a backend's or command's environment; everything else is ours. */
const PASS_ENV = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'TMPDIR', 'TZ']

interface Backend {
  appId: string
  /** The entry it runs (absolute) and the revision it was started for. */
  entry: string
  revision: number
  child: ChildProcess | null
  startedAt: number
  crashes: number
  restartTimer: NodeJS.Timeout | null
  /** Set while Pomade stops it on purpose (update, removal, quit). */
  stopping: Promise<void> | null
  lastExit: string | null
}

const backends = new Map<string, Backend>()
let quitting = false

function userData(): string {
  return app.getPath('userData')
}

/** The environment Pomade gives an app's backend or command: a few inherited basics plus its
 *  identity on the Host API socket, its state folder (created here) and the workspace root. */
export function clientEnv(appId: string, role: ClientRole): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of PASS_ENV) {
    const v = process.env[key]
    if (v !== undefined) env[key] = v
  }
  for (const [key, v] of Object.entries(process.env)) if (key.startsWith('LC_') && v !== undefined) env[key] = v
  env.ELECTRON_RUN_AS_NODE = '1'
  env[POMADE_ENV.appId] = appId
  env[POMADE_ENV.keyFile] = appKeyFile(userData(), appId)
  env[POMADE_ENV.role] = role
  env[POMADE_ENV.appState] = ensureAppStateFolder(userData(), appId)
  const socket = hostSocketPath()
  if (socket) env[POMADE_ENV.socket] = socket
  // E-034 — where the app's keeper binds; Pomade attaches tabs there directly.
  if (role === 'backend') {
    ensureKeeperSocketDir()
    env[POMADE_ENV.keeperSocket] = keeperSocketFor(appId)
  }
  const root = configStore.getRoot()
  if (root) env[POMADE_ENV.workspace] = root
  return env
}

function pidFile(appId: string): string {
  return join(userData(), 'run', `backend-${appId}.pid`)
}

function logFile(appId: string): string {
  return join(userData(), 'app-logs', appId, 'backend.log')
}

/** An append-only log fd, rotated once it is large. */
async function openLog(appId: string): Promise<number> {
  const file = logFile(appId)
  await fs.mkdir(join(file, '..'), { recursive: true })
  try {
    if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`)
  } catch {
    /* no log yet */
  }
  return openSync(file, 'a')
}

function status(b: Backend | undefined, appId: string): AppBackendStatus | null {
  const m = appManifest(appId)
  if (!m?.backend) return null
  if (m.backend.mode === 'always-on') return alwaysOnStatus(appId)
  const connected = socketSessionsOf(appId).some((s) => s.role === 'backend')
  if (!appFolder(appId)) {
    return { mode: 'with-pomade', state: 'stopped', detail: 'a dev-server link has no local backend', pid: null, connected }
  }
  if (!b) return { mode: 'with-pomade', state: 'starting', detail: null, pid: null, connected }
  if (b.child?.pid !== undefined && b.child.exitCode === null && b.child.signalCode === null) {
    return { mode: 'with-pomade', state: 'running', detail: `pid ${b.child.pid}`, pid: b.child.pid, connected }
  }
  if (b.restartTimer) {
    return {
      mode: 'with-pomade',
      state: 'restarting',
      detail: `${b.lastExit ?? 'stopped'} · crash ${b.crashes}`,
      pid: null,
      connected
    }
  }
  return { mode: 'with-pomade', state: 'stopped', detail: b.lastExit, pid: null, connected }
}

function backoff(crashes: number): number {
  return Math.min(BACKOFF_MIN_MS * 2 ** Math.max(0, crashes - 1), BACKOFF_MAX_MS)
}

async function launch(b: Backend): Promise<void> {
  const folder = appFolder(b.appId)
  if (!folder || quitting) return
  await ensureAppKey(userData(), b.appId)
  const log = await openLog(b.appId)
  let child: ChildProcess
  try {
    child = spawn(process.execPath, [b.entry], {
      cwd: folder,
      env: clientEnv(b.appId, 'backend'),
      stdio: ['ignore', log, log]
    })
  } finally {
    closeSync(log)
  }
  b.child = child
  b.startedAt = Date.now()
  if (child.pid !== undefined) void fs.writeFile(pidFile(b.appId), `${child.pid}\n${b.entry}\n`).catch(() => undefined)
  child.once('error', (err) => {
    b.lastExit = `could not start: ${err.message}`
  })
  child.once('exit', (code, signal) => {
    if (b.child !== child) return
    b.child = null
    void fs.rm(pidFile(b.appId), { force: true })
    b.lastExit = signal ? `stopped by ${signal}` : `exited with code ${code}`
    if (b.stopping || quitting || backends.get(b.appId) !== b) {
      broadcastApps()
      return
    }
    // A crash (or any exit Pomade did not ask for): restart after the back-off.
    b.crashes = Date.now() - b.startedAt >= HEALTHY_RUN_MS ? 1 : b.crashes + 1
    b.restartTimer = setTimeout(() => {
      b.restartTimer = null
      void launch(b).then(broadcastApps)
    }, backoff(b.crashes))
    broadcastApps()
  })
  broadcastApps()
}

/** Stop a backend: SIGTERM, then SIGKILL after the grace period. Resolves once it exited. */
function stop(b: Backend): Promise<void> {
  if (b.restartTimer) clearTimeout(b.restartTimer)
  b.restartTimer = null
  const child = b.child
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  b.stopping ??= new Promise<void>((resolve) => {
    const kill = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS)
    child.once('exit', () => {
      clearTimeout(kill)
      resolve()
    })
    child.kill('SIGTERM')
  }).finally(() => {
    b.stopping = null
  })
  return b.stopping
}

/** Bring the running backends in line with the registry: start new ones, restart updated ones,
 *  stop the ones whose app went away (or no longer declares a with-Pomade backend). */
async function reconcile(): Promise<void> {
  if (quitting) return
  const wanted = new Map<string, { entry: string; revision: number }>()
  for (const id of knownAppIds()) {
    const m = appManifest(id)
    const folder = appFolder(id)
    if (m?.backend?.mode === 'with-pomade' && folder) wanted.set(id, { entry: join(folder, m.backend.entry), revision: appRevision(id) })
  }
  for (const [id, b] of [...backends]) {
    const w = wanted.get(id)
    if (w && w.entry === b.entry && w.revision === b.revision) continue
    backends.delete(id)
    await stop(b)
  }
  for (const [id, w] of wanted) {
    if (backends.has(id)) continue
    const b: Backend = { appId: id, entry: w.entry, revision: w.revision, child: null, startedAt: 0, crashes: 0, restartTimer: null, stopping: null, lastExit: null }
    backends.set(id, b)
    await launch(b)
  }
  broadcastApps()
}

let reconciling: Promise<void> = Promise.resolve()
function scheduleReconcile(): void {
  reconciling = reconciling.then(reconcile).catch((err: unknown) => console.error('[backends] reconcile failed', err))
}

/** Restart every backend (a workspace switch: they start over against the new root). */
function restartAll(): void {
  reconciling = reconciling
    .then(async () => {
      for (const [id, b] of [...backends]) {
        backends.delete(id)
        await stop(b)
      }
    })
    .then(reconcile)
    .catch((err: unknown) => console.error('[backends] restart failed', err))
}

/** Stop a with-Pomade backend a previous, crashed Pomade left running: the pid file names the
 *  process and the entry it ran; it is stopped only when that process still runs that entry. */
async function reapLeftovers(): Promise<void> {
  const run = join(userData(), 'run')
  let names: string[]
  try {
    names = (await fs.readdir(run)).filter((n) => /^backend-.+\.pid$/.test(n))
  } catch {
    return
  }
  await Promise.all(
    names.map(async (name) => {
      const [pidText, entry] = (await fs.readFile(join(run, name), 'utf8').catch(() => '')).split('\n')
      const pid = Number(pidText)
      await fs.rm(join(run, name), { force: true })
      if (!Number.isInteger(pid) || pid <= 0 || !entry) return
      const command = await new Promise<string>((resolve) =>
        execFile('/bin/ps', ['-o', 'command=', '-p', String(pid)], (err, out) => resolve(err ? '' : out))
      )
      if (command.includes(entry)) {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          /* already gone */
        }
      }
    })
  )
}

/** Start supervising (before the registry's first scan, so its first change starts them). */
export function registerAppBackends(): void {
  setBackendStatusProvider((id) => status(backends.get(id), id))
  onAppsChanged(scheduleReconcile)
  onWorkspaceReady(restartAll)
}

/** Stop backends left by a crashed Pomade; run once at start, before the registry scans. */
export function reapLeftoverBackends(): Promise<void> {
  return reapLeftovers()
}

/** Quit: stop every backend and wait until they exited (bounded by the grace period). */
export async function stopAllBackends(): Promise<void> {
  quitting = true
  await Promise.all([...backends.values()].map(stop))
}
