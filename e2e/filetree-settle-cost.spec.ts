// modules: filetree
// T-296 e2e — what the file tree's settle costs. After a batch re-reads a folder, the settle
// re-reads only that folder (at 0.3 s and 1.2 s), never every folder the tree has loaded; and a
// folder on the watcher's skip-list (`node_modules` here), whose changes raise no event at all,
// still shows a new entry — the tree re-reads the expanded ones itself every 2 s. Folder reads are
// counted through the main-process test hook `__pomadeTreeReads` (docs/contracts/test-hooks.md).
// Specs chain state within this file — append, never insert mid-file.
// LIGHT partition: no terminal panes.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type ElectronApplication, type Page } from '@playwright/test'

import { launchApp } from './fixtures/app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

let fixture: Fixture
let app: ElectronApplication
let page: Page

const abs = (rel: string): string => join(fixture.workspaceRoot, rel)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const row = (path: string) => page.getByTestId(`tree-node-${path}`)
const SKIP_LISTED = /(^|\/)node_modules(\/|$)/

const clearReads = (): Promise<void> =>
  app.evaluate(() => {
    globalThis.__pomadeTreeReads = []
  })
const reads = (): Promise<string[]> =>
  app.evaluate(() => [...(globalThis.__pomadeTreeReads ?? [])])

test.describe('T-296 the file tree settles without full refreshes', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await expect(page.getByTestId('filetree-root')).toBeVisible()
    // node_modules is an ignored item: show ignored items to list it.
    await page.getByTestId('tree-section-kebab').click()
    await page.getByTestId('menu-toggle-ignored').click()
    const folders = ['Projects', 'Projects/alpha', 'Projects/beta', 'Apps', 'node_modules', 'node_modules/dummy-pkg']
    for (const folder of folders) await row(folder).click()
    await expect(row('Projects/beta/data.csv')).toBeVisible()
    await expect(row('node_modules/dummy-pkg/index.js')).toBeVisible()
    await sleep(2500) // past the registration settle (re-reads everything at 0.3 s and 1.2 s)
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('a new file re-reads only its folder, through the refresh and its settle', async () => {
    await clearReads()
    await fs.writeFile(abs('Projects/alpha/new.md'), 'new\n')
    await expect(row('Projects/alpha/new.md')).toBeVisible({ timeout: 1500 })
    await sleep(2500) // the settle's re-reads land at 0.3 s and 1.2 s after the refresh
    const watched = (await reads()).filter((p) => !SKIP_LISTED.test(p))
    // The refresh, then a settle re-read at each delay — all of them of the one folder.
    expect(watched).toEqual(['Projects/alpha', 'Projects/alpha', 'Projects/alpha'])
  })

  test('a new entry in an expanded node_modules folder shows, with no other change', async () => {
    await fs.writeFile(abs('node_modules/dummy-pkg/added.js'), 'module.exports = 1\n')
    await fs.mkdir(abs('node_modules/new-pkg'))
    await expect(row('node_modules/dummy-pkg/added.js')).toBeVisible({ timeout: 4000 })
    await expect(row('node_modules/new-pkg')).toBeVisible({ timeout: 4000 })
    await fs.rm(abs('node_modules/dummy-pkg/added.js'))
    await expect(row('node_modules/dummy-pkg/added.js')).toHaveCount(0, { timeout: 4000 })
  })

  test('expanded skip-list folders are re-read at a bounded rate, and nothing else while idle', async () => {
    await clearReads()
    await sleep(5000)
    const all = await reads()
    const perFolder = (p: string): number => all.filter((r) => r === p).length
    // Every 2 s: two or three passes in 5 s, each reading each expanded skip-list folder once.
    for (const folder of ['node_modules', 'node_modules/dummy-pkg']) {
      expect(perFolder(folder)).toBeGreaterThanOrEqual(2)
      expect(perFolder(folder)).toBeLessThanOrEqual(3)
    }
    expect(all.filter((p) => !SKIP_LISTED.test(p))).toEqual([])
  })
})
