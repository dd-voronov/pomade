// Pomade — SessionHistory (renderer). Wave 2b.
// Per active project, lists prior agent sessions (timestamp + first-message preview +
// session id) read from each agent's own storage. Resume launches a new agent tab with
// `<agent> --resume <id>` (codex: `codex resume <id>`).

import { useEffect, useState } from 'react'

import type { AgentInfo, Project, SessionRecord } from '@shared/types'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useTerminalsStore } from '../../stores/terminals-store'
import { Modal } from '../../components/Modal'
import styles from './SessionHistory.module.css'

interface Props {
  project: Project
  onClose: () => void
}

interface AgentSessions {
  agent: AgentInfo
  sessions: SessionRecord[]
}

function absCwd(root: string, rootPath: string): string {
  return rootPath ? `${root.replace(/\/$/, '')}/${rootPath}` : root
}

function formatTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function SessionHistory({ project, onClose }: Props): React.JSX.Element {
  const root = useWorkspaceStore((s) => s.root)
  const [loading, setLoading] = useState(true)
  const [groups, setGroups] = useState<AgentSessions[]>([])

  // Escape-to-close is Modal's own (window keydown listener) — no local handler needed.

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      const roster = await window.pomade.agents.roster()
      const visible = project.visibleAgents.includes('*')
        ? roster
        : roster.filter((a) => project.visibleAgents.includes(a.id))
      const cwd = root ? absCwd(root, project.rootPath) : ''
      const results = await Promise.all(
        visible.map(async (agent) => ({
          agent,
          sessions: cwd ? await window.pomade.agents.sessions(agent.id, cwd) : []
        }))
      )
      if (cancelled) return
      setGroups(results.filter((g) => g.sessions.length > 0))
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [project.id, project.rootPath, project.visibleAgents, root])

  const resume = (agent: AgentInfo, record: SessionRecord): void => {
    void useTerminalsStore.getState().startAgent(project, agent, record.sessionId)
    onClose()
  }

  return (
    <Modal
      title={`Session history — ${project.name}`}
      onClose={onClose}
      testId="session-history"
      width={520}
    >
      {loading && <p className={styles.hint}>Scanning agent storage…</p>}
      {!loading && groups.length === 0 && (
        <p className={styles.hint} data-testid="session-history-empty">
          No past sessions found for this project’s agents.
        </p>
      )}
      {!loading &&
        groups.map(({ agent, sessions }) => (
          <section key={agent.id} className={styles.group}>
            <h3 className={styles.groupTitle}>{agent.name}</h3>
            <ul className={styles.list}>
              {sessions.map((rec) => (
                <li key={rec.sessionId} className={styles.row} data-testid={`session-${rec.sessionId}`}>
                  <div className={styles.rowMain}>
                    <span className={styles.preview}>{rec.preview}</span>
                    <span className={styles.sub}>
                      <span className={styles.time}>{formatTime(rec.startedAt)}</span>
                      <span className={styles.sid}>{rec.sessionId.slice(0, 8)}</span>
                    </span>
                  </div>
                  <button
                    type="button"
                    className={styles.resumeBtn}
                    data-testid={`resume-session-${rec.sessionId}`}
                    onClick={() => resume(agent, rec)}
                  >
                    Resume
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
    </Modal>
  )
}
