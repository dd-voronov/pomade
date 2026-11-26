// modules: core, tabs, editor
// Pomade e2e — doc rename via the tab strip: T-055 collision keeps the same input mounted,
// E-016 renaming a dirty doc follows the file. Doc-tab only (no terminal/agent), so this file
// runs in the LIGHT pass; the zsh-bound tab suites live in tabs.spec.ts (heavy).

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { present } from './fixtures/assert'
import { launchApp } from './fixtures/app'
import { resetTabs } from './fixtures/stores'

interface TabSnap {
  id: string
  kind: string
  title: string
  color?: string
  path?: string
  dirty?: boolean
}

function tabsOf(page: Page, pid: string): Promise<TabSnap[]> {
  return page.evaluate((p) => {
    const s = window.__pomadeStores.useTabsStore.getState()
    return (s.tabsByProject[p] ?? []).map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title,
      color: t.color,
      path: t.path,
      dirty: t.dirty
    }))
  }, pid)
}


async function openDoc(page: Page, rel: string, pid: string): Promise<string> {
  const before = new Set((await tabsOf(page, pid)).map((t) => t.id))
  await page.getByTestId(`tree-node-${rel}`).click()
  await expect.poll(() => tabsOf(page, pid).then((t) => t.length)).toBeGreaterThan(before.size)
  const added = (await tabsOf(page, pid)).find((t) => !before.has(t.id))
  if (!added) throw new Error('doc did not open')
  // T-063 — this helper's contract is "open <rel> in its OWN persistent tab". Preview-tab mode
  // (default ON) would otherwise let the NEXT tree click replace this one; commit it so every
  // openDoc yields a distinct tab, as the whole suite assumes. (Preview reuse is covered on its
  // own in preview-tabs.spec.ts.)
  await page.evaluate(
    (p) => window.__pomadeStores.useTabsStore.getState().commitPreview(p),
    pid
  )
  return added.id
}

// ─── T-055: a colliding doc rename keeps the SAME input mounted (no close/reopen flicker) ───
test.describe('T-055 rename collision does not remount the input', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await fs.writeFile(join(fixture.workspaceRoot, 'Projects/alpha/keep.txt'), 'keep\n')
    await fs.writeFile(join(fixture.workspaceRoot, 'Projects/alpha/taken.txt'), 'taken\n')
    await fs.writeFile(join(fixture.workspaceRoot, 'Projects/alpha/e016-follow.txt'), 'ORIG\n')
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    alpha = fixture.projects.alpha
    await page.getByTestId(`project-${alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('a colliding rename keeps the very same input element mounted and focused with the attempted name', async () => {
    await resetTabs(page, alpha)
    const docId = await openDoc(page, 'Projects/alpha/keep.txt', alpha)

    await page.getByTestId(`tab-${docId}`).click({ button: 'right' })
    await page.getByTestId('menu-tab-rename-doc').click()
    const input = page.getByTestId(`tab-rename-input-${docId}`)
    await expect(input).toBeVisible()
    // Capture the live DOM node so we can prove it is never detached/remounted by the error path.
    const handle = present(await input.elementHandle(), 'rename input handle')

    await input.fill('taken.txt')
    await input.press('Enter')

    // The collision surfaces an error…
    await expect(page.getByText(/already exists/i)).toBeVisible()
    // …but the ORIGINAL input element is still connected (before T-055 the error path did
    // setRename(null) then setRename(value), unmounting + remounting a NEW node — the flicker).
    expect(await handle.evaluate((el) => el.isConnected)).toBe(true)
    // …still the focused element, still holding the attempted name.
    expect(await handle.evaluate((el) => el === document.activeElement)).toBe(true)
    await expect(input).toHaveValue('taken.txt')

    // Disk untouched; the tab keeps its current name.
    expect(await fs.readFile(join(fixture.workspaceRoot, 'Projects/alpha/taken.txt'), 'utf8')).toBe(
      'taken\n'
    )
    expect((await tabsOf(page, alpha)).find((t) => t.id === docId)?.title).toBe('keep.txt')

    // Correcting to a free name then commits and closes the (same) input.
    await input.fill('renamed-keep.txt')
    await input.press('Enter')
    await expect
      .poll(() => tabsOf(page, alpha).then((t) => t.find((x) => x.id === docId)?.title))
      .toBe('renamed-keep.txt')
    await expect(page.getByTestId(`tab-rename-input-${docId}`)).toHaveCount(0)
  })

  // E-016 — renaming a doc's file via the tab strip must retarget the open tab AND make the
  // pane save to the NEW path, preserving the (dirty) in-memory buffer.
  test('renaming a dirty doc follows the file and saves to the new path', async () => {
    await resetTabs(page, alpha)
    const docId = await openDoc(page, 'Projects/alpha/e016-follow.txt', alpha)
    await expect(page.locator('[data-doc-path="Projects/alpha/e016-follow.txt"]:visible')).toBeVisible()

    // Edit the buffer so the tab is dirty (the user's in-memory content that must survive).
    await page.locator('[data-testid="editor-pane"] .cm-content').click()
    await page.keyboard.type('EDITED ')
    await expect(page.getByTestId('editor-dirty')).toBeVisible()

    // Rename the file via the tab context menu.
    await page.getByTestId(`tab-${docId}`).click({ button: 'right' })
    await page.getByTestId('menu-tab-rename-doc').click()
    const input = page.getByTestId(`tab-rename-input-${docId}`)
    await input.fill('e016-followed.txt')
    await input.press('Enter')

    // The tab followed to the new path/title; the buffer is still dirty (no reload).
    await expect
      .poll(() => tabsOf(page, alpha).then((t) => t.find((x) => x.id === docId)?.path))
      .toBe('Projects/alpha/e016-followed.txt')
    expect((await tabsOf(page, alpha)).find((t) => t.id === docId)?.dirty).toBe(true)

    // Save writes the edited buffer to the NEW path; the old path no longer exists (renamed).
    await page.getByTestId('doc-save').click()
    await expect
      .poll(() => fs.readFile(join(fixture.workspaceRoot, 'Projects/alpha/e016-followed.txt'), 'utf8').catch(() => ''))
      .toContain('EDITED')
    expect(
      await fs
        .access(join(fixture.workspaceRoot, 'Projects/alpha/e016-follow.txt'))
        .then(() => true)
        .catch(() => false)
    ).toBe(false)
  })
})
