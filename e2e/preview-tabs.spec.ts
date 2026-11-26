// modules: tabs, filetree, editor
// Pomade T-063 e2e — file-tree PREVIEW-TAB mode. A doc opened by a single tree click reuses one
// "preview" tab: the next tree click REPLACES it in place, UNLESS any other interaction (an edit,
// a click into the editor, switching tabs) committed it first. A dirty doc is never replaced. The
// mode is a default-ON AppSetting; OFF restores the one-tab-per-click behavior.
//
// New file ⇒ its own parallel worker; state does not chain with tabs.spec.

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
import { resetTabs } from './fixtures/stores'
import { expectQuiet } from './fixtures/timing'

interface TabSnap {
  id: string
  kind: string
  path?: string
  dirty?: boolean
}

function tabsOf(page: Page, pid: string): Promise<TabSnap[]> {
  return page.evaluate((p) => {
    const s = window.__pomadeStores.useTabsStore.getState()
    return (s.tabsByProject[p] ?? []).map((t) => ({
      id: t.id,
      kind: t.kind,
      path: t.path,
      dirty: t.dirty
    }))
  }, pid)
}


function setPreviewMode(page: Page, value: boolean): Promise<void> {
  return page.evaluate(
    (v) => window.__pomadeStores.useAppSettingsStore.getState().setPreviewTabMode(v),
    value
  )
}

function previewOn(page: Page): Promise<boolean> {
  return page.evaluate(
    () => window.__pomadeStores.useAppSettingsStore.getState().previewTabMode
  )
}

const A = 'Projects/alpha/pv-a.txt'
const B = 'Projects/alpha/pv-b.txt'
const C = 'Projects/alpha/pv-c.txt'

async function clickTree(page: Page, rel: string): Promise<void> {
  await page.getByTestId(`tree-node-${rel}`).click()
}

test.describe('T-063 preview-tab mode', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await fs.writeFile(join(fixture.workspaceRoot, 'Projects/alpha/pv-a.txt'), 'A\n')
    await fs.writeFile(join(fixture.workspaceRoot, 'Projects/alpha/pv-b.txt'), 'B\n')
    await fs.writeFile(join(fixture.workspaceRoot, 'Projects/alpha/pv-c.txt'), 'C\n')
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    alpha = fixture.projects.alpha
    await page.getByTestId(`project-${alpha}`).click()
    // The tree files must be present before the tests click them.
    await expect(page.getByTestId(`tree-node-${A}`)).toBeVisible({ timeout: 10_000 })
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('preview mode defaults ON', async () => {
    expect(await previewOn(page)).toBe(true)
  })

  test('click A then B with no interstitial interaction → ONE tab showing B', async () => {
    await resetTabs(page, alpha)
    await clickTree(page, A)
    await expect.poll(() => tabsOf(page, alpha).then((t) => t.length)).toBe(1)
    await clickTree(page, B)
    // Still ONE tab — B replaced A in place… (poll the replacement in)
    await expect.poll(() => tabsOf(page, alpha).then((t) => t.map((x) => x.path).join(','))).toBe(B)
    // …and no async follow-up may grow a second tab.
    await expectQuiet(async () => {
      const tabs = await tabsOf(page, alpha)
      expect(tabs).toHaveLength(1)
      expect(tabs[0].path).toBe(B)
    }, 200)
  })

  test('quickly clicking A → B → C leaves exactly one tab showing C', async () => {
    await resetTabs(page, alpha)
    await clickTree(page, A)
    await clickTree(page, B)
    await clickTree(page, C)
    await expect.poll(() => tabsOf(page, alpha).then((t) => t.map((x) => x.path).join(','))).toBe(C)
    // Exactly one tab holds — the A/B previews were replaced, not queued into extra tabs.
    await expectQuiet(async () => {
      const tabs = await tabsOf(page, alpha)
      expect(tabs).toHaveLength(1)
      expect(tabs[0].path).toBe(C)
    }, 200)
  })

  test('click A, click into the editor, then click B → TWO tabs', async () => {
    await resetTabs(page, alpha)
    await clickTree(page, A)
    await expect(page.locator('[data-doc-path="Projects/alpha/pv-a.txt"]:visible')).toBeVisible()
    // Any interaction other than the tree click commits the preview.
    await page.locator('[data-testid="editor-pane"] .cm-content').click()
    await clickTree(page, B)
    await expect.poll(() => tabsOf(page, alpha).then((t) => t.length)).toBe(2)
    const paths = (await tabsOf(page, alpha)).map((t) => t.path).sort()
    expect(paths).toEqual([A, B].sort())
  })

  test('a DIRTY preview tab is never replaced', async () => {
    await resetTabs(page, alpha)
    await clickTree(page, A)
    await page.locator('[data-testid="editor-pane"] .cm-content').click()
    await page.keyboard.type('EDIT')
    await expect(page.getByTestId('editor-dirty')).toBeVisible()
    // Clicking B must open a NEW tab, keeping the dirty A.
    await clickTree(page, B)
    await expect.poll(() => tabsOf(page, alpha).then((t) => t.length)).toBe(2)
    const tabs = await tabsOf(page, alpha)
    expect(tabs.find((t) => t.path === A)?.dirty).toBe(true)
    expect(tabs.find((t) => t.path === B)).toBeTruthy()
  })

  test('clicking a file already open elsewhere jumps to it (does not replace the preview)', async () => {
    await resetTabs(page, alpha)
    // Commit A into a normal tab (edit it), then open B as a fresh preview.
    await clickTree(page, A)
    await page.locator('[data-testid="editor-pane"] .cm-content').click()
    await page.keyboard.type('X')
    await clickTree(page, B) // new preview (A was committed/dirty)
    await expect.poll(() => tabsOf(page, alpha).then((t) => t.length)).toBe(2)
    // Re-clicking the already-open A jumps to it — no new tab, no replacement of B.
    await clickTree(page, A)
    const activeTab = (p: string): Promise<string | undefined> =>
      page.evaluate(
        (pid) => window.__pomadeStores.useTabsStore.getState().activeTabByProject[pid],
        p
      )
    const aId = (await tabsOf(page, alpha)).find((t) => t.path === A)?.id
    await expect.poll(() => activeTab(alpha)).toBe(aId)
    await expectQuiet(async () => {
      expect(await tabsOf(page, alpha)).toHaveLength(2)
      expect(await activeTab(alpha)).toBe(aId)
    }, 200)
  })

  test('setting OFF restores one-tab-per-click; back ON restores preview reuse', async () => {
    await setPreviewMode(page, false)
    await resetTabs(page, alpha)
    await clickTree(page, A)
    await clickTree(page, B)
    await expect.poll(() => tabsOf(page, alpha).then((t) => t.length)).toBe(2)

    await setPreviewMode(page, true)
    await resetTabs(page, alpha)
    await clickTree(page, A)
    await clickTree(page, B)
    await expect.poll(() => tabsOf(page, alpha).then((t) => t.map((x) => x.path).join(','))).toBe(B)
    await expectQuiet(async () => {
      expect(await tabsOf(page, alpha)).toHaveLength(1)
    }, 200)
  })
})
