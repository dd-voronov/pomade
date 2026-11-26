// modules: tabs, git
// Pomade T-298 e2e — a version tab has no name of its own and can't be renamed: double-click does
// nothing, the tab menu's "Rename document" is greyed out with a reason tip, and the file on disk
// is never touched. A plain doc tab's rename still renames the file on disk.
// Fixture: Projects/alpha is a repo; docs/v.md has two commits (its first opens as the version tab);
// docs/p.md is a plain document. Set POMADE_TEST_T298_SHOTS=<dir> to save review screenshots there.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { present } from './fixtures/assert'
import { launchAppPage } from './fixtures/app'
import { commitAt, configRepo, git, write } from './fixtures/git-repos'
import { tabsOf, type TabSnap } from './fixtures/stores'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const ALPHA = 'proj-alpha'
const V = 'Projects/alpha/docs/v.md'
const P = 'Projects/alpha/docs/p.md'

const SHOTS = process.env.POMADE_TEST_T298_SHOTS

let fx: Fixture
let docsDir: string
let app: ElectronApplication
let page: Page
let c1: string

const vis = (sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)

async function openRaw(path: string): Promise<void> {
  await page.evaluate(
    ({ p, f }) => window.__pomadeStores.useTabsStore.getState().openDocByPath(p, f, { mode: 'raw' }),
    { p: ALPHA, f: path }
  )
}

async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

async function showHistory(): Promise<void> {
  if (!(await vis('[data-testid="doc-history"]').isVisible())) await vis('[data-testid="doc-history-toggle"]').click()
}

async function versionTab(): Promise<TabSnap> {
  return present((await tabsOf(page, ALPHA)).find((x) => !!x.version), 'version tab')
}

test.beforeAll(async () => {
  fx = await createFixtureWorkspace()
  const alpha = join(fx.workspaceRoot, 'Projects/alpha')
  docsDir = join(alpha, 'docs')
  git(alpha, 'init', '-q', '-b', 'main')
  configRepo(alpha)
  await write(join(docsDir, 'v.md'), '# V\n\none\n')
  await write(join(docsDir, 'p.md'), '# P\n\nplain\n')
  git(alpha, 'add', '-A')
  commitAt(alpha, '2026-10-10T09:00:00', '-m', 'one')
  c1 = git(alpha, 'rev-parse', 'HEAD').trim()
  await write(join(docsDir, 'v.md'), '# V\n\ntwo\n')
  git(alpha, 'add', '-A')
  commitAt(alpha, '2026-10-12T09:00:00', '-m', 'two')
  ;({ app, page } = await launchAppPage(fx))
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId(`project-${ALPHA}`).click()
})

test.afterAll(async () => {
  await app?.close()
  await fx?.cleanup()
})

test('a version tab cannot be renamed; the file on disk stays', async () => {
  await openRaw(V)
  const panel = vis('[data-testid="doc-history"]')
  await showHistory()
  const row = panel.getByTestId(`history-row-commit-${c1.slice(0, 7)}`)
  await expect(async () => {
    await row.click({ button: 'right', timeout: 2000 })
    await expect(page.getByTestId('history-menu')).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 20000 })
  await page.getByTestId('history-menu-open-tab').click()
  await expect.poll(async () => (await tabsOf(page, ALPHA)).filter((t) => !!t.version).length).toBe(1)
  const vt = await versionTab()
  const tab = page.getByTestId(`tab-${vt.id}`)
  const diskBefore = (await fs.readdir(docsDir)).sort()

  // Double-click: no rename input.
  await tab.dblclick()
  await expect(page.getByTestId(`tab-rename-input-${vt.id}`)).toHaveCount(0)
  await shot('t298-version-tab-dblclick')

  // Menu: Rename document is there but greyed out, with the reason on hover; clicking it does nothing.
  await tab.click({ button: 'right' })
  const item = page.getByTestId('menu-tab-rename-doc')
  await expect(item).toHaveAttribute('aria-disabled', 'true')
  await item.hover()
  await expect(page.getByTestId('menu-tab-rename-doc-tooltip')).toContainText("A version can't be renamed")
  await shot('t298-version-tab-menu')
  await item.dispatchEvent('click')
  await expect(page.getByTestId(`tab-rename-input-${vt.id}`)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('tab-context-menu')).toHaveCount(0)

  // Nothing moved: same files, same tab.
  expect((await fs.readdir(docsDir)).sort()).toEqual(diskBefore)
  const after = await versionTab()
  expect([after.title, after.path]).toEqual([vt.title, vt.path])
})

test('a plain doc tab still renames the file on disk', async () => {
  await openRaw(P)
  const doc = present((await tabsOf(page, ALPHA)).find((t) => t.path === P && !t.version), 'doc tab')
  await page.getByTestId(`tab-${doc.id}`).dblclick()
  const input = page.getByTestId(`tab-rename-input-${doc.id}`)
  await expect(input).toBeVisible()
  await expect(input).toHaveValue('p.md')
  await input.fill('q.md')
  await input.press('Enter')
  await expect(page.getByTestId(`tab-rename-input-${doc.id}`)).toHaveCount(0)
  const files = await fs.readdir(docsDir)
  expect(files).toContain('q.md')
  expect(files).not.toContain('p.md')
  await expect
    .poll(async () => (await tabsOf(page, ALPHA)).find((t) => t.id === doc.id)?.path)
    .toBe('Projects/alpha/docs/q.md')
})
