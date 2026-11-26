// modules: core, filetree, tabs, editor
// Pomade T-109 e2e (E-021) — a refused/unsupported file must LOCK the Save button VISIBLY and
// explain why on hover. The T-095 guard already made saves inert, but silently; T-109 renders the
// Save button with the real `disabled` attribute (dims per tokens) and carries the tooltip
// `File is not supported: editing is not available` (native `title=`, the app's button-tooltip
// precedent — ScopeMark's tooltip is a self-contained icon component, not a button wrapper).
//
// Covered here (in- AND outside-workspace, per the Owner's user-test finding): Save disabled + tooltip
// present, Cmd+S writes nothing, and — for the outside file — the T-102 first-save confirm never
// appears (the refusal guard early-returns before it). A normal editable doc keeps Save enabled and
// carries the plain `Save (Cmd+S)` tooltip. The outside file is a SECOND OS-tmp dir (never a real
// user path); the in-workspace >2 MB file is written into the fixture workspace.

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
import { expectQuiet } from './fixtures/timing'
import { tempDir } from './fixtures/temp'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const REFUSAL_TIP = 'File is not supported: editing is not available'

// >2 MB of real text — trips the size refusal before any read.
const BIG = ('lorem ipsum dolor sit amet '.repeat(64) + '\n').repeat(1300)

let fixture: Fixture
let app: ElectronApplication
let page: Page
let outsideDir: string
let outsideBig: string
let inWsBig: string

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
          t.some(
            (x) => x.kind === 'doc' && !!x.path && x.path.startsWith('/') && x.path.endsWith(suffix)
          )
        ),
      { timeout: 10_000 }
    )
    .toBe(true)
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  // In-workspace >2 MB file, inside the Alpha project root.
  inWsBig = join(fixture.workspaceRoot, 'Projects/alpha/huge.md')
  await fs.writeFile(inWsBig, BIG)

  outsideDir = await tempDir('pomade-t109-tip-')
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

test.describe('T-109 — refused files: Save locked visibly + explanatory tooltip (E-021)', () => {
  test('in-workspace >2 MB from tree: Save disabled + tooltip; Cmd+S writes nothing', async () => {
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await submitGoto('Projects/alpha/huge.md')

    const pane = page.locator('[data-testid="editor-pane"]:visible')
    await expect(pane.locator('[data-testid="editor-refusal"]')).toBeVisible({ timeout: 10_000 })

    const saveBtn = pane.locator('[data-testid="doc-save"]')
    await expect(saveBtn).toBeDisabled()
    await expect(saveBtn).toHaveAttribute('title', REFUSAL_TIP)

    const before = (await fs.stat(inWsBig)).size
    expect(before).toBeGreaterThan(2 * 1024 * 1024)
    await page.keyboard.press(`${MOD}+s`)
    // A write, if it happened, would land fast — held.
    await expectQuiet(async () => {
      expect((await fs.stat(inWsBig)).size).toBe(before)
    }, 600)
  })

  test('outside-workspace refused file: Save disabled + tooltip; Cmd+S inert; NO outside-save confirm', async () => {
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await submitGoto(outsideBig)
    await outsideTabExists('/outside-huge.md')

    const pane = page.locator('[data-testid="editor-pane"]:visible')
    await expect(pane.locator('[data-testid="editor-refusal"]')).toBeVisible({ timeout: 10_000 })

    const saveBtn = pane.locator('[data-testid="doc-save"]')
    await expect(saveBtn).toBeDisabled()
    await expect(saveBtn).toHaveAttribute('title', REFUSAL_TIP)

    const before = (await fs.stat(outsideBig)).size
    await page.keyboard.press(`${MOD}+s`)
    // The refusal guard fires BEFORE the T-102 outside-save confirm — the confirm must not
    // appear and no write may land, held for the whole window.
    await expectQuiet(async () => {
      await expect(page.locator('[data-testid="outside-save-confirm"]')).toHaveCount(0)
      expect((await fs.stat(outsideBig)).size).toBe(before)
    }, 600)
  })

  test('a normal editable doc is never refusal-locked; an edit enables Save with the plain tooltip', async () => {
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await submitGoto('Projects/alpha/README.md')

    const pane = page.locator('[data-testid="editor-pane"]:visible')
    await expect(pane.locator('[data-testid="editor-refusal"]')).toHaveCount(0)

    const saveBtn = pane.locator('[data-testid="doc-save"]')
    // T-139 — a clean editable doc shows the deliberate disabled "Saved" (NOT the refusal lock:
    // its tooltip is the settled-state text, never the refusal explanation).
    await expect(saveBtn).toBeDisabled()
    await expect(saveBtn).toHaveText('Saved')
    await expect(saveBtn).toHaveAttribute('title', 'Saved — no unsaved changes')
    // Editing flips it to the enabled "Save" with the plain tooltip.
    await pane.locator('.cm-content').first().click()
    await page.keyboard.type('x')
    await expect(saveBtn).toBeEnabled()
    await expect(saveBtn).toHaveText('Save')
    await expect(saveBtn).toHaveAttribute('title', 'Save (Cmd+S)')
  })
})
