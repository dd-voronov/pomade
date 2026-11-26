// modules: core, filetree, tabs
// Pomade E-018 e2e — file-tree MULTI-SELECT + bulk operations. Shift+click takes the contiguous
// range in visible row order, Cmd+click toggles, both across folders; the bulk context menu applies
// every action per item (Open in editor / Cut / Copy / Paste / Move to Trash / Copy path / Copy full
// path / Reveal in Finder). Runs against the FIXTURE workspace; this file seeds its own `ms/` subtree
// on disk before launch. Specs chain state WITHIN this file — append, never insert mid-file.

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

const MOD: 'Meta' | 'Control' = process.platform === 'darwin' ? 'Meta' : 'Control'
// The default active project is the Workspace project (WORKSPACE_PROJECT_ID).
const WS = '__workspace__'

let fixture: Fixture
let app: ElectronApplication
let page: Page
let root: string

const onDisk = (rel: string): Promise<boolean> =>
  fs
    .access(join(root, rel))
    .then(() => true)
    .catch(() => false)

const row = (rel: string) => page.getByTestId(`tree-node-${rel}`)

/** Every currently-selected row, as workspace-relative paths, sorted. */
async function selected(): Promise<string[]> {
  const paths = await page
    .locator('[data-selected="true"]')
    .evaluateAll((els) =>
      els.map((el) => ((el as HTMLElement).dataset.testid ?? '').replace('tree-node-', ''))
    )
  return paths.sort()
}

interface TabSnap {
  id: string
  kind: string
  path?: string
}

function tabsOf(): Promise<TabSnap[]> {
  return page.evaluate((p) => {
    const s = window.__pomadeStores.useTabsStore.getState()
    return (s.tabsByProject[p] ?? []).map((t) => ({ id: t.id, kind: t.kind, path: t.path }))
  }, WS)
}

async function resetTabs(): Promise<void> {
  await page.evaluate((p) => {
    const s = window.__pomadeStores.useTabsStore.getState()
    for (const t of [...(s.tabsByProject[p] ?? [])]) s.closeTab(p, t.id)
  }, WS)
  await expect.poll(() => tabsOf().then((t) => t.length)).toBe(0)
}

async function openMenuOn(rel: string): Promise<void> {
  await row(rel).click({ button: 'right' })
  await expect(page.getByTestId('tree-menu')).toBeVisible()
}

// HTML5 drag-and-drop, driven deterministically (mirrors filetree-manage.spec.ts).
async function dragNodeOnto(sourcePath: string, targetPath: string): Promise<void> {
  const dt = await page.evaluateHandle(() => new DataTransfer())
  const source = row(sourcePath)
  const target = row(targetPath)
  const box = await target.boundingBox()
  if (!box) throw new Error('target node has no box')
  const clientX = Math.round(box.x + box.width / 2)
  const clientY = Math.round(box.y + box.height / 2)
  await source.dispatchEvent('dragstart', { dataTransfer: dt })
  await target.dispatchEvent('dragover', { dataTransfer: dt, clientX, clientY })
  await target.dispatchEvent('drop', { dataTransfer: dt, clientX, clientY })
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  root = fixture.workspaceRoot

  // A self-contained subtree at the workspace root. Sorted render order once ms/ and ms/sub are
  // expanded: dest, sub, [s1.md, s2.md], a.md, b.md, c.md, cp1.md, cp2.md, d.md, dg1.md, dg2.md,
  // mv1.md, mv2.md, pr1.md, pr2.md, tr1.md, tr2.md — dirs first, then files, alphabetically.
  await fs.mkdir(join(root, 'ms/sub'), { recursive: true })
  await fs.mkdir(join(root, 'ms/dest'), { recursive: true })
  for (const name of ['a', 'b', 'c', 'd', 'cp1', 'cp2', 'dg1', 'dg2', 'mv1', 'mv2', 'pr1', 'pr2', 'tr1', 'tr2']) {
    await fs.writeFile(join(root, `ms/${name}.md`), `${name.toUpperCase()}\n`)
  }
  await fs.writeFile(join(root, 'ms/sub/s1.md'), 'S1\n')
  await fs.writeFile(join(root, 'ms/sub/s2.md'), 'S2\n')
  // 11 files — one above the "Open N files?" confirm threshold.
  await fs.mkdir(join(root, 'many'), { recursive: true })
  for (let i = 1; i <= 11; i++) {
    await fs.writeFile(join(root, `many/f${String(i).padStart(2, '0')}.md`), `F${i}\n`)
  }

  app = await launchApp({ workspaceRoot: root, userDataDir: fixture.userDataDir })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.getByTestId('filetree-root')).toBeVisible()
  // Expand ms/ and ms/sub so the cross-folder ranges below have visible rows.
  await row('ms').click()
  await expect(row('ms/a.md')).toBeVisible()
  await row('ms/sub').click()
  await expect(row('ms/sub/s1.md')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

// ── Selection model ──────────────────────────────────────────────────────────

test('a plain click selects exactly one row and still opens the file', async () => {
  await resetTabs()
  await row('ms/a.md').click()

  expect(await selected()).toEqual(['ms/a.md'])
  // No count badge for a single selection.
  await expect(page.getByTestId('tree-selection-count')).toHaveCount(0)
  await expect.poll(() => tabsOf().then((t) => t.map((x) => x.path))).toEqual(['ms/a.md'])
})

test('Cmd+click toggles rows, ACROSS folders, without opening anything', async () => {
  await resetTabs()
  await row('ms/a.md').click()
  await resetTabs() // the plain click above opened a preview tab; start the count from zero

  await row('ms/sub/s2.md').click({ modifiers: [MOD] })
  expect(await selected()).toEqual(['ms/a.md', 'ms/sub/s2.md'])
  await expect(page.getByTestId('tree-selection-count')).toHaveText('2')

  // Cmd+click an already-selected row removes it.
  await row('ms/a.md').click({ modifiers: [MOD] })
  expect(await selected()).toEqual(['ms/sub/s2.md'])

  // Nothing was opened by either modified click.
  expect(await tabsOf()).toEqual([])
})

test('Shift+click takes the visible range across the folder boundary', async () => {
  await row('ms/sub/s1.md').click()
  await row('ms/b.md').click({ modifiers: ['Shift'] })

  // Visible rows between the anchor and the target, spanning ms/sub → ms.
  expect(await selected()).toEqual(['ms/a.md', 'ms/b.md', 'ms/sub/s1.md', 'ms/sub/s2.md'])
  await expect(page.getByTestId('tree-selection-count')).toHaveText('4')
})

test('a second Shift+click recomputes from the SAME anchor (it does not extend)', async () => {
  await row('ms/a.md').click()
  await row('ms/c.md').click({ modifiers: ['Shift'] })
  expect(await selected()).toEqual(['ms/a.md', 'ms/b.md', 'ms/c.md'])

  // Shift-clicking a nearer row shrinks the range back to the anchor — it does not add.
  await row('ms/b.md').click({ modifiers: ['Shift'] })
  expect(await selected()).toEqual(['ms/a.md', 'ms/b.md'])
  await expect(row('ms/c.md')).not.toHaveAttribute('data-selected', 'true')
})

test('Cmd+Shift+click ADDS a range to what is already selected', async () => {
  await row('ms/c.md').click()
  await row('ms/sub/s1.md').click({ modifiers: [MOD] })
  // Anchor is now s1.md; Cmd+Shift extends from it and unions with the existing selection.
  await row('ms/sub/s2.md').click({ modifiers: [MOD, 'Shift'] })

  expect(await selected()).toEqual(['ms/c.md', 'ms/sub/s1.md', 'ms/sub/s2.md'])
})

test('a modified click never opens a tab nor replaces the preview tab', async () => {
  await resetTabs()
  await row('ms/a.md').click() // one preview tab
  await expect.poll(() => tabsOf().then((t) => t.length)).toBe(1)

  await row('ms/b.md').click({ modifiers: [MOD] })
  await row('ms/sub/s2.md').click({ modifiers: ['Shift'] })

  // Still exactly the one tab, still showing the originally-clicked file — held for the
  // window a wrong open would need.
  await expectQuiet(async () => {
    const tabs = await tabsOf()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].path).toBe('ms/a.md')
  }, 200)
})

test('Escape clears the selection', async () => {
  await row('ms/a.md').click()
  await row('ms/c.md').click({ modifiers: ['Shift'] })
  expect(await selected()).toHaveLength(3)

  await page.keyboard.press('Escape')
  await expect(page.locator('[data-selected="true"]')).toHaveCount(0)
  await expect(page.getByTestId('tree-selection-count')).toHaveCount(0)
})

// ── Open in editor ───────────────────────────────────────────────────────────

test('the single-file menu gains Open in editor, which leaves a REAL tab', async () => {
  await resetTabs()
  // A preview tab first: "Open in editor" on another file must NOT reuse it.
  await row('ms/a.md').click()
  await expect.poll(() => tabsOf().then((t) => t.length)).toBe(1)

  await openMenuOn('ms/b.md')
  await page.getByTestId('menu-open-editor').click()

  await expect.poll(() => tabsOf().then((t) => t.length)).toBe(2)
  expect((await tabsOf()).map((t) => t.path).sort()).toEqual(['ms/a.md', 'ms/b.md'])
})

test('bulk Open in editor opens every selected file as its own real tab', async () => {
  await resetTabs()
  await row('ms/sub/s1.md').click()
  await row('ms/b.md').click({ modifiers: ['Shift'] }) // s1, s2, a, b — 4 files across folders

  await openMenuOn('ms/a.md')
  await expect(page.getByTestId('menu-bulk-count')).toContainText('4 items selected')
  await page.getByTestId('menu-open-editor').click()

  await expect.poll(() => tabsOf().then((t) => t.length)).toBe(4)
  expect((await tabsOf()).map((t) => t.path).sort()).toEqual([
    'ms/a.md',
    'ms/b.md',
    'ms/sub/s1.md',
    'ms/sub/s2.md'
  ])
})

// ── Paths ────────────────────────────────────────────────────────────────────

test('Copy path / Copy full path on a multi-selection give the COMMON PARENT folder', async () => {
  // Two files in the same folder → that folder.
  await row('ms/a.md').click()
  await row('ms/b.md').click({ modifiers: [MOD] })
  await openMenuOn('ms/a.md')
  await page.getByTestId('menu-copy-path').click()
  await expect.poll(() => page.evaluate(() => window.pomade.app.clipboardRead())).toBe('ms')

  // Spanning ms/ and ms/sub → their first common ancestor, ms.
  await row('ms/sub/s1.md').click({ modifiers: [MOD] })
  await openMenuOn('ms/a.md')
  await page.getByTestId('menu-copy-full-path').click()
  await expect.poll(() => page.evaluate(() => window.pomade.app.clipboardRead())).toBe(join(root, 'ms'))
})

// ── Bulk clipboard ───────────────────────────────────────────────────────────

test('bulk Copy → Paste duplicates every selected item into the target folder', async () => {
  await row('ms/cp1.md').click()
  await row('ms/cp2.md').click({ modifiers: [MOD] })
  await openMenuOn('ms/cp1.md')
  await page.getByTestId('menu-copy').click()

  await openMenuOn('ms/dest')
  await page.getByTestId('menu-paste').click()

  await expect(row('ms/dest/cp1.md')).toBeVisible()
  await expect(row('ms/dest/cp2.md')).toBeVisible()
  await expect.poll(() => onDisk('ms/dest/cp1.md')).toBe(true)
  await expect.poll(() => onDisk('ms/dest/cp2.md')).toBe(true)
  // Originals untouched, and ONE summary toast for the batch.
  expect(await onDisk('ms/cp1.md')).toBe(true)
  await expect(page.locator('[role="status"]')).toContainText('2 items copied')
})

test('bulk Cut → Paste moves every selected item', async () => {
  await row('ms/mv1.md').click()
  await row('ms/mv2.md').click({ modifiers: [MOD] })
  await openMenuOn('ms/mv1.md')
  await page.getByTestId('menu-cut').click()

  await openMenuOn('ms/dest')
  await page.getByTestId('menu-paste').click()

  await expect.poll(() => onDisk('ms/dest/mv1.md')).toBe(true)
  await expect.poll(() => onDisk('ms/dest/mv2.md')).toBe(true)
  await expect.poll(() => onDisk('ms/mv1.md')).toBe(false)
  await expect.poll(() => onDisk('ms/mv2.md')).toBe(false)
  await expect(page.locator('[role="status"]')).toContainText('2 items moved')

  // The cut clipboard is consumed: Paste is disabled again.
  await openMenuOn('ms/dest')
  await expect(page.getByTestId('menu-paste')).toBeDisabled()
  await page.keyboard.press('Escape')
})

test('bulk Move to Trash removes every selected item and reports one summary', async () => {
  await row('ms/tr1.md').click()
  await row('ms/tr2.md').click({ modifiers: [MOD] })
  await openMenuOn('ms/tr1.md')
  await page.getByTestId('menu-delete').click()

  await expect(row('ms/tr1.md')).toHaveCount(0)
  await expect(row('ms/tr2.md')).toHaveCount(0)
  await expect.poll(() => onDisk('ms/tr1.md')).toBe(false)
  await expect.poll(() => onDisk('ms/tr2.md')).toBe(false)
  await expect(page.locator('[role="status"]')).toContainText('2 items moved to Trash')
})

// ── Lifecycle + deferred multi-drag ──────────────────────────────────────────

test('dragging a row out of a multi-selection moves ONLY that row and collapses the selection', async () => {
  await row('ms/dg1.md').click()
  await row('ms/dg2.md').click({ modifiers: [MOD] })
  expect(await selected()).toHaveLength(2)

  await dragNodeOnto('ms/dg1.md', 'ms/dest')

  await expect.poll(() => onDisk('ms/dest/dg1.md')).toBe(true)
  // The other selected file did NOT travel (multi-drag is deferred, v1 drags one row).
  expect(await onDisk('ms/dest/dg2.md')).toBe(false)
  expect(await onDisk('ms/dg2.md')).toBe(true)
  // …and the selection collapsed onto the dragged row (which then vanished from this folder).
  await expect.poll(() => selected().then((s) => s.length)).toBeLessThanOrEqual(1)
})

test('an externally deleted row is pruned from the selection', async () => {
  await row('ms/pr1.md').click()
  await row('ms/pr2.md').click({ modifiers: [MOD] })
  expect(await selected()).toEqual(['ms/pr1.md', 'ms/pr2.md'])

  // Deleted behind the app's back — the watcher refresh must drop it from the selection.
  await fs.rm(join(root, 'ms/pr1.md'))

  await expect.poll(() => selected(), { timeout: 10_000 }).toEqual(['ms/pr2.md'])
})

test('switching projects clears the selection', async () => {
  await row('ms/a.md').click()
  await row('ms/b.md').click({ modifiers: [MOD] })
  expect(await selected()).toHaveLength(2)

  await page.getByTestId(`project-${fixture.projects.alpha}`).click()
  await expect(page.getByTestId('tree-node-Projects/alpha/README.md')).toBeVisible()
  await expect(page.locator('[data-selected="true"]')).toHaveCount(0)

  // Back to the workspace tree for the remaining specs.
  await page.getByTestId(`project-${WS}`).click()
  await expect(page.getByTestId('tree-node-ms')).toBeVisible()
})

// ── The >10 confirm ──────────────────────────────────────────────────────────

test('Open in editor above 10 files asks first: cancel opens nothing, confirm opens all', async () => {
  await resetTabs()
  await page.getByTestId('tree-node-many').click()
  await expect(page.getByTestId('tree-node-many/f01.md')).toBeVisible()

  await page.getByTestId('tree-node-many/f01.md').click()
  await page.getByTestId('tree-node-many/f11.md').click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('tree-selection-count')).toHaveText('11')
  await resetTabs() // the anchor click opened a preview tab

  await openMenuOn('many/f05.md')
  await page.getByTestId('menu-open-editor').click()
  const dialog = page.getByTestId('tree-open-many')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('11')

  await page.getByTestId('open-many-cancel').click()
  await expect(dialog).toHaveCount(0)
  expect(await tabsOf()).toEqual([])

  await openMenuOn('many/f05.md')
  await page.getByTestId('menu-open-editor').click()
  await page.getByTestId('open-many-confirm').click()
  await expect.poll(() => tabsOf().then((t) => t.length)).toBe(11)
})
