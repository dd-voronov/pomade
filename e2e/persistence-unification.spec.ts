// modules: core, filetree, tabs
// Pomade T-157 e2e — unified per-project persistence (createProjectStatePersistence).
//
// Two independent describes, each with its own fixture + app:
//   1. QUIT INSIDE THE SAVE WINDOW — a mount added moments before quit survives the restart.
//      Pre-T-157 the mounts-store had its own 500ms renderer debounce, no flush method and no
//      registration in the quit path, so this exact sequence silently LOST the mount (the
//      revert-proof for this file: with the fix reverted, the relaunch shows no mount).
//   2. WORKSPACE SWITCH TEARDOWN — switching resets EVERY registered per-project store: the old
//      workspace's mounts do not leak into the new one (mounts-store was never reset at all —
//      its stale hydratedProjects served the old workspace's in-memory mounts), stale
//      previewTab/propertiesPanel entries are cleared (the old field-by-field reset missed
//      both), and switching BACK re-hydrates the mounts from that workspace's own disk state.
//
// Terminal-free by design → light partition.

import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'

async function firstPage(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  return page
}

/** Open the file-tree kebab → "Mount new folder…" → type `path` → Mount. */
async function mountFolder(page: Page, path: string): Promise<void> {
  await page.getByTestId('tree-section-kebab').click()
  await page.getByTestId('menu-mount-folder').click()
  await expect(page.getByTestId('tree-mount-dialog')).toBeVisible()
  await page.getByTestId('tree-mount-input').fill(path)
  await page.getByTestId('tree-mount-submit').click()
}

/** The header row of a mounted root, located by its (stable) workspace-relative path. */
const rootHeader = (page: Page, path: string): Locator => page.locator(`[data-root-path="${path}"]`)

// ─── 1. Quit inside the save window ───────────────────────────────────────────────────────────

test.describe('T-157 — quit inside the save window', () => {
  let fixture: Fixture
  let app: ElectronApplication

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await fs.mkdir(join(fixture.workspaceRoot, 'Knowledge'), { recursive: true })
    await fs.writeFile(join(fixture.workspaceRoot, 'Knowledge/note.md'), '# Note\n')
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('a mount added moments before quit survives the restart', async () => {
    app = await launchApp(fixture)
    let page = await firstPage(app)
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await expect(page.getByTestId('filetree-root')).toContainText('Projects/alpha')

    // Mount, then quit IMMEDIATELY — well inside any save-debounce window. No settling wait on
    // purpose: the quit-flush pipeline (renderer flush registry → main flushPendingWrites) is
    // exactly what is under test.
    await mountFolder(page, 'Knowledge')
    await expect(rootHeader(page, 'Knowledge')).toBeVisible()
    await app.close()

    // The state file carries the mount…
    const stateFile = join(fixture.workspaceRoot, '.pomade', 'state', `${fixture.projects.alpha}.json`)
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as {
      mounts?: Array<{ path: string }>
    }
    expect((state.mounts ?? []).map((m) => m.path)).toEqual(['Knowledge'])

    // …and the relaunch restores it.
    app = await launchApp(fixture)
    page = await firstPage(app)
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await expect(rootHeader(page, 'Knowledge')).toBeVisible()
    await expect(page.getByTestId('tree-node-Knowledge/note.md')).toBeVisible()
  })
})

// ─── 2. Workspace switch teardown ─────────────────────────────────────────────────────────────

test.describe('T-157 — workspace switch resets every per-project store', () => {
  let wsA: Fixture
  let wsB: Fixture
  let app: ElectronApplication
  let page: Page
  let alpha: string

  // A project id that exists ONLY in workspace A: the new workspace never re-hydrates it, so any
  // stale per-project entry it leaves behind is visible indefinitely (the alpha/beta ids exist in
  // both fixtures and get overwritten by B's own hydration).
  const GAMMA = 'proj-gamma-a-only'

  async function switchTo(target: string): Promise<void> {
    await app.evaluate(({}, t) => {
      process.env.POMADE_PICK_ROOT = t
    }, target)
    await app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById('menu-change-workspace')?.click()
    })
  }

  test.beforeAll(async () => {
    wsA = await createFixtureWorkspace()
    wsB = await createFixtureWorkspace()
    alpha = wsA.projects.alpha

    // Distinct root markers proving which workspace is loaded.
    await fs.writeFile(join(wsA.workspaceRoot, 'marker-a.md'), '# A\n')
    await fs.writeFile(join(wsB.workspaceRoot, 'marker-b.md'), '# B\n')
    // A folder to mount in A only.
    await fs.mkdir(join(wsA.workspaceRoot, 'Knowledge'), { recursive: true })
    await fs.writeFile(join(wsA.workspaceRoot, 'Knowledge/note.md'), '# Note\n')
    // The A-only gamma project (rooted at the existing Apps/gamma fixture folder).
    const cfgPath = join(wsA.workspaceRoot, '.pomade', 'workspace.json')
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as {
      projects: Array<Record<string, unknown>>
    }
    cfg.projects.push({ id: GAMMA, name: 'Gamma', rootPath: 'Apps/gamma', visibleAgents: ['*'], order: 2 })
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2))

    app = await launchApp(wsA)
    page = await firstPage(app)
    await expect(page.getByTestId('tree-node-marker-a.md')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    await wsA?.cleanup()
    await wsB?.cleanup()
  })

  test('seed workspace A: a mount, a preview tab, and a gamma properties-panel collapse', async () => {
    await page.getByTestId(`project-${alpha}`).click()
    await expect(page.getByTestId('filetree-root')).toContainText('Projects/alpha')
    await mountFolder(page, 'Knowledge')
    await expect(rootHeader(page, 'Knowledge')).toBeVisible()

    // Boot hydrates every project (gamma included) — wait for it so the mutations persist.
    await expect
      .poll(() =>
        page.evaluate(([pid, gid]) => {
          const s = window.__pomadeStores.useTabsStore.getState()
          return s.hydratedProjects[pid] === true && s.hydratedProjects[gid] === true
        }, [alpha, GAMMA])
      )
      .toBe(true)

    // Seed the two per-project fields the old switch-reset missed: a PREVIEW tab on alpha and a
    // collapsed properties panel on gamma (an id workspace B never hydrates over).
    await page.evaluate(
      ([pid, gid]) => {
        const tabs = window.__pomadeStores.useTabsStore.getState()
        tabs.openTab(
          {
            id: 't157-preview-doc',
            projectId: pid,
            kind: 'doc',
            title: 'README.md',
            path: 'Projects/alpha/README.md',
            mode: 'raw',
            dirty: false
          },
          { preview: true }
        )
        tabs.togglePropertiesPanelExpanded(gid)
      },
      [alpha, GAMMA]
    )
    await expect
      .poll(() =>
        page.evaluate(([pid, gid]) => {
          const s = window.__pomadeStores.useTabsStore.getState()
          return (
            s.previewTabByProject[pid] === 't157-preview-doc' &&
            s.propertiesPanelExpandedByProject[gid] === false
          )
        }, [alpha, GAMMA])
      )
      .toBe(true)

    // The mount must land in A's state file before switching (the switch-back re-hydrates from it).
    await expect
      .poll(async () => {
        const raw = await fs
          .readFile(join(wsA.workspaceRoot, '.pomade', 'state', `${alpha}.json`), 'utf8')
          .catch(() => '')
        if (!raw) return null
        const st = JSON.parse(raw) as { mounts?: Array<{ path: string }> }
        return (st.mounts ?? []).map((m) => m.path)
      })
      .toEqual(['Knowledge'])
  })

  test('switch A → B: no stale preview/properties entries, no leaked mounts', async () => {
    await switchTo(wsB.workspaceRoot)
    await expect(page.getByTestId('tree-node-marker-b.md')).toBeVisible({ timeout: 15_000 })

    // The stale-leak assertions. previewTabByProject is untouched by hydration, and gamma exists
    // only in A (B never hydrates over its entries), so pre-T-157 all three entries survived the
    // switch verbatim.
    await expect
      .poll(() =>
        page.evaluate(([pid, gid]) => {
          const s = window.__pomadeStores.useTabsStore.getState()
          return (
            s.previewTabByProject[pid] === undefined &&
            s.propertiesPanelExpandedByProject[gid] === undefined &&
            s.hydratedProjects[gid] === undefined
          )
        }, [alpha, GAMMA])
      )
      .toBe(true)

    // B's alpha shows NO mounts: pre-T-157 mounts-store was never reset, so its stale
    // hydratedProjects flag served workspace A's in-memory Knowledge mount here.
    await page.getByTestId(`project-${alpha}`).click()
    await expect(page.getByTestId('filetree-root')).toContainText('Projects/alpha')
    await expect(rootHeader(page, 'Knowledge')).toHaveCount(0)
    await expect
      .poll(() =>
        page.evaluate((pid) => {
          const s = window.__pomadeStores.useMountsStore.getState()
          return (s.mountsByProject[pid] ?? []).length
        }, alpha)
      )
      .toBe(0)
  })

  test('switch back B → A: the mounts re-hydrate from A’s own disk state', async () => {
    await switchTo(wsA.workspaceRoot)
    await expect(page.getByTestId('tree-node-marker-a.md')).toBeVisible({ timeout: 15_000 })

    await page.getByTestId(`project-${alpha}`).click()
    await expect(page.getByTestId('filetree-root')).toContainText('Projects/alpha')
    await expect(rootHeader(page, 'Knowledge')).toBeVisible()
    await expect(page.getByTestId('tree-node-Knowledge/note.md')).toBeVisible()
  })
})
