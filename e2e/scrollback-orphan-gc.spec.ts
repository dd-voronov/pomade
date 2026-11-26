// modules: terminal, core
// Pomade T-116 e2e — orphaned scrollback snapshots are collected at workspace boot. The seeded
// tab is persisted-DEAD and nothing revives it (no pty, no zsh), so this file runs in the LIGHT
// pass; the live snapshot/revive suites live in terminal-scrollback.spec.ts (heavy).

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

async function bootPage(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  return page
}

async function seedProjectState(fixture: Fixture, projectId: string, state: unknown): Promise<void> {
  await fs.mkdir(join(fixture.workspaceRoot, '.pomade', 'state'), { recursive: true })
  await fs.writeFile(
    join(fixture.workspaceRoot, '.pomade', 'state', `${projectId}.json`),
    JSON.stringify(state, null, 2)
  )
}

// ── the snapshot file: `<workspace>/.pomade/state/scrollback/<tabId>` ─────────────────
function snapshotPath(fixture: Fixture, tabId: string): string {
  return join(fixture.workspaceRoot, '.pomade', 'state', 'scrollback', tabId)
}

async function seedSnapshot(fixture: Fixture, tabId: string, content: string): Promise<void> {
  await fs.mkdir(join(fixture.workspaceRoot, '.pomade', 'state', 'scrollback'), { recursive: true })
  await fs.writeFile(snapshotPath(fixture, tabId), content, 'utf8')
}

async function snapshotOf(fixture: Fixture, tabId: string): Promise<string | null> {
  try {
    return await fs.readFile(snapshotPath(fixture, tabId), 'utf8')
  } catch {
    return null
  }
}

async function scrollbackDir(fixture: Fixture): Promise<string[]> {
  try {
    return (
      await fs.readdir(join(fixture.workspaceRoot, '.pomade', 'state', 'scrollback'))
    ).sort()
  } catch {
    return []
  }
}

// ─── orphan GC at workspace boot ───────────────────────────────────────────────────────
test.describe('T-116 — orphaned snapshots are collected at boot', () => {
  let fixture: Fixture
  let app: ElectronApplication | undefined
  let alpha = ''
  const OWNED = 'gc-owned-tab'
  const ORPHAN = 'gc-orphan-tab'

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    alpha = fixture.projects.alpha
    // A persisted-DEAD tab: it owns its snapshot without triggering a revive (so the file cannot
    // be rewritten by a fresh pty during the assertion).
    await seedProjectState(fixture, alpha, {
      openTabs: [
        {
          id: OWNED,
          projectId: alpha,
          kind: 'terminal',
          title: 'zsh 1',
          termId: 'gc-owned-gone',
          cwd: join(fixture.workspaceRoot, 'Projects/alpha'),
          status: 'dead'
        }
      ],
      activeTabId: OWNED
    })
    await seedSnapshot(fixture, OWNED, 'GC_OWNED_MARK\r\n')
    // No tab, in any state file, claims this one — a crash between "tab closed" and "file
    // deleted", or a hand-edited state file.
    await seedSnapshot(fixture, ORPHAN, 'GC_ORPHAN_MARK\r\n')
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('the unowned file is deleted, the owned one is kept', async () => {
    test.slow()
    app = await launchApp(fixture)
    await bootPage(app)
    await expect.poll(() => scrollbackDir(fixture), { timeout: 20_000 }).toEqual([OWNED])
    expect(await snapshotOf(fixture, OWNED)).toBe('GC_OWNED_MARK\r\n')
  })
})
