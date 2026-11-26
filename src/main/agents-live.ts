// Pomade — "is an agent live here?": the one main-side answer, for every caller — the Host API's
// `agents.liveIn` (host-socket.ts, asked by `pomade-git`) and the Git panel's In progress rows and
// merge / rebase / remove blocks (E-041, git-branches.ts). Two sources, joined: the agents app's
// `sessions.liveIn` when it is installed and answering (agent tabs, prompted or not, and Runner
// runs — agent-sessions.ts, E-043), and Pomade's own terminals (pty-manager: an agent and its
// physical folder at launch), which alone answer when the app is absent or not responding. Each
// agent carries what it is doing when known (T-323): `pomade-git` skips only for one that works or
// waits, while the Git panel counts every live agent, idle or not.

import { joinLiveAgents, type LiveAgent } from '@shared/git-branches'

import { isAtOrBelow } from '../git-core/agent-processes'
import { appAgentsLiveIn } from './agent-sessions'
import { ptyManager } from './pty-manager'

/** Agents running in Pomade's terminals whose folder at launch is `folder` (absolute) or inside it,
 *  with what each is doing when its scanner has read it and its terminal shell's pid. An agent that
 *  `cd`s elsewhere after it started still counts where it started. */
async function terminalAgentsIn(folder: string): Promise<LiveAgent[]> {
  const out: LiveAgent[] = []
  for (const a of ptyManager.liveAgents()) {
    if (!(await isAtOrBelow(a.cwd, folder))) continue
    out.push({ agentId: a.agentId, cwd: a.cwd, ...(a.state ? { state: a.state } : {}), terminalPids: [a.pid] })
  }
  return out
}

/** Every agent live at or below `folder` (absolute): the agents app's answer and Pomade's own
 *  terminals, each agent and folder once (`joinLiveAgents`: the busier state wins). */
export async function agentsLiveIn(folder: string): Promise<LiveAgent[]> {
  const [own, app] = await Promise.all([terminalAgentsIn(folder), appAgentsLiveIn(folder)])
  return joinLiveAgents(app, own)
}
