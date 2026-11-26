// Pomade — the `pomade-git` command's entry (docs/modules/git/pomade-git.md). Built by
// electron-vite next to the main process (out/main/pomade-git.js) from git-core alone — no
// Electron — and run by Pomade's shim in its command folder (`ELECTRON_RUN_AS_NODE`) or by the
// source checkout's `bin/pomade-git` (Node). It wires git-core/command.ts to the outside world:
// the environment, the output, and Pomade's answer to "is an agent live here?" over the socket
// (its terminals, and the agents app's agent tabs and Runner runs when that app answers — each with
// its state when known and the shells of the Pomade terminals it runs in).

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { PLATFORM_CLIENT_ID } from 'pomade-kit/protocol'
import { connectSocket, pomadeUserData } from 'pomade-kit/node'
import type { HostClient } from 'pomade-kit/sdk'

import { agentProcessesIn } from './agent-processes'
import { main, type AgentProbe, type CommandDeps } from './command'

/** How long the command waits for a running Pomade to answer before treating it as closed. */
const SOCKET_TIMEOUT_MS = 1500

function homeOf(env: NodeJS.ProcessEnv, stable: boolean): string {
  const override = env.POMADE_HOME?.trim()
  return override || join(homedir(), stable ? '.pomade' : '.pomade-dev')
}

/** Pomade's answer over its socket and the agent processes on this Mac. One connection to the
 *  running Pomade serves the whole run, opened on first use; Pomade closed (or refusing): null. */
function probe(userData: string): AgentProbe {
  let client: Promise<HostClient | null> | null = null
  const connect = async (): Promise<HostClient | null> => {
    const keyFile = join(userData, 'app-keys', PLATFORM_CLIENT_ID)
    const socketPath = join(userData, 'run', 'pomade.sock')
    if (!existsSync(keyFile) || !existsSync(socketPath)) return null
    const r = await connectSocket({ socketPath, appId: PLATFORM_CLIENT_ID, keyFile, role: 'command', env: {}, timeoutMs: SOCKET_TIMEOUT_MS }).catch(() => null)
    return r?.status === 'connected' ? r.host : null
  }
  return {
    pomade: async (folder) => {
      client ??= connect()
      const host = await client
      if (!host) return null
      return (await host.agents.liveIn(folder)).agents
    },
    processes: agentProcessesIn,
    close: () => {
      void client?.then((h) => h?.close())
    }
  }
}

export function run(argv: readonly string[]): Promise<number> {
  const env = process.env
  const deps: CommandDeps = {
    env,
    cwd: process.cwd(),
    now: Date.now,
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    agents: probe,
    userData: (stable) => pomadeUserData({ stable, env }),
    home: (stable) => homeOf(env, stable)
  }
  return main(argv, deps)
}

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    process.stderr.write(`pomade-git: ${(err as Error)?.stack ?? String(err)}\n`)
    process.exitCode = 1
  }
)
