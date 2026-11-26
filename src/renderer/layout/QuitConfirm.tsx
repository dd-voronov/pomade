// Pomade — T-098 / T-187 quit confirmation. Main intercepts EVERY quit path (Cmd+Q, app-menu Quit,
// the red traffic light, Cmd+Shift+W) and asks here; nothing exits until `app.confirmQuit()`
// is called. Deliberate friction, per spec — up to three SEQUENTIAL stages (one scrim at a time):
//   1. always → "Quit Pomade?" (Cancel / Quit)
//   2. when live terminal/agent sessions exist → a stronger confirm with the REAL counts
//      (Cancel / Quit anyway)
//   3. (T-187) when ≥1 doc tab is dirty in ANY project (hidden panes included — panes are never
//      unmounted) → a data-loss confirm: Save all docs / Discard all changes / Cancel.
// Stages 2 and 3 each appear only when their condition holds, always AFTER the ones before them
// (docs is last). Cancel · Esc · scrim-click · × at any stage aborts the whole quit; the next quit
// attempt re-runs the flow from stage one.
//
// The stages are SEQUENTIAL (one scrim at a time), not stacked: stacking full-viewport scrims buys
// nothing and only invites z-index/Esc-ordering bugs. The escalation is carried by the copy and the
// danger-variant button.
//
// T-187 "Save all docs": every dirty doc is saved through its pane's NORMAL save pipeline (T-142
// conflict guard, T-095 refusal guard) via the tabs-store save-guard registry. A doc that CANNOT be
// saved unattended (untitled, refused, unconfirmed outside-workspace, on-disk conflict) is surfaced
// by name and the quit is ABORTED — never silently discarded.

import { useEffect, useState } from 'react'

import type { QuitRequest } from '@shared/ipc-api'
import { Modal } from '../components/Modal'
import { Button } from '../components/fields'
import { useTabsStore } from '../stores/tabs-store'

interface LiveCounts {
  agents: number
  terminals: number
}

/** Cross main's authoritative live-pty set with the tab kinds only the renderer knows.
 *  A session counts when the tab is a terminal/agent tab, its own status is 'live', AND main
 *  still has that pty alive — so restored-dead tabs (T-023) and a stale live flag can never
 *  inflate the number. Counted per termId across ALL projects (a quit takes the whole app
 *  down, not just the active project). */
function countLive(liveTermIds: string[]): LiveCounts {
  const live = new Set(liveTermIds)
  const counted = new Set<string>()
  let agents = 0
  let terminals = 0
  for (const tabs of Object.values(useTabsStore.getState().tabsByProject)) {
    for (const tab of tabs) {
      if (tab.kind !== 'terminal' && tab.kind !== 'agent') continue
      if (tab.status !== 'live' || !live.has(tab.termId) || counted.has(tab.termId)) continue
      counted.add(tab.termId)
      if (tab.kind === 'agent') agents += 1
      else terminals += 1
    }
  }
  return { agents, terminals }
}

/** "2 agents and 3 terminals are still running." — numeric, never vague. */
function runningPhrase({ agents, terminals }: LiveCounts): string {
  const parts: string[] = []
  if (agents > 0) parts.push(`${agents} ${agents === 1 ? 'agent' : 'agents'}`)
  if (terminals > 0) parts.push(`${terminals} ${terminals === 1 ? 'terminal' : 'terminals'}`)
  const verb = agents + terminals === 1 ? 'is' : 'are'
  return `${parts.join(' and ')} ${verb} still running.`
}

type Stage = 'quit' | 'sessions' | 'docs' | 'docs-blocked'
type Flow = { stage: Stage; counts: LiveCounts; blocked?: string[] } | null

/** How many doc tabs are dirty right now, across ALL projects (hidden panes included). Read live
 *  from the store at decision time — the quit flow is modal, so nothing edits a doc meanwhile. */
function hasDirtyDocs(): boolean {
  return useTabsStore.getState().dirtyDocs().length > 0
}

export function QuitConfirm(): React.JSX.Element | null {
  const [flow, setFlow] = useState<Flow>(null)
  // T-187 — guards the async "Save all docs" so a double-click can't re-run the sweep.
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    return window.pomade.app.onConfirmQuit((req: QuitRequest) => {
      // Main re-sends on every further quit attempt while the flow is open (it keeps no dialog
      // state), so a repeat must be a complete no-op: never a second dialog, never a bounce
      // back to stage one. The counts are main's snapshot from the moment the quit was
      // attempted — the moment that semantically matters ("were sessions running when you hit
      // Cmd+Q?") — so stage two never has to re-query.
      setFlow((current) => current ?? { stage: 'quit', counts: countLive(req.liveTermIds) })
    })
  }, [])

  if (!flow) return null

  const abort = (): void => {
    setFlow(null)
    setSaving(false)
  }
  const quitNow = (): void => void window.pomade.app.confirmQuit()
  const { agents, terminals } = flow.counts

  // Advance from the "Quit Pomade?" stage: sessions (if live) → docs (if dirty) → quit.
  const afterQuitStage = (): void => {
    if (agents + terminals > 0) setFlow({ ...flow, stage: 'sessions' })
    else if (hasDirtyDocs()) setFlow({ ...flow, stage: 'docs' })
    else quitNow()
  }
  // Advance from the "Sessions still running" stage: docs (if dirty) → quit.
  const afterSessionsStage = (): void => {
    if (hasDirtyDocs()) setFlow({ ...flow, stage: 'docs' })
    else quitNow()
  }
  // T-187 — save every dirty doc through the normal pipeline. If any can't be saved unattended,
  // surface them by name and ABORT the quit; otherwise continue quitting.
  const saveAll = (): void => {
    if (saving) return
    setSaving(true)
    void (async () => {
      const blocked = await useTabsStore.getState().saveAllDirtyDocs()
      if (blocked.length > 0) {
        setSaving(false)
        setFlow({ stage: 'docs-blocked', counts: flow.counts, blocked: blocked.map((b) => b.title) })
      } else {
        quitNow()
      }
    })()
  }

  // E-035 — Discard all keeps every dirty doc's unsaved state as a discarded draft (7 days, user
  // data) before the quit continues.
  const discardAll = (): void => {
    if (saving) return
    setSaving(true)
    void useTabsStore
      .getState()
      .discardAllDirtyDocs()
      .finally(quitNow)
  }

  if (flow.stage === 'quit') {
    return (
      <Modal
        title="Quit Pomade?"
        onClose={abort}
        testId="quit-confirm"
        width={420}
        footer={
          <>
            <Button data-testid="quit-cancel" onClick={abort}>
              Cancel
            </Button>
            <Button variant="primary" data-testid="quit-ok" onClick={afterQuitStage}>
              Quit
            </Button>
          </>
        }
      >
        <p style={{ margin: 0, lineHeight: 'var(--lh)' }}>
          Cancel keeps every tab and session exactly as it is.
        </p>
      </Modal>
    )
  }

  if (flow.stage === 'sessions') {
    return (
      <Modal
        title="Sessions still running"
        onClose={abort}
        testId="quit-confirm-sessions"
        width={420}
        footer={
          <>
            <Button data-testid="quit-sessions-cancel" onClick={abort}>
              Cancel
            </Button>
            <Button variant="danger" data-testid="quit-sessions-ok" onClick={afterSessionsStage}>
              Quit anyway
            </Button>
          </>
        }
      >
        <p style={{ margin: 0, lineHeight: 'var(--lh)' }} data-testid="quit-sessions-message">
          {runningPhrase(flow.counts)} Quitting ends them and loses their context.
        </p>
      </Modal>
    )
  }

  if (flow.stage === 'docs') {
    const count = useTabsStore.getState().dirtyDocs().length
    const phrase =
      count === 1 ? '1 document has unsaved changes.' : `${count} documents have unsaved changes.`
    return (
      <Modal
        title="Unsaved documents"
        onClose={abort}
        testId="quit-confirm-docs"
        width={440}
        footer={
          <>
            <Button data-testid="quit-docs-cancel" onClick={abort}>
              Cancel
            </Button>
            <Button variant="danger" data-testid="quit-docs-discard" disabled={saving} onClick={discardAll}>
              Discard all changes
            </Button>
            <Button
              variant="primary"
              data-testid="quit-docs-save-all"
              disabled={saving}
              onClick={saveAll}
            >
              Save all docs
            </Button>
          </>
        }
      >
        <p style={{ margin: 0, lineHeight: 'var(--lh)' }} data-testid="quit-docs-message">
          {phrase} Save all before quitting, or discard them.
        </p>
      </Modal>
    )
  }

  // stage === 'docs-blocked' — a mid-save-all doc couldn't be saved unattended; the quit was
  // aborted so nothing is lost. Name the offenders; a single OK dismisses (the app stays).
  return (
    <Modal
      title="Couldn't save some documents"
      onClose={abort}
      testId="quit-confirm-docs-blocked"
      width={460}
      footer={
        <Button variant="primary" data-testid="quit-docs-blocked-ok" onClick={abort}>
          OK
        </Button>
      }
    >
      <p style={{ margin: 0, lineHeight: 'var(--lh)' }} data-testid="quit-docs-blocked-message">
        These documents couldn’t be saved automatically: {(flow.blocked ?? []).join(', ')}. Quitting
        was cancelled so nothing is lost — save or resolve them, then quit again.
      </p>
    </Modal>
  )
}
