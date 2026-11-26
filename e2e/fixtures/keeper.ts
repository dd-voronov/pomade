// Pomade e2e — E-034: a test keeper for an app id, bound where Pomade looks for that app's keeper
// (`<userData>/run/keepers/<appId>.sock`), run on Pomade's own Electron binary in Node mode — and
// the owner's side of the attach protocol, from the spec process. Everything it starts is killed
// in `stop()`.

import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { expect } from '@playwright/test'
import { connectKeeper, type KeeperClient } from 'pomade-kit/node'
import { keeperSocketPath } from 'pomade-kit/protocol'

const ENTRY = resolve(__dirname, 'keeper/keeper.mjs')
/** Pomade's own runtime (the dev Electron), run as Node — as an app's backend runs. */
const ELECTRON = resolve(__dirname, '../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')

export interface TestKeeper {
  socketPath: string
  stateDir: string
  /** The owner's connection (spawn, stop, update, upgrade). */
  owner(): Promise<KeeperClient>
  /** Keeper pids seen (an update starts new ones). */
  pids: Set<number>
  /** Kill every keeper process and every session it started. */
  stop(): void
}

async function answer(socketPath: string): Promise<number | null> {
  const r = await connectKeeper({ socketPath, app: 'e2e', timeoutMs: 500 })
  if (r.status !== 'connected') return null
  r.keeper.close()
  return r.keeper.keeper.pid
}

export async function startTestKeeper(userDataDir: string, appId: string): Promise<TestKeeper> {
  const socketPath = keeperSocketPath(userDataDir, appId)
  const stateDir = join(userDataDir, 'app-state', appId, 'keeper')
  const child = spawn(ELECTRON, [ENTRY], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      SHELL: '/bin/sh',
      POMADE_APP_ID: appId,
      POMADE_KEEPER_SOCKET: socketPath
    }
  })
  child.unref()
  const pids = new Set<number>()
  if (child.pid) pids.add(child.pid)
  let pid: number | null = null
  await expect.poll(async () => (pid = await answer(socketPath)), { timeout: 15000 }).not.toBeNull()
  if (pid) pids.add(pid)
  const clients: KeeperClient[] = []
  return {
    socketPath,
    stateDir,
    pids,
    async owner() {
      const r = await connectKeeper({ socketPath, app: appId, role: 'owner' })
      if (r.status !== 'connected') throw new Error(`owner connect: ${JSON.stringify(r)}`)
      pids.add(r.keeper.keeper.pid)
      clients.push(r.keeper)
      return r.keeper
    },
    stop() {
      for (const c of clients) c.close()
      for (const p of pids) {
        try {
          process.kill(p, 'SIGKILL')
        } catch {
          /* gone */
        }
      }
      try {
        for (const name of readdirSync(join(stateDir, 'sessions'))) {
          const rec = JSON.parse(readFileSync(join(stateDir, 'sessions', name), 'utf8')) as { pid: number | null }
          if (rec.pid) {
            try {
              process.kill(-rec.pid, 'SIGKILL')
            } catch {
              /* gone */
            }
          }
        }
      } catch {
        /* no sessions */
      }
    }
  }
}

/** True while `pid` runs. */
export function alive(pid: number | null | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
