// Pomade — T-327: what a Claude Code transcript's first message says about where it came from
// (docs/modules/agents/session-stores.md, "Provider: Claude Code"):
//   • `forkedFrom` — `/branch` writes the new transcript at once, copying the conversation so far;
//     every copied message line carries `forkedFrom: { sessionId: <parent>, messageUuid }`.
//   • `sessionKind` — a session Claude runs in the background (`"bg"`: the copy `/fork` starts
//     while the tab keeps its own session; also daemon sessions) marks its message lines with it.
//     Such a transcript is never the session a tab's person is typing into.
// A fresh session or a `/clear` writes neither. The first message line (one with a `uuid`)
// decides; the lines before it (`mode`, `session-owner`, `file-history-snapshot` …) are skipped.
// Read by the session watcher for a new transcript an 'await-new' window could bind.

import { promises as fs } from 'node:fs'

/** What a transcript's first message records. `decided` is false while no message line is on disk. */
export interface ClaudeTranscriptHead {
  decided: boolean
  /** The session it was branched from, or null. */
  forkedFrom: string | null
  /** A background (or daemon) session's transcript — never a tab's. */
  background: boolean
}

const UNDECIDED: ClaudeTranscriptHead = { decided: false, forkedFrom: null, background: false }

/** The head of a transcript from its leading complete lines. */
export function parseClaudeHead(lines: readonly string[]): ClaudeTranscriptHead {
  for (const line of lines) {
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      return UNDECIDED // a partially flushed line — no verdict from what is on disk yet
    }
    if (typeof record !== 'object' || record === null || Array.isArray(record)) continue
    const r = record as { uuid?: unknown; forkedFrom?: unknown; sessionKind?: unknown }
    if (typeof r.uuid !== 'string') continue
    const parent =
      typeof r.forkedFrom === 'object' && r.forkedFrom !== null ? (r.forkedFrom as { sessionId?: unknown }).sessionId : undefined
    return {
      decided: true,
      forkedFrom: typeof parent === 'string' && parent ? parent : null,
      background: typeof r.sessionKind === 'string' && r.sessionKind !== ''
    }
  }
  return UNDECIDED
}

/** How much of a transcript's head is read for its first message line. */
const HEAD_MAX = 1024 * 1024

/** Read a transcript's head (undecided when unreadable or no message line is written yet). */
export async function readClaudeHead(file: string): Promise<ClaudeTranscriptHead> {
  let handle: fs.FileHandle
  try {
    handle = await fs.open(file, 'r')
  } catch {
    return UNDECIDED
  }
  try {
    const buf = Buffer.alloc(HEAD_MAX)
    const { bytesRead } = await handle.read(buf, 0, HEAD_MAX, 0)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    // Only complete lines: the last one may be cut by the read bound or still being written.
    const complete = text.slice(0, text.lastIndexOf('\n') + 1)
    return parseClaudeHead(complete.split('\n').filter((l) => l.trim() !== ''))
  } catch {
    return UNDECIDED
  } finally {
    await handle.close()
  }
}
