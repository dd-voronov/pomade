// modules: core, tabs, editor
// Pomade T-102 e2e (E-021) — outside-workspace doc-tab restore across restart: a persisted tab
// whose absolute path resolves is restored, one whose path is gone is dropped silently. Doc tabs
// only (no terminal/agent), so this file runs in the LIGHT pass; the interactive outside-file
// suite lives in terminal-outside-workspace.spec.ts (heavy).
//
// The outside directory is a SECOND temp dir outside the fixture workspace (never a real user
// path). Fixture files mirror real vault content (frontmatter + inline markup), per the repo rule.

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

async function write(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content, 'utf8')
}

// ─── Restore behavior: seed .pomade/state with an outside doc tab, relaunch ─────
test.describe('T-102 — outside-workspace tab persistence across restart', () => {
  let f: Fixture
  let dir: string
  let livePath: string

  test.beforeAll(async () => {
    f = await createFixtureWorkspace()
    dir = await tempDir('pomade-t102-restore-')
    livePath = join(dir, 'restored.md')
    await write(livePath, '# Restored\n\nSentinel: RESTORED_BODY_SENTINEL.\n')
  })

  test.afterAll(async () => {
    await f?.cleanup()
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })

  async function seedState(openTabs: unknown[], activeTabId: string): Promise<void> {
    const state = { openTabs, activeTabId }
    await fs.mkdir(join(f.workspaceRoot, '.pomade/state'), { recursive: true })
    await fs.writeFile(
      join(f.workspaceRoot, '.pomade/state/proj-alpha.json'),
      JSON.stringify(state, null, 2)
    )
  }

  function outsideDocTab(id: string, absPath: string): Record<string, unknown> {
    return { id, projectId: 'proj-alpha', kind: 'doc', title: 'x.md', path: absPath, mode: 'rendered', dirty: false }
  }

  async function launch(): Promise<{ a: ElectronApplication; p: Page }> {
    const a = await launchApp(f)
    const p = await a.firstWindow()
    await p.waitForLoadState('domcontentloaded')
    await p.getByTestId('project-proj-alpha').click()
    return { a, p }
  }

  test('an outside-workspace tab whose path resolves is restored', async () => {
    await seedState([outsideDocTab('doc-live', livePath)], 'doc-live')
    const { a, p } = await launch()
    await expect
      .poll(
        () =>
          p.evaluate(() => {
            const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject['proj-alpha'] ?? []
            return tabs.map((t) => t.path)
          }),
        { timeout: 10_000 }
      )
      .toContain(livePath)
    await expect(p.locator('[data-testid="editor-pane"]:visible')).toContainText(
      'RESTORED_BODY_SENTINEL',
      { timeout: 10_000 }
    )
    await a.close()
  })

  test('an outside-workspace tab whose path no longer resolves is dropped silently', async () => {
    const gonePath = join(dir, 'deleted.md')
    // Never created on disk (simulates moved/deleted, or .pomade synced from another machine).
    await seedState([outsideDocTab('doc-live', livePath), outsideDocTab('doc-gone', gonePath)], 'doc-gone')
    const { a, p } = await launch()
    // The live tab survives; the unresolved one is pruned. Give hydration time to settle.
    await expect
      .poll(
        () =>
          p.evaluate(() => {
            const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject['proj-alpha'] ?? []
            return tabs.map((t) => t.path)
          }),
        { timeout: 10_000 }
      )
      .toContain(livePath)
    const paths = await p.evaluate(() => {
      const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject['proj-alpha'] ?? []
      return tabs.map((t) => t.path)
    })
    expect(paths).not.toContain(gonePath)
    await a.close()
  })
})
