// modules: git, core
// Pomade E-041 e2e — branches and worktrees, on fixture repos with LOCAL BARE remotes
// (e2e/fixtures/git-branch-repos.ts): In progress lists an agent-like worktree, local branches and a
// remote-only branch (fetched in the background when the panel opens) with correct counts; a row
// opens its branch tab (commits, total change, a file opens the comparison); Check out to a
// worktree puts a remote branch in a new folder and leaves the repo's own checkout exactly as it
// was; Merge into main stopping on a conflict opens the conflict tab, Abort puts everything back
// exactly, and combining it there lands it; Squash-merge lands one commit with the typed message,
// History shows one row and the offer removes the branch and its worktree; Rebase a branch not
// checked out (a temporary worktree); Open on GitHub hands the compare URL to the browser (stubbed
// in test mode). Set POMADE_E041_SHOTS=<dir> for screenshots.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { launchAppPage } from './fixtures/app'
import { createBranchFixture, type BranchFixture } from './fixtures/git-branch-repos'
import { gitIn } from './fixtures/git-ops-repos'
import { showGitPanel } from './fixtures/panels'

let fx: BranchFixture
let app: ElectronApplication
let page: Page

const SHOTS = process.env.POMADE_E041_SHOTS

async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  for (const t of await page.getByTestId('toast').all()) await t.click({ timeout: 500 }).catch(() => {})
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

const g = (cwd: string, ...args: string[]): string => gitIn(fx.scratch, cwd, ...args).trim()
const head = (cwd: string, rev = 'HEAD'): string => g(cwd, 'rev-parse', rev)
const exists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false)

/** "Exactly as before": HEAD, the branch, the index, the full porcelain v2 status, and the bytes of
 *  every tracked and untracked file. */
async function exactState(cwd: string): Promise<string> {
  const files = g(cwd, 'ls-files', '-co', '--exclude-standard').split('\n').filter(Boolean).sort()
  const contents = await Promise.all(files.map(async (f) => `${f}\n${await fs.readFile(join(cwd, f), 'utf8')}`))
  return [
    head(cwd),
    g(cwd, 'symbolic-ref', 'HEAD'),
    g(cwd, 'ls-files', '-s'),
    g(cwd, 'status', '--porcelain=v2', '--branch', '--untracked-files=all', '--ignored=matching'),
    ...contents
  ].join('\n---\n')
}

async function selectProject(id: string): Promise<void> {
  await page.getByTestId(`project-${id}`).click()
  await expect(page.getByTestId('panehost')).toHaveAttribute('data-active-project', id)
  await showGitPanel(page)
  await expect(page.getByTestId('git-panel')).toBeVisible()
}

const view = (): ReturnType<Page['locator']> => page.getByTestId('git-repo-view')
const dialog = (): ReturnType<Page['locator']> => page.getByTestId('git-op-dialog')
const row = (name: string): ReturnType<Page['locator']> => view().getByTestId(`git-progress-${name}`)
const branchPane = (): ReturnType<Page['locator']> => page.locator('[data-testid="branch-pane"]:visible')
const toast = (text: string | RegExp): ReturnType<Page['locator']> => page.getByTestId('toast').filter({ hasText: text })

async function openBranch(name: string): Promise<void> {
  await row(name).click()
  await expect(branchPane()).toHaveAttribute('data-branch', name)
  await expect(branchPane().getByTestId('branch-actions')).toBeVisible()
}

async function runDialog(): Promise<void> {
  await expect(dialog().getByTestId('git-op-run')).toBeEnabled()
  await dialog().getByTestId('git-op-run').click()
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  fx = await createBranchFixture()
  ;({ app, page } = await launchAppPage(fx, fx.env))
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fx?.cleanupGit()
})

test('In progress: a worktree, local branches, and a remote-only branch fetched in the background — with counts, local rows first', async () => {
  expect(g(fx.alpha, 'branch', '-r')).not.toContain('origin/colleague')
  await selectProject(fx.projects.alpha)
  await expect(view().getByTestId('git-progress')).toBeVisible()

  await expect(row('agent/t1')).toHaveAttribute('data-kind', 'worktree')
  await expect(row('agent/t1')).toHaveAttribute('data-ahead', '2')
  await expect(row('agent/t1')).toHaveAttribute('data-behind', '1')
  await expect(view().getByTestId('git-progress-counts-agent/t1')).toHaveText('2 ahead · 1 behind')
  await expect(row('feature')).toHaveAttribute('data-kind', 'branch')
  await expect(row('feature')).toHaveAttribute('data-ahead', '2')
  await expect(row('stale')).toHaveAttribute('data-ahead', '1')
  await expect(row('stale')).toHaveAttribute('data-behind', '1')

  // Opening the panel fetched: the colleague's branch is there, under Remote, after every local row.
  await expect(row('origin/colleague')).toHaveAttribute('data-kind', 'remote', { timeout: 15000 })
  await expect(row('origin/colleague')).toHaveAttribute('data-ahead', '3')
  await expect(row('origin/colleague')).toHaveAttribute('data-behind', '2')
  expect(g(fx.alpha, 'branch', '-r')).toContain('origin/colleague')
  await expect(view().getByTestId('git-progress-remote')).toContainText('Remote')
  const order = await view()
    .getByTestId('git-progress-list')
    .locator('[data-testid^="git-progress-"][data-kind]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
  // Most recent first within local (the worktree's commits are newest), then remote.
  expect(order).toEqual(['git-progress-agent/t1', 'git-progress-feature', 'git-progress-stale', 'git-progress-origin/colleague'])
  await expect(view().getByTestId('git-progress-count')).toHaveText('4')
  await shot('e041-in-progress')
})

test('A row opens its branch tab: commits main lacks, the total change, a file opens the comparison; no Remove for an unmerged branch', async () => {
  await openBranch('feature')
  await expect(branchPane().getByTestId('branch-kind')).toHaveText('Branch')
  await expect(branchPane().getByTestId('branch-counts')).toHaveText('2 ahead · 1 behind')
  await expect(branchPane().getByTestId('branch-commits-count')).toHaveText('2')
  await expect(branchPane().getByTestId('branch-files-count')).toHaveText('2')
  await expect(branchPane().getByTestId('branch-remove')).toHaveCount(0)
  await shot('e041-branch-tab')
  await branchPane().getByTestId('branch-file-Projects/alpha/intro.md').click()
  await expect(page.locator('[data-testid="compare-pane"]:visible')).toBeVisible()
  await expect(page.locator('[data-testid="compare-pane"]:visible')).toContainText('The feature’s first line.')
})

test('Check out the remote branch to a worktree: a new folder on that branch; the repo’s own checkout untouched', async () => {
  const before = await exactState(fx.alpha)
  await openBranch('origin/colleague')
  await branchPane().getByTestId('branch-worktree').click()
  const folder = join(fx.worktrees, 'alpha', 'colleague')
  await expect(dialog().getByTestId('git-op-preview')).toHaveText(
    `This will make a local “colleague” from origin/colleague (it follows it) and check it out in a new worktree folder, ${folder}. This checkout stays exactly as it is.`
  )
  await shot('e041-worktree-dialog')
  await runDialog()
  await expect(dialog()).toHaveCount(0)
  await expect(toast(`Checked out “colleague” in ${folder}.`)).toBeVisible()
  expect(g(folder, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('colleague')
  expect(g(folder, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/colleague')
  expect(await exists(join(folder, 'colleague-3.md'))).toBe(true)
  expect(await exactState(fx.alpha)).toBe(before)
  // It is a worktree now; the remote row went (a local branch follows it).
  await expect(row('colleague')).toHaveAttribute('data-kind', 'worktree')
  await expect(row('origin/colleague')).toHaveCount(0)
})

test('Merge into main stopping on a conflict: the conflict tab, then Abort — everything exactly as before', async () => {
  const before = await exactState(fx.alpha)
  await openBranch('feature')
  await branchPane().getByTestId('branch-merge').click()
  await expect(dialog().getByTestId('git-op-preview')).toContainText('This lands 2 commits from “feature” as 1 commit on main (squash merge).')
  await dialog().getByTestId('git-merge-mode-merge').click()
  await expect(dialog().getByTestId('git-op-preview')).toContainText('This lands 2 commits from “feature” on main with a merge commit that keeps them.')
  await expect(dialog().getByTestId('git-merge-message')).toHaveValue('feature\n\n- Feature: rewrite intro\n- Feature: add page\n')
  await runDialog()
  const pane = page.locator('[data-testid="conflict-pane"]:visible')
  await expect(pane).toHaveAttribute('data-kind', 'merge')
  await expect(pane.getByTestId('conflict-summary')).toContainText('Landing feature on main.')
  await expect(pane.getByTestId('conflict-label-theirs')).toContainText('Main')
  await expect(pane.getByTestId('conflict-label-yours')).toContainText('feature')
  await expect(pane.getByTestId('conflict-theirs-0')).toContainText('Main’s first line.')
  await expect(pane.getByTestId('conflict-yours-0')).toContainText('The feature’s first line.')
  await expect(view().getByTestId('git-op-bar')).toHaveAttribute('data-operation', 'merge')
  await shot('e041-merge-conflict')

  await pane.getByTestId('conflict-abort').click()
  await expect(dialog().getByTestId('git-op-preview')).toHaveText(
    'This puts everything back exactly as before the merge: main and your files as they were (abort). Pomade checks it afterwards.'
  )
  await runDialog()
  await expect(dialog()).toHaveCount(0)
  await expect(toast('Back to before — “feature” did not land; main is exactly as it was (checked).')).toBeVisible()
  expect(await exactState(fx.alpha)).toBe(before)
})

test('Combine it in the conflict tab and finish: a merge commit lands it; the offer removes the branch (its tip is in main)', async () => {
  const before = head(fx.alpha)
  await openBranch('feature')
  await branchPane().getByTestId('branch-merge').click()
  await dialog().getByTestId('git-merge-mode-merge').click()
  await runDialog()
  const pane = page.locator('[data-testid="conflict-pane"]:visible')
  await expect(pane).toHaveAttribute('data-kind', 'merge')
  await pane.getByTestId('conflict-take-yours-0').click()
  await expect(pane.getByTestId('conflict-preview')).toHaveText('This will save the result as intro.md, mark it resolved, then commit the merge.')
  await pane.getByTestId('conflict-resolve').click()

  // Landed: the dialog offers the removal.
  await expect(dialog()).toContainText('Landed — remove branch and worktree?')
  await expect(dialog().getByTestId('git-op-preview')).toHaveText('“feature” is in main (its commits are there). This removes the branch.')
  const landed = head(fx.alpha)
  expect(g(fx.alpha, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toEqual([landed, before, head(fx.alpha, 'feature')])
  expect(g(fx.alpha, 'log', '-1', '--format=%B')).toBe('feature\n\n- Feature: rewrite intro\n- Feature: add page')
  await expect(fs.readFile(join(fx.alpha, 'intro.md'), 'utf8')).resolves.toBe('# Intro\n\nThe feature’s first line.\n')
  await runDialog()
  await expect(dialog()).toHaveCount(0)
  expect(g(fx.alpha, 'branch', '--list', 'feature')).toBe('')
  await expect(row('feature')).toHaveCount(0)
})

test('Squash-merge the agent’s worktree branch: one commit with the message, one History row; the offer removes branch and worktree', async () => {
  const before = head(fx.alpha)
  await openBranch('agent/t1')
  await expect(branchPane().getByTestId('branch-kind')).toHaveText('Worktree')
  await expect(branchPane().getByTestId('branch-path')).toHaveText(fx.agentWt)
  await branchPane().getByTestId('branch-merge').click()
  await expect(dialog().getByTestId('git-op-preview')).toContainText('This lands 2 commits from “agent/t1” as 1 commit on main (squash merge).')
  await expect(dialog().getByTestId('git-merge-message')).toHaveValue('agent/t1\n\n- Agent: add notes\n- Agent: expand notes\n')
  await dialog().getByTestId('git-merge-message').fill('T1 Agent notes\n\nWhat the agent wrote.')
  await shot('e041-squash-dialog')
  await runDialog()

  await expect(dialog()).toContainText('Landed — remove branch and worktree?')
  const landed = head(fx.alpha)
  expect(g(fx.alpha, 'rev-list', '--count', `${before}..HEAD`)).toBe('1')
  expect(g(fx.alpha, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toEqual([landed, before])
  expect(g(fx.alpha, 'log', '-1', '--format=%B')).toBe('T1 Agent notes\n\nWhat the agent wrote.')
  await expect(fs.readFile(join(fx.alpha, 'agent.md'), 'utf8')).resolves.toBe('# Agent\n\nMore notes.\n')
  await expect(dialog().getByTestId('git-op-preview')).toHaveText(
    `“agent/t1” is in main (landed as ${landed.slice(0, 7)}). This removes the branch and its worktree folder ${fx.agentWt}.`
  )
  // History: one new row for the landing.
  await expect(view().getByTestId(`git-commit-${landed.slice(0, 7)}`)).toContainText('T1 Agent notes')
  await expect(view().getByTestId(`git-commit-${head(fx.alpha, 'agent/t1').slice(0, 7)}`)).toHaveCount(0)
  await shot('e041-landed-offer')

  await runDialog()
  await expect(dialog()).toHaveCount(0)
  await expect(toast('Removed “agent/t1” and its worktree — its work is in main.')).toBeVisible()
  expect(await exists(fx.agentWt)).toBe(false)
  expect(g(fx.alpha, 'branch', '--list', 'agent/t1')).toBe('')
  await expect(row('agent/t1')).toHaveCount(0)
})

test('Rebase a branch that is checked out nowhere onto main — in a temporary worktree, gone afterwards', async () => {
  const worktreesBefore = g(fx.alpha, 'worktree', 'list', '--porcelain')
  await openBranch('stale')
  await branchPane().getByTestId('branch-rebase').click()
  await expect(dialog().getByTestId('git-op-preview')).toHaveText(
    'This will put “stale”’s 1 commit on top of main’s 5 newer commits (rebase), in a temporary folder — this checkout is untouched. If their changes conflict with its own, nothing changes.'
  )
  await runDialog()
  await expect(dialog()).toHaveCount(0)
  await expect(toast('Put “stale”’s 1 commit on top of main (5 new commits).')).toBeVisible()
  expect(g(fx.alpha, 'merge-base', 'main', 'stale')).toBe(head(fx.alpha, 'main'))
  expect(g(fx.alpha, 'worktree', 'list', '--porcelain')).toBe(worktreesBefore)
  await expect(row('stale')).toHaveAttribute('data-behind', '0')
})

test('Open on GitHub opens the compare page of a github.com remote (the browser stubbed)', async () => {
  await selectProject('__workspace__')
  await page.getByTestId('git-repo-row-Apps/gamma').click()
  await expect(view()).toHaveAttribute('data-repo', 'Apps/gamma')
  await openBranch('feature-x')
  await expect(branchPane().getByTestId('branch-open-pr')).toHaveText('Open on GitHub')
  await branchPane().getByTestId('branch-open-pr').click()
  await expect
    .poll(() => app.evaluate(() => globalThis.__pomadeOpenedUrls ?? []))
    .toContain('https://github.com/pomade-test/gamma/compare/main...feature-x?expand=1')
  // A local-only repository offers no hand-off.
  await selectProject(fx.projects.beta)
  await expect(view().getByTestId('git-progress-empty')).toBeVisible()
})
