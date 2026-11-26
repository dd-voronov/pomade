// modules: tabs, terminal, editor
// Pomade E-004 e2e — tab power features (T-020 context menu + close variants + rename doc,
// T-021 terminal rename + colors, T-022 icons). Drives the real Electron app; tab state is
// read/reset through the __pomadeStores hook (the terminals suite's established pattern).

import {
  test,
  expect,
  type ElectronApplication,
  type ElementHandle,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp, launchAppPage } from './fixtures/app'
import { resetTabs, writePty } from './fixtures/stores'
import { FAKE_AGENT_ECHO_EXIT, seedFakeAgent } from './fixtures/fake-agent'
import { expectQuiet } from './fixtures/timing'

/** The persisted per-project tab state on disk (empty string until the first write lands). */
function persistedState(fixture: Fixture, projectId: string): Promise<string> {
  return fs
    .readFile(join(fixture.workspaceRoot, '.pomade', 'state', `${projectId}.json`), 'utf8')
    .catch(() => '')
}
const SHOTS = process.env.POMADE_SHOTS // set to capture self-check screenshots

/** A self-check screenshot of the window into POMADE_SHOTS, when set. */
async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, name) })
}

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

function activeId(page: Page, pid: string): Promise<string | undefined> {
  return page.evaluate(
    (p) => window.__pomadeStores.useTabsStore.getState().activeTabByProject[p],
    pid
  )
}


async function newTabVia(page: Page, pid: string, testid: string): Promise<string> {
  const before = new Set((await tabsOf(page, pid)).map((t) => t.id))
  const menu = page.getByTestId('tab-add-menu')
  const item = page.getByTestId(testid)
  // Open the "+" menu and wait for the target item. Agent items depend on the async roster
  // load, so retry the wait WITHOUT re-toggling an already-open menu (a blind second click on
  // tab-add would close it) — this makes agent launches robust against a slow first roster.
  await expect(async () => {
    if (!(await menu.isVisible().catch(() => false))) {
      await page.getByTestId('tab-add').click()
    }
    await expect(item).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 20_000 })
  await item.click()
  await expect.poll(() => tabsOf(page, pid).then((t) => t.length)).toBeGreaterThan(before.size)
  const added = (await tabsOf(page, pid)).find((t) => !before.has(t.id))
  if (!added) throw new Error('no new tab')
  return added.id
}

const newTerminalTab = (page: Page, pid: string): Promise<string> =>
  newTabVia(page, pid, 'tab-add-terminal')
const newAgentTab = (page: Page, pid: string): Promise<string> =>
  newTabVia(page, pid, 'tab-add-agent-claude-test')

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

// T-044 helpers — termId lookup, foreground-busy poll, and raw pty write (driving a shell).
function termIdOf(page: Page, pid: string, tabId: string): Promise<string | undefined> {
  return page.evaluate(
    ({ p, t }) => {
      const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject[p] ?? []
      return tabs.find((x) => x.id === t)?.termId
    },
    { p: pid, t: tabId }
  )
}

function ptyBusy(page: Page, termId: string): Promise<boolean> {
  return page.evaluate(
    (tid) => window.pomade.pty.list().then((l) => !!l.find((t) => t.termId === tid)?.busy),
    termId
  )
}

function ptyAlive(page: Page, termId: string): Promise<boolean> {
  return page.evaluate(
    (tid) => window.pomade.pty.list().then((l) => !!l.find((t) => t.termId === tid)?.alive),
    termId
  )
}


// The seeded fake agent prints AGENT_READY — a reliable signal that its pty is up and this
// pane has mounted (so its close guard is registered).
function readAgentReady(page: Page, termId: string): Promise<boolean> {
  return page.evaluate(
    (tid) => window.pomade.pty.buffer(tid).then((b: string) => b.includes('AGENT_READY')),
    termId
  )
}

// T-048 — drive HTML5 drag-and-drop deterministically (Playwright mouse gestures don't
// trigger native DnD). We share one DataTransfer across the dragstart→dragover→drop→dragend
// sequence and drop on the LEFT half of the target so the source lands BEFORE it.
async function dragTabBefore(page: Page, sourceId: string, targetId: string): Promise<void> {
  const dt = await page.evaluateHandle(() => new DataTransfer())
  const source = page.getByTestId(`tab-${sourceId}`)
  const target = page.getByTestId(`tab-${targetId}`)
  const box = await target.boundingBox()
  if (!box) throw new Error('target tab has no box')
  const clientX = Math.round(box.x + 2)
  const clientY = Math.round(box.y + box.height / 2)
  await source.dispatchEvent('dragstart', { dataTransfer: dt })
  await target.dispatchEvent('dragover', { dataTransfer: dt, clientX, clientY })
  await target.dispatchEvent('drop', { dataTransfer: dt, clientX, clientY })
  await source.dispatchEvent('dragend', { dataTransfer: dt })
}

// ─── Main suite: one window, alpha project ────────────────────────────────────
test.describe('tab context menu, close variants, rename, icons', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await seedFakeAgent(fixture, { script: FAKE_AGENT_ECHO_EXIT })
    // Extra real files for the rename/collision cases.
    await fs.writeFile(join(fixture.workspaceRoot, 'Projects/alpha/rename-me.txt'), 'rename me\n')
    await fs.writeFile(join(fixture.workspaceRoot, 'Projects/alpha/other.txt'), 'other\n')
    await fs.writeFile(join(fixture.workspaceRoot, 'Projects/alpha/dblclick-me.txt'), 'dbl\n')
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

  test('context menu items are scoped by tab kind', async () => {
    await resetTabs(page, alpha)
    const docId = await openDoc(page, 'Projects/alpha/README.md', alpha)

    await page.getByTestId(`tab-${docId}`).click({ button: 'right' })
    await expect(page.getByTestId('tab-context-menu')).toBeVisible()
    for (const id of [
      'menu-tab-close',
      'menu-tab-close-others',
      'menu-tab-close-right',
      'menu-tab-copy-path',
      'menu-tab-copy-full-path',
      'menu-tab-rename-doc'
    ]) {
      await expect(page.getByTestId(id)).toBeVisible()
    }
    // Doc tabs get "Rename document" + (T-046) color, but not the terminal "Rename tab".
    await expect(page.getByTestId('menu-tab-rename')).toHaveCount(0)
    await expect(page.getByTestId('menu-tab-color')).toBeVisible()

    await shot(page, 'tab-menu-doc.png')

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('tab-context-menu')).toHaveCount(0)

    const termId = await newTerminalTab(page, alpha)
    await page.getByTestId(`tab-${termId}`).click({ button: 'right' })
    await expect(page.getByTestId('tab-context-menu')).toBeVisible()
    await expect(page.getByTestId('menu-tab-rename')).toBeVisible()
    await expect(page.getByTestId('menu-tab-color')).toBeVisible()
    await expect(page.getByTestId('menu-tab-copy-path')).toHaveCount(0)
    await expect(page.getByTestId('menu-tab-rename-doc')).toHaveCount(0)
    // Dismiss by clicking the scrim at a CORNER (its center now sits under the taller per-tab
    // menu once T-150 added the "Show tab details" section — the default center-click would land
    // on a menu item and never reach the scrim).
    await page.getByTestId('tab-menu-scrim').click({ position: { x: 5, y: 5 } })
    await expect(page.getByTestId('tab-context-menu')).toHaveCount(0)
  })

  test('close, close others, and close to the right', async () => {
    await resetTabs(page, alpha)
    const t1 = await newTerminalTab(page, alpha)
    const t2 = await newTerminalTab(page, alpha)
    const t3 = await newTerminalTab(page, alpha)

    // Close to the right of t1 → t2, t3 gone; t1 stays.
    await page.getByTestId(`tab-${t1}`).click({ button: 'right' })
    await page.getByTestId('menu-tab-close-right').click()
    await expect(page.getByTestId(`tab-${t2}`)).toHaveCount(0)
    await expect(page.getByTestId(`tab-${t3}`)).toHaveCount(0)
    await expect(page.getByTestId(`tab-${t1}`)).toBeVisible()

    // Rebuild → close others of the middle one → only it survives, and it's active.
    const u2 = await newTerminalTab(page, alpha)
    const u3 = await newTerminalTab(page, alpha)
    await page.getByTestId(`tab-${u2}`).click({ button: 'right' })
    await page.getByTestId('menu-tab-close-others').click()
    await expect(page.getByTestId(`tab-${t1}`)).toHaveCount(0)
    await expect(page.getByTestId(`tab-${u3}`)).toHaveCount(0)
    await expect(page.getByTestId(`tab-${u2}`)).toBeVisible()
    expect(await activeId(page, alpha)).toBe(u2)

    // Plain Close.
    await page.getByTestId(`tab-${u2}`).click({ button: 'right' })
    await page.getByTestId('menu-tab-close').click()
    await expect(page.getByTestId(`tab-${u2}`)).toHaveCount(0)
  })

  test('close others: clean tabs close silently, a dirty doc prompts (focused); Cancel keeps it and ABORTS the rest', async () => {
    await resetTabs(page, alpha)
    // Order: [a(idle term), docId(dirty), c(idle term), keeper]. Close others of keeper →
    // targets [a, docId, c]: a closes silently, docId prompts, Cancel must abort so c survives.
    const a = await newTerminalTab(page, alpha)
    const docId = await openDoc(page, 'Projects/alpha/notes.txt', alpha)
    const cm = page.locator('[data-testid="raw-editor"]:visible .cm-content')
    await cm.click()
    await page.keyboard.type('DIRTY EDIT')
    await expect(page.locator('[data-testid="editor-dirty"]:visible')).toBeVisible()
    const c = await newTerminalTab(page, alpha)
    const keeper = await newTerminalTab(page, alpha)

    await page.getByTestId(`tab-${keeper}`).click({ button: 'right' })
    await page.getByTestId('menu-tab-close-others').click()
    // The dirty doc prompts, and it is the FOCUSED/active tab while its dialog shows.
    await expect(page.locator('[data-testid="close-guard"]:visible')).toBeVisible()
    expect(await activeId(page, alpha)).toBe(docId)
    // The clean terminal ahead of it in the batch already closed silently.
    await expect(page.getByTestId(`tab-${a}`)).toHaveCount(0)
    // Cancel → keeps the doc AND aborts the remainder: c must survive.
    await page.locator('[data-testid="guard-cancel"]:visible').click()
    await expect(page.getByTestId(`tab-${docId}`)).toBeVisible()
    expect((await tabsOf(page, alpha)).find((t) => t.id === docId)?.dirty).toBe(true)
    await expect(page.getByTestId(`tab-${c}`)).toBeVisible()

    // Retry → Discard closes the dirty doc; the batch then closes the (idle) terminal c too.
    await page.getByTestId(`tab-${keeper}`).click({ button: 'right' })
    await page.getByTestId('menu-tab-close-others').click()
    await expect(page.locator('[data-testid="close-guard"]:visible')).toBeVisible()
    await page.locator('[data-testid="guard-discard"]:visible').click()
    await expect(page.getByTestId(`tab-${docId}`)).toHaveCount(0)
    await expect(page.getByTestId(`tab-${c}`)).toHaveCount(0)
    await expect(page.getByTestId(`tab-${keeper}`)).toBeVisible()
  })

  test('rename document renames the file on disk, updates the tab, and refreshes the tree', async () => {
    const root = fixture.workspaceRoot
    await resetTabs(page, alpha)
    const docId = await openDoc(page, 'Projects/alpha/rename-me.txt', alpha)

    await page.getByTestId(`tab-${docId}`).click({ button: 'right' })
    await page.getByTestId('menu-tab-rename-doc').click()
    const input = page.getByTestId(`tab-rename-input-${docId}`)
    await expect(input).toBeVisible()
    await input.fill('renamed.txt')
    await input.press('Enter')

    // Disk: new name exists, old is gone.
    await expect
      .poll(() =>
        fs
          .access(join(root, 'Projects/alpha/renamed.txt'))
          .then(() => true)
          .catch(() => false)
      )
      .toBe(true)
    await expect
      .poll(() =>
        fs
          .access(join(root, 'Projects/alpha/rename-me.txt'))
          .then(() => true)
          .catch(() => false)
      )
      .toBe(false)
    // A successful Enter must NOT leave a spurious error toast (the input's onBlur fires as it
    // unmounts; the rename must be single-shot, not re-run against the now-old path) — held
    // for the unmount/blur window.
    await expectQuiet(async () => {
      await expect(page.getByText(/already exists|ENOENT|no such file/i)).toHaveCount(0)
    }, 400)
    // Tab metadata updated.
    expect((await tabsOf(page, alpha)).find((t) => t.id === docId)?.title).toBe('renamed.txt')
    // Tree refreshed via the existing fs watcher.
    await expect(page.getByTestId('tree-node-Projects/alpha/renamed.txt')).toBeVisible({
      timeout: 10_000
    })
    await expect(page.getByTestId('tree-node-Projects/alpha/rename-me.txt')).toHaveCount(0)

    // T-045 collision feedback: renaming onto an existing sibling shows an error, does NOT
    // clobber it, and RETURNS to the rename input holding the attempted name for correction.
    await page.getByTestId(`tab-${docId}`).click({ button: 'right' })
    await page.getByTestId('menu-tab-rename-doc').click()
    const input2 = page.getByTestId(`tab-rename-input-${docId}`)
    await input2.fill('other.txt')
    await input2.press('Enter')
    // Error surfaced.
    await expect(page.getByText(/already exists/i)).toBeVisible()
    // Input returns holding the attempted name.
    const input3 = page.getByTestId(`tab-rename-input-${docId}`)
    await expect(input3).toBeVisible()
    await expect(input3).toHaveValue('other.txt')
    // The sibling on disk is untouched; the tab keeps its current name.
    expect(await fs.readFile(join(root, 'Projects/alpha/other.txt'), 'utf8')).toBe('other\n')
    expect((await tabsOf(page, alpha)).find((t) => t.id === docId)?.title).toBe('renamed.txt')
    // Esc ends the flow, restoring the original (nothing changed on disk).
    await input3.press('Escape')
    await expect(page.getByTestId(`tab-rename-input-${docId}`)).toHaveCount(0)
    expect((await tabsOf(page, alpha)).find((t) => t.id === docId)?.title).toBe('renamed.txt')

    // Correcting to a free name then succeeds (loop ends on a valid commit).
    await page.getByTestId(`tab-${docId}`).click({ button: 'right' })
    await page.getByTestId('menu-tab-rename-doc').click()
    const input4 = page.getByTestId(`tab-rename-input-${docId}`)
    await input4.fill('free-name.txt')
    await input4.press('Enter')
    await expect
      .poll(() => (tabsOf(page, alpha)).then((t) => t.find((x) => x.id === docId)?.title))
      .toBe('free-name.txt')
    await expect
      .poll(() =>
        fs
          .access(join(root, 'Projects/alpha/free-name.txt'))
          .then(() => true)
          .catch(() => false)
      )
      .toBe(true)
  })

  test('every tab kind shows an icon (doc by type, plain terminal, agent)', async () => {
    await resetTabs(page, alpha)
    const mdId = await openDoc(page, 'Projects/alpha/README.md', alpha)
    const txtId = await openDoc(page, 'Projects/alpha/notes.txt', alpha)
    const termId = await newTerminalTab(page, alpha)
    const agentId = await newAgentTab(page, alpha)

    for (const id of [mdId, txtId, termId, agentId]) {
      await expect(page.locator(`[data-testid="tab-${id}"] svg`)).toHaveCount(1)
    }

    // Also color a terminal so the screenshot shows a tint.
    await page.getByTestId(`tab-${termId}`).click({ button: 'right' })
    await page.getByTestId('menu-tab-color').click()
    await page.getByTestId('menu-tab-color-blue').click()
    await expect(page.getByTestId(`tab-${termId}`)).toHaveAttribute('data-color', 'blue')

    await shot(page, 'tab-icons-colors.png')
  })

  test('T-047: double-clicking a doc tab starts the rename-document flow', async () => {
    const root = fixture.workspaceRoot
    await resetTabs(page, alpha)
    const docId = await openDoc(page, 'Projects/alpha/dblclick-me.txt', alpha)

    await page.getByTestId(`tab-${docId}`).dblclick()
    const input = page.getByTestId(`tab-rename-input-${docId}`)
    await expect(input).toBeVisible()
    await input.fill('dbl-renamed.txt')
    await input.press('Enter')

    await expect
      .poll(() => tabsOf(page, alpha).then((t) => t.find((x) => x.id === docId)?.title))
      .toBe('dbl-renamed.txt')
    await expect
      .poll(() =>
        fs
          .access(join(root, 'Projects/alpha/dbl-renamed.txt'))
          .then(() => true)
          .catch(() => false)
      )
      .toBe(true)
    await expect(page.getByTestId('tree-node-Projects/alpha/dbl-renamed.txt')).toBeVisible({
      timeout: 10_000
    })
  })

  test('T-046: doc tabs can be colored via the context menu', async () => {
    await resetTabs(page, alpha)
    const docId = await openDoc(page, 'Projects/alpha/README.md', alpha)

    await page.getByTestId(`tab-${docId}`).click({ button: 'right' })
    await expect(page.getByTestId('menu-tab-color')).toBeVisible()
    await page.getByTestId('menu-tab-color').click()
    await page.getByTestId('menu-tab-color-purple').click()
    await expect(page.getByTestId(`tab-${docId}`)).toHaveAttribute('data-color', 'purple')
    expect((await tabsOf(page, alpha)).find((t) => t.id === docId)?.color).toBe('purple')
  })

  test('T-044: an idle terminal closes silently; a busy terminal prompts', async () => {
    await resetTabs(page, alpha)

    // Idle terminal → the × closes it with no confirmation.
    const idle = await newTerminalTab(page, alpha)
    await page.getByTestId(`close-${idle}`).click()
    await expect(page.getByTestId(`tab-${idle}`)).toHaveCount(0)
    await expect(page.getByTestId('terminal-close-guard')).toHaveCount(0)

    // Busy terminal → the × prompts; Cancel keeps it, Close ends it.
    const busy = await newTerminalTab(page, alpha)
    const termId = (await termIdOf(page, alpha, busy)) as string
    await writePty(page, termId, 'sleep 30\r')
    await expect.poll(() => ptyBusy(page, termId), { timeout: 10_000 }).toBe(true)

    await page.getByTestId(`close-${busy}`).click()
    await expect(page.getByTestId('terminal-close-guard')).toBeVisible()
    await page.getByTestId('terminal-close-cancel').click()
    await expect(page.getByTestId(`tab-${busy}`)).toBeVisible()

    await page.getByTestId(`close-${busy}`).click()
    await expect(page.getByTestId('terminal-close-guard')).toBeVisible()
    await page.getByTestId('terminal-close-confirm').click()
    await expect(page.getByTestId(`tab-${busy}`)).toHaveCount(0)
    // The pty is reaped (its process killed) once no tab references it.
    await expect.poll(() => ptyAlive(page, termId), { timeout: 10_000 }).toBe(false)
  })

  test('T-044: a live agent tab always prompts before closing', async () => {
    await resetTabs(page, alpha)
    const agentId = await newAgentTab(page, alpha)
    const termId = (await termIdOf(page, alpha, agentId)) as string
    await expect.poll(() => readAgentReady(page, termId), { timeout: 10_000 }).toBe(true)

    await page.getByTestId(`close-${agentId}`).click()
    await expect(page.getByTestId('terminal-close-guard')).toBeVisible()
    await page.getByTestId('terminal-close-cancel').click()
    await expect(page.getByTestId(`tab-${agentId}`)).toBeVisible()

    await page.getByTestId(`close-${agentId}`).click()
    await expect(page.getByTestId('terminal-close-guard')).toBeVisible()
    await page.getByTestId('terminal-close-confirm').click()
    await expect(page.getByTestId(`tab-${agentId}`)).toHaveCount(0)
  })

  test('T-044: bulk close over [clean doc, dirty doc, live agent] — clean silent, dirty Save-and-close writes the file, agent prompts', async () => {
    const root = fixture.workspaceRoot
    await resetTabs(page, alpha)

    // Order: [cleanDoc, dirtyDoc, agent, keeper]. Close others of keeper → targets are the
    // first three, processed left-to-right.
    const cleanDoc = await openDoc(page, 'Projects/alpha/README.md', alpha)
    const dirtyDoc = await openDoc(page, 'Projects/alpha/notes.txt', alpha)
    const cm = page.locator('[data-testid="raw-editor"]:visible .cm-content')
    await cm.click()
    await page.keyboard.type('BULK SAVE EDIT ')
    await expect(page.locator('[data-testid="editor-dirty"]:visible')).toBeVisible()
    const agentId = await newAgentTab(page, alpha)
    const agentTermId = (await termIdOf(page, alpha, agentId)) as string
    await expect.poll(() => readAgentReady(page, agentTermId), { timeout: 10_000 }).toBe(true)
    const keeper = await newTerminalTab(page, alpha)

    await page.getByTestId(`tab-${keeper}`).click({ button: 'right' })
    await page.getByTestId('menu-tab-close-others').click()

    // Clean doc closed silently; the dirty doc's 3-way prompt is up and focused.
    await expect(page.getByTestId(`tab-${cleanDoc}`)).toHaveCount(0)
    await expect(page.locator('[data-testid="close-guard"]:visible')).toBeVisible()
    expect(await activeId(page, alpha)).toBe(dirtyDoc)
    // Save and close writes the file, then the batch advances.
    await page.locator('[data-testid="guard-save"]:visible').click()
    await expect(page.getByTestId(`tab-${dirtyDoc}`)).toHaveCount(0)
    await expect
      .poll(() => fs.readFile(join(root, 'Projects/alpha/notes.txt'), 'utf8').catch(() => ''))
      .toContain('BULK SAVE EDIT')

    // The live agent then prompts (its own confirmation); Close ends it.
    await expect(page.getByTestId('terminal-close-guard')).toBeVisible()
    await page.getByTestId('terminal-close-confirm').click()
    await expect(page.getByTestId(`tab-${agentId}`)).toHaveCount(0)
    await expect(page.getByTestId(`tab-${keeper}`)).toBeVisible()
  })
})

// ─── Restart suite: a renamed + colored terminal survives an app restart ───────
test.describe('renamed & colored tabs survive restart', () => {
  let fixture: Fixture

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await seedFakeAgent(fixture, { script: FAKE_AGENT_ECHO_EXIT })
  })

  test.afterAll(async () => {
    await fixture?.cleanup()
  })

  test('a renamed, colored terminal tab comes back named and tinted', async () => {
    const { alpha } = fixture.projects

    // Session 1: open a terminal, rename it + color it via the context menu, let it persist.
    const app1 = await launchApp(fixture)
    const page1 = await app1.firstWindow()
    await page1.waitForLoadState('domcontentloaded')
    await page1.getByTestId(`project-${alpha}`).click()
    const termId = await newTerminalTab(page1, alpha)

    await page1.getByTestId(`tab-${termId}`).click({ button: 'right' })
    await page1.getByTestId('menu-tab-rename').click()
    const input = page1.getByTestId(`tab-rename-input-${termId}`)
    await input.fill('my workhorse')
    await input.press('Enter')

    await page1.getByTestId(`tab-${termId}`).click({ button: 'right' })
    await page1.getByTestId('menu-tab-color').click()
    await page1.getByTestId('menu-tab-color-green').click()
    await expect(page1.getByTestId(`tab-${termId}`)).toHaveAttribute('data-color', 'green')

    // The (tuned) debounced state write must land before quitting — poll the file itself.
    await expect.poll(() => persistedState(fixture, alpha), { timeout: 15_000 }).toContain('my workhorse')
    await expect.poll(() => persistedState(fixture, alpha), { timeout: 15_000 }).toContain('green')
    await app1.close()

    // Session 2: the tab restores (dead) but keeps its name and color.
    const app2 = await launchApp(fixture)
    const page2 = await app2.firstWindow()
    await page2.waitForLoadState('domcontentloaded')
    await page2.getByTestId(`project-${alpha}`).click()

    await expect
      .poll(() => tabsOf(page2, alpha).then((t) => t.some((x) => x.title === 'my workhorse')))
      .toBe(true)
    const restored = (await tabsOf(page2, alpha)).find((x) => x.title === 'my workhorse')
    expect(restored?.color).toBe('green')
    await expect(page2.getByTestId(`tab-${restored?.id}`)).toHaveAttribute('data-color', 'green')

    await app2.close()
  })

  test('T-046: a colored DOC tab survives restart', async () => {
    const { alpha } = fixture.projects

    const app1 = await launchApp(fixture)
    const page1 = await app1.firstWindow()
    await page1.waitForLoadState('domcontentloaded')
    await page1.getByTestId(`project-${alpha}`).click()
    const docId = await openDoc(page1, 'Projects/alpha/README.md', alpha)
    await page1.getByTestId(`tab-${docId}`).click({ button: 'right' })
    await page1.getByTestId('menu-tab-color').click()
    await page1.getByTestId('menu-tab-color-teal').click()
    await expect(page1.getByTestId(`tab-${docId}`)).toHaveAttribute('data-color', 'teal')
    // The (tuned) debounced state write must land before quitting — poll the file itself.
    await expect.poll(() => persistedState(fixture, alpha), { timeout: 15_000 }).toContain('teal')
    await app1.close()

    const app2 = await launchApp(fixture)
    const page2 = await app2.firstWindow()
    await page2.waitForLoadState('domcontentloaded')
    await page2.getByTestId(`project-${alpha}`).click()
    await expect
      .poll(() =>
        tabsOf(page2, alpha).then((t) => t.find((x) => x.path === 'Projects/alpha/README.md')?.color)
      )
      .toBe('teal')
    await app2.close()
  })
})

// ─── T-048: drag-and-drop reorder persists and keeps live PTYs ────────────────
test.describe('drag-and-drop tab reorder', () => {
  let fixture: Fixture

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await seedFakeAgent(fixture, { script: FAKE_AGENT_ECHO_EXIT })
  })

  test.afterAll(async () => {
    await fixture?.cleanup()
  })

  test('dragging a tab from position 3 to 1 reorders, keeps its live PTY, and persists', async () => {
    const { alpha } = fixture.projects

    const app1 = await launchApp(fixture)
    const page1 = await app1.firstWindow()
    await page1.waitForLoadState('domcontentloaded')
    await page1.getByTestId(`project-${alpha}`).click()

    // Three terminals in creation order → titles zsh 1 / zsh 2 / zsh 3.
    const t1 = await newTerminalTab(page1, alpha)
    const t2 = await newTerminalTab(page1, alpha)
    const t3 = await newTerminalTab(page1, alpha)
    expect((await tabsOf(page1, alpha)).map((t) => t.id)).toEqual([t1, t2, t3])
    const t3TermId = (await termIdOf(page1, alpha, t3)) as string
    expect(await ptyAlive(page1, t3TermId)).toBe(true)

    // Drag position 3 (t3) before position 1 (t1) → order [t3, t1, t2].
    await dragTabBefore(page1, t3, t1)
    await expect
      .poll(() => tabsOf(page1, alpha).then((t) => t.map((x) => x.id)))
      .toEqual([t3, t1, t2])
    // Its PTY is untouched — same termId, still alive (no relaunch, pane not remounted).
    expect((await termIdOf(page1, alpha, t3)) as string).toBe(t3TermId)
    expect(await ptyAlive(page1, t3TermId)).toBe(true)

    // The (tuned) debounced state write must persist the new ORDER before quitting.
    await expect
      .poll(async () => {
        try {
          const raw = JSON.parse(await persistedState(fixture, alpha)) as {
            openTabs?: { id: string }[]
          }
          return (raw.openTabs ?? []).map((t) => t.id)
        } catch {
          return []
        }
      }, { timeout: 15_000 })
      .toEqual([t3, t1, t2])
    await app1.close()

    // Restart: the reordered order persists (titles carry the identity across restart).
    const app2 = await launchApp(fixture)
    const page2 = await app2.firstWindow()
    await page2.waitForLoadState('domcontentloaded')
    await page2.getByTestId(`project-${alpha}`).click()
    await expect
      .poll(() => tabsOf(page2, alpha).then((t) => t.map((x) => x.title)))
      .toEqual(['zsh 3', 'zsh 1', 'zsh 2'])
    await app2.close()
  })
})

// ─── T-061: Mark unread — the same red dot as the attention counter, on every tab kind, ───────
// cleared on the ACTIVATION EDGE (marking the active tab keeps the dot until you leave AND return).
test.describe('T-061 Mark unread (red dot, edge-clear, all kinds)', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await seedFakeAgent(fixture, { script: FAKE_AGENT_ECHO_EXIT })
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

  test('the item shows for every tab kind (terminal, agent, doc)', async () => {
    await resetTabs(page, alpha)
    const term = await newTerminalTab(page, alpha)
    await page.getByTestId(`tab-${term}`).click({ button: 'right' })
    await expect(page.getByTestId('menu-tab-mark-unread')).toBeVisible()
    // Dismiss by clicking the scrim at a CORNER (its center now sits under the taller per-tab
    // menu once T-150 added the "Show tab details" section — the default center-click would land
    // on a menu item and never reach the scrim).
    await page.getByTestId('tab-menu-scrim').click({ position: { x: 5, y: 5 } })

    const doc = await openDoc(page, 'Projects/alpha/README.md', alpha)
    await page.getByTestId(`tab-${doc}`).click({ button: 'right' })
    await expect(page.getByTestId('menu-tab-mark-unread')).toBeVisible()
    // Dismiss by clicking the scrim at a CORNER (its center now sits under the taller per-tab
    // menu once T-150 added the "Show tab details" section — the default center-click would land
    // on a menu item and never reach the scrim).
    await page.getByTestId('tab-menu-scrim').click({ position: { x: 5, y: 5 } })
  })

  test('marking an INACTIVE tab sets the dot without activating it; activation clears it', async () => {
    await resetTabs(page, alpha)
    const t1 = await newTerminalTab(page, alpha)
    const t2 = await newTerminalTab(page, alpha) // t2 is active; t1 is inactive
    expect(await activeId(page, alpha)).toBe(t2)

    // Right-click the inactive t1 and mark it unread — it must NOT become active.
    await page.getByTestId(`tab-${t1}`).click({ button: 'right' })
    await page.getByTestId('menu-tab-mark-unread').click()
    await expect(page.getByTestId(`tab-attention-${t1}`)).toBeVisible()
    expect(await activeId(page, alpha)).toBe(t2)

    // Activating t1 clears its dot (the activation edge).
    await page.getByTestId(`tab-${t1}`).click()
    await expect(page.getByTestId(`tab-attention-${t1}`)).toHaveCount(0)
  })

  test('marking the ACTIVE tab: the dot stays, survives switching away, clears only on return', async () => {
    await resetTabs(page, alpha)
    const a = await newTerminalTab(page, alpha)
    const b = await newTerminalTab(page, alpha) // b active

    await page.getByTestId(`tab-${b}`).click({ button: 'right' })
    await page.getByTestId('menu-tab-mark-unread').click()
    // Dot shows and STAYS while b is the active tab (no instant wipe).
    await expect(page.getByTestId(`tab-attention-${b}`)).toBeVisible()
    expect(await activeId(page, alpha)).toBe(b)
    // …and STAYS through the window an instant wipe would fire in (real-world renderer tick).
    await expectQuiet(async () => {
      await expect(page.getByTestId(`tab-attention-${b}`)).toBeVisible()
    }, 300)

    // Switching AWAY keeps the dot.
    await page.getByTestId(`tab-${a}`).click()
    await expect(page.getByTestId(`tab-attention-${b}`)).toBeVisible()

    // Returning to b clears it (comes BACK = activation edge).
    await page.getByTestId(`tab-${b}`).click()
    await expect(page.getByTestId(`tab-attention-${b}`)).toHaveCount(0)
  })

  test('doc tab: the red dot replaces the blue dirty dot; blue returns when red clears (dirty untouched)', async () => {
    await resetTabs(page, alpha)
    const other = await newTerminalTab(page, alpha)
    const docId = await openDoc(page, 'Projects/alpha/notes.txt', alpha) // raw editor, active

    // Dirty the doc so the blue tab dot shows (also commits it out of preview mode).
    await page.locator('[data-testid="editor-pane"] .cm-content').click()
    await page.keyboard.type('DIRTY')
    const blueDot = page.locator(`[data-testid="tab-${docId}"] [aria-label="unsaved"]`)
    const redDot = page.getByTestId(`tab-attention-${docId}`)
    await expect(blueDot).toBeVisible()
    await expect(redDot).toHaveCount(0)

    // Mark unread → red REPLACES blue.
    await page.getByTestId(`tab-${docId}`).click({ button: 'right' })
    await page.getByTestId('menu-tab-mark-unread').click()
    await expect(redDot).toBeVisible()
    await expect(blueDot).toHaveCount(0)

    // Leave and return → red clears, blue is back; the doc is STILL dirty.
    await page.getByTestId(`tab-${other}`).click()
    await expect(redDot).toBeVisible() // persists while away
    await page.getByTestId(`tab-${docId}`).click()
    await expect(redDot).toHaveCount(0)
    await expect(blueDot).toBeVisible()
    expect((await tabsOf(page, alpha)).find((t) => t.id === docId)?.dirty).toBe(true)
  })

  // T-151 — the Projects panel attention badge is the LIVE DERIVED count of unread tabs, with NO
  // active-project gating: marking tabs unread in the OPEN project raises alpha's badge
  // immediately (the Owner's motivating scenario), and activating each unread tab decrements it.
  test('the Projects panel badge reflects the unread count in the ACTIVE project and decrements on read', async () => {
    await resetTabs(page, alpha)
    const badge = page.getByTestId(`project-attention-${alpha}`)
    await expect(badge).toHaveCount(0) // no unread tabs yet

    const t1 = await newTerminalTab(page, alpha)
    const doc = await openDoc(page, 'Projects/alpha/README.md', alpha) // doc is active

    // Mark the inactive terminal unread → the OPEN project's badge appears with 1 at once.
    await page.getByTestId(`tab-${t1}`).click({ button: 'right' })
    await page.getByTestId('menu-tab-mark-unread').click()
    await expect(badge).toBeVisible()
    await expect(badge).toHaveText('1')

    // Mark the active doc unread too (its dot stays) → badge shows 2.
    await page.getByTestId(`tab-${doc}`).click({ button: 'right' })
    await page.getByTestId('menu-tab-mark-unread').click()
    await expect(badge).toHaveText('2')

    // Reading t1 (activation edge) clears its dot → badge decrements to 1.
    await page.getByTestId(`tab-${t1}`).click()
    await expect(badge).toHaveText('1')

    // Returning to the doc (activation edge) clears its dot → badge hides at 0.
    await page.getByTestId(`tab-${doc}`).click()
    await expect(page.getByTestId(`project-attention-${alpha}`)).toHaveCount(0)
  })
})

// ─── T-062: the tab strip auto-scrolls the newly opened / newly activated tab into view. ──────
test.describe('T-062 tab-strip autoscroll', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha: string

  // Create a terminal straight through the store (fast; no "+" menu round-trip) and return its id.
  const newTermViaStore = (pid: string): Promise<string> =>
    page.evaluate(async (p) => {
      const stores = window.__pomadeStores
      const project = stores.useWorkspaceStore.getState().projectById(p)
      const before = new Set(
        (stores.useTabsStore.getState().tabsByProject[p] ?? []).map((t) => t.id)
      )
      await stores.useTerminalsStore.getState().newTerminal(project)
      const tabs = stores.useTabsStore.getState().tabsByProject[p] ?? []
      return tabs.find((t) => !before.has(t.id))?.id as string
    }, pid)

  const stripOverflows = (): Promise<boolean> =>
    page.evaluate(() => {
      const s = document.querySelector('[data-testid="tabstrip-scroll"]') as HTMLElement | null
      return !!s && s.scrollWidth > s.clientWidth + 8
    })

  /** Open terminal tabs (at least six, at most 24) until the strip overflows horizontally. */
  const fillStripUntilOverflow = async (pid: string): Promise<string[]> => {
    const ids: string[] = []
    for (let i = 0; i < 24; i++) {
      ids.push(await newTermViaStore(pid))
      if (i >= 5 && (await stripOverflows())) break
    }
    return ids
  }

  const scrollLeftOf = (): Promise<number> =>
    page.evaluate(
      () => (document.querySelector('[data-testid="tabstrip-scroll"]') as HTMLElement).scrollLeft
    )

  // Whether a tab's box sits within the scroller's visible window (a horizontal-overflow-aware
  // "in view" — Playwright's isVisible ignores overflow clipping).
  const tabInView = (tabId: string): Promise<boolean> =>
    page.evaluate((id) => {
      const el = document.querySelector(`[data-testid="tab-${id}"]`)
      const s = document.querySelector('[data-testid="tabstrip-scroll"]')
      if (!el || !s) return false
      const r = el.getBoundingClientRect()
      const c = s.getBoundingClientRect()
      return r.left >= c.left - 1 && r.right <= c.right + 1
    }, tabId)

  const setActiveViaStore = (pid: string, tabId: string): Promise<void> =>
    page.evaluate(
      ({ p, t }) => window.__pomadeStores.useTabsStore.getState().setActive(p, t),
      { p: pid, t: tabId }
    )

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await seedFakeAgent(fixture, { script: FAKE_AGENT_ECHO_EXIT })
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

  test('a fresh tab scrolls into view; activating an off-screen tab does too; no jump when visible', async () => {
    await resetTabs(page, alpha)

    const ids = await fillStripUntilOverflow(alpha)
    expect(await stripOverflows()).toBe(true)

    // The most-recently opened tab is active and was scrolled into view (born off-screen otherwise).
    const last = ids[ids.length - 1]
    expect(await activeId(page, alpha)).toBe(last)
    await expect.poll(() => tabInView(last)).toBe(true)

    // The first tab is now off-screen.
    const first = ids[0]
    expect(await tabInView(first)).toBe(false)

    // Activating it via the store (hotkey-style; Playwright's click would auto-scroll and mask
    // the feature) scrolls the strip to bring it into view.
    await setActiveViaStore(alpha, first)
    await expect.poll(() => tabInView(first)).toBe(true)

    // No jump when the active tab is already visible: re-activating `first` leaves scroll put.
    const before = await scrollLeftOf()
    await setActiveViaStore(alpha, first)
    // A wrong jump would scroll within a frame or two — the position holds throughout.
    await expectQuiet(async () => {
      expect(await scrollLeftOf()).toBe(before)
    }, 250)
  })
})

// ─── T-087: the empty strip area right of the last tab is a live "move to END" drop target ────
// The T-073 principle applied to the tab strip: every area that visually reads as a drop position
// must accept the drop. The gesture below is dispatched at REAL coordinates inside that empty area
// and delivered to whatever element actually sits under the pointer (document.elementFromPoint) —
// so the spec proves reachability by GEOMETRY, not by knowing which element implements the zone.
// Pre-fix that point resolves to the strip itself (no drop handler), the drop is declined and the
// order is unchanged.
test.describe('T-087 drop on the empty strip area moves the tab to the end', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await seedFakeAgent(fixture, { script: FAKE_AGENT_ECHO_EXIT })
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

  // A point in the middle of the visually-empty strip area: between the last tab's right edge and
  // the first control of the actions cluster. Fails loudly if that area isn't actually empty.
  async function emptyStripPoint(lastTabId: string): Promise<{ x: number; y: number }> {
    const lastBox = await page.getByTestId(`tab-${lastTabId}`).boundingBox()
    const actionsBox = await page.getByTestId('session-history-open').boundingBox()
    if (!lastBox || !actionsBox) throw new Error('tab strip geometry unavailable')
    const gap = actionsBox.x - (lastBox.x + lastBox.width)
    expect(gap).toBeGreaterThan(40)
    return {
      x: Math.round(lastBox.x + lastBox.width + gap / 2),
      y: Math.round(lastBox.y + lastBox.height / 2)
    }
  }

  async function elementAt(pt: { x: number; y: number }): Promise<ElementHandle<Node>> {
    const handle = await page.evaluateHandle(({ x, y }) => document.elementFromPoint(x, y), pt)
    const el = handle.asElement()
    if (!el) throw new Error('no element under the empty strip point')
    return el
  }

  test('dragging a tab onto the free area right of the last tab lands it LAST', async () => {
    await resetTabs(page, alpha)

    // Three terminals via the "+" launcher — which also proves the new drop zone does not swallow
    // clicks on the actions cluster it sits next to.
    const t1 = await newTerminalTab(page, alpha)
    const t2 = await newTerminalTab(page, alpha)
    const t3 = await newTerminalTab(page, alpha)
    expect((await tabsOf(page, alpha)).map((t) => t.id)).toEqual([t1, t2, t3])
    expect(await activeId(page, alpha)).toBe(t3)

    const pt = await emptyStripPoint(t3)
    const dt = await page.evaluateHandle(() => new DataTransfer())
    const source = page.getByTestId(`tab-${t1}`)
    await source.dispatchEvent('dragstart', { dataTransfer: dt })

    // Hovering the empty area shows the END insertion indicator (and no between-tab indicator).
    const target = await elementAt(pt)
    await target.dispatchEvent('dragover', { dataTransfer: dt, clientX: pt.x, clientY: pt.y })
    await expect(page.getByTestId('tabstrip-end-zone')).toHaveAttribute('data-drop-end', 'true')
    for (const id of [t1, t2, t3]) {
      await expect(page.getByTestId(`tab-${id}`)).not.toHaveAttribute('data-drop', /before|after/)
    }

    // Releasing there reorders the dragged tab to the END — the drop is NOT declined.
    await target.dispatchEvent('drop', { dataTransfer: dt, clientX: pt.x, clientY: pt.y })
    await source.dispatchEvent('dragend', { dataTransfer: dt })
    await expect
      .poll(() => tabsOf(page, alpha).then((t) => t.map((x) => x.id)))
      .toEqual([t2, t3, t1])
    // The indicator is gone and the drag did not activate anything.
    await expect(page.getByTestId('tabstrip-end-zone')).not.toHaveAttribute('data-drop-end', 'true')
    expect(await activeId(page, alpha)).toBe(t3)

    // Dragging the tab that is ALREADY last onto the same area: no indicator, no reorder.
    const pt2 = await emptyStripPoint(t1)
    const dt2 = await page.evaluateHandle(() => new DataTransfer())
    const lastSource = page.getByTestId(`tab-${t1}`)
    await lastSource.dispatchEvent('dragstart', { dataTransfer: dt2 })
    const target2 = await elementAt(pt2)
    await target2.dispatchEvent('dragover', { dataTransfer: dt2, clientX: pt2.x, clientY: pt2.y })
    await expect(page.getByTestId('tabstrip-end-zone')).not.toHaveAttribute('data-drop-end', 'true')
    await target2.dispatchEvent('drop', { dataTransfer: dt2, clientX: pt2.x, clientY: pt2.y })
    await lastSource.dispatchEvent('dragend', { dataTransfer: dt2 })
    await expect
      .poll(() => tabsOf(page, alpha).then((t) => t.map((x) => x.id)))
      .toEqual([t2, t3, t1])
  })
})

// ─── T-141: app-start reopens the last active project (on its active tab) ──────
// The last-active project id is written on EVERY switch (not only at quit) to the gitignored,
// workspace-scoped workspace-ui.json; on boot the app selects it via the normal select-project
// path (which already restores that project's openTabs + activeTabId). A stale/missing id falls
// back to the default, the Workspace project. Each test uses its own fixture + fresh app instances so
// nothing chains. Project-SWITCHING (per-project active-tab restore) must stay exactly as-is.
test.describe('T-141 — reopen last active project on app start', () => {
  const created: Fixture[] = []
  const mk = async (): Promise<Fixture> => {
    const f = await createFixtureWorkspace()
    created.push(f)
    return f
  }

  test.afterAll(async () => {
    for (const f of created) await f.cleanup()
  })

  const WORKSPACE = '__workspace__'
  const uiPath = (f: Fixture): string => join(f.workspaceRoot, '.pomade', 'state', 'workspace-ui.json')
  const activeProjectOf = (p: Page): Promise<string> =>
    p.evaluate(
      () => window.__pomadeStores.useWorkspaceStore.getState().activeProjectId as string
    )
  const lastActiveOnDisk = async (f: Fixture): Promise<string | null | undefined> => {
    const raw = await fs.readFile(uiPath(f), 'utf8').catch(() => '')
    return raw ? (JSON.parse(raw).lastActiveProjectId as string | null) : undefined
  }

  test('quit → relaunch reopens the last active project on its active tab', async () => {
    const fixture = await mk()
    const { alpha } = fixture.projects

    // Session 1: open alpha, open two docs, leave README as the active tab.
    const app1 = await launchApp(fixture)
    const page1 = await app1.firstWindow()
    await page1.waitForLoadState('domcontentloaded')
    await expect(page1.getByTestId('app-shell')).toBeVisible()
    await page1.getByTestId(`project-${alpha}`).click()
    const readme = await openDoc(page1, 'Projects/alpha/README.md', alpha)
    await openDoc(page1, 'Projects/alpha/notes.txt', alpha)
    await page1.getByTestId(`tab-${readme}`).click()
    await expect.poll(() => activeId(page1, alpha)).toBe(readme)
    // Both (tuned) debounced writes must land before quitting — poll the files themselves.
    await expect.poll(() => persistedState(fixture, alpha), { timeout: 15_000 }).toContain(readme)
    await expect
      .poll(
        () =>
          fs
            .readFile(join(fixture.workspaceRoot, '.pomade', 'state', 'workspace-ui.json'), 'utf8')
            .catch(() => ''),
        { timeout: 15_000 }
      )
      .toContain(alpha)
    await app1.close()

    // Session 2: WITHOUT touching the Projects panel, the app boots straight into alpha on its README tab.
    const app2 = await launchApp(fixture)
    const page2 = await app2.firstWindow()
    await page2.waitForLoadState('domcontentloaded')
    await expect(page2.getByTestId('app-shell')).toBeVisible()
    await expect.poll(() => activeProjectOf(page2)).toBe(alpha)
    await expect(page2.getByTestId(`project-${alpha}`)).toHaveAttribute('data-active', 'true')
    await expect.poll(() => activeId(page2, alpha)).toBe(readme)
    await app2.close()
  })

  test('the last-active project is written on every switch, not only at quit', async () => {
    const fixture = await mk()
    const { alpha, beta } = fixture.projects
    const { app, page } = await launchAppPage(fixture)
    await expect(page.getByTestId('app-shell')).toBeVisible()

    await page.getByTestId(`project-${alpha}`).click()
    await expect.poll(() => lastActiveOnDisk(fixture), { timeout: 5_000 }).toBe(alpha)
    await page.getByTestId(`project-${beta}`).click()
    await expect.poll(() => lastActiveOnDisk(fixture), { timeout: 5_000 }).toBe(beta)
    await page.getByTestId(`project-${alpha}`).click()
    await expect.poll(() => lastActiveOnDisk(fixture), { timeout: 5_000 }).toBe(alpha)
    await app.close()
  })

  test('a stale last-active id falls back to the Workspace project without crashing', async () => {
    const fixture = await mk()
    // Seed a last-active pointing at a project that does not exist in this workspace.
    await fs.mkdir(join(fixture.workspaceRoot, '.pomade', 'state'), { recursive: true })
    await fs.writeFile(
      uiPath(fixture),
      JSON.stringify({ lastActiveProjectId: 'ghost-project', collapsedGroups: [] }, null, 2),
      'utf8'
    )
    const { app, page } = await launchAppPage(fixture)
    // No crash: the shell renders and lands on the Workspace project (the default), not
    // the ghost id, and the Projects panel's real projects are present.
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await expect(page.getByTestId(`project-${fixture.projects.alpha}`)).toBeVisible()
    await expect.poll(() => activeProjectOf(page)).toBe(WORKSPACE)
    await app.close()
  })

  test('project switching still restores each project’s own active tab (regression)', async () => {
    const fixture = await mk()
    const { alpha, beta } = fixture.projects
    const { app, page } = await launchAppPage(fixture)
    await expect(page.getByTestId('app-shell')).toBeVisible()

    // alpha: a doc is the active tab.
    await page.getByTestId(`project-${alpha}`).click()
    const aDoc = await openDoc(page, 'Projects/alpha/README.md', alpha)
    await expect.poll(() => activeId(page, alpha)).toBe(aDoc)

    // beta: a terminal is the active tab.
    await page.getByTestId(`project-${beta}`).click()
    const bTerm = await newTerminalTab(page, beta)
    await expect.poll(() => activeId(page, beta)).toBe(bTerm)

    // Switching back and forth restores each project's OWN active tab (unchanged behavior).
    await page.getByTestId(`project-${alpha}`).click()
    await expect.poll(() => activeId(page, alpha)).toBe(aDoc)
    await page.getByTestId(`project-${beta}`).click()
    await expect.poll(() => activeId(page, beta)).toBe(bTerm)
    await app.close()
  })
})
