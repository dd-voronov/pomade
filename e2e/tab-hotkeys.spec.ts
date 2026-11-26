// modules: tabs, terminal, editor
// Pomade T-036 e2e — tab hotkeys via the application menu.
// Cmd+W closes the ACTIVE tab (dirty-editor guard, PTY reaper); with zero tabs it leaves
// the window alone (window close lives on Cmd+Shift+W). Cmd+T opens a new terminal tab
// inserted immediately right of the active tab, focused.
//
// Playwright's synthesized key events never reach native menu accelerators, so these specs
// trigger the REAL menu items programmatically (Menu.getMenuItemById(...).click() inside
// the main process) — that drives the full menu-item → IPC event → renderer path; only the
// OS keystroke→menu dispatch itself can't be automated (noted in docs/contracts/test-hooks.md "Menu accelerators").

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

/** Click a real application-menu item from the main process (see header note). */
function clickMenuItem(app: ElectronApplication, id: string): Promise<void> {
  return app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId)
    if (!item) throw new Error(`menu item not found: ${itemId}`)
    item.click()
  }, id)
}

interface TabsSnapshot {
  ids: string[]
  kinds: string[]
  active: string | undefined
}

function tabsSnapshot(page: Page, projectId: string): Promise<TabsSnapshot> {
  return page.evaluate((pid) => {
    const s = window.__pomadeStores.useTabsStore.getState()
    const tabs = s.tabsByProject[pid] ?? []
    return {
      ids: tabs.map((t) => t.id),
      kinds: tabs.map((t) => t.kind),
      active: s.activeTabByProject[pid]
    }
  }, projectId)
}

async function seedAlphaDoc(root: string): Promise<void> {
  const state = {
    openTabs: [
      {
        id: 'doc-md',
        projectId: 'proj-alpha',
        kind: 'doc',
        title: 'README.md',
        path: 'Projects/alpha/README.md',
        mode: 'rendered',
        dirty: false
      }
    ],
    activeTabId: 'doc-md'
  }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(root, '.pomade/state/proj-alpha.json'), JSON.stringify(state, null, 2))
}

test.describe('tab hotkeys (Cmd+W / Cmd+T via app menu)', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  const vis = (sel: string) => page.locator(`${sel}:visible`)

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await seedAlphaDoc(fixture.workspaceRoot)
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('menu wiring: Cmd+W = Close Tab, Cmd+T = New Terminal Tab, window close on Cmd+Shift+W', async () => {
    const wiring = await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu()
      const item = (id: string) => menu?.getMenuItemById(id)
      return {
        closeTab: item('menu-close-tab')?.accelerator,
        newTerminal: item('menu-new-terminal-tab')?.accelerator,
        closeWindow: item('menu-close-window')?.accelerator,
        closeWindowRole: item('menu-close-window')?.role
      }
    })
    expect(wiring.closeTab).toBe('CmdOrCtrl+W')
    expect(wiring.newTerminal).toBe('CmdOrCtrl+T')
    expect(wiring.closeWindow).toBe('Shift+CmdOrCtrl+W')
    expect(wiring.closeWindowRole).toBe('close')
  })

  test('Cmd+T inserts a new terminal immediately right of the active tab and focuses it', async () => {
    const { beta } = fixture.projects
    await page.getByTestId(`project-${beta}`).click()

    // Two terminals via the "+" menu → [A, B], B active (each lands right of the
    // then-active tab, which here equals appending).
    for (let i = 0; i < 2; i++) {
      await page.getByTestId('tab-add').click()
      await page.getByTestId('tab-add-terminal').click()
    }
    let snap = await tabsSnapshot(page, beta)
    expect(snap.ids).toHaveLength(2)
    const [tabA, tabB] = snap.ids

    // Activate the FIRST tab, then Cmd+T: the new tab must land between A and B.
    await page.getByTestId(`tab-${tabA}`).click()
    await clickMenuItem(app, 'menu-new-terminal-tab')

    await expect.poll(() => tabsSnapshot(page, beta).then((s) => s.ids.length)).toBe(3)
    snap = await tabsSnapshot(page, beta)
    expect(snap.ids[0]).toBe(tabA)
    expect(snap.ids[2]).toBe(tabB)
    const created = snap.ids[1]
    expect(snap.kinds).toEqual(['terminal', 'terminal', 'terminal'])
    expect(snap.active).toBe(created) // focused
    await expect(page.getByTestId(`tab-${created}`)).toHaveAttribute('data-active', 'true')
    await expect(page.locator('[data-term-id][data-status="live"]:visible')).toHaveCount(1)
  })

  test('Cmd+W closes the active tab and its pty is reaped; works while the terminal has focus', async () => {
    const { beta } = fixture.projects
    // State from the previous test: [A, created, B], created active.
    const before = await tabsSnapshot(page, beta)
    expect(before.ids).toHaveLength(3)
    const active = before.active as string

    // Give the ACTIVE terminal keyboard focus (xterm), like a user mid-session.
    const pane = page.locator('[data-term-id]:visible').first()
    const termId = await pane.getAttribute('data-term-id')
    await pane.click()

    await clickMenuItem(app, 'menu-close-tab')

    await expect(page.getByTestId(`tab-${active}`)).toHaveCount(0)
    const after = await tabsSnapshot(page, beta)
    expect(after.ids).toEqual([before.ids[0], before.ids[2]])
    // Tab-lifecycle reaper killed the pty: it must drop out of the live list.
    await expect
      .poll(
        () =>
          page.evaluate(
            (tid) => window.pomade.pty.list().then(
              (l) => l.some((t) => t.termId === tid && t.alive)
            ),
            termId
          ),
        { timeout: 10_000 }
      )
      .toBe(false)

    // Clean up the remaining two terminals via Cmd+W as well (also proves repeatability).
    await clickMenuItem(app, 'menu-close-tab')
    await clickMenuItem(app, 'menu-close-tab')
    await expect.poll(() => tabsSnapshot(page, beta).then((s) => s.ids.length)).toBe(0)
  })

  test('a dirty editor prompts before Cmd+W closes it (cancel keeps, discard closes)', async () => {
    const { alpha } = fixture.projects
    await page.getByTestId(`project-${alpha}`).click()

    // Make the seeded README.md dirty by typing into the rendered view.
    await vis('[data-testid="rendered-editor"] .ProseMirror').click()
    await page.keyboard.type(' HOTKEYEDIT')
    await expect(vis('[data-testid="editor-dirty"]')).toBeVisible()

    // Cmd+W → close-guard appears; Cancel keeps the tab.
    await clickMenuItem(app, 'menu-close-tab')
    await expect(vis('[data-testid="close-guard"]')).toBeVisible()
    await vis('[data-testid="guard-cancel"]').click()
    await expect(page.locator('[data-testid="close-guard"]')).toHaveCount(0)
    await expect(page.getByTestId('tab-doc-md')).toHaveCount(1)

    // Cmd+W again → Discard closes it.
    await clickMenuItem(app, 'menu-close-tab')
    await vis('[data-testid="guard-discard"]').click()
    await expect(page.getByTestId('tab-doc-md')).toHaveCount(0)
  })

  test('Cmd+W with zero tabs open does nothing to the window', async () => {
    const { alpha } = fixture.projects
    expect((await tabsSnapshot(page, alpha)).ids).toHaveLength(0)

    await clickMenuItem(app, 'menu-close-tab')
    await clickMenuItem(app, 'menu-close-tab')

    // A wrongful window-close would land within a beat — the window survives throughout.
    await expectQuiet(async () => {
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
      await expect(page.getByTestId('app-shell')).toBeVisible()
    }, 500)
  })

  // Runs last in this describe: alpha is still empty here (asserted above).
  test('the "+" menu also inserts the new terminal right of the active tab', async () => {
    const { alpha } = fixture.projects
    await page.getByTestId(`project-${alpha}`).click()

    for (let i = 0; i < 2; i++) {
      await page.getByTestId('tab-add').click()
      await page.getByTestId('tab-add-terminal').click()
    }
    let snap = await tabsSnapshot(page, alpha)
    expect(snap.ids).toHaveLength(2)
    const [tabA, tabB] = snap.ids

    // Activate the FIRST tab, then create via the "+" menu instead of Cmd+T.
    await page.getByTestId(`tab-${tabA}`).click()
    await page.getByTestId('tab-add').click()
    await page.getByTestId('tab-add-terminal').click()

    await expect.poll(() => tabsSnapshot(page, alpha).then((s) => s.ids.length)).toBe(3)
    snap = await tabsSnapshot(page, alpha)
    expect(snap.ids[0]).toBe(tabA)
    expect(snap.ids[2]).toBe(tabB)
    expect(snap.active).toBe(snap.ids[1])
  })
})
