import { execFile } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import {
  CHECK_MARKER,
  CHECK_SCRIPT,
  commandWord,
  createCommandChecker,
  isResolved,
  parseCheckOutput,
  type ShellRun
} from './agent-check-core'

const answered = (statuses: number[], extra: Partial<ShellRun> = {}): ShellRun => ({
  stdout: 'motd noise\n' + statuses.map((s, i) => `${CHECK_MARKER} ${i + 1} ${s}`).join('\n') + '\n',
  stderr: '',
  code: 0,
  signal: null,
  timedOut: false,
  ...extra
})

const timedOut: ShellRun = { stdout: '', stderr: 'compinit: slow\n', code: null, signal: 'SIGTERM', timedOut: true }

/** A checker whose shell answers from a script of runs; records every call's words. */
function scripted(runs: ShellRun[]) {
  const calls: string[][] = []
  const logs: string[] = []
  const checker = createCommandChecker({
    run: async (_script, words) => {
      calls.push(words)
      const next = runs.shift()
      if (!next) throw new Error('no more scripted runs')
      return next
    },
    log: (line) => logs.push(line),
    timeoutMs: 8000
  })
  return { checker, calls, logs }
}

describe('createCommandChecker', () => {
  it('a check that times out once is unknown (still resolved), and the next roster build re-checks and resolves it', async () => {
    const { checker, calls } = scripted([timedOut, answered([0])])
    const first = await checker.check(['claude-libra'])
    expect(first.get('claude-libra')).toBe('unknown')
    expect(isResolved(first.get('claude-libra')!)).toBe(true)
    const second = await checker.check(['claude-libra'])
    expect(second.get('claude-libra')).toBe('found')
    expect(calls).toEqual([['claude-libra'], ['claude-libra']])
  })

  it('never caches "not found": a command installed later resolves on the next build', async () => {
    const { checker, calls } = scripted([answered([1]), answered([0])])
    expect((await checker.check(['codex'])).get('codex')).toBe('not-found')
    expect((await checker.check(['codex'])).get('codex')).toBe('found')
    expect(calls).toHaveLength(2)
  })

  it('caches "found" for the run; forget() re-checks', async () => {
    const { checker, calls } = scripted([answered([0]), answered([0])])
    await checker.check(['claude'])
    await checker.check(['claude'])
    expect(calls).toHaveLength(1)
    checker.forget('claude')
    await checker.check(['claude'])
    expect(calls).toHaveLength(2)
  })

  it('checks a whole roster in one shell, by first word, each word once', async () => {
    const { checker, calls } = scripted([answered([0, 1, 0])])
    const out = await checker.check(['claude', 'codex --full-auto', 'claude-libra', 'claude --resume x', 'nope'])
    expect(calls).toEqual([['claude', 'codex', 'claude-libra', 'nope']])
    // The shell reported three of the four words; the fourth never came back ⇒ unknown.
    expect(out.get('codex --full-auto')).toBe('not-found')
    expect(out.get('claude --resume x')).toBe('found')
    expect(out.get('nope')).toBe('unknown')
  })

  it('concurrent roster builds share one in-flight shell', async () => {
    const { checker, calls } = scripted([answered([0])])
    const [a, b] = await Promise.all([checker.check(['claude']), checker.check(['claude'])])
    expect(a.get('claude')).toBe('found')
    expect(b.get('claude')).toBe('found')
    expect(calls).toHaveLength(1)
  })

  it('logs each failure once with the command, the reason and the stderr head', async () => {
    const { checker, logs } = scripted([timedOut, timedOut, answered([0]), answered([1])])
    await checker.check(['claude-pm'])
    await checker.check(['claude-pm'])
    expect(logs).toEqual(['[agents] command check: "claude-pm" unknown — timed out after 8000 ms; stderr: compinit: slow'])
    await checker.check(['claude-pm']) // found — cached from here on
    checker.forget('claude-pm')
    await checker.check(['claude-pm'])
    expect(logs[1]).toBe('[agents] command check: "claude-pm" not-found — whence exit 1 in the interactive login shell')
  })

  it('a shell that cannot start leaves every word unknown', async () => {
    const { checker, logs } = scripted([])
    expect((await checker.check(['claude'])).get('claude')).toBe('unknown')
    expect(logs[0]).toContain('shell did not start')
  })

  it('an empty command is not found without a shell', async () => {
    const { checker, calls } = scripted([])
    expect((await checker.check(['  '])).get('  ')).toBe('not-found')
    expect(calls).toHaveLength(0)
  })
})

describe('parsing', () => {
  it('commandWord takes the first word', () => {
    expect(commandWord('  codex  --full-auto ')).toBe('codex')
    expect(commandWord('')).toBe('')
  })
  it('parseCheckOutput reads marker lines only, by index', () => {
    expect(parseCheckOutput(`hello\n${CHECK_MARKER} 2 1\n${CHECK_MARKER} 9 0\nx ${CHECK_MARKER} 1 0\n`, 3)).toEqual([null, 1, null])
  })
})

describe('CHECK_SCRIPT in a real zsh (no startup files)', () => {
  it('reports each word by position and never evaluates a word', async () => {
    const words = ['ls', 'pomade-no-such-cmd', '$(echo pwned >&2)', "it's; rm -rf x"]
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) =>
      execFile('zsh', ['-fc', CHECK_SCRIPT, 'pomade-agent-check', ...words], (err, stdout, stderr) =>
        err ? reject(err) : resolve({ stdout, stderr })
      )
    )
    expect(parseCheckOutput(stdout, words.length)).toEqual([0, 1, 1, 1])
    expect(stderr).toBe('')
  })
})

describe('a roster build waits for the shell only briefly', () => {
  it('answers unknown after waitMs while the shell runs on, and the late answer serves the next build', async () => {
    let finish: (run: ShellRun) => void = () => {}
    const calls: string[][] = []
    const checker = createCommandChecker({
      run: (_script, words) => {
        calls.push(words)
        return new Promise<ShellRun>((resolve) => (finish = resolve))
      },
      log: () => {},
      timeoutMs: 30_000
    })
    const first = await checker.check(['claude-libra'], 20)
    expect(first.get('claude-libra')).toBe('unknown')
    finish(answered([0]))
    await new Promise((r) => setTimeout(r, 0))
    expect((await checker.check(['claude-libra'], 20)).get('claude-libra')).toBe('found')
    expect(calls).toHaveLength(1)
  })
})
