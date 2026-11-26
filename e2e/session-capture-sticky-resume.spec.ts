// modules: tabs, terminal, agents
// Pomade T-113 e2e — the sticky-resumeSessionId invariant on a restored, never-revived tab.
// The seeded agent tab is DEAD and nothing revives it (no pty, no zsh), so this file runs in
// the LIGHT pass; the live-capture suites live in session-capture.spec.ts (heavy).

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'

interface TabSnap {
  id: string
  kind: string
  status: string
  termId: string
  resumeSessionId?: string
}

function tabSnaps(page: Page, projectId: string): Promise<TabSnap[]> {
  return page.evaluate((pid) => {
    const stores = window.__pomadeStores
    return (stores.useTabsStore.getState().tabsByProject[pid] ?? []).map((t) => ({
      id: t.id,
      kind: t.kind,
      status: t.status,
      termId: t.termId,
      resumeSessionId: t.resumeSessionId
    }))
  }, projectId) as Promise<TabSnap[]>
}

async function resumeIdOf(page: Page, projectId: string, tabId: string): Promise<string> {
  return (await tabSnaps(page, projectId)).find((t) => t.id === tabId)?.resumeSessionId ?? ''
}

/** `resumeSessionId` as it landed on disk — the field only survives a reload if it persisted. */
async function persistedResumeId(
  fixture: Fixture,
  projectId: string,
  tabId: string
): Promise<string> {
  try {
    const raw = await fs.readFile(
      join(fixture.workspaceRoot, '.pomade', 'state', `${projectId}.json`),
      'utf8'
    )
    const state = JSON.parse(raw) as { openTabs?: { id: string; resumeSessionId?: string }[] }
    return state.openTabs?.find((t) => t.id === tabId)?.resumeSessionId ?? ''
  } catch {
    return ''
  }
}

// ─── sticky invariant: a restored, never-revived tab round-trips the field ─────────
test.describe('T-113 — resumeSessionId is sticky across an app run', () => {
  let fixture: Fixture
  // The test itself quits the app (the round-trip IS the assertion), so afterAll must not
  // close it a second time.
  let app: ElectronApplication | undefined
  let page: Page
  const TAB_ID = 'sticky-agent-tab'
  const STICKY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    const alpha = fixture.projects.alpha
    // A dead agent tab exactly as a previous app run would have left it, carrying a captured id.
    const state = {
      openTabs: [
        {
          id: TAB_ID,
          projectId: alpha,
          kind: 'agent',
          title: 'Claude Test',
          termId: 'gone-with-the-previous-run',
          agentId: 'claude-test',
          cwd: join(fixture.workspaceRoot, 'Projects/alpha'),
          status: 'dead',
          lastCommand: 'claude-test',
          resumeSessionId: STICKY_ID
        }
      ],
      activeTabId: TAB_ID
    }
    const stateDir = join(fixture.workspaceRoot, '.pomade', 'state')
    await fs.mkdir(stateDir, { recursive: true })
    await fs.writeFile(join(stateDir, `${alpha}.json`), JSON.stringify(state, null, 2))
    const started = await launchApp(fixture)
    app = started
    page = await started.firstWindow()
    await page.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  // Stronger than "the project is never activated": the project IS opened, so the tab is
  // restored, reconciled and re-persisted — and the field still has to come back byte-identical.
  // Nothing but the live capture (or handleAgentExit's downgrade) may ever touch it.
  test('a restored, never-revived dead agent tab keeps its id through the run', async () => {
    const alpha = fixture.projects.alpha
    await page.getByTestId(`project-${alpha}`).click()

    // It restored as a dead agent tab offering Resume session — and nothing was revived.
    await expect(page.getByTestId(`terminal-dead-${TAB_ID}`)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId(`resume-${TAB_ID}`)).toBeVisible()
    expect(await resumeIdOf(page, alpha, TAB_ID)).toBe(STICKY_ID)

    // The re-persisted project state must reach disk before the round-trip quit — poll the file.
    await expect
      .poll(() => persistedResumeId(fixture, alpha, TAB_ID), { timeout: 15_000 })
      .toBe(STICKY_ID)
    await app?.close()
    app = undefined
    expect(await persistedResumeId(fixture, alpha, TAB_ID)).toBe(STICKY_ID)
  })
})
