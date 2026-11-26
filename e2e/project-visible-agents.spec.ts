// modules: projects, terminal, agents
// heavy-exempt: only opens the + menu and asserts its items; no agent or terminal is ever launched
// T-218 e2e — a project can have NO visible agents. Un-ticking every agent in the project window
// and saving persists an empty list (distinct from "All agents"), re-opening the window shows
// nothing ticked, it survives a restart, and the tab "+" menu offers no agents. A config file
// without the field still offers every agent. Runs against the FIXTURE workspace (the roster
// holds the folder agent `claude-test` plus the built-ins). State chains WITHIN this file.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchAppPage, relaunchApp } from './fixtures/app'
import { hoverClick } from './fixtures/interactions'

let fixture: Fixture
let app: ElectronApplication
let page: Page

const ALPHA = 'proj-alpha'

const savedAgents = async (): Promise<string[] | undefined> => {
  const cfg = JSON.parse(await fs.readFile(join(fixture.workspaceRoot, '.pomade/workspace.json'), 'utf8'))
  return cfg.projects.find((p: { id: string }) => p.id === ALPHA)?.visibleAgents
}

async function openEdit(): Promise<void> {
  await hoverClick(page.getByTestId(`project-${ALPHA}`), page.getByTestId(`project-menu-${ALPHA}`))
  await page.getByTestId(`project-edit-${ALPHA}`).click()
  await expect(page.getByTestId('project-agents')).toBeVisible()
}

async function checkedStates(): Promise<boolean[]> {
  return page.getByTestId('project-agents').locator('input[type="checkbox"]').evaluateAll((els) =>
    els.map((e) => (e as HTMLInputElement).checked)
  )
}

async function openPlusMenu(): Promise<void> {
  await page.getByTestId(`project-${ALPHA}`).click()
  await page.getByTestId('tab-add').click()
  await expect(page.getByTestId('tab-add-menu')).toBeVisible()
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  ;({ app, page } = await launchAppPage(fixture))
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test('un-ticking every agent and saving keeps "no agents" — re-opening shows none ticked', async () => {
  await openEdit()
  expect((await checkedStates()).every(Boolean)).toBe(true) // default: All agents
  await page.getByTestId('project-agents').getByText('All agents').click() // untick "All"
  expect((await checkedStates()).some(Boolean)).toBe(false)
  await page.getByTestId('project-save').click()
  await expect(page.getByTestId('project-modal')).toHaveCount(0)
  await expect.poll(savedAgents).toEqual([])

  await openEdit()
  const states = await checkedStates()
  expect(states.length).toBeGreaterThan(1)
  expect(states.some(Boolean)).toBe(false)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('project-modal')).toHaveCount(0)
})

test('the + menu offers no agents for such a project, and it survives a restart', async () => {
  await openPlusMenu()
  await expect(page.getByTestId('tab-add-doc')).toBeVisible()
  await expect(page.locator('[data-testid^="tab-add-agent-"]')).toHaveCount(0)
  await page.keyboard.press('Escape')

  ;({ app, page } = await relaunchApp(app, fixture))
  await expect(page.getByTestId('app-shell')).toBeVisible()
  expect(await savedAgents()).toEqual([])
  await openEdit()
  expect((await checkedStates()).some(Boolean)).toBe(false)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('project-modal')).toHaveCount(0)
  await openPlusMenu()
  await expect(page.locator('[data-testid^="tab-add-agent-"]')).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('ticking one agent keeps exactly that one; "All agents" is still reachable', async () => {
  await openEdit()
  await page.getByTestId('project-agents').getByText('claude-test').click()
  await page.getByTestId('project-save').click()
  await expect.poll(savedAgents).toEqual(['claude-test'])
  await openPlusMenu()
  await expect(page.getByTestId('tab-add-agent-claude-test')).toBeVisible()
  await expect(page.locator('[data-testid^="tab-add-agent-"]')).toHaveCount(1)
  await page.keyboard.press('Escape')

  await openEdit()
  await page.getByTestId('project-agents').getByText('All agents').click()
  await page.getByTestId('project-save').click()
  await expect.poll(savedAgents).toEqual(['*'])
})

test('a config file with no visible-agents list offers every agent', async () => {
  await app.close()
  const path = join(fixture.workspaceRoot, '.pomade/workspace.json')
  const cfg = JSON.parse(await fs.readFile(path, 'utf8'))
  for (const p of cfg.projects) delete p.visibleAgents
  await fs.writeFile(path, JSON.stringify(cfg, null, 2))
  ;({ app, page } = await relaunchApp(app, fixture))
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await openPlusMenu()
  await expect(page.getByTestId('tab-add-agent-claude-test')).toBeVisible()
  await page.keyboard.press('Escape')
})
