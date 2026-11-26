// modules: projects, terminal, tabs
// Pomade T-156 e2e — deleting a project is a real TEARDOWN pipeline.
//
// The bug: `deleteProject` used to filter the `projects` array and fix `activeProjectId` only, so
// a deleted project's live terminals/agents kept their PTYs alive in main with NO UI to reach them
// until quit (CPU/tokens/file writes burning invisibly), its `.pomade/state/<id>.json` and per-tab
// scrollback snapshots were never deleted, and every per-project store map leaked its entries.
//
// This drives the real thing: open a project, spawn a LIVE terminal (real login zsh + PTY), give it
// a mount and a closed sibling tab (a reopen-stack entry), then delete the project and assert the
// whole teardown fired — the PTY exits, the state file and the terminal's scrollback snapshot are
// gone, and no per-project map (tabs / active / preview / props / reopen / mounts, in either store)
// still holds the project. A REAL zsh terminal ⇒ this file is listed in HEAVY_ZSH_NAMES.

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
import { readBuffer, writePty } from './fixtures/stores'

function stateFile(fixture: Fixture, projectId: string): string {
  return join(fixture.workspaceRoot, '.pomade', 'state', `${projectId}.json`)
}
function snapshotFile(fixture: Fixture, tabId: string): string {
  return join(fixture.workspaceRoot, '.pomade', 'state', 'scrollback', tabId)
}
function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false
  )
}

interface TabSnap {
  id: string
  kind: string
  termId: string
}
function tabSnaps(page: Page, projectId: string): Promise<TabSnap[]> {
  return page.evaluate((pid) => {
    const stores = window.__pomadeStores
    return (stores.useTabsStore.getState().tabsByProject[pid] ?? []).map((t) => ({
      id: t.id,
      kind: t.kind,
      termId: t.termId
    }))
  }, projectId) as Promise<TabSnap[]>
}

function ptyList(page: Page): Promise<{ termId: string; alive: boolean }[]> {
  return page.evaluate(() => window.pomade.pty.list())
}

/** Open a terminal tab through the UI (tab-add → tab-add-terminal) and return the new tab's snap.
 *  `before` are the ids that already existed, so we can pick out the one this call created. */
async function addTerminal(page: Page, projectId: string, before: Set<string>): Promise<TabSnap> {
  await page.getByTestId('tab-add').click()
  await page.getByTestId('tab-add-terminal').click()
  await expect
    .poll(async () => (await tabSnaps(page, projectId)).some((t) => !before.has(t.id)), {
      timeout: 20_000
    })
    .toBe(true)
  const created = (await tabSnaps(page, projectId)).find((t) => !before.has(t.id))
  if (!created) throw new Error('new terminal tab never appeared')
  return created
}

test.describe('T-156 — deleting a project tears down its PTYs, state file, snapshots and maps', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha = ''
  let beta = ''

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    beta = fixture.projects.beta
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${alpha}`).click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('the whole teardown fires; a sibling project is untouched', async () => {
    test.slow()

    // ── setup — a live terminal, a mount, and a closed sibling tab (reopen-stack entry) ──
    const liveTab = await addTerminal(page, alpha, new Set())
    // A second terminal we CLOSE (via the silent store primitive), leaving a reopen-stack entry so
    // the "no stale reopen entries after delete" assertion has something real to sweep.
    const closedTab = await addTerminal(page, alpha, new Set([liveTab.id]))

    // The live terminal is a real PTY: it appears alive in main's pty list.
    await expect
      .poll(() => ptyList(page).then((l) => l.some((t) => t.termId === liveTab.termId && t.alive)), {
        timeout: 20_000
      })
      .toBe(true)

    // Produce output on the live terminal and wait until its scrollback snapshot lands on disk
    // (keyed by TAB id) — that file is what the delete must forget.
    await expect
      .poll(() => readBuffer(page, liveTab.termId).then((b) => b.length), { timeout: 20_000 })
      .toBeGreaterThan(0)
    await writePty(page, liveTab.termId, 'echo TEARDOWN_MARK\r')
    await expect
      .poll(() => exists(snapshotFile(fixture, liveTab.id)), { timeout: 20_000 })
      .toBe(true)

    // Close the sibling terminal silently → a reopen-stack entry for alpha (its PTY is reaped).
    await page.evaluate(
      ({ pid, tid }) => {
        ;window.__pomadeStores.useTabsStore.getState().closeTab(pid, tid)
      },
      { pid: alpha, tid: closedTab.id }
    )

    // Give alpha a mount so mounts-store has a per-project entry to sweep.
    await page.evaluate((pid) => {
      const mounts = window.__pomadeStores.useMountsStore.getState()
      mounts.hydrateProject(pid)
      mounts.addMount(pid, 'Projects/alpha/deep', false)
    }, alpha)

    // The per-project state file exists on disk (the debounced save from opening/adding landed).
    await expect.poll(() => exists(stateFile(fixture, alpha)), { timeout: 20_000 }).toBe(true)

    // Pre-conditions the delete must undo (so a reverted fix visibly fails these later).
    const before = await page.evaluate((pid) => {
      const s = window.__pomadeStores
      const tabs = s.useTabsStore.getState()
      const mounts = s.useMountsStore.getState()
      return {
        reopenLen: (tabs.reopenStackByProject[pid] ?? []).length,
        mountsLen: (mounts.mountsByProject[pid] ?? []).length
      }
    }, alpha)
    expect(before.reopenLen).toBe(1)
    expect(before.mountsLen).toBe(1)

    // ── delete alpha ──
    await page.evaluate((pid) => {
      ;window.__pomadeStores.useWorkspaceStore.getState().deleteProject(pid)
    }, alpha)

    // 1. The live terminal's PTY exits (gone from main's pty list). This is the load-bearing
    //    assertion the old behavior fails: switching/deleting never used to reap these.
    await expect
      .poll(() => ptyList(page).then((l) => l.some((t) => t.termId === liveTab.termId)), {
        timeout: 20_000
      })
      .toBe(false)

    // 2. The per-project state file is gone.
    await expect.poll(() => exists(stateFile(fixture, alpha)), { timeout: 20_000 }).toBe(false)

    // 3. The live terminal's scrollback snapshot is gone.
    await expect
      .poll(() => exists(snapshotFile(fixture, liveTab.id)), { timeout: 20_000 })
      .toBe(false)

    // 4. No per-project map (either store) still holds alpha.
    const leaks = await page.evaluate((pid) => {
      const s = window.__pomadeStores
      const tabs = s.useTabsStore.getState()
      const mounts = s.useMountsStore.getState()
      return {
        tabs: pid in tabs.tabsByProject,
        active: pid in tabs.activeTabByProject,
        preview: pid in tabs.previewTabByProject,
        props: pid in tabs.propertiesPanelExpandedByProject,
        reopen: pid in tabs.reopenStackByProject,
        tabsHydrated: pid in tabs.hydratedProjects,
        mounts: pid in mounts.mountsByProject,
        collapsed: pid in mounts.collapsedByProject,
        mountsHydrated: pid in mounts.hydratedProjects
      }
    }, alpha)
    expect(leaks).toEqual({
      tabs: false,
      active: false,
      preview: false,
      props: false,
      reopen: false,
      tabsHydrated: false,
      mounts: false,
      collapsed: false,
      mountsHydrated: false
    })

    // 5. The project is gone from the workspace and the active project fell back to the Workspace project.
    const wsAfter = await page.evaluate(() => {
      const ws = window.__pomadeStores.useWorkspaceStore.getState()
      return { ids: ws.projects.map((p: { id: string }) => p.id), active: ws.activeProjectId }
    })
    expect(wsAfter.ids).not.toContain(alpha)
    expect(wsAfter.active).toBe('__workspace__')

    // 6. The sibling project beta is entirely untouched — still present and switchable.
    expect(wsAfter.ids).toContain(beta)
    await page.getByTestId(`project-${beta}`).click()
    await expect(page.getByTestId('panehost')).toHaveAttribute('data-active-project', beta)
  })
})
