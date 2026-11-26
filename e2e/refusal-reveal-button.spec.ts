// modules: core, filetree, tabs, editor
// Pomade T-106 e2e (E-021) — the editor refusal / unsupported panel gains a Reveal-in-Finder
// button.
//
// Every refusal variant (binary, >2 MB) shows a "Reveal in Finder" button that fires the existing
// app.showItemInFolder IPC with the file's ABSOLUTE path — for in- AND outside-workspace files.
// Reveal is recorded (not performed) under NODE_ENV=test via the main-process
// `__pomadeRevealedPaths` bucket. The T-095 empty-save guard stays inert on the panel.
//
// The outside file is a SECOND OS-tmp dir (never a real user path); the in-workspace >2 MB file is
// written into the fixture workspace.

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
import { tempDir } from './fixtures/temp'

// >2 MB of real text — trips the size refusal before any read.
const BIG = ('lorem ipsum dolor sit amet '.repeat(64) + '\n').repeat(1300)

let fixture: Fixture
let app: ElectronApplication
let page: Page
let outsideDir: string
let outsideBig: string

interface TabSnapshot {
  id: string
  kind: string
  path?: string
}
function tabsOf(projectId: string): Promise<TabSnapshot[]> {
  return page.evaluate((pid) => {
    const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject[pid] ?? []
    return tabs.map((t) => ({ id: t.id, kind: t.kind, path: t.path }))
  }, projectId)
}

function revealed(): Promise<string[]> {
  return app.evaluate(() => (globalThis.__pomadeRevealedPaths ?? []) as string[])
}

async function submitGoto(pathText: string): Promise<void> {
  const input = page.getByTestId('tree-goto')
  await expect(input).toBeVisible()
  await input.fill(pathText)
  await input.press('Enter')
}

async function outsideTabExists(suffix: string): Promise<void> {
  await expect
    .poll(
      () =>
        tabsOf(fixture.projects.alpha).then((t) =>
          t.some((x) => x.kind === 'doc' && !!x.path && x.path.startsWith('/') && x.path.endsWith(suffix))
        ),
      { timeout: 10_000 }
    )
    .toBe(true)
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  // In-workspace >2 MB file, inside the Alpha project root.
  await fs.writeFile(join(fixture.workspaceRoot, 'Projects/alpha/huge.md'), BIG)

  outsideDir = await tempDir('pomade-t106-reveal-')
  outsideBig = join(outsideDir, 'outside-huge.md')
  await fs.writeFile(outsideBig, BIG)

  app = await launchApp(fixture)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId(`project-${fixture.projects.alpha}`).click()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
  if (outsideDir) await fs.rm(outsideDir, { recursive: true, force: true })
})

test.describe('T-106 — refusal panel Reveal-in-Finder button (E-021)', () => {
  test('an IN-WORKSPACE >2 MB file opened from the tree shows the button; clicking reveals its absolute path', async () => {
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    const revealedBefore = (await revealed()).length

    // Open from the tree (in-scope go-to-path reveals + opens through the P-021 tree path).
    await submitGoto('Projects/alpha/huge.md')

    const pane = page.locator('[data-testid="editor-pane"]:visible')
    await expect(pane.locator('[data-testid="editor-refusal"]')).toBeVisible({ timeout: 10_000 })
    const btn = pane.locator('[data-testid="refusal-reveal"]')
    await expect(btn).toBeVisible()

    await btn.click()
    // Recorded path is canonical (realpath); assert by suffix (/var → /private/var on macOS).
    await expect
      .poll(
        () => revealed().then((paths) => paths.some((p) => p.endsWith('/Projects/alpha/huge.md'))),
        { timeout: 10_000 }
      )
      .toBe(true)
    expect(await revealed()).toHaveLength(revealedBefore + 1)
  })

  test('an OUTSIDE-WORKSPACE file shows the button; clicking reveals its absolute path', async () => {
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    const revealedBefore = (await revealed()).length

    await submitGoto(outsideBig)
    await outsideTabExists('/outside-huge.md')

    const pane = page.locator('[data-testid="editor-pane"]:visible')
    await expect(pane.locator('[data-testid="editor-refusal"]')).toBeVisible({ timeout: 10_000 })
    const btn = pane.locator('[data-testid="refusal-reveal"]')
    await expect(btn).toBeVisible()
    // T-095 — Save is still inert on a refused file even with the reveal button present.
    await expect(pane.locator('[data-testid="doc-save"]')).toBeDisabled()

    await btn.click()
    await expect
      .poll(() => revealed().then((paths) => paths.some((p) => p.endsWith('/outside-huge.md'))), {
        timeout: 10_000
      })
      .toBe(true)
    expect(await revealed()).toHaveLength(revealedBefore + 1)
  })
})
