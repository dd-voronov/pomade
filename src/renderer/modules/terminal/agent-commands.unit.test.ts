// T-179 — round-trip proof that buildAgentCommand/parseResumeId agree: whatever the builder
// encodes, the parser must recover the exact same session id, for every agent kind. This is the
// test the ticket calls out: a new provider that gets one direction right and the other wrong
// would misclassify a resume launch as fresh (or vice versa) with no other signal.

import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_COMMANDS, type AgentInfo } from '@shared/types'
import { buildAgentCommand, matchSessionCommand, parseResumeId, shellArg } from './agent-commands'

function agent(kind: AgentInfo['kind'], command: string): AgentInfo {
  return { id: kind, name: kind, kind, command, resolved: true, modes: [] }
}

describe('agent-commands round trip', () => {
  it('codex: build then parse recovers the same session id', () => {
    const cmd = buildAgentCommand(agent('codex', 'codex'), 'sess-abc123')
    expect(cmd).toBe('codex resume sess-abc123')
    expect(parseResumeId(cmd)).toBe('sess-abc123')
  })

  it('claude: build then parse recovers the same session id', () => {
    const cmd = buildAgentCommand(agent('claude', 'claude'), 'sess-xyz789')
    expect(cmd).toBe('claude --resume sess-xyz789')
    expect(parseResumeId(cmd)).toBe('sess-xyz789')
  })

  it('custom folder agent (claude-family flag) round-trips too', () => {
    const cmd = buildAgentCommand(agent('custom', '/opt/my-agent --config x'), 'sess-42')
    expect(cmd).toBe('/opt/my-agent --config x --resume sess-42')
    expect(parseResumeId(cmd)).toBe('sess-42')
  })

  it('no resumeSessionId: bare roster command, nothing to parse', () => {
    const cmd = buildAgentCommand(agent('codex', 'codex'))
    expect(cmd).toBe('codex')
    expect(parseResumeId(cmd)).toBeUndefined()
  })

  it('a plain (non-resume) launch command parses to undefined', () => {
    expect(parseResumeId('claude')).toBeUndefined()
    expect(parseResumeId('zsh')).toBeUndefined()
  })
})

describe('E-033 launch modes', () => {
  it('a mode\'s args follow the command', () => {
    expect(buildAgentCommand(agent('claude', 'claude-pm'), undefined, ['--dangerously-skip-permissions'])).toBe(
      'claude-pm --dangerously-skip-permissions'
    )
    expect(buildAgentCommand(agent('codex', 'codex'), undefined, [])).toBe('codex')
  })

  it('an arg with spaces or quotes is single-quoted for zsh', () => {
    expect(shellArg('--model=opus')).toBe('--model=opus')
    expect(shellArg('two words')).toBe("'two words'")
    expect(shellArg("it's")).toBe("'it'\\''s'")
    expect(buildAgentCommand(agent('claude', 'claude'), undefined, ['--append', 'be brief'])).toBe("claude --append 'be brief'")
  })
})

describe('matchSessionCommand (T-327)', () => {
  const claude = AGENT_SESSION_COMMANDS.claude
  const codex = AGENT_SESSION_COMMANDS.codex

  it('claude: /clear and its aliases clear, /branch forks, /resume resumes — with or without an argument', () => {
    for (const line of ['/clear', '/reset', '/new', '/clear next topic']) expect(matchSessionCommand(claude, line)).toBe('clear')
    for (const line of ['/branch', '/branch G4 grill']) expect(matchSessionCommand(claude, line)).toBe('fork')
    for (const line of ['/resume', '/resume abc']) expect(matchSessionCommand(claude, line)).toBe('resume')
  })

  it('claude /fork copies the conversation into a background session: the tab keeps its own, no command', () => {
    expect(matchSessionCommand(claude, '/fork')).toBeNull()
    expect(matchSessionCommand(claude, '/fork look into the flaky spec')).toBeNull()
  })

  it('codex: /clear and /new clear, /fork forks, /resume resumes', () => {
    expect(matchSessionCommand(codex, '/clear')).toBe('clear')
    expect(matchSessionCommand(codex, '/new')).toBe('clear')
    expect(matchSessionCommand(codex, '/fork')).toBe('fork')
    expect(matchSessionCommand(codex, '/resume 019a')).toBe('resume')
    expect(matchSessionCommand(codex, '/branch')).toBeNull()
  })

  it('a prompt is no command — not even one that starts like one', () => {
    expect(matchSessionCommand(claude, 'clear the cache')).toBeNull()
    expect(matchSessionCommand(claude, '/clearly not')).toBeNull()
    expect(matchSessionCommand(claude, '/branches')).toBeNull()
  })
})
