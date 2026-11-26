// modules: filetree, tabs, editor
// Pomade T-290 (E-047) e2e — project scope: a mount put in the project's scope (the mount dialog's
// Add to project scope box, or the mount menu's Add to / Remove from project scope) makes its files
// the project's — no scope mark on the tab or in the editor header, and the header's short
// `<folder name>/…` path. A convenience mount without the box keeps the mark; the same file stays
// orange in another project; an in-scope folder outside the workspace drops the red mark too.
//
// Runs against the fixture workspace with the active project switched to alpha. Tests chain state
// within this file — append, never insert mid-file.

import { test, expect, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchAppPage, relaunchApp } from './fixtures/app'
import { tabsOf } from './fixtures/stores'
import { tempDir } from './fixtures/temp'

// The tests chain one app's state: a failure skips the rest instead of rerunning them on a fresh app.
test.describe.configure({ mode: 'serial' })

const NOTE = 'Pomade-Notes/alpha/T-1.md'
const NOTE2 = 'Pomade-Notes/alpha/T-2.md'
const KNOW = 'Knowledge/k.md'

let fixture: Fixture
let app: ElectronApplication
let page: Page
let alpha: string
let beta: string
let outsideDir: string

const rootHeader = (path: string): Locator => page.locator(`[data-root-path="${path}"]`)
const mountId = async (path: string): Promise<string> =>
  (await rootHeader(path).getAttribute('data-root-id')) ?? ''

async function launched(p: Page): Promise<void> {
  page = p
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId(`project-${alpha}`).click()
  await expect(page.getByTestId('filetree-root')).toContainText('Projects/alpha')
}

async function openMountDialog(): Promise<void> {
  await page.getByTestId('tree-section-kebab').click()
  await page.getByTestId('menu-mount-folder').click()
  await expect(page.getByTestId('tree-mount-dialog')).toBeVisible()
}

/** Open a mount's ⋯ menu and click its scope item, checking the label it showed first. */
async function toggleScopeFromMenu(path: string, expectedLabel: string): Promise<void> {
  await rootHeader(path).hover()
  await page.getByTestId(`tree-root-kebab-${await mountId(path)}`).click()
  const item = page.getByTestId('menu-mount-scope')
  await expect(item).toHaveText(expectedLabel)
  await item.click()
}

/** Show the header's path form (the one global toggle), so `editor-title` reads the path. */
async function showHeaderPath(): Promise<void> {
  const title = page.locator('[data-testid="editor-title"]:visible')
  if ((await title.getAttribute('data-expanded')) !== 'true') await title.click()
  await expect(title).toHaveAttribute('data-expanded', 'true')
}

const visibleTitle = (): Locator => page.locator('[data-testid="editor-title"]:visible')
const visibleHeaderScope = (): Locator => page.locator('[data-testid="editor-scope"]:visible')

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  alpha = fixture.projects.alpha
  beta = fixture.projects.beta
  const root = fixture.workspaceRoot
  await fs.mkdir(join(root, 'Pomade-Notes/alpha'), { recursive: true })
  await fs.writeFile(join(root, NOTE), '# T-1\n')
  await fs.writeFile(join(root, NOTE2), '# T-2\n')
  await fs.mkdir(join(root, 'Knowledge'), { recursive: true })
  await fs.writeFile(join(root, KNOW), '# K\n')
  outsideDir = await tempDir('pomade-t290-out-')
  await fs.writeFile(join(outsideDir, 'o.md'), '# Outside\n')

  // Alpha starts with the Planner note open: orange until its folder joins the scope.
  const docTab = (id: string, path: string): Record<string, unknown> => ({
    id,
    projectId: alpha,
    kind: 'doc',
    title: path.slice(path.lastIndexOf('/') + 1),
    path,
    mode: 'raw',
    dirty: false
  })
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(
    join(root, '.pomade/state', `${alpha}.json`),
    JSON.stringify({ openTabs: [docTab('doc-note', NOTE)], activeTabId: 'doc-note' })
  )

  const r = await launchAppPage(fixture)
  app = r.app
  await launched(r.page)
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
  if (outsideDir) await fs.rm(outsideDir, { recursive: true, force: true })
})

test('a note outside the project carries the orange mark before its folder is in scope', async () => {
  await expect(page.getByTestId('tab-scope-doc-note')).toHaveAttribute('data-tone', 'warning')
  await expect(visibleHeaderScope()).toHaveAttribute('data-tone', 'warning')
})

test('the mount dialog: Add to project scope is off by default, explains itself, and changes the hint', async () => {
  await openMountDialog()
  const box = page.getByTestId('tree-mount-scope')
  await expect(box).not.toBeChecked()
  await expect(page.getByTestId('tree-mount-dialog')).toContainText('Add to project scope')

  await page.getByTestId('tree-mount-scope-info').hover()
  await expect(page.getByTestId('tree-mount-scope-tip')).toHaveText(
    "Files in this folder count as part of this project: no 'Outside this project' mark."
  )

  await page.getByTestId('tree-mount-input').fill('Pomade-Notes/alpha')
  await expect(page.getByTestId('tree-mount-hint')).toHaveText('Outside this project — mounts with an orange mark.')
  await box.check()
  await expect(page.getByTestId('tree-mount-hint')).toHaveText('Outside this project — in project scope, so no mark.')
})

test('mounting with the box ticked unmarks the open note and gives the header its short path', async () => {
  await page.getByTestId('tree-mount-submit').click()
  await expect(rootHeader('Pomade-Notes/alpha')).toBeVisible()

  await expect(page.getByTestId('tab-scope-doc-note')).toHaveCount(0)
  await expect(visibleHeaderScope()).toHaveCount(0)
  await showHeaderPath()
  await expect(visibleTitle()).toHaveText('alpha/T-1.md')
  // The in-scope mount's diamond reads as the project's own.
  await expect(page.locator('[data-root-path="Pomade-Notes/alpha"] [data-scope]')).toHaveAttribute('data-scope', 'in-project')
})

test('another file of the in-scope folder opens unmarked', async () => {
  await page.getByTestId(`tree-node-${NOTE2}`).click()
  await expect(visibleTitle()).toHaveText('alpha/T-2.md')
  const tab = (await tabsOf(page, alpha)).find((t) => t.kind === 'doc' && t.path === NOTE2)
  expect(tab).toBeTruthy()
  await expect(page.getByTestId(`tab-${tab!.id}`)).toBeVisible()
  await expect(page.getByTestId(`tab-scope-${tab!.id}`)).toHaveCount(0)
})

test('Remove from project scope turns the open tab orange at once; Add brings it back', async () => {
  await page.getByTestId('tab-doc-note').click()
  await toggleScopeFromMenu('Pomade-Notes/alpha', 'Remove from project scope')
  await expect(page.getByTestId('tab-scope-doc-note')).toHaveAttribute('data-tone', 'warning')
  await expect(visibleHeaderScope()).toHaveAttribute('data-tone', 'warning')
  // Out of scope: the full path again (the fixture lives in the OS temp dir, so no `~`).
  await expect(visibleTitle()).toHaveText(new RegExp(`/pomade-ws-[^/]+/${NOTE}$`))
  await expect(page.locator('[data-root-path="Pomade-Notes/alpha"] [data-scope]')).toHaveAttribute('data-scope', 'outside-project')

  await toggleScopeFromMenu('Pomade-Notes/alpha', 'Add to project scope')
  await expect(page.getByTestId('tab-scope-doc-note')).toHaveCount(0)
  await expect(visibleTitle()).toHaveText('alpha/T-1.md')
})

test('a convenience mount without the box keeps the orange mark', async () => {
  await openMountDialog()
  await page.getByTestId('tree-mount-input').fill('Knowledge')
  await page.getByTestId('tree-mount-submit').click()
  await expect(rootHeader('Knowledge')).toBeVisible()
  await page.getByTestId(`tree-node-${KNOW}`).click()
  const tab = (await tabsOf(page, alpha)).find((t) => t.kind === 'doc' && t.path === KNOW)
  expect(tab).toBeTruthy()
  await expect(page.getByTestId(`tab-scope-${tab!.id}`)).toHaveAttribute('data-tone', 'warning')
})

test('an in-scope folder outside the workspace drops the red mark', async () => {
  await openMountDialog()
  await page.getByTestId('tree-mount-input').fill(outsideDir)
  await expect(page.getByTestId('tree-mount-hint')).toHaveText('Outside the workspace — mounts with a red mark.')
  await page.getByTestId('tree-mount-scope').check()
  await expect(page.getByTestId('tree-mount-hint')).toHaveText('Outside the workspace — in project scope, so no mark.')
  await page.getByTestId('tree-mount-submit').click()
  await expect(rootHeader(outsideDir)).toBeVisible()

  const file = join(outsideDir, 'o.md')
  await page.getByTestId(`tree-node-${file}`).click()
  const leaf = outsideDir.slice(outsideDir.lastIndexOf('/') + 1)
  await expect(visibleTitle()).toHaveText(`${leaf}/o.md`)
  const tab = (await tabsOf(page, alpha)).find((t) => t.kind === 'doc' && t.path === file)
  expect(tab).toBeTruthy()
  await expect(page.getByTestId(`tab-scope-${tab!.id}`)).toHaveCount(0)
})

test('the scope flag persists with the mount across a relaunch', async () => {
  const r = await relaunchApp(app, fixture)
  app = r.app
  await launched(r.page)
  await page.getByTestId('tab-doc-note').click()
  await expect(page.getByTestId('tab-scope-doc-note')).toHaveCount(0)

  const state = JSON.parse(
    await fs.readFile(join(fixture.workspaceRoot, '.pomade/state', `${alpha}.json`), 'utf8')
  ) as { mounts: { path: string; inScope?: boolean }[] }
  const byPath = Object.fromEntries(state.mounts.map((m) => [m.path, m.inScope]))
  expect(byPath).toEqual({ 'Pomade-Notes/alpha': true, Knowledge: undefined, [outsideDir]: true })
})

test('the same note stays orange in another project', async () => {
  await page.getByTestId(`project-${beta}`).click()
  await expect(page.getByTestId('filetree-root')).toContainText('Projects/beta')
  const id = await page.evaluate(
    ([p, path]) => window.__pomadeStores.useTabsStore.getState().openDocByPath(p, path) as string,
    [beta, NOTE] as const
  )
  const mark = page.getByTestId(`tab-scope-${id}`)
  await expect(mark).toHaveAttribute('data-tone', 'warning')
  await expect(mark).toHaveAttribute('aria-label', /^Outside this project/)
  // Back in alpha the note is unmarked by location — only the duplicate line remains.
  await page.getByTestId(`project-${alpha}`).click()
  await expect(page.getByTestId('tab-scope-doc-note')).toHaveAttribute('aria-label', '2+ copies open across projects')
})
