// modules: agents, tabs, core
// heavy-exempt: reads the "+" menu's items (the New terminal item included) but never picks one, so no terminal opens
// E-033 e2e — PLATFORM rule 7 for the agents app: the "+" menu reads the roster from the installed
// agents app, and with the app absent (or installed but not running) it is exactly Pomade's own
// folder scan — the built-ins, then the workspace's agent folders — and the Session history button opens
// Pomade's own session history.

import { resolve } from 'node:path'

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const AGENTS_DIR = resolve(__dirname, 'fixtures/apps/agents')

/** The "+" menu's items, top to bottom: test id and label. */
async function plusMenu(page: Page): Promise<[string, string][]> {
  await page.getByTestId('tab-add').click()
  const menu = page.getByTestId('tab-add-menu')
  await expect(menu).toBeVisible()
  // The roster is re-read as the menu opens; let it settle before reading the items.
  await expect(page.getByTestId('tab-add-agent-claude-test')).toBeVisible()
  const items = await menu.locator('[data-testid^="tab-add-"]').evaluateAll((els) =>
    els.map((el) => [el.getAttribute('data-testid') ?? '', (el.textContent ?? '').trim()] as [string, string])
  )
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  return items
}

/** Pomade's own scan of the fixture workspace: the built-ins, then `Agents/claude-test` — with its
 *  "!" badge: its command is not found (no stand-in is mapped in this spec). */
const SCANNED: [string, string][] = [
  ['tab-add-doc', 'New doc'],
  ['tab-add-terminal', 'New terminal'],
  ['tab-add-agent-claude', 'Claude'],
  ['tab-add-agent-codex', 'Codex'],
  ['tab-add-agent-claude-test', 'claude-test!']
]

test.describe('E-033 the "+" menu without the agents app', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture)
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close().catch(() => {})
    await fixture?.cleanup()
  })

  test('absent: the menu is the folder scan, and History opens Pomade\'s own session history', async () => {
    expect(await plusMenu(page)).toEqual(SCANNED)
    await page.getByTestId('session-history-open').click()
    await expect(page.getByTestId('session-history')).toBeVisible()
    await page.getByTestId('modal-close').click()
  })
})

test.describe('E-033 the "+" menu with the agents app installed but not running', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture, { POMADE_DEV_APPS: AGENTS_DIR })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close().catch(() => {})
    await fixture?.cleanup()
  })

  test('nothing serves its roster: the agents are the folder scan; the app is listed as an app', async () => {
    expect(await plusMenu(page)).toEqual([...SCANNED, ['tab-add-app-pomade-agents', 'Agents (test)']])
  })
})
