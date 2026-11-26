// Pomade — E-028 commands on PATH (docs/HOST-API.md §2 "Commands").
//
// This Pomade's home (`app-commands-core.ts#resolvePomadeHome`: `~/.pomade`, a dev Pomade's
// `~/.pomade-dev`, or `POMADE_HOME`) holds:
//   bin/        — one shim per command: every hosted app's manifest `commands` and the platform's
//                 own — `pomade-git` (always; it ships in the app bundle) and `pomade` (from a
//                 source checkout); rewritten on every registry change
//   workspace   — the current workspace root, for commands run with Pomade closed
//   host.json   — the socket and how to launch this Pomade (`HostRecord`)
// A shim sets the command's identity (app id, key file, role `command`, the home, its state folder) and execs the
// entry with Pomade's runtime (`ELECTRON_RUN_AS_NODE=1`). Only files carrying the shim marker are
// ever replaced or removed. Pomade's own terminals get the folder on PATH through their environment
// (`commandTerminalEnv`). Other shells get it from one marked line in `~/.zprofile`
// (`shell-path-line.ts`), which Pomade writes or removes only when asked: Settings ▸ General
// (`commands.pathLine` / `commands.setPathLine`) or `pomade path install` / `remove`.

import { promises as fs, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { app, type IpcMain } from 'electron'

import { HOME_FILES, POMADE_ENV, type HostRecord } from 'pomade-kit/protocol'

import { CH } from '@shared/ipc-api'
import type { PathLineStatus } from '@shared/types'

import { appKeyFile, ensureAppKey } from './app-keys'
import { ensureAppStateFolder } from './app-state'
import {
  SHIM_MARKER,
  launchSpec,
  resolvePomadeHome,
  shimText,
  terminalEnv,
  type ShimSpec
} from './app-commands-core'
import { appFolder, appManifest, knownAppIds, onAppsChanged } from './app-registry'
import { configStore, onWorkspaceReady } from './config-store'
import { hostSocketPath } from './host-socket'
import { defineHandler } from './ipc'
import { resolveShellRc } from './owner-paths'
import { installPathLine, readPathLine, removePathLine } from './shell-path-line'

let home: string | null = null
let shellRc: string | null = null

/** This Pomade's home; null when commands are off (a test run without `POMADE_HOME`). */
export function pomadeHome(): string | null {
  return home
}

/** What Pomade's own terminals add to their environment (`pty-manager.ts#childEnv`). */
export function commandTerminalEnv(path: string | undefined): Record<string, string> {
  return terminalEnv(path, home, configStore.getRoot())
}

async function writeAtomic(path: string, text: string, mode: number): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  await fs.writeFile(tmp, text, { mode })
  await fs.chmod(tmp, mode)
  await fs.rename(tmp, path)
}

async function writeIfChanged(path: string, text: string, mode: number): Promise<void> {
  const current = await fs.readFile(path, 'utf8').catch(() => null)
  if (current !== text) await writeAtomic(path, text, mode)
}

/** The source checkout's `bin/pomade` (dev and test builds); a packaged Pomade has none. */
function platformPomadeBin(): string | null {
  const bin = resolve(__dirname, '../../bin/pomade')
  return existsSync(bin) ? bin : null
}

/** The built `pomade-git` command next to the main bundle (out/main/pomade-git.js; inside the app
 *  bundle when packaged). */
function platformPomadeGit(): string | null {
  const entry = join(__dirname, 'pomade-git.js')
  return existsSync(entry) ? entry : null
}

/** Every shim the command folder should hold, by command name. */
async function wantedShims(homeDir: string): Promise<Map<string, ShimSpec>> {
  const out = new Map<string, ShimSpec>()
  const userData = app.getPath('userData')
  // Sorted by id: when two apps name the same command (an app "a" and an app "a-b"), the first wins.
  for (const id of knownAppIds().sort()) {
    const m = appManifest(id)
    const folder = appFolder(id)
    if (!m || !folder || m.commands.length === 0) continue
    await ensureAppKey(userData, id)
    for (const c of m.commands) {
      if (out.has(c.name)) continue
      out.set(c.name, {
        label: `${c.name} of the app ${id}`,
        env: {
          [POMADE_ENV.home]: homeDir,
          [POMADE_ENV.appId]: id,
          [POMADE_ENV.keyFile]: appKeyFile(userData, id),
          [POMADE_ENV.role]: 'command',
          [POMADE_ENV.appState]: ensureAppStateFolder(userData, id),
          ELECTRON_RUN_AS_NODE: '1'
        },
        argv: [process.execPath, join(folder, c.entry)]
      })
    }
  }
  const pomadeGit = platformPomadeGit()
  if (pomadeGit && !out.has('pomade-git')) {
    out.set('pomade-git', {
      label: "pomade-git, Pomade's own command",
      env: { [POMADE_ENV.home]: homeDir, POMADE_USER_DATA: userData, ELECTRON_RUN_AS_NODE: '1' },
      argv: [process.execPath, pomadeGit]
    })
  }
  const pomadeBin = platformPomadeBin()
  if (pomadeBin && !out.has('pomade')) {
    out.set('pomade', { label: "pomade, Pomade's own command", env: { [POMADE_ENV.home]: homeDir, POMADE_USER_DATA: userData }, argv: [pomadeBin] })
  }
  return out
}

async function refresh(): Promise<void> {
  if (!home) return
  const bin = join(home, HOME_FILES.bin)
  await fs.mkdir(bin, { recursive: true })
  const root = configStore.getRoot()
  if (root) await writeIfChanged(join(home, HOME_FILES.workspace), `${root}\n`, 0o644)
  const socket = hostSocketPath()
  if (socket) {
    const record: HostRecord = { socket, launch: launchSpec(process.execPath, process.argv, process.env, app.isPackaged) }
    await writeIfChanged(join(home, HOME_FILES.host), `${JSON.stringify(record, null, 2)}\n`, 0o600)
  }
  const wanted = await wantedShims(home)
  for (const [name, spec] of wanted) await writeIfChanged(join(bin, name), shimText(spec), 0o755)
  for (const name of await fs.readdir(bin)) {
    if (wanted.has(name)) continue
    const text = await fs.readFile(join(bin, name), 'utf8').catch(() => '')
    if (text.split('\n')[1]?.startsWith(SHIM_MARKER)) await fs.rm(join(bin, name), { force: true })
  }
}

let queue: Promise<void> = Promise.resolve()
function scheduleRefresh(): void {
  queue = queue.then(refresh).catch((err: unknown) => console.error('[commands] refresh failed', err))
}

/** The PATH line for this Pomade's command folder; null when commands are off (a test run
 *  without `POMADE_HOME`, or without `POMADE_SHELL_RC`). */
async function pathLine(change?: 'install' | 'remove'): Promise<PathLineStatus | null> {
  if (!home || !shellRc) return null
  const binDir = join(home, HOME_FILES.bin)
  if (change === 'install') return installPathLine(shellRc, binDir)
  if (change === 'remove') return removePathLine(shellRc, binDir)
  return readPathLine(shellRc, binDir)
}

/** Resolve the home, follow the registry and the workspace (before the registry's first scan), and
 *  serve the PATH line to Settings. */
export function registerAppCommands(ipc: IpcMain): void {
  const flavor = app.isPackaged ? 'stable' : 'dev'
  home = resolvePomadeHome(process.env, flavor, homedir())
  shellRc = home ? resolveShellRc(process.env, homedir()) : null
  onAppsChanged(scheduleRefresh)
  onWorkspaceReady(scheduleRefresh)
  defineHandler(ipc, CH.commands.pathLine, () => pathLine())
  defineHandler(ipc, CH.commands.setPathLine, (_e, on) => pathLine(on === true ? 'install' : 'remove'))
}

/** Write the home's records now (after the socket started) and wait for it. */
export function refreshCommands(): Promise<void> {
  scheduleRefresh()
  return queue
}
