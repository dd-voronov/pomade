import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { parseCodexMeta, readCodexMeta } from './codex-rollout'

const OWN = '019a0000-0000-7000-8000-000000000001'
const PARENT = '019a0000-0000-7000-8000-000000000002'
const meta = (payload: Record<string, unknown>): string => JSON.stringify({ type: 'session_meta', payload })

describe('parseCodexMeta', () => {
  it('reads the rollout’s own id from payload.id', () => {
    expect(parseCodexMeta(meta({ id: OWN, session_id: OWN, cwd: '/w', timestamp: 't0', source: 'cli' }))).toEqual({
      sessionId: OWN,
      cwd: '/w',
      startedAt: 't0',
      subagent: false
    })
  })

  it('a rollout without session_id (older CLI, Codex Desktop) still has its id', () => {
    expect(parseCodexMeta(meta({ id: OWN, cwd: '/w', source: 'vscode' }))?.sessionId).toBe(OWN)
  })

  it('a sub-agent rollout is its own id, marked sub-agent — never its parent’s session_id', () => {
    const m = parseCodexMeta(
      meta({
        id: OWN,
        session_id: PARENT,
        cwd: '/w',
        source: { subagent: { thread_spawn: {} } },
        parent_thread_id: PARENT
      })
    )
    expect(m).toMatchObject({ sessionId: OWN, subagent: true })
  })

  it('a forked rollout (`/fork`) names its parent; a fresh one does not', () => {
    expect(parseCodexMeta(meta({ id: OWN, forked_from_id: PARENT, cwd: '/w', source: 'cli' }))).toMatchObject({
      sessionId: OWN,
      subagent: false,
      forkedFrom: PARENT
    })
    expect(parseCodexMeta(meta({ id: OWN, cwd: '/w', source: 'cli' }))).not.toHaveProperty('forkedFrom')
    expect(parseCodexMeta(meta({ id: OWN, forked_from_id: '', cwd: '/w' }))).not.toHaveProperty('forkedFrom')
  })

  it('falls back to session_id only when there is no id', () => {
    expect(parseCodexMeta(meta({ session_id: OWN, cwd: '/w' }))?.sessionId).toBe(OWN)
  })

  it('is null for a partial line, another line type, or a meta without id or cwd', () => {
    expect(parseCodexMeta(meta({ id: OWN, cwd: '/w' }).slice(0, 20))).toBeNull()
    expect(parseCodexMeta(JSON.stringify({ type: 'turn_context', payload: { id: OWN, cwd: '/w' } }))).toBeNull()
    expect(parseCodexMeta(meta({ cwd: '/w' }))).toBeNull()
    expect(parseCodexMeta(meta({ id: OWN }))).toBeNull()
  })
})

describe('readCodexMeta', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codex-rollout-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('takes line 0 even when later lines repeat a session_meta (sub-agent, Desktop resume)', async () => {
    const file = join(dir, 'sub.jsonl')
    await writeFile(
      file,
      [
        meta({ id: OWN, cwd: '/w', source: { subagent: 'x' } }),
        meta({ id: PARENT, cwd: '/w', source: 'cli' }),
        '{}'
      ].join('\n') + '\n'
    )
    expect(await readCodexMeta(file)).toMatchObject({ sessionId: OWN, subagent: true })
  })

  it('reads a line 0 longer than one read chunk (base instructions run to tens of KB)', async () => {
    const file = join(dir, 'long.jsonl')
    await writeFile(file, meta({ id: OWN, cwd: '/w', base_instructions: 'x'.repeat(200_000) }) + '\n{}\n')
    expect((await readCodexMeta(file))?.sessionId).toBe(OWN)
  })

  it('is null for a missing file or a partially written line 0', async () => {
    expect(await readCodexMeta(join(dir, 'missing.jsonl'))).toBeNull()
    const file = join(dir, 'partial.jsonl')
    await writeFile(file, meta({ id: OWN, cwd: '/w' }).slice(0, 30))
    expect(await readCodexMeta(file)).toBeNull()
  })
})
