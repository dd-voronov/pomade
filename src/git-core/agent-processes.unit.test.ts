import { describe, expect, it } from 'vitest'

import { agentOf, ancestorsOf, parseLsofCwd, parsePs } from './agent-processes'

describe('agentOf', () => {
  it('knows the agent executables and scripts run by an interpreter', () => {
    expect(agentOf('claude')).toBe('claude')
    expect(agentOf('/Users/me/.local/bin/claude --resume abc')).toBe('claude')
    expect(agentOf('node /opt/homebrew/bin/codex')).toBe('codex')
    expect(agentOf('node --no-warnings /x/codex.js exec')).toBe('codex')
    expect(agentOf('/bin/zsh /tmp/fake/claude')).toBe('claude')
  })

  it('leaves everything else alone', () => {
    expect(agentOf('vim claude.md')).toBeNull()
    expect(agentOf('node server.js claude')).toBeNull()
    expect(agentOf('/Applications/Claude.app/Contents/MacOS/Claude')).toBeNull()
    expect(agentOf('')).toBeNull()
  })
})

describe('parsePs / parseLsofCwd / ancestorsOf', () => {
  const out = '    1     0 /sbin/launchd\n  101     1 /bin/zsh -l\n  202   101 claude\n  303   202 node /usr/local/bin/codex\n  404   101 claude\n'

  it('finds agent pids, never its own, and every parent', () => {
    const { agents, parents } = parsePs(out, 404)
    expect(agents).toEqual([
      { pid: 202, agent: 'claude' },
      { pid: 303, agent: 'codex' }
    ])
    expect(parents.get(303)).toBe(202)
    expect(parents.size).toBe(5)
  })

  it("lists a process's ancestors nearest first, short of pid 1, and stops on a loop", () => {
    const { parents } = parsePs(out)
    expect(ancestorsOf(303, parents)).toEqual([202, 101])
    expect(ancestorsOf(101, parents)).toEqual([])
    expect(ancestorsOf(999, parents)).toEqual([])
    expect(ancestorsOf(7, new Map([[7, 8], [8, 9], [9, 8]]))).toEqual([8, 9])
  })

  it("reads each pid's working directory", () => {
    expect(parseLsofCwd('p202\nfcwd\nn/Users/me/ws/Knowledge\np303\nfcwd\nn/tmp\n')).toEqual(
      new Map([
        [202, '/Users/me/ws/Knowledge'],
        [303, '/tmp']
      ])
    )
  })
})
