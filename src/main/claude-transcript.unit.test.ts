// T-327 — what a Claude Code transcript's first message records: the session it was branched
// from (`/branch`), and whether it is a background session (the copy `/fork` starts).

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { parseClaudeHead, readClaudeHead } from './claude-transcript'

const PARENT = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1'
const OWN = 'b2b2b2b2-2222-4222-8222-b2b2b2b2b2b2'
const line = (o: Record<string, unknown>): string => JSON.stringify(o)
const mode = line({ type: 'mode', mode: 'normal', sessionId: OWN })
const snapshot = line({ type: 'file-history-snapshot', messageId: 'm0', snapshot: {} })
const UNDECIDED = { decided: false, forkedFrom: null, background: false }

describe('parseClaudeHead', () => {
  it('a branch: its copied lines name the parent session', () => {
    const copied = line({ type: 'user', uuid: 'u1', sessionId: OWN, forkedFrom: { sessionId: PARENT, messageUuid: 'u1' } })
    expect(parseClaudeHead([copied])).toEqual({ decided: true, forkedFrom: PARENT, background: false })
    expect(parseClaudeHead([line({ type: 'session-owner', sessionId: OWN }), copied]).forkedFrom).toBe(PARENT)
  })

  it('a fresh session or a /clear: its first message names no parent', () => {
    const clear = line({ type: 'user', uuid: 'u1', sessionId: OWN, message: { content: '<command-name>/clear</command-name>' } })
    expect(parseClaudeHead([mode, snapshot, clear])).toEqual({ decided: true, forkedFrom: null, background: false })
    // A later line that happens to carry the field does not count: the first message decides.
    const later = line({ type: 'user', uuid: 'u2', forkedFrom: { sessionId: PARENT, messageUuid: 'x' } })
    expect(parseClaudeHead([mode, clear, later]).forkedFrom).toBeNull()
  })

  it('a background session (the copy claude\'s /fork starts) is marked by its sessionKind', () => {
    const ops = line({ type: 'queue-operation', operation: 'enqueue', sessionId: OWN })
    const copied = line({ type: 'user', uuid: 'u1', sessionId: OWN, sessionKind: 'bg', message: { content: 'how much is 2 x 2?' } })
    expect(parseClaudeHead([mode, ops, copied])).toEqual({ decided: true, forkedFrom: null, background: true })
  })

  it('no message yet, or a partial line: undecided; a malformed parent is none', () => {
    expect(parseClaudeHead([mode, snapshot])).toEqual(UNDECIDED)
    expect(parseClaudeHead([])).toEqual(UNDECIDED)
    expect(parseClaudeHead(['{"type":"user","uu'])).toEqual(UNDECIDED)
    expect(parseClaudeHead([line({ uuid: 'u1', forkedFrom: { sessionId: 7 } })]).forkedFrom).toBeNull()
    expect(parseClaudeHead([line({ uuid: 'u1', forkedFrom: 'x' })]).forkedFrom).toBeNull()
  })
})

describe('readClaudeHead', () => {
  let dir = ''
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pomade-claude-transcript-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads the head off the file; a missing file is undecided', async () => {
    const file = join(dir, `${OWN}.jsonl`)
    const copied = line({ type: 'user', uuid: 'u1', forkedFrom: { sessionId: PARENT, messageUuid: 'u1' } })
    await writeFile(file, [mode, copied, line({ type: 'assistant', uuid: 'u2' })].join('\n') + '\n')
    expect(await readClaudeHead(file)).toEqual({ decided: true, forkedFrom: PARENT, background: false })
    expect(await readClaudeHead(join(dir, 'missing.jsonl'))).toEqual(UNDECIDED)
  })

  it('a first message still being written (no newline yet) is undecided', async () => {
    const file = join(dir, 'partial.jsonl')
    await writeFile(file, `${mode}\n{"type":"user","uuid":"u1","forkedFrom":{"sessionId":"${PARENT}"`)
    expect(await readClaudeHead(file)).toEqual(UNDECIDED)
  })
})
