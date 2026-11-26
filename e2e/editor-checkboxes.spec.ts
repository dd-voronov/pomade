// modules: core, editor
// Pomade E-002 (T-016) — GFM task-list checkboxes render as real, clickable checkboxes in
// rendered mode and serialize back to exactly `[ ]`/`[x]`. Toggling one checkbox and saving
// changes ONLY that single character on disk.

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

let fixture: Fixture
let app: ElectronApplication
let page: Page

const vis = (sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)

const TASKS = '# Tasks\n\n- [ ] first\n- [x] second\n'

function docTab(id: string, name: string): Record<string, unknown> {
  return { id, projectId: 'proj-alpha', kind: 'doc', title: name, path: `Projects/alpha/${name}`, mode: 'rendered', dirty: false }
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const root = fixture.workspaceRoot
  await fs.writeFile(join(root, 'Projects/alpha/tasks.md'), TASKS)

  const state = { openTabs: [docTab('doc-tasks', 'tasks.md')], activeTabId: 'doc-tasks' }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(root, '.pomade/state/proj-alpha.json'), JSON.stringify(state, null, 2))

  app = await launchApp({ workspaceRoot: root, userDataDir: fixture.userDataDir })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByTestId('project-proj-alpha').click()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test('task list opens rendered with real checkboxes reflecting checked state', async () => {
  await page.getByTestId('tab-doc-tasks').click()
  await expect(vis('[data-testid="editor-pane"]')).toHaveAttribute('data-mode', 'rendered')

  const boxes = page.locator('[data-testid="rendered-editor"]:visible input[data-testid="task-checkbox"]')
  await expect(boxes).toHaveCount(2)
  await expect(boxes.nth(0)).not.toBeChecked() // `- [ ] first`
  await expect(boxes.nth(1)).toBeChecked() // `- [x] second`
})

test('toggling a checkbox → save → only that one character changes on disk', async () => {
  const target = join(fixture.workspaceRoot, 'Projects/alpha/tasks.md')

  const boxes = page.locator('[data-testid="rendered-editor"]:visible input[data-testid="task-checkbox"]')
  await boxes.nth(0).click()
  await expect(boxes.nth(0)).toBeChecked()
  await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()

  await vis('[data-testid="doc-save"]').click()

  // Exactly one character differs: `- [ ] first` → `- [x] first`; everything else identical.
  const expected = TASKS.replace('- [ ] first', '- [x] first')
  await expect.poll(async () => fs.readFile(target, 'utf8')).toBe(expected)
})
