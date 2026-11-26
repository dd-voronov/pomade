// Pomade — git-core: agent processes working in a folder, found without Pomade — the `pomade-git`
// command's "is an agent live here?" when nothing answers on the socket, and alongside the socket's
// answer when something does (an agent started in another terminal app is not in Pomade's list).
//
//   An agent process is a `claude` or `codex` executable, or a script by that name run by an
//   interpreter (`node …/codex`, `/bin/zsh …/claude`). Its working directory (lsof) at or below the
//   folder, compared by real path, makes it live there. Each carries its ancestors' pids, so the
//   command can tell one that runs in a Pomade terminal (under that terminal's shell).

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { basename, isAbsolute, relative, resolve } from 'node:path'

/** The agent executables looked for. */
export const AGENT_NAMES: readonly string[] = ['claude', 'codex']
const INTERPRETERS = new Set(['node', 'bun', 'deno', 'sh', 'bash', 'zsh', 'python', 'python3'])

export interface AgentProcess {
  pid: number
  agent: string
  cwd: string
  /** Its parent, the parent's parent, … up to (not including) pid 1, nearest first. */
  ancestors: number[]
}

/** The agent an argument list runs, or null. */
export function agentOf(args: string): string | null {
  const words = args.trim().split(/\s+/)
  const name = (w: string | undefined): string => (w ? basename(w).replace(/\.(c|m)?js$/, '') : '')
  const first = name(words[0])
  if (AGENT_NAMES.includes(first)) return first
  if (INTERPRETERS.has(first)) {
    const script = words.slice(1).find((w) => !w.startsWith('-'))
    const second = name(script)
    if (AGENT_NAMES.includes(second)) return second
  }
  return null
}

/** `ps -axo pid=,ppid=,args=` → the agent processes (pid and agent), this process excluded, and
 *  every process's parent. */
export function parsePs(out: string, self = process.pid): { agents: { pid: number; agent: string }[]; parents: Map<number, number> } {
  const agents: { pid: number; agent: string }[] = []
  const parents = new Map<number, number>()
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    parents.set(pid, Number(m[2]))
    const agent = pid === self ? null : agentOf(m[3])
    if (agent) agents.push({ pid, agent })
  }
  return { agents, parents }
}

/** `pid`'s ancestors by `parents`, nearest first, up to (not including) pid 1. */
export function ancestorsOf(pid: number, parents: ReadonlyMap<number, number>): number[] {
  const out: number[] = []
  for (let p = parents.get(pid); p !== undefined && p > 1 && !out.includes(p) && p !== pid; p = parents.get(p)) out.push(p)
  return out
}

/** `lsof -Fn -a -d cwd -p …` → each pid's working directory. */
export function parseLsofCwd(out: string): Map<number, string> {
  const cwd = new Map<number, string>()
  let pid = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) cwd.set(pid, line.slice(1))
  }
  return cwd
}

function run(cmd: string, args: readonly string[]): Promise<string> {
  return new Promise((done) => {
    execFile(cmd, args as string[], { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => done(stdout ?? ''))
  })
}

async function realOr(p: string): Promise<string> {
  return fs.realpath(p).catch(() => resolve(p))
}

/** True when `path` is `folder` or inside it (both absolute; real paths). */
export async function isAtOrBelow(path: string, folder: string): Promise<boolean> {
  const [p, f] = await Promise.all([realOr(path), realOr(folder)])
  const rel = relative(f, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The agent processes whose working directory is `folder` or below it. */
export async function agentProcessesIn(folder: string): Promise<AgentProcess[]> {
  const { agents, parents } = parsePs(await run('ps', ['-axo', 'pid=,ppid=,args=']))
  if (agents.length === 0) return []
  const cwds = parseLsofCwd(await run('lsof', ['-w', '-Fn', '-a', '-d', 'cwd', '-p', agents.map((a) => a.pid).join(',')]))
  const out: AgentProcess[] = []
  for (const a of agents) {
    const cwd = cwds.get(a.pid)
    if (cwd && (await isAtOrBelow(cwd, folder))) out.push({ pid: a.pid, agent: a.agent, cwd, ancestors: ancestorsOf(a.pid, parents) })
  }
  return out
}
