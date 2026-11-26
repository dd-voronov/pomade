import { describe, expect, it } from 'vitest'

import type { GitRunResult } from 'pomade-kit/protocol'

import {
  autoCommitMessage,
  cleanJobName,
  jobCommitLabel,
  parseRunLogLine,
  summarizeRuns
} from './git-runs'

const result = (path: string, status: GitRunResult['status']): GitRunResult => ({
  repo: 'K',
  path,
  op: 'commit-push',
  status,
  reason: status === 'done' ? null : 'why',
  steps: [{ step: 'agents', outcome: 'done', detail: 'no agent working here' }],
  commit: null
})
const line = (x: unknown): string => JSON.stringify(x)

describe('the run log', () => {
  it('keeps the last run per repo; a failure is unseen until a later seen line', () => {
    const text = [
      line({ kind: 'run', at: 1, job: null, result: result('/a', 'done') }),
      line({ kind: 'run', at: 2, job: 'J', result: result('/a', 'failed') }),
      line({ kind: 'run', at: 3, job: null, result: result('/b', 'failed') }),
      'torn {',
      line({ kind: 'seen', at: 4, path: '/b' }),
      ''
    ].join('\n')
    const s = summarizeRuns(text)
    expect(s.get('/a')).toMatchObject({ at: 2, job: 'J', unseenFailure: true })
    expect(s.get('/b')).toMatchObject({ at: 3, unseenFailure: false })
  })

  it('skips lines that are not entries', () => {
    expect(parseRunLogLine('{"kind":"run","at":1,"job":null,"result":{"repo":"K"}}')).toBeNull()
    expect(parseRunLogLine('{"kind":"seen","at":1}')).toBeNull()
    expect(parseRunLogLine('nope')).toBeNull()
  })
})

describe('job wording', () => {
  it('names the job in the message and the trailer', () => {
    const at = new Date(2026, 10, 9, 13, 0).getTime()
    expect(autoCommitMessage('Knowledge twice daily', at)).toBe(
      'Committed automatically · job "Knowledge twice daily" · 2026-11-09 13:00\n\nPomade-Job: Knowledge twice daily\n'
    )
    expect(autoCommitMessage(null, at)).toBe('Committed automatically · 2026-11-09 13:00\n')
    expect(jobCommitLabel('Knowledge twice daily', at)).toBe('Committed automatically · job "Knowledge twice daily" · 13:00')
  })

  it('takes one-line names only', () => {
    expect(cleanJobName('  a  ')).toBe('a')
    expect(cleanJobName('')).toBeNull()
    expect(cleanJobName('a\nb')).toBeNull()
    expect(cleanJobName('x'.repeat(101))).toBeNull()
  })
})
