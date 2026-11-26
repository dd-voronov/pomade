// Pomade — E-043: what the agents app (`pomade-agents`) tells the platform about agent sessions,
// through the broker (PLATFORM rule 7; contract in `pomade-kit/protocol` agent-sessions):
//
//   appAgentsLiveIn(folder)          `sessions.liveIn` — agent tabs and Runner runs at or below a
//                                    folder; null when the app is absent, not responding or
//                                    answered malformed (agents-live.ts then answers alone)
//   branchSession(folder, branch)    `sessions.forRepo` — the session behind an In progress row
//
// An app that let a call time out is not asked again for QUIET_MS, so a hung app costs one
// timeout, not one per row.

import { promises as fsp } from 'node:fs'

import {
  SESSIONS_APP_ID,
  SESSIONS_FOR_REPO_METHOD,
  SESSIONS_LIVE_IN_METHOD,
  checkLiveIn,
  checkRepoSessions,
  type JsonValue,
  type LiveSession
} from 'pomade-kit/protocol'

import { pickBranchSession, type BranchSession } from '@shared/git-branches'
import { rosterName } from './agent-service'
import { callFromPlatform, isServing } from './app-broker'

/** How long a platform read waits for the agents app. */
const TIMEOUT_MS = 1500
/** How long an app that timed out is left alone. */
const QUIET_MS = 10_000

let quietUntil = 0

async function ask(method: string, params: JsonValue): Promise<unknown> {
  if (!isServing(SESSIONS_APP_ID) || Date.now() < quietUntil) return null
  const outcome = await callFromPlatform({ app: SESSIONS_APP_ID, method, params, timeoutMs: TIMEOUT_MS })
  if (outcome.ok) return outcome.value
  if (outcome.error.code === 'app-not-responding') quietUntil = Date.now() + QUIET_MS
  return null
}

async function real(path: string): Promise<string> {
  return fsp.realpath(path).catch(() => path)
}

/** `sessions.liveIn`: what the agents app sees running at or below `folder`. */
export async function appAgentsLiveIn(folder: string): Promise<LiveSession[] | null> {
  const answer = await ask(SESSIONS_LIVE_IN_METHOD, { folder: await real(folder) })
  if (answer === null) return null
  const checked = checkLiveIn(answer)
  return checked.ok ? checked.result.sessions : null
}

/** `sessions.forRepo`: the session behind a worktree (its folder) or a branch (the repository's
 *  folder and the branch); null without an answer or a session. */
export async function branchSession(folder: string, branch: string | null): Promise<BranchSession | null> {
  const params: JsonValue = branch === null ? { folder: await real(folder) } : { folder: await real(folder), branch }
  const sessions = checkRepoSessions(await ask(SESSIONS_FOR_REPO_METHOD, params))
  const s = sessions ? pickBranchSession(sessions) : null
  if (!s) return null
  return { id: s.id, agentId: s.agent, agentName: await rosterName(s.agent), name: s.name, live: s.live, cwd: s.cwd, projectId: s.project }
}
