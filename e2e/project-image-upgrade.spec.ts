// modules: projects
// Pomade T-264 e2e — a workspace.json written when a project's icon image was `coverImage` still
// shows that icon, and the next save writes `image` and no `coverImage`. The fixture workspace is
// rewritten before launch so the project carries only the old key.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'
import { hoverClick } from './fixtures/interactions'

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64'
)
const ALPHA = 'proj-alpha'
const IMAGE = '.pomade/assets/0123456789abcdef.png'

let fixture: Fixture
let app: ElectronApplication
let page: Page

const workspaceJson = (): string => join(fixture.workspaceRoot, '.pomade/workspace.json')

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  await fs.mkdir(join(fixture.workspaceRoot, '.pomade/assets'), { recursive: true })
  await fs.writeFile(join(fixture.workspaceRoot, IMAGE), PNG_1PX)
  const config = JSON.parse(await fs.readFile(workspaceJson(), 'utf8'))
  config.projects[0].coverImage = IMAGE
  await fs.writeFile(workspaceJson(), JSON.stringify(config, null, 2))

  app = await launchApp(fixture)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test('a project saved with coverImage shows its image icon, and the next save writes image', async () => {
  await expect(page.getByTestId(`project-${ALPHA}`).locator('img[data-icon="image"]')).toBeVisible()

  // Any save rewrites workspace.json: rename Alpha through its edit window.
  await hoverClick(page.getByTestId(`project-${ALPHA}`), page.getByTestId(`project-menu-${ALPHA}`))
  await page.getByTestId(`project-edit-${ALPHA}`).click()
  await expect(page.getByTestId('project-image')).toHaveValue(IMAGE)
  await page.getByTestId('project-name').fill('Alpha renamed')
  await page.getByTestId('project-save').click()
  await expect(page.getByTestId('project-modal')).toHaveCount(0)

  await expect
    .poll(async () => {
      const saved = JSON.parse(await fs.readFile(workspaceJson(), 'utf8'))
      const alpha = saved.projects.find((p: { id: string }) => p.id === ALPHA)
      return { name: alpha.name, image: alpha.image, hasCover: 'coverImage' in alpha }
    })
    .toEqual({ name: 'Alpha renamed', image: IMAGE, hasCover: false })
  await expect(page.getByTestId(`project-${ALPHA}`).locator('img[data-icon="image"]')).toBeVisible()
})
