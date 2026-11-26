// Pomade e2e — E-028: talk to a Pomade under test over its Host API socket, as an app's backend or
// command would (pomade-kit/node's client), from the spec process.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { expect } from '@playwright/test'
import { connectSocket, type SocketConnectResult } from 'pomade-kit/node'
import type { HostClient } from 'pomade-kit/sdk'

/** The socket of the Pomade using `userDataDir`. */
export function socketPathOf(userDataDir: string): string {
  return join(userDataDir, 'run', 'pomade.sock')
}

/** The key Pomade issued for `appId` (`pomade` = the platform client's). */
export function appKeyOf(userDataDir: string, appId: string): Promise<string> {
  return fs.readFile(join(userDataDir, 'app-keys', appId), 'utf8').then((k) => k.trim())
}

/** Wait until the socket listens and the app's key exists. */
export async function waitForSocket(userDataDir: string, appId?: string): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          await fs.stat(socketPathOf(userDataDir))
          if (appId) await appKeyOf(userDataDir, appId)
          return true
        } catch {
          return false
        }
      },
      { timeout: 15000 }
    )
    .toBe(true)
}

/** Connect as `appId` with its issued key. */
export async function connectAs(
  userDataDir: string,
  appId: string,
  role: 'backend' | 'command' = 'command'
): Promise<SocketConnectResult> {
  return connectSocket({ socketPath: socketPathOf(userDataDir), appId, key: await appKeyOf(userDataDir, appId), role, env: {} })
}

/** `connectAs`, requiring success. */
export async function clientAs(userDataDir: string, appId: string, role: 'backend' | 'command' = 'command'): Promise<HostClient> {
  const r = await connectAs(userDataDir, appId, role)
  if (r.status !== 'connected') throw new Error(`socket connect as ${appId}: ${JSON.stringify(r)}`)
  return r.host
}
