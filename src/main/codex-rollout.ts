// Pomade — a Codex rollout's identity, from its line 0 (docs/modules/agents/session-stores.md,
// "Provider: Codex CLI"). Line 0 is the rollout's own `session_meta`: `payload.id` is the file's
// own session id. Later `session_meta` lines are not the file's identity — a sub-agent rollout
// repeats its parent's on line 1, and Codex Desktop writes the same-id meta again on resume — and
// `payload.session_id` is not either: older and Desktop rollouts lack it, and a sub-agent's
// carries its parent's id. Read by the session watcher, session validation and the history scan.

import { promises as fs } from 'node:fs'

export interface CodexRolloutMeta {
  /** The rollout's own session id. */
  sessionId: string
  /** The absolute cwd the session ran in. */
  cwd: string
  /** When the session was created (`payload.timestamp`), when recorded. */
  startedAt?: string
  /** A sub-agent's rollout (`payload.source.subagent`): never a tab's session, never listed. */
  subagent: boolean
  /** The session this one was forked from (`payload.forked_from_id`), when it is a fork (`/fork`). */
  forkedFrom?: string
}

/** Parse line 0 of a rollout; null when it is not a complete `session_meta` line. */
export function parseCodexMeta(line0: string): CodexRolloutMeta | null {
  let meta: { type?: unknown; payload?: Record<string, unknown> }
  try {
    meta = JSON.parse(line0) as typeof meta
  } catch {
    return null // a partially flushed first line
  }
  const p = meta?.payload
  if (meta?.type !== 'session_meta' || !p || typeof p !== 'object') return null
  const id = typeof p.id === 'string' && p.id ? p.id : typeof p.session_id === 'string' ? p.session_id : ''
  if (!id || typeof p.cwd !== 'string' || !p.cwd) return null
  const source = p.source
  return {
    sessionId: id,
    cwd: p.cwd,
    ...(typeof p.timestamp === 'string' ? { startedAt: p.timestamp } : {}),
    subagent: typeof source === 'object' && source !== null && 'subagent' in source,
    ...(typeof p.forked_from_id === 'string' && p.forked_from_id ? { forkedFrom: p.forked_from_id } : {})
  }
}

/** Line 0 of a rollout can be tens of KB (it carries the base instructions); read until its
 *  newline, bounded. */
const LINE0_CHUNK = 64 * 1024
const LINE0_MAX = 1024 * 1024

/** Read and parse a rollout's line 0. Null when unreadable, incomplete or not a rollout. */
export async function readCodexMeta(file: string): Promise<CodexRolloutMeta | null> {
  let handle: fs.FileHandle
  try {
    handle = await fs.open(file, 'r')
  } catch {
    return null
  }
  try {
    const chunks: Buffer[] = []
    let total = 0
    while (total < LINE0_MAX) {
      const buf = Buffer.alloc(LINE0_CHUNK)
      const { bytesRead } = await handle.read(buf, 0, LINE0_CHUNK, total)
      if (bytesRead === 0) break
      const chunk = buf.subarray(0, bytesRead)
      const nl = chunk.indexOf(0x0a)
      if (nl >= 0) {
        chunks.push(chunk.subarray(0, nl))
        return parseCodexMeta(Buffer.concat(chunks).toString('utf8'))
      }
      chunks.push(chunk)
      total += bytesRead
    }
    // No newline yet: a complete one-line file still parses; a partial line does not.
    return parseCodexMeta(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  } finally {
    await handle.close()
  }
}
