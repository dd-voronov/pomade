// Pomade — E-028 always-on app backends (docs/HOST-API.md §2 "Backends").
//
// An app whose manifest declares `backend: { mode: "always-on" }` gets a per-user launchd agent (a
// login item): a plist in `~/Library/LaunchAgents` (`app-launchd-core.ts#resolveLaunchd`) that runs
// its entry from its build folder with Pomade's runtime, starts at login, is restarted by launchd
// after a crash, and keeps running when Pomade quits. Pomade writes and loads it when the app
// appears; when the app is updated the running backend is left alone unless the manifest says
// `restartOnUpdate`; when the app goes away the job is booted out and its plist removed. Pomade
// manages only plists whose label carries its own prefix.

import { execFile } from 'node:child_process'
import { promises as fs, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { app } from 'electron'

import { POMADE_ENV } from 'pomade-kit/protocol'

import type { AppBackendStatus } from '@shared/types'
import { clientEnv } from './app-backends'
import { pomadeHome } from './app-commands'
import { ensureAppKey } from './app-keys'
import { plistText, resolveLaunchd, type LaunchdConfig } from './app-launchd-core'
import { appFolder, appManifest, broadcastApps, knownAppIds, onAppsChanged } from './app-registry'
import { socketSessionsOf } from './host-socket'

let config: LaunchdConfig | null = null
/** The jobs Pomade loaded or found loaded this run, by app id. */
const loaded = new Set<string>()

function launchctl(...args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) =>
    execFile('/bin/launchctl', args, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}` }))
  )
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`
}

function labelOf(appId: string): string {
  return `${config!.labelPrefix}${appId}`
}

function plistPath(label: string): string {
  return join(config!.agentsDir, `${label}.plist`)
}

/** What identifies a build of the app: an update changes it. */
function buildStamp(folder: string, entry: string, version: string): string {
  try {
    return `${version} ${statSync(join(folder, entry)).mtimeMs}`
  } catch {
    return version
  }
}

function stampFile(appId: string): string {
  return join(app.getPath('userData'), 'run', `always-on-${appId}.stamp`)
}

async function isLoaded(label: string): Promise<boolean> {
  return (await launchctl('print', `${domain()}/${label}`)).ok
}

async function bootstrap(label: string): Promise<void> {
  let r = await launchctl('bootstrap', domain(), plistPath(label))
  for (let i = 0; i < 5 && !r.ok; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    r = await launchctl('bootstrap', domain(), plistPath(label))
  }
  if (!r.ok) console.error(`[always-on] bootstrap ${label} failed: ${r.out.trim()}`)
}

/** Unload the job and wait until launchd has let go of it (bootout returns before the job is gone,
 *  and a bootstrap of the same label until then fails). */
async function bootout(label: string): Promise<void> {
  await launchctl('bootout', `${domain()}/${label}`)
  for (let i = 0; i < 50 && (await isLoaded(label)); i++) await new Promise((r) => setTimeout(r, 100))
}

async function install(appId: string, folder: string, entry: string, version: string, restartOnUpdate: boolean): Promise<void> {
  const label = labelOf(appId)
  const userData = app.getPath('userData')
  await ensureAppKey(userData, appId)
  const log = join(userData, 'app-logs', appId, 'backend.log')
  await fs.mkdir(join(log, '..'), { recursive: true })
  // The workspace comes from the pointer at run time (it changes while the backend runs).
  const env = clientEnv(appId, 'backend')
  delete env[POMADE_ENV.workspace]
  const home = pomadeHome()
  if (home) env[POMADE_ENV.home] = home
  const text = plistText({ label, program: [process.execPath, join(folder, entry)], workingDirectory: folder, env, log })
  await fs.mkdir(config!.agentsDir, { recursive: true })
  const current = await fs.readFile(plistPath(label), 'utf8').catch(() => null)
  if (current !== text) await fs.writeFile(plistPath(label), text)
  const stamp = buildStamp(folder, entry, version)
  const previous = await fs.readFile(stampFile(appId), 'utf8').catch(() => null)
  await fs.mkdir(join(stampFile(appId), '..'), { recursive: true })
  await fs.writeFile(stampFile(appId), stamp)
  if (!(await isLoaded(label))) {
    await bootstrap(label)
  } else if (restartOnUpdate && previous !== null && previous !== stamp) {
    // The app asked: an update restarts its backend, with the plist as it is now.
    await bootout(label)
    await bootstrap(label)
  }
  loaded.add(appId)
}

async function uninstall(label: string, appId: string | null): Promise<void> {
  await bootout(label)
  await fs.rm(plistPath(label), { force: true })
  if (appId) {
    loaded.delete(appId)
    await fs.rm(stampFile(appId), { force: true })
  }
}

async function reconcile(): Promise<void> {
  if (!config) return
  const wanted = new Set<string>()
  for (const id of knownAppIds()) {
    const m = appManifest(id)
    const folder = appFolder(id)
    if (m?.backend?.mode !== 'always-on' || !folder) continue
    wanted.add(id)
    await install(id, folder, m.backend.entry, m.version, m.backend.restartOnUpdate)
  }
  // Login items of apps that went away (also: removed while Pomade was closed).
  const names = await fs.readdir(config.agentsDir).catch(() => [] as string[])
  for (const name of names) {
    if (!name.startsWith(config.labelPrefix) || !name.endsWith('.plist')) continue
    const label = name.slice(0, -'.plist'.length)
    const appId = label.slice(config.labelPrefix.length)
    // An app that is still known but unavailable for a moment (a broken update) keeps its item.
    if (wanted.has(appId) || knownAppIds().includes(appId)) continue
    await uninstall(label, appId)
  }
  broadcastApps()
}

let queue: Promise<void> = Promise.resolve()
function scheduleReconcile(): void {
  queue = queue.then(reconcile).catch((err: unknown) => console.error('[always-on] reconcile failed', err))
}

/** The status of an always-on backend, for the strip icon. */
export function alwaysOnStatus(appId: string): AppBackendStatus {
  const connected = socketSessionsOf(appId).some((s) => s.role === 'backend')
  if (!config) {
    return { mode: 'always-on', state: 'stopped', detail: 'always-on backends are off in this Pomade', pid: null, connected }
  }
  if (!appFolder(appId)) {
    return { mode: 'always-on', state: 'stopped', detail: 'a dev-server link has no local backend', pid: null, connected }
  }
  if (!loaded.has(appId)) return { mode: 'always-on', state: 'starting', detail: 'installing the login item', pid: null, connected }
  return {
    mode: 'always-on',
    state: 'running',
    detail: connected ? 'connected to Pomade' : 'not connected to Pomade',
    pid: null,
    connected
  }
}

/** Resolve where login items go and follow the registry (before its first scan). */
export function registerAppLaunchd(): void {
  config = resolveLaunchd(process.env, app.isPackaged ? 'stable' : 'dev', homedir())
  onAppsChanged(scheduleReconcile)
}
