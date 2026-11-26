// modules: git, core, tabs
// Pomade E-037 e2e — the Git panel (reading) and the commit-details tab, on a fixture shaped like
// the real workspace (e2e/fixtures/git-repos.ts): a Local-only root repo, a project repo pushed to a
// local bare remote (↑1 ↓1 — the ↑1 commit under Not pushed, not in History —, a squash commit, a
// --no-ff merge, uncommitted modify/new/delete/rename)
// and a project folder holding two repos (one with 60 commits, for paging).
// Set POMADE_E037_SHOTS=<dir> to save review screenshots there.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { launchAppPage, relaunchApp } from './fixtures/app'
import { createGitFixture, git, write, type GitFixture } from './fixtures/git-repos'
import { showGitPanel } from './fixtures/panels'

let fx: GitFixture
let app: ElectronApplication
let page: Page

const SHOTS = process.env.POMADE_E037_SHOTS

async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

async function ready(): Promise<void> {
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.getByTestId('filetree-root')).toBeVisible()
}

/** Select a Projects panel row and show its Git panel (the shown panel is remembered per project). */
async function selectProject(id: string): Promise<void> {
  await page.getByTestId(`project-${id}`).click()
  await expect(page.getByTestId('panehost')).toHaveAttribute('data-active-project', id)
  await showGitPanel(page)
  await expect(page.getByTestId('git-panel')).toBeVisible()
}

function short(cwd: string, rev: string): string {
  return git(cwd, 'rev-parse', '--short=7', rev).trim()
}

test.beforeAll(async () => {
  fx = await createGitFixture()
  ;({ app, page } = await launchAppPage(fx))
  await ready()
})

test.afterAll(async () => {
  await app?.close()
  await fx?.cleanupGit()
})

test('the Git icon fills the side panel; the Workspace row lists every repo with its safety marks', async () => {
  await expect(page.getByTestId('strip-git')).toBeVisible()
  await selectProject('__workspace__')
  await expect(page.getByTestId('strip-git')).toHaveAttribute('data-active-panel', 'true')
  await expect(page.getByTestId('side-panel-files')).toBeHidden()

  await expect(page.getByTestId('git-repo-list-title')).toHaveText('All repositories')
  const rows = page.getByTestId('git-repo-list').locator('[data-testid^="git-repo-row-"]')
  await expect(rows).toHaveCount(4)

  // The root repo: no remote → the Local only warning, one uncommitted file.
  await expect(page.getByTestId('git-repo-row-.')).toContainText(fx.workspaceRoot.split('/').pop()!)
  await expect(page.getByTestId('git-remote-.')).toHaveText('Local only — commits exist only on this Mac')
  await expect(page.getByTestId('git-remote-.')).toHaveAttribute('data-local-only', 'true')
  await expect(page.getByTestId('git-uncommitted-.')).toHaveAttribute('data-count', '1')

  // alpha: the remote as a path (a local bare repo), one unpushed and one behind.
  await expect(page.getByTestId('git-remote-Projects/alpha')).toContainText(fx.remote.replace(/\/$/, ''))
  await expect(page.getByTestId('git-ahead-Projects/alpha')).toHaveText('↑1')
  await expect(page.getByTestId('git-behind-Projects/alpha')).toHaveText('↓1')
  await expect(page.getByTestId('git-uncommitted-Projects/alpha')).toHaveAttribute('data-count', '4')
  await expect(page.getByTestId('git-repo-row-Projects/alpha')).toContainText('main')
  await shot('01-all-repositories')

  // Drill in, then back.
  await page.getByTestId('git-repo-row-Projects/alpha').click()
  await expect(page.getByTestId('git-repo-view')).toHaveAttribute('data-repo', 'Projects/alpha')
  await expect(page.getByTestId('git-repo-title')).toHaveText('alpha')
  await page.getByTestId('git-back').click()
  await expect(page.getByTestId('git-repo-list')).toBeVisible()
})

test('a one-repo project opens straight in; a two-repo project lists its repos', async () => {
  await selectProject('proj-alpha')
  await expect(page.getByTestId('git-repo-view')).toHaveAttribute('data-repo', 'Projects/alpha')
  await expect(page.getByTestId('git-back')).toHaveCount(0)

  await selectProject('proj-beta')
  await expect(page.getByTestId('git-repo-list-title')).toHaveText('Repositories in Beta')
  const rows = page.getByTestId('git-repo-list').locator('[data-testid^="git-repo-row-"]')
  await expect(rows).toHaveCount(2)
  await page.getByTestId('git-repo-row-Projects/beta/two').click()
  await expect(page.getByTestId('git-repo-view')).toHaveAttribute('data-repo', 'Projects/beta/two')
  await expect(page.getByTestId('git-remote-Projects/beta/two')).toHaveAttribute('data-local-only', 'true')
  await page.getByTestId('git-back').click()
  await expect(rows).toHaveCount(2)
})

test('Changes lists the uncommitted files with their letters, staged ones apart', async () => {
  await selectProject('proj-alpha')
  const changes = page.getByTestId('git-changes')
  await expect(page.getByTestId('git-changes-count')).toHaveText('4')
  await expect(changes.getByTestId('git-change-Projects/alpha/docs/BACKLOG.md')).toHaveAttribute('data-git-status', 'M')
  await expect(changes.getByTestId('git-change-Projects/alpha/draft.md')).toHaveAttribute('data-git-status', 'U')
  await expect(changes.getByTestId('git-change-Projects/alpha/keep.md')).toHaveAttribute('data-git-status', 'D')
  // The rename is staged (git mv), so Changes is split: it sits under Staged (E-040).
  await expect(changes.getByTestId('git-staged-count')).toHaveText('1')
  await expect(changes.getByTestId('git-staged-Projects/alpha/terminal-links.md')).toHaveAttribute('data-git-status', 'R')
  await expect(changes.getByTestId('git-change-Projects/alpha/docs/BACKLOG.md')).toContainText('docs')
  await shot('02-repo-view-changes')
})

test('History: one row per landed piece of work; a merge expands; Show every commit shows all', async () => {
  const merge = short(fx.alpha, 'HEAD~1')
  const squash = short(fx.alpha, 'HEAD~3')
  const history = page.getByTestId('git-history')
  await expect(history).toHaveAttribute('data-mode', 'first-parent')
  await expect(page.getByTestId(`git-commit-subject-${squash}`)).toHaveText('T-198: markdown file links')
  await expect(page.getByTestId(`git-commit-${merge}`)).toHaveAttribute('data-merge', 'true')
  // The branch's own commits are not rows of their own …
  await expect(history.getByText('wip: cmd+click handler')).toHaveCount(0)
  // First-parent line: merge, bump, squash, initial (the fetched remote commit is not on HEAD); the
  // local commit is Not pushed, its own group.
  await expect(page.getByTestId('git-unpushed').locator('[data-testid^="git-commit-subject-"]')).toHaveText(['Local work, not pushed'])
  await expect(history.locator('[data-testid^="git-commit-subject-"]')).toHaveText([
    'Merge T-197: terminal Cmd+click fix',
    'Bump version',
    'T-198: markdown file links',
    'Initial import'
  ])
  await expect(page.getByTestId(`git-commit-${squash}`)).toContainText('Pomade Test')

  // … until the merge row expands.
  await page.getByTestId(`git-merge-toggle-${merge}`).click()
  const inner = page.getByTestId(`git-merge-inner-${merge}`)
  await expect(inner.locator('[data-testid^="git-commit-subject-"]')).toHaveText(['fix lint', 'wip: cmd+click handler'])
  await expect(page.getByTestId(`git-merge-toggle-${merge}`)).toHaveAttribute('aria-expanded', 'true')
  await shot('03-history-merge-expanded')

  await page.getByTestId('git-show-all').click()
  await expect(page.getByTestId('git-show-all')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('git-history')).toHaveAttribute('data-mode', 'all')
  await expect(page.getByTestId('git-history').locator('[data-testid^="git-commit-subject-"]')).toHaveCount(6)
  await expect(page.getByTestId('git-merge-inner-' + merge)).toHaveCount(0)
  await page.getByTestId('git-show-all').click()
  await expect(page.getByTestId('git-history')).toHaveAttribute('data-mode', 'first-parent')
  await page.getByTestId(`git-merge-toggle-${merge}`).click()
  await expect(inner).toHaveCount(0)
})

test('History loads in pages as it scrolls', async () => {
  await selectProject('proj-beta')
  await page.getByTestId('git-repo-row-Projects/beta/one').click()
  const subjects = page.getByTestId('git-history').locator('[data-testid^="git-commit-subject-"]')
  await expect(subjects).toHaveCount(50)
  await expect(page.getByTestId('git-history-end')).toHaveAttribute('data-more', 'true')
  await page.getByTestId('git-history-end').scrollIntoViewIfNeeded()
  await expect(subjects).toHaveCount(60)
  await expect(page.getByTestId('git-history-end')).toHaveAttribute('data-more', 'false')
  await expect(subjects.last()).toHaveText('one: commit 0')
  await page.getByTestId('git-back').click()
})

test('live: a new file shows in Changes; a commit made elsewhere tops Not pushed', async () => {
  await selectProject('proj-alpha')
  await write(join(fx.alpha, 'live.md'), 'live\n')
  await expect(page.getByTestId('git-change-Projects/alpha/live.md')).toHaveAttribute('data-git-status', 'U')
  await expect(page.getByTestId('git-changes-count')).toHaveText('5')

  git(fx.alpha, 'add', 'live.md')
  git(fx.alpha, 'commit', '-q', '-m', 'Live commit from a terminal')
  await expect(page.getByTestId('git-change-Projects/alpha/live.md')).toHaveCount(0)
  await expect(page.getByTestId('git-unpushed').locator('[data-testid^="git-commit-subject-"]').first()).toHaveText(
    'Live commit from a terminal'
  )
  await expect(page.getByTestId('git-ahead-Projects/alpha')).toHaveText('↑2')
  await expect(page.getByTestId('git-unpushed-count')).toHaveText('2')
})

test('a History row opens the commit-details tab: message as markdown, author, date, hash, files', async () => {
  const squashFull = git(fx.alpha, 'rev-parse', 'HEAD~4').trim()
  const squash = squashFull.slice(0, 7)
  await page.getByTestId(`git-commit-${squash}`).click()
  const pane = page.locator(`[data-testid="commit-pane"][data-hash="${squashFull}"]`)
  await expect(pane).toBeVisible()
  await expect(pane.getByTestId('commit-subject')).toHaveText('T-198: markdown file links')
  const message = pane.getByTestId('commit-message')
  await expect(message.locator('strong')).toHaveText('Links')
  await expect(message.locator('li')).toHaveCount(3)
  await expect(message.locator('code').first()).toHaveText('[[wikilinks]]')
  await expect(message.locator('input[type="checkbox"]')).toHaveCount(1)
  await expect(message.locator('a')).toHaveText('https://example.com/t-198')
  await expect(pane.getByTestId('commit-author')).toHaveText('Pomade Test')
  await expect(pane.getByTestId('commit-date')).toHaveText('Oct 12, 2026, 14:03')
  await expect(pane.getByTestId('commit-hash')).toHaveText(squash)

  // Files: letters and +/- counts, the rename at its new name.
  await expect(pane.getByTestId('commit-files-count')).toHaveText('3')
  await expect(pane.getByTestId('commit-file-docs/BACKLOG.md')).toHaveAttribute('data-status', 'M')
  await expect(pane.getByTestId('commit-file-stat-docs/BACKLOG.md')).toHaveText('+1−1')
  await expect(pane.getByTestId('commit-file-links.md')).toHaveAttribute('data-status', 'R')
  await expect(pane.getByTestId('commit-file-obsolete.md')).toHaveAttribute('data-status', 'D')

  // The tab: titled by the subject, the row marked as the open one.
  const tabs = page.getByTestId('tabstrip').locator('[role="tab"]')
  await expect(tabs.filter({ hasText: 'T-198: markdown file links' })).toHaveCount(1)
  await expect(page.getByTestId(`git-commit-${squash}`)).toHaveAttribute('data-selected', 'true')
  await shot('04-commit-details')

  // Copy the hash: the full hash lands on the clipboard; the label says so for a moment.
  await pane.getByTestId('commit-hash-copy').click()
  await expect(pane.getByTestId('commit-hash')).toHaveText('Copied')
  await expect.poll(() => page.evaluate(() => window.pomade.app.clipboardRead())).toBe(squashFull)
  await expect(pane.getByTestId('commit-hash')).toHaveText(squash)
})

test('single clicks reuse one preview tab; the merge shows what it brought in', async () => {
  const mergeFull = git(fx.alpha, 'rev-parse', 'HEAD~2').trim()
  const bump = git(fx.alpha, 'rev-parse', '--short=7', 'HEAD~3').trim()
  const tabs = page.getByTestId('tabstrip').locator('[role="tab"]')
  // The details tab above was clicked into, so it is a real tab now: the next click opens a preview …
  const before = await tabs.count()
  await page.getByTestId(`git-commit-${bump}`).click()
  await expect(tabs).toHaveCount(before + 1)
  await expect(tabs.filter({ hasText: 'Bump version' })).toHaveCount(1)
  // … which the next single click replaces in place.
  await page.getByTestId(`git-commit-${mergeFull.slice(0, 7)}`).click()
  const pane = page.locator(`[data-testid="commit-pane"][data-hash="${mergeFull}"]`)
  await expect(pane).toBeVisible()
  await expect(tabs).toHaveCount(before + 1)
  await expect(tabs.filter({ hasText: 'Bump version' })).toHaveCount(0)
  await expect(pane.getByTestId('commit-merge-tag')).toBeVisible()
  await expect(pane.getByTestId('commit-file-terminal.md')).toHaveAttribute('data-status', 'A')
})

test('commit tabs stay mounted while hidden and survive a restart; a missing commit restores readably', async () => {
  const mergeFull = git(fx.alpha, 'rev-parse', 'HEAD~2').trim()
  const pane = page.locator(`[data-testid="commit-pane"][data-hash="${mergeFull}"]`)
  await pane.evaluate((el) => el.setAttribute('data-mark', 'kept'))
  await page.getByTestId('project-proj-beta').click()
  await expect(pane).toBeHidden()
  await selectProject('proj-alpha')
  await expect(pane).toHaveAttribute('data-mark', 'kept')

  // A commit tab whose commit does not exist (history rewritten, repo replaced).
  await page.evaluate(() => {
    window.__pomadeStores.useTabsStore.getState().openTab({
      id: 'gone-commit',
      projectId: 'proj-alpha',
      kind: 'commit',
      repo: 'Projects/alpha',
      hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      title: 'Gone'
    })
  })
  await expect(page.getByTestId('pane-gone-commit').getByTestId('commit-error')).toContainText('Commit deadbee cannot be shown')

  ;({ app, page } = await relaunchApp(app, fx))
  await expect(page.getByTestId('app-shell')).toBeVisible()
  // The Git panel is still the project's panel after the restart.
  await expect(page.getByTestId('git-panel')).toBeVisible()
  await selectProject('proj-alpha')
  await expect(page.getByTestId('pane-gone-commit').getByTestId('commit-error')).toBeAttached()
  const tabs = page.getByTestId('tabstrip').locator('[role="tab"]')
  await tabs.filter({ hasText: 'Merge T-197' }).click()
  await expect(page.locator(`[data-testid="commit-pane"][data-hash="${mergeFull}"]`).getByTestId('commit-subject')).toHaveText(
    'Merge T-197: terminal Cmd+click fix'
  )
})

test('a narrow panel keeps rows inside it (no horizontal overflow)', async () => {
  await selectProject('__workspace__')
  // The narrowest the divider allows (LAYOUT_LIMITS.fileTreeMin).
  await page.getByTestId('side-panel').evaluate((el) => (el as HTMLElement).style.setProperty('--filetree-w', '160px'))
  expect((await page.getByTestId('git-panel').boundingBox())?.width).toBeLessThanOrEqual(161)
  const body = page.getByTestId('git-panel-body')
  const overflow = (): Promise<boolean> => body.evaluate((el) => el.scrollWidth > el.clientWidth + 1)
  expect(await overflow()).toBe(false)
  await shot('05-narrow-all-repositories')
  await page.getByTestId('git-repo-row-Projects/alpha').click()
  expect(await overflow()).toBe(false)
  await shot('06-narrow-repo-view')
  await page.getByTestId('side-panel').evaluate((el) => (el as HTMLElement).style.removeProperty('--filetree-w'))
  await page.getByTestId('git-back').click()
})
