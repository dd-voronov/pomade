// Pomade — feature-detect the Wave 2b agents roster from the renderer (Wave 2a).
// The `agents` namespace is declared in docs/contracts/ipc-terminal.md but only wired by Wave 2b; when that
// wave isn't merged yet, window.pomade.agents is undefined. We degrade gracefully.

import { useEffect, useState } from 'react'

import type { AgentInfo } from '@shared/types'

interface AgentsApi {
  roster(): Promise<AgentInfo[]>
}

function getAgentsApi(): AgentsApi | null {
  const bridge = window.pomade as unknown as { agents?: AgentsApi }
  return bridge.agents && typeof bridge.agents.roster === 'function' ? bridge.agents : null
}

/** Returns the agent roster if the 2b bridge exists, else null (caller shows a hint). */
export function useAgentRoster(): { available: boolean; agents: AgentInfo[] } {
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [available, setAvailable] = useState(false)

  useEffect(() => {
    const api = getAgentsApi()
    if (!api) return
    let cancelled = false
    void api
      .roster()
      .then((list) => {
        if (!cancelled) {
          setAgents(list)
          setAvailable(true)
        }
      })
      .catch(() => {
        /* leave unavailable → fallback hint */
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { available, agents }
}
