// E-033 — an agent tab's Host API view and the `agentTab.changed` diff, on store-shaped tabs.

import { describe, expect, it } from 'vitest'

import type { AgentTabInfo } from 'pomade-kit/protocol'
import type { Tab, TerminalTab } from '@shared/types'
import { agentTabEvents, agentTabInfo, collectAgentTabs, type LiveContext } from './agent-tab-info'

function agentTab(id: string, patch: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    projectId: 'p1',
    kind: 'agent',
    title: 'Claude',
    termId: `term-${id}`,
    agentId: 'claude',
    cwd: 'Projects/alpha',
    status: 'live',
    ...patch
  }
}

const live = (states: LiveContext['states'] = {}, runTerms: string[] = []): LiveContext => ({
  states,
  isRunTerm: (t) => runTerms.includes(t)
})

describe('agentTabInfo', () => {
  it('a fresh launch: no session, default title, idle while its term is this run\'s', () => {
    expect(agentTabInfo(agentTab('a'), 'p1', live({}, ['term-a']))).toEqual({
      tabId: 'a',
      projectId: 'p1',
      agentId: 'claude',
      cwd: null,
      launchedAt: null,
      sessionId: null,
      title: 'Claude',
      titleSource: 'default',
      unnamed: false,
      state: 'idle'
    })
  })

  it('bound, launched, live state from main', () => {
    const tab = agentTab('a', {
      resumeSessionId: 's1',
      bindState: 'bound',
      cwdAtLaunch: '/ws/Projects/alpha',
      launchedAt: '2026-11-11T10:00:00.000Z'
    })
    expect(agentTabInfo(tab, 'p1', live({ 'term-a': 'needs-you' }))).toMatchObject({
      cwd: '/ws/Projects/alpha',
      launchedAt: '2026-11-11T10:00:00.000Z',
      sessionId: 's1',
      state: 'needs-you'
    })
  })

  it('an unsure binding reports no session', () => {
    expect(agentTabInfo(agentTab('a', { resumeSessionId: 's1', bindState: 'unbound' }), 'p1', live()).sessionId).toBeNull()
  })

  it('exited: a dead tab, or one restored from an earlier run and not revived yet', () => {
    expect(agentTabInfo(agentTab('a', { status: 'dead' }), 'p1', live({ 'term-a': 'working' })).state).toBe('exited')
    expect(agentTabInfo(agentTab('a'), 'p1', live()).state).toBe('exited')
  })

  it('title source: the user, then an app, else the default; the unnamed mark', () => {
    expect(agentTabInfo(agentTab('a', { renamed: true }), 'p1', live()).titleSource).toBe('user')
    expect(agentTabInfo(agentTab('a', { appTitled: true }), 'p1', live()).titleSource).toBe('app')
    expect(agentTabInfo(agentTab('a', { unnamed: true }), 'p1', live())).toMatchObject({ titleSource: 'default', unnamed: true })
  })
})

describe('collectAgentTabs', () => {
  it('agent tabs only, the Workspace project first, then projects in Projects panel order', () => {
    const terminal: Tab = { ...agentTab('t'), kind: 'terminal', agentId: undefined }
    const tabsByProject: Record<string, Tab[]> = {
      p2: [agentTab('b', { projectId: 'p2' })],
      p1: [terminal, agentTab('a')],
      __workspace__: [agentTab('w', { projectId: '__workspace__' })]
    }
    expect(collectAgentTabs(tabsByProject, ['p1', 'p2'], live()).map((t) => [t.tabId, t.projectId])).toEqual([
      ['w', '__workspace__'],
      ['a', 'p1'],
      ['b', 'p2']
    ])
  })
})

describe('agentTabEvents', () => {
  const base: AgentTabInfo = agentTabInfo(agentTab('a'), 'p1', live({}, ['term-a']))
  const map = (...tabs: AgentTabInfo[]): Map<string, AgentTabInfo> => new Map(tabs.map((t) => [t.tabId, t]))

  it('opened, closed (shown exited), and nothing for an unchanged tab', () => {
    const b = { ...base, tabId: 'b' }
    expect(agentTabEvents(map(base), [base, b])).toEqual([{ tab: b, changes: ['opened'] }])
    expect(agentTabEvents(map(base, b), [b])).toEqual([{ tab: { ...base, state: 'exited' }, changes: ['closed'] }])
    expect(agentTabEvents(map(base), [base])).toEqual([])
  })

  it('names every field group that changed, once', () => {
    const next = { ...base, sessionId: 's2', title: 'G4', titleSource: 'app' as const, state: 'working' as const, projectId: 'p2' }
    expect(agentTabEvents(map(base), [next])).toEqual([
      { tab: next, changes: ['session', 'title', 'state', 'project'], session: { cause: 'unknown', previousSessionId: null } }
    ])
    expect(agentTabEvents(map(base), [{ ...base, unnamed: true }])[0].changes).toEqual(['title'])
  })

  it('a session change says why — the cause noted for the new session — and what the tab held before', () => {
    const s1 = { ...base, sessionId: 's1' }
    const s2 = { ...base, sessionId: 's2' }
    const noted = (tabId: string, sessionId: string | null): 'fork' | undefined => (tabId === 'a' && sessionId === 's2' ? 'fork' : undefined)
    expect(agentTabEvents(map(s1), [s2], noted)).toEqual([{ tab: s2, changes: ['session'], session: { cause: 'fork', previousSessionId: 's1' } }])
    // A binding that goes to none is always unknown, whatever was noted.
    expect(agentTabEvents(map(s2), [base], () => 'clear')).toEqual([
      { tab: base, changes: ['session'], session: { cause: 'unknown', previousSessionId: 's2' } }
    ])
    // No session change, no `session` part — and no cause is asked for.
    const asked: string[] = []
    const titled = { ...s1, title: 'G4' }
    expect(agentTabEvents(map(s1), [titled], (t) => (asked.push(t), 'clear'))).toEqual([{ tab: titled, changes: ['title'] }])
    expect(asked).toEqual([])
  })

  it('a relaunch alone (new launch time, same folder) is not an event', () => {
    expect(agentTabEvents(map(base), [{ ...base, launchedAt: '2026-11-11T11:00:00.000Z' }])).toEqual([])
  })
})
