// modules: git, editor, tabs
// Pomade Wave 3 e2e — git diff, the dirty-close guard routed through the tab-strip ×, and a
// workspace.json carrying unknown legacy keys loading normally. Real git repos are built in
// the fixture.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp, launchAppPage } from './fixtures/app'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

const vis = (page: Page, sel: string): ReturnType<Page['locator']> =>
  page.locator(`${sel}:visible`)

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}
function configRepo(dir: string): void {
  git(dir, 'config', 'user.email', 't@pomade.test')
  git(dir, 'config', 'user.name', 'Pomade Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
}

// ─────────────────────────────────────────────────────────────────────────────
test.describe('git diff + dirty-close guard', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let headSha = ''
  let prevSha = ''

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    const repo = join(fixture.workspaceRoot, 'Projects/alpha')
    const readme = join(repo, 'README.md')

    // Two commits + an uncommitted working change → both diff modes have content.
    git(repo, 'init', '-q', '-b', 'main')
    configRepo(repo)
    await fs.writeFile(readme, '# Alpha\n\nFirst version.\n')
    git(repo, 'add', 'README.md')
    git(repo, 'commit', '-q', '-m', 'v1')
    prevSha = git(repo, 'rev-parse', '--short', 'HEAD').trim()
    await fs.writeFile(readme, '# Alpha\n\nSecond version, committed.\n')
    git(repo, 'add', 'README.md')
    git(repo, 'commit', '-q', '-m', 'v2')
    headSha = git(repo, 'rev-parse', '--short', 'HEAD').trim()
    await fs.appendFile(readme, 'Uncommitted working line.\n')

    // Seed an open doc tab for the README (same restore path the app uses on relaunch).
    const state = {
      openTabs: [
        {
          id: 'doc-readme',
          projectId: 'proj-alpha',
          kind: 'doc',
          title: 'README.md',
          path: 'Projects/alpha/README.md',
          mode: 'raw',
          dirty: false
        }
      ],
      activeTabId: 'doc-readme'
    }
    await fs.mkdir(join(fixture.workspaceRoot, '.pomade/state'), { recursive: true })
    await fs.writeFile(
      join(fixture.workspaceRoot, '.pomade/state/proj-alpha.json'),
      JSON.stringify(state, null, 2)
    )

    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId('project-proj-alpha').click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('Cmd+Shift+G opens a diff with both modes and revision labels', async () => {
    await expect(vis(page, '[data-testid="editor-pane"]')).toBeVisible()
    await page.keyboard.press(`${MOD}+Shift+G`)

    await expect(page.getByTestId('diff-overlay')).toBeVisible()
    await expect(page.getByTestId('diff-merge')).toBeVisible()

    // Default mode: Working vs HEAD.
    await expect(page.getByTestId('diff-mode-working-vs-head')).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('diff-label-a')).toContainText(`HEAD (${headSha})`)
    await expect(page.getByTestId('diff-label-b')).toHaveText('Working tree')
    // The working-tree side shows the uncommitted line.
    await expect(page.getByTestId('diff-merge')).toContainText('Uncommitted working line.')

    // Switch to HEAD vs Previous.
    await page.getByTestId('diff-mode-head-vs-prev').click()
    await expect(page.getByTestId('diff-label-a')).toContainText(`Previous (${prevSha})`)
    await expect(page.getByTestId('diff-label-b')).toContainText(`HEAD (${headSha})`)
    await expect(page.getByTestId('diff-merge')).toContainText('First version.')
    await expect(page.getByTestId('diff-merge')).toContainText('Second version, committed.')

    // Close the overlay.
    await page.getByTestId('diff-close').click()
    await expect(page.getByTestId('diff-overlay')).toHaveCount(0)
  })

  test('E-035 — a dirty doc in a repo peeks Saved ↔ Unsaved first, with the git modes beside it', async () => {
    await vis(page, '[data-testid="raw-editor"] .cm-content').click()
    await page.keyboard.type('\nPEEK EDIT\n')
    await page.keyboard.press(`${MOD}+Shift+G`)
    await expect(page.getByTestId('diff-mode-saved-vs-unsaved')).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('diff-mode-working-vs-head')).toBeVisible()
    await expect(page.getByTestId('diff-mode-head-vs-prev')).toBeVisible()
    await expect(page.getByTestId('diff-label-b')).toHaveText('Unsaved (editor)')
    await expect(page.getByTestId('diff-merge')).toContainText('PEEK EDIT')
    // The git side still shows the file as on disk, not the buffer.
    await page.getByTestId('diff-mode-working-vs-head').click()
    await expect(page.getByTestId('diff-label-b')).toHaveText('Working tree')
    await expect(page.getByTestId('diff-merge')).not.toContainText('PEEK EDIT')
    await page.getByTestId('diff-close').click()
  })

  test('dirty doc: tab-strip × routes through the save/discard/cancel guard', async () => {
    // Make the doc dirty by typing in the raw editor.
    await vis(page, '[data-testid="raw-editor"] .cm-content').click()
    await page.keyboard.type('\nDIRTY EDIT\n')
    await expect(page.getByTestId('tab-doc-readme').locator('[aria-label="unsaved"]')).toBeVisible()

    // Click the × on the tab strip (NOT the editor's own close button).
    await page.getByTestId('close-doc-readme').click()
    await expect(vis(page, '[data-testid="close-guard"]')).toBeVisible()

    // Cancel keeps it.
    await vis(page, '[data-testid="guard-cancel"]').click()
    await expect(page.locator('[data-testid="close-guard"]')).toHaveCount(0)
    await expect(page.getByTestId('tab-doc-readme')).toBeVisible()

    // × again, this time Discard closes it.
    await page.getByTestId('close-doc-readme').click()
    await vis(page, '[data-testid="guard-discard"]').click()
    await expect(page.getByTestId('tab-doc-readme')).toHaveCount(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
test.describe('workspace.json with legacy keys', () => {
  let fixture: Fixture
  let repo: string

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    repo = join(fixture.workspaceRoot, 'Projects/alpha')
    git(repo, 'init', '-q', '-b', 'main')
    configRepo(repo)
    await fs.writeFile(join(repo, 'README.md'), '# Alpha\n')
    git(repo, 'add', 'README.md')
    git(repo, 'commit', '-q', '-m', 'initial')
    await fs.writeFile(join(repo, 'pending.txt'), 'uncommitted\n')

    // A workspace.json written by an older Pomade: an extra top-level `settings` object that
    // enables a schedule at the current minute over the repo above. Nothing reads it.
    const cfgPath = join(fixture.workspaceRoot, '.pomade/workspace.json')
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as Record<string, unknown>
    const now = new Date()
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    cfg.settings = { enabled: true, times: [hhmm], repos: ['Projects/alpha'] }
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2))
  })

  test.afterAll(async () => {
    await fixture?.cleanup()
  })

  test('opens normally, Settings has no git section, and the repo is left untouched', async () => {
    const { app, page } = await launchAppPage(fixture)

    // The config loaded: both fixture projects are in the Projects panel and one opens.
    await expect(page.getByTestId('project-proj-alpha')).toBeVisible()
    await expect(page.getByTestId('project-proj-beta')).toBeVisible()
    await page.getByTestId('project-proj-alpha').click()

    // Settings lists exactly General + File tree.
    await page.getByTestId('projects-panel-settings').click()
    await expect(page.getByTestId('settings-modal')).toBeVisible()
    await expect(page.locator('[data-testid^="settings-nav-"]')).toHaveCount(2)
    await expect(page.getByTestId('settings-nav-general')).toBeVisible()
    await expect(page.getByTestId('settings-nav-filetree')).toBeVisible()
    await page.getByTestId('modal-close').click()

    // The repo still has its one commit and its uncommitted file.
    expect(git(repo, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
    expect(git(repo, 'status', '--porcelain')).toContain('pending.txt')

    await app.close()
  })
})
