// modules: filetree, tabs
// Pomade T-292 e2e — go-to-path reveals a path under any visible mount in that mount's section.
//
// Alpha (rooted at Projects/alpha) mounts two folders it does not contain: `Library/` inside the
// workspace and an OS-tmp folder outside it. The outside folder is mounted by its raw tmp path
// (`/var/folders/…` on macOS) while main resolves targets canonically (`/private/var/…`), so these
// specs also pin that the routing matches a mount however it was typed. A folder under a mount is
// revealed and selected in the mount's section — no Finder; a file is revealed and opens as a tab
// on the tree's path. Finder stays for a folder in no root and no mount. Reveal-in-Finder is
// recorded (not performed) under NODE_ENV=test via the main-process `__pomadeRevealedPaths`
// bucket. Specs chain state within this file — append, never insert mid-file.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'
import { expectQuiet } from './fixtures/timing'
import { tempDir } from './fixtures/temp'

async function write(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content, 'utf8')
}

let fixture: Fixture
let app: ElectronApplication
let page: Page
/** A folder OUTSIDE the fixture workspace (OS tmp — never a real user path), mounted in alpha. */
let outsideDir: string
let insideMountId: string
let outsideMountId: string

interface TabSnapshot {
  kind: string
  path?: string
  id: string
}
function alphaTabs(): Promise<TabSnapshot[]> {
  return page.evaluate((pid) => {
    const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject[pid] ?? []
    return tabs.map((t) => ({ id: t.id, kind: t.kind, path: t.path }))
  }, fixture.projects.alpha)
}

/** Paths handed to Finder by the routing matrix (recorded, not revealed, under NODE_ENV=test). */
function revealed(): Promise<string[]> {
  return app.evaluate(() => (globalThis.__pomadeRevealedPaths ?? []) as string[])
}

async function submitGoto(pathText: string): Promise<void> {
  const input = page.getByTestId('tree-goto')
  await expect(input).toBeVisible()
  await input.fill(pathText)
  await input.press('Enter')
}

function setCollapsed(rootId: string, collapsed: boolean): Promise<void> {
  return page.evaluate(
    ([pid, id, c]) => window.__pomadeStores.useMountsStore.getState().setRootCollapsed(pid, id, c),
    [fixture.projects.alpha, rootId, collapsed] as const
  )
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  await write(join(fixture.workspaceRoot, 'Library/shelf/book.md'), '# Book\n\nLIBRARY_SENTINEL\n')
  outsideDir = await tempDir('pomade-t292-outside-')
  await write(join(outsideDir, 'notes/deep/page.md'), '# Page\n\nOUTSIDE_SENTINEL\n')

  app = await launchApp(fixture)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.evaluate(
    (p) => window.__pomadeStores.useWorkspaceStore.getState().setActiveProject(p),
    fixture.projects.alpha
  )
  await expect(page.getByTestId('filetree-root')).toContainText('Projects/alpha')
  const ids = await page.evaluate(
    async ([pid, outside]) => {
      const s = window.__pomadeStores.useMountsStore.getState()
      await s.hydrateProject(pid)
      return [s.addMount(pid, 'Library', false), s.addMount(pid, outside, true)]
    },
    [fixture.projects.alpha, outsideDir] as const
  )
  insideMountId = ids[0] ?? ''
  outsideMountId = ids[1] ?? ''
  await expect(page.locator(`[data-root-path="${outsideDir}"]`)).toBeVisible()
  await expect(page.locator('[data-root-path="Library"]')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
  if (outsideDir) await fs.rm(outsideDir, { recursive: true, force: true })
})

test('a folder under an outside mount is revealed and selected in its section, not in Finder', async () => {
  const revealedBefore = (await revealed()).length
  const tabsBefore = (await alphaTabs()).length

  await submitGoto(`${outsideDir}/notes/deep`)

  const row = page.getByTestId(`tree-node-${outsideDir}/notes/deep`)
  await expect(row).toHaveAttribute('data-selected', 'true')
  await expect(row).toBeInViewport()
  await expect(page.getByTestId('tree-goto')).toHaveValue('')
  await expectQuiet(async () => {
    expect(await revealed()).toHaveLength(revealedBefore)
    expect(await alphaTabs()).toHaveLength(tabsBefore)
  }, 300)
})

test('a file under an outside mount is revealed and opens as a tab on the tree path', async () => {
  const path = `${outsideDir}/notes/deep/page.md`
  await submitGoto(path)

  await expect(page.getByTestId(`tree-node-${path}`)).toHaveAttribute('data-selected', 'true')
  // The tab carries the mount's own path form (the one a tree click opens), so the two share a tab.
  await expect.poll(async () => (await alphaTabs()).filter((t) => t.path === path).length).toBe(1)
  const id = (await alphaTabs()).find((t) => t.path === path)?.id ?? ''
  await expect(page.getByTestId(`tab-scope-${id}`)).toHaveAttribute('data-tone', 'danger')
  await expect(page.locator('[data-testid="editor-pane"]:visible')).toContainText('OUTSIDE_SENTINEL')

  // A tree click on the revealed row lands on the same tab, not a second one.
  await page.getByTestId(`tree-node-${path}`).click()
  await expectQuiet(async () => {
    expect((await alphaTabs()).filter((t) => t.path === path)).toHaveLength(1)
  }, 300)
})

test('a folder under a workspace mount outside the project is revealed in its section, not in Finder', async () => {
  const revealedBefore = (await revealed()).length

  await submitGoto('Library/shelf')

  await expect(page.getByTestId('tree-node-Library/shelf')).toHaveAttribute('data-selected', 'true')
  await expectQuiet(async () => {
    expect(await revealed()).toHaveLength(revealedBefore)
  }, 300)
})

test('a file under a collapsed workspace mount opens the section, is revealed, and opens with an orange mark', async () => {
  await setCollapsed(insideMountId, true)
  await expect(page.getByTestId(`tree-root-diamond-${insideMountId}`)).toHaveAttribute('data-collapsed', 'true')

  await submitGoto(`${fixture.workspaceRoot}/Library/shelf/book.md`)

  await expect(page.getByTestId(`tree-root-diamond-${insideMountId}`)).toHaveAttribute('data-collapsed', 'false')
  const row = page.getByTestId('tree-node-Library/shelf/book.md')
  await expect(row).toHaveAttribute('data-selected', 'true')
  await expect(row).toBeInViewport()
  await expect.poll(async () => (await alphaTabs()).some((t) => t.path === 'Library/shelf/book.md')).toBe(true)
  const id = (await alphaTabs()).find((t) => t.path === 'Library/shelf/book.md')?.id ?? ''
  await expect(page.getByTestId(`tab-scope-${id}`)).toHaveAttribute('data-tone', 'warning')
})

test('a mount in project scope reveals the same way; its file opens unmarked', async () => {
  await page.evaluate(
    ([pid, id]) => window.__pomadeStores.useMountsStore.getState().setMountInScope(pid, id, true),
    [fixture.projects.alpha, outsideMountId] as const
  )
  await setCollapsed(outsideMountId, true)
  const path = `${outsideDir}/notes/deep/page.md`
  // Close the earlier tab so this one is opened by the go-to, not reused.
  await page.evaluate(
    ([pid, p]) => {
      const s = window.__pomadeStores.useTabsStore.getState()
      const tab = (s.tabsByProject[pid] ?? []).find((t) => t.path === p)
      if (tab) s.closeTab(pid, tab.id)
    },
    [fixture.projects.alpha, path] as const
  )

  await submitGoto(path)

  await expect(page.getByTestId(`tree-root-diamond-${outsideMountId}`)).toHaveAttribute('data-collapsed', 'false')
  await expect(page.getByTestId(`tree-node-${path}`)).toHaveAttribute('data-selected', 'true')
  await expect.poll(async () => (await alphaTabs()).some((t) => t.path === path)).toBe(true)
  const id = (await alphaTabs()).find((t) => t.path === path)?.id ?? ''
  await expect(page.getByTestId(`tab-${id}`)).toBeVisible()
  await expect(page.getByTestId(`tab-scope-${id}`)).toHaveCount(0)
})

test('a folder in no root and no mount still opens in Finder', async () => {
  const revealedBefore = (await revealed()).length

  await submitGoto('Projects/beta')

  await expect
    .poll(() => revealed().then((paths) => paths.slice(revealedBefore).some((p) => p.endsWith('/Projects/beta'))))
    .toBe(true)
})
