// Pomade — TerminalActions (renderer). Wave 2b.
// The tab-strip action cluster: the "+" launcher (New terminal + one item per visible
// agent of the active project + one per hosted app, E-027), the bulk-actions menu (stop all terminals / exit all
// agents — Wave 2c appends close-all-docs items into THIS component), and the Session
// history button. Mounted by TabStrip.
//
// E-033 (PLATFORM rule 7) — the roster is re-read each time the "+" menu opens: main asks the
// installed agents app (`roster.list`) and falls back to its own folder scan when the app is absent
// or not responding, so with no agents app the menu is exactly the scan's. The Session history button opens
// the agents app's Sessions view (its tab at route `sessions`) when the app is installed, and
// Pomade's own Session history otherwise.

import { useCallback, useEffect, useState } from 'react'
import { ROSTER_APP_ID } from 'pomade-kit/protocol'

import type { AgentInfo, HostedApp, Project } from '@shared/types'
import { useTabsStore } from '../../stores/tabs-store'
import { useAppsStore } from '../../stores/apps-store'
import { AppIcon } from '../apps/AppIcon'
import { openAppRoute, openAppTab } from '../apps/open-app'
import { useTerminalsStore } from '../../stores/terminals-store'
import { ContextMenu, type MenuItem } from '../../components/ContextMenu'
import { Tooltip } from '../../components/Tooltip'
import { AgentMappingDialog } from './AgentMappingDialog'
import { SessionHistory } from './SessionHistory'
import styles from './TerminalActions.module.css'

/** The agents app's route for its Sessions view (the Session history button opens it there). */
const AGENTS_SESSIONS_ROUTE = 'sessions'

function visibleAgentsFor(project: Project, roster: AgentInfo[]): AgentInfo[] {
  if (project.visibleAgents.includes('*')) return roster
  return roster.filter((a) => project.visibleAgents.includes(a.id))
}

export function TerminalActions({ project }: { project: Project }): React.JSX.Element {
  const [roster, setRoster] = useState<AgentInfo[]>([])
  // T-158 — anchor points captured from the trigger button's rect (bottom-left). Held instead of
  // a boolean so the menu opens through the shared ContextMenu primitive (scrim + viewport clamp).
  const [addAnchor, setAddAnchor] = useState<{ x: number; y: number } | null>(null)
  const [bulkAnchor, setBulkAnchor] = useState<{ x: number; y: number } | null>(null)
  const [sessionHistoryOpen, setSessionHistoryOpen] = useState(false)
  const [mappingAgent, setMappingAgent] = useState<AgentInfo | null>(null)

  const refreshRoster = useCallback(async () => {
    try {
      setRoster(await window.pomade.agents.roster())
    } catch {
      /* roster unavailable — leave empty */
    }
  }, [])

  useEffect(() => {
    void refreshRoster()
  }, [refreshRoster])

  const agents = visibleAgentsFor(project, roster)
  const apps = useAppsStore((s) => s.apps)
  const agentsApp = apps.find((a) => a.id === ROSTER_APP_ID && !a.unavailable)

  const openSessionHistory = (): void => {
    if (agentsApp) openAppRoute(agentsApp, AGENTS_SESSIONS_ROUTE, project.id)
    else setSessionHistoryOpen(true)
  }

  // T-149 — the current project's reopen-stack depth. Subscribed so the "Reopen closed tab" item
  // enables/disables live as tabs close and reopen.
  const canReopen = useTabsStore(
    (s) => (s.reopenStackByProject[project.id] ?? []).length > 0
  )

  const reopenClosedTab = (): void => {
    void useTerminalsStore.getState().reopenClosedTab(project.id)
    setBulkAnchor(null)
  }

  const newTerminal = (): void => {
    void useTerminalsStore.getState().newTerminal(project)
    setAddAnchor(null)
  }

  // T-170 — routed through the shared `openDocByPath` action. `path: ''` never dedupes (the
  // action's dedupe is guarded on a non-empty path), so repeated clicks still each land a fresh
  // untitled tab. T-192 — an Untitled buffer is markdown BY POLICY (`isMarkdownPath('')` is true),
  // so `initialDocMode('')` composes the same "New markdown opens as" + Keep/Adjust rule as every
  // other opener: rich by default (Live under Keep), raw when the setting is Raw. It reclassifies
  // on first save by real extension — saving as `.md` keeps the rich treatment, another extension
  // drops it. No `mode` override needed anymore (it existed only because the empty path used to
  // resolve to 'raw').
  const newDoc = (): void => {
    useTabsStore.getState().openDocByPath(project.id, '', { title: 'Untitled' })
    setAddAnchor(null)
  }

  const openApp = (app: HostedApp): void => {
    setAddAnchor(null)
    openAppTab(project.id, app)
  }

  const launchAgent = (agent: AgentInfo): void => {
    setAddAnchor(null)
    if (!agent.resolved) {
      setMappingAgent(agent)
      return
    }
    void useTerminalsStore.getState().startAgent(project, agent)
  }

  const stopTerminals = (): void => {
    void useTerminalsStore.getState().stopAllTerminals(project.id)
    setBulkAnchor(null)
  }

  const exitAgents = (): void => {
    void useTerminalsStore.getState().exitAllAgents(project.id)
    setBulkAnchor(null)
  }

  const onMappingSaved = (updated: AgentInfo): void => {
    setMappingAgent(null)
    void refreshRoster()
    if (updated.resolved) void useTerminalsStore.getState().startAgent(project, updated)
  }

  return (
    <div className={styles.actions}>
      {/* Session history */}
      <Tooltip lines={['Session history']}>
        <button
          type="button"
          className={styles.iconBtn}
          aria-label="Session history"
          data-testid="session-history-open"
          onClick={openSessionHistory}
        >
          <ClockGlyph />
        </button>
      </Tooltip>

      {/* Bulk actions */}
      <div className={styles.wrap}>
        <Tooltip lines={['Bulk actions']}>
          <button
            type="button"
            className={styles.iconBtn}
            aria-label="Bulk actions"
            data-testid="bulk-actions"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setBulkAnchor(bulkAnchor ? null : { x: r.left, y: r.bottom + 2 })
            }}
          >
            <DotsGlyph />
          </button>
        </Tooltip>
        {bulkAnchor && (
          <ContextMenu
            x={bulkAnchor.x}
            y={bulkAnchor.y}
            onClose={() => setBulkAnchor(null)}
            testId="bulk-menu"
            scrimTestId="bulk-scrim"
            items={[
              // T-149 — Reopen closed tab: FIRST item, separated from the destructive bulk
              // actions. DISABLED (not hidden) when this project's reopen stack is empty.
              {
                label: 'Reopen closed tab',
                testId: 'bulk-reopen-closed-tab',
                disabled: !canReopen,
                onSelect: reopenClosedTab
              },
              { separator: true },
              { label: 'Stop all terminals', testId: 'bulk-stop-terminals', onSelect: stopTerminals },
              { label: 'Exit all agents', testId: 'bulk-exit-agents', onSelect: exitAgents },
              {
                label: 'Close all docs',
                testId: 'bulk-close-all-docs',
                // T-044 — guarded flow: dirty docs prompt instead of silently discarding.
                onSelect: () => useTabsStore.getState().requestCloseAllDocs(project.id)
              },
              {
                label: 'Close saved docs',
                testId: 'bulk-close-saved-docs',
                onSelect: () => useTabsStore.getState().closeSavedDocs(project.id)
              }
            ]}
          />
        )}
      </div>

      {/* "+" launcher */}
      <div className={styles.wrap}>
        <Tooltip lines={['New tab (Cmd+T)']}>
          <button
            type="button"
            className={styles.add}
            aria-label="New tab"
            data-testid="tab-add"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              if (!addAnchor) void refreshRoster()
              setAddAnchor(addAnchor ? null : { x: r.left, y: r.bottom + 2 })
            }}
          >
            +
          </button>
        </Tooltip>
        {addAnchor && (
          <ContextMenu
            x={addAnchor.x}
            y={addAnchor.y}
            onClose={() => setAddAnchor(null)}
            testId="tab-add-menu"
            items={[
              { label: 'New doc', testId: 'tab-add-doc', onSelect: newDoc },
              { label: 'New terminal', testId: 'tab-add-terminal', onSelect: newTerminal },
              ...(agents.length > 0 ? [{ separator: true } satisfies MenuItem] : []),
              ...agents.map<MenuItem>((agent) => ({
                label: <span className={styles.agentName}>{agent.name}</span>,
                testId: `tab-add-agent-${agent.id}`,
                // T-143 — a passive status badge INSIDE a menu-item button (not a chrome control of
                // its own); keeps its native `title=`, consistent with the editor menu badge.
                trailing: !agent.resolved ? (
                  <span className={styles.badge} title="Command not found — click to map">
                    !
                  </span>
                ) : undefined,
                onSelect: () => launchAgent(agent)
              })),
              // E-027 — installed and dev-linked apps. An unavailable one stays listed, disabled,
              // with its reason on hover.
              ...(apps.length > 0 ? [{ separator: true } satisfies MenuItem] : []),
              ...apps.map<MenuItem>((app) => ({
                label: <span className={styles.agentName}>{app.name}</span>,
                glyph: <AppIcon appId={app.id} />,
                testId: `tab-add-app-${app.id}`,
                disabled: !!app.unavailable,
                tooltip: app.unavailable ? [app.unavailable] : undefined,
                onSelect: () => openApp(app)
              }))
            ]}
          />
        )}
      </div>

      {mappingAgent && (
        <AgentMappingDialog
          agent={mappingAgent}
          onClose={() => setMappingAgent(null)}
          onSaved={onMappingSaved}
        />
      )}
      {sessionHistoryOpen && <SessionHistory project={project} onClose={() => setSessionHistoryOpen(false)} />}
    </div>
  )
}

function ClockGlyph(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 4.6V8l2.4 1.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function DotsGlyph(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="12.5" cy="8" r="1.3" />
    </svg>
  )
}
