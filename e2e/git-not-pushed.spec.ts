// modules: git, tabs
// Pomade T-231 e2e — the repo view's Not pushed group, on fixture repos with LOCAL BARE remotes
// (e2e/fixtures/git-ops-repos.ts): a commit kept local is listed under Not pushed (with ↑n's count)
// and not in History; a click opens its commit tab as the preview; it follows commits made in a
// terminal, a fetch and a merge from the remote; after Push the group is gone and the commits are in
// History. A repo with no remote, or a branch with no upstream, never shows the group. Every ticket
// Acceptance bullet is an assertion here. Set POMADE_T231_SHOTS=<dir> for screenshots.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { launchAppPage } from './fixtures/app'
import { createGitOpsFixture, gitIn, write, type GitOpsFixture } from './fixtures/git-ops-repos'
import { activeIdOf } from './fixtures/stores'
import { showGitPanel } from './fixtures/panels'

let fx: GitOpsFixture
let app: ElectronApplication
let page: Page

const SHOTS = process.env.POMADE_T231_SHOTS

async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

const g = (cwd: string, ...args: string[]): string => gitIn(fx.scratch, cwd, ...args).trim()
const short = (cwd: string, rev = 'HEAD'): string => g(cwd, 'rev-parse', '--short=7', rev)

const view = (): ReturnType<Page['locator']> => page.getByTestId('git-repo-view')
const group = (): ReturnType<Page['locator']> => view().getByTestId('git-unpushed')
const history = (): ReturnType<Page['locator']> => view().getByTestId('git-history')
const subjects = (where: ReturnType<Page['locator']>): ReturnType<Page['locator']> =>
  where.locator('[data-testid^="git-commit-subject-"]')
const toast = (text: string | RegExp): ReturnType<Page['locator']> => page.getByTestId('toast').filter({ hasText: text })

async function selectProject(id: string): Promise<void> {
  await page.getByTestId(`project-${id}`).click()
  await expect(page.getByTestId('panehost')).toHaveAttribute('data-active-project', id)
  await showGitPanel(page)
  await expect(page.getByTestId('git-panel')).toBeVisible()
}

/** A commit made outside Pomade (a terminal, an agent). */
async function commitOutside(cwd: string, file: string, text: string, message: string): Promise<void> {
  await write(join(cwd, file), text)
  g(cwd, 'add', '-A')
  g(cwd, 'commit', '-q', '-m', message)
}

async function push(): Promise<void> {
  await view().getByTestId('git-commit-open').click()
  await expect(view().getByTestId('git-commit-run')).toHaveText('Push')
  await view().getByTestId('git-commit-run').click()
  await expect(toast(/^Pushed \d+ commits? to .+ \(origin\/main\)\.$/)).toBeVisible()
  await expect(view().getByTestId('git-commit-box')).toHaveCount(0)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  fx = await createGitOpsFixture()
  ;({ app, page } = await launchAppPage(fx, fx.env))
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fx?.cleanupGit()
})

test('pushed and clean: no Not pushed group', async () => {
  await selectProject(fx.projects.alpha)
  await expect(subjects(history())).toHaveText(['Alpha: start'])
  await expect(group()).toHaveCount(0)
})

test('Commit without pushing: Not pushed (1) lists it, History does not; a click opens its commit tab as the preview', async () => {
  await write(join(fx.alpha, 'notes.md'), '# Notes\n\nLocal only for now.\n')
  await expect(view().getByTestId('git-changes-count')).toHaveText('1')
  await view().getByTestId('git-commit-open').click()
  await view().getByTestId('git-commit-message').fill('Alpha: notes, kept local')
  await view().getByTestId('git-commit-push-after').uncheck()
  await view().getByTestId('git-commit-run').click()
  await expect(toast(/^Committed [0-9a-f]{7} — not pushed\.$/)).toBeVisible()

  const local = short(fx.alpha)
  await expect(group().getByTestId('git-unpushed-count')).toHaveText('1')
  await expect(subjects(group())).toHaveText(['Alpha: notes, kept local'])
  await expect(view().getByTestId('git-ahead-Projects/alpha')).toHaveAttribute('data-count', '1')
  await expect(subjects(history())).toHaveText(['Alpha: start'])
  // Between Changes and History.
  const order = await view().locator('section').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
  expect(order.indexOf('git-unpushed')).toBe(order.indexOf('git-changes') + 1)
  expect(order.indexOf('git-unpushed')).toBeLessThan(order.indexOf('git-history-section'))
  await shot('01-not-pushed-1')

  await group().getByTestId(`git-commit-${local}`).click()
  const pane = page.locator(`[data-testid="commit-pane"][data-hash^="${local}"]`)
  await expect(pane.getByTestId('commit-subject')).toHaveText('Alpha: notes, kept local')
  const tabId = await activeIdOf(page, fx.projects.alpha)
  await expect(page.getByTestId(`tab-${tabId}`)).toHaveAttribute('data-preview', 'true')
  await expect(group().getByTestId(`git-commit-${local}`)).toHaveAttribute('data-selected', 'true')
  // The same right-click menu as History's rows.
  await group().getByTestId(`git-commit-${local}`).click({ button: 'right' })
  await expect(page.getByTestId('row-menu-open-new-tab')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('row-menu-open-new-tab')).toHaveCount(0)
})

test('a commit made in a terminal joins the group live, newest first; the group folds', async () => {
  await commitOutside(fx.alpha, 'plan.md', '# Plan\n', 'Alpha: plan, from a terminal')
  await expect(group().getByTestId('git-unpushed-count')).toHaveText('2')
  await expect(subjects(group())).toHaveText(['Alpha: plan, from a terminal', 'Alpha: notes, kept local'])
  await expect(subjects(history())).toHaveText(['Alpha: start'])

  await group().getByTestId('git-unpushed-toggle').click()
  await expect(group().getByTestId('git-unpushed-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect(subjects(group())).toHaveCount(0)
  await expect(group().getByTestId('git-unpushed-count')).toHaveText('2')
  await group().getByTestId('git-unpushed-toggle').click()
  await expect(subjects(group())).toHaveCount(2)
})

test('Push: the group is gone, the commits are in History', async () => {
  await push()
  await expect(group()).toHaveCount(0)
  await expect(subjects(history())).toHaveText(['Alpha: plan, from a terminal', 'Alpha: notes, kept local', 'Alpha: start'])
  await shot('02-after-push')
})

test('fetch and an unpushed merge: the merge and the local commit are Not pushed; History is what the remote has', async () => {
  // Someone else pushes; Fetch notices it (↓1) — nothing is ahead, so still no group.
  g(fx.other, 'pull', '-q', '--ff-only')
  await commitOutside(fx.other, 'remote.md', '# From elsewhere\n', 'Other: remote work')
  g(fx.other, 'push', '-q')
  await view().getByTestId('git-fetch').click()
  await expect(view().getByTestId('git-behind-Projects/alpha')).toHaveAttribute('data-count', '1')
  await expect(group()).toHaveCount(0)

  // A local commit, then the remote's work merged in from a terminal: two commits to push.
  await commitOutside(fx.alpha, 'local.md', '# Local\n', 'Alpha: local work')
  await expect(group().getByTestId('git-unpushed-count')).toHaveText('1')
  g(fx.alpha, 'merge', '-q', '--no-ff', '-m', 'Merge origin/main', 'origin/main')
  const merge = short(fx.alpha)
  await expect(group().getByTestId('git-unpushed-count')).toHaveText('2')
  await expect(subjects(group())).toHaveText(['Merge origin/main', 'Alpha: local work'])
  // Flat: the merge's own commits are rows here, so the merge row has no chevron.
  await expect(group().getByTestId(`git-merge-toggle-${merge}`)).toHaveCount(0)
  // History holds what both sides have: the remote's commit is pushed, so it is there; the local ones are not.
  await expect(subjects(history())).toHaveText(['Other: remote work', 'Alpha: plan, from a terminal', 'Alpha: notes, kept local', 'Alpha: start'])
  await shot('03-unpushed-merge')

  await push()
  await expect(group()).toHaveCount(0)
  // Pushed, the branch's own line again: the merge row (with what it brought in) over the local commit.
  await expect(subjects(history())).toHaveText(['Merge origin/main', 'Alpha: local work', 'Alpha: plan, from a terminal', 'Alpha: notes, kept local', 'Alpha: start'])
  await expect(history().getByTestId(`git-commit-${merge}`)).toHaveAttribute('data-merge', 'true')
  await history().getByTestId(`git-merge-toggle-${merge}`).click()
  await expect(subjects(view().getByTestId(`git-merge-inner-${merge}`))).toHaveText(['Other: remote work'])
})

test('a branch with no upstream never shows the group — its commits are in History', async () => {
  g(fx.alpha, 'switch', '-q', '-c', 'topic')
  await commitOutside(fx.alpha, 'topic.md', '# Topic\n', 'Alpha: topic work')
  await expect(view().getByTestId('git-repo-branch')).toContainText('topic')
  await expect(subjects(history()).first()).toHaveText('Alpha: topic work')
  await expect(group()).toHaveCount(0)
  g(fx.alpha, 'switch', '-q', 'main')
  await expect(view().getByTestId('git-repo-branch')).toContainText('main')
})

test('a repo with no remote never shows the group', async () => {
  await selectProject(fx.projects.beta)
  await commitOutside(fx.beta, 'later.md', '# Later\n', 'Beta: later')
  await expect(subjects(history())).toHaveText(['Beta: later', 'Beta: start'])
  await expect(group()).toHaveCount(0)
})
