// Pomade (T-179) — the resume-command build + parse pair, colocated. `terminals-store` used to
// encode this vocabulary twice in OPPOSITE directions: `agentCommand` BUILT `codex resume <id>` /
// `claude --resume <id>`, and `handleAgentStart` separately RE-PARSED a command string with its
// own regex to recover the id. A new provider had to update both — and get the regex's shape
// exactly right — or bind-state silently misclassified a resume launch as a fresh one. Keeping
// build + parse in the same file, next to each other, is what makes that coupling visible; the
// round-trip unit test below is what proves it.
//
// `@shared/types.AGENT_SESSION_COMMANDS` is a SEPARATE vocabulary (the in-session `/clear`,
// `/branch`, `/resume`… slash commands the user types to a live agent, read by
// `matchSessionCommand` below) — an independent concern from the CLI resume FLAG this module
// builds/parses. A new provider must still update both.

import type { AgentInfo, AgentSessionCommands } from '@shared/types'

/** One argument for zsh: as is when it is plain, single-quoted otherwise. */
export function shellArg(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

/** Build a launch command: the roster command, then a launch mode's args, or the resume args when
 *  resuming a session. No notification flags: the pty's Apple_Terminal masquerade makes agents
 *  notify on their own (docs/modules/agents/agent-providers.md). */
export function buildAgentCommand(agent: AgentInfo, resumeSessionId?: string, modeArgs: readonly string[] = []): string {
  const base = [agent.command, ...modeArgs.map(shellArg)].join(' ')
  if (!resumeSessionId) return base
  return agent.kind === 'codex' ? `${base} resume ${resumeSessionId}` : `${base} --resume ${resumeSessionId}`
}

// Matches the two shapes `buildAgentCommand` can produce: `<cmd> resume <id>` (codex) or anything
// containing `--resume <id>` (every other provider).
const RESUME_RE = /(?:^\S+\s+resume|--resume)\s+(\S+)/

/** Recover the resume session id from a just-launched command line, if it names one. */
export function parseResumeId(command: string): string | undefined {
  return command.match(RESUME_RE)?.[1]
}

/** Which session command a submitted line is, in an agent's vocabulary: the command exactly, or
 *  the command and an argument. */
export function matchSessionCommand(vocab: AgentSessionCommands, line: string): 'clear' | 'fork' | 'resume' | null {
  const is = (cmd: string): boolean => line === cmd || line.startsWith(`${cmd} `)
  if (vocab.clear.some(is)) return 'clear'
  if (vocab.fork.some(is)) return 'fork'
  if (is(vocab.resume)) return 'resume'
  return null
}
