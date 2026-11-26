// modules: git, core
// T-255 e2e — the branch tab's actions explain themselves on hover. A `<Tooltip>` around the shared
// `Button` shows (the Button forwards its ref to the <button> the tip anchors on), and a DISABLED
// action's tip shows too — it carries the reason the action is blocked. Open folder and Open terminal
// there have tips. Fixture repos with local bare remotes (e2e/fixtures/git-branch-repos.ts), plus a
// branch whose work is already in main (every action but Remove blocked) and a GitHub branch that is
// not on the remote yet. "An agent is working here" is checked in git-branches-agent.spec.ts.
// Set POMADE_T255_SHOTS=<dir> for screenshots.

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

const SHOTS = process.env.POMADE_T255_SHOTS

async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

async function selectProject(id: string): Promise<void> {
  await page.getByTestId(`project-${id}`).click()
  await expect(page.getByTestId('panehost')).toHaveAttribute('data-active-project', id)
  await showGitPanel(page)
  await expect(page.getByTestId('git-panel')).toBeVisible()
}

const view = (): ReturnType<Page['locator']> => page.getByTestId('git-repo-view')
const pane = (): ReturnType<Page['locator']> => page.locator('[data-testid="branch-pane"]:visible')

async function openBranch(name: string): Promise<void> {
  await view().getByTestId(`git-progress-${name}`).click()
  await expect(pane()).toHaveAttribute('data-branch', name)
  await expect(pane().getByTestId('branch-actions')).toBeVisible()
}

/** Hover an action and read the shown tip's lines; the pointer leaving removes the tip. */
async function hoverTip(testId: string, enabled: boolean): Promise<string[]> {
  const button = pane().getByTestId(testId)
  await (enabled ? expect(button).toBeEnabled() : expect(button).toBeDisabled())
  await page.mouse.move(0, 0)
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await button.hover()
  const tip = page.getByRole('tooltip')
  await expect(tip).toHaveCount(1)
  return tip.locator('span').allTextContents()
}

async function leave(): Promise<void> {
  await page.mouse.move(0, 0)
  await expect(page.getByRole('tooltip')).toHaveCount(0)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  fx = await createBranchFixture()
  // A worktree on a branch whose work is already in main (no commits to merge, nothing to rebase), and a GitHub
  // branch that is not on the remote yet (no page to open).
  gitIn(fx.scratch, fx.alpha, 'worktree', 'add', '-q', '-b', 'landed', join(fx.scratch, 'landed-wt'))
  gitIn(fx.scratch, fx.gamma, 'branch', 'feature-y', 'feature-x')
  ;({ app, page } = await launchAppPage(fx, fx.env))
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fx?.cleanupGit()
})

test('Enabled actions: Merge, Rebase and Check out to a worktree explain themselves, with the glossary lines', async () => {
  await selectProject(fx.projects.alpha)
  await openBranch('feature')
  expect((await hoverTip('branch-merge', true))[0]).toBe('Land it on main — as one commit, or with a merge commit')
  await expect(page.getByRole('tooltip').locator('span')).toHaveCount(3)
  await shot('t255-merge-enabled')
  await leave()
  expect((await hoverTip('branch-rebase', true))[0]).toBe('Put its commits on top of main’s newest')
  await expect(page.getByRole('tooltip').locator('span')).toHaveCount(3)
  await leave()
  const worktree = await hoverTip('branch-worktree', true)
  expect(worktree[0]).toBe('Check it out in its own folder, outside the repository — this checkout stays as it is')
  expect(worktree).toHaveLength(3)
  await leave()
})

test('Open folder and Open terminal there have tips', async () => {
  await openBranch('agent/t1')
  expect(await hoverTip('branch-open-folder', true)).toEqual(['Show its folder — in Files when it is inside this project, otherwise in Finder'])
  await shot('t255-open-folder')
  await leave()
  expect(await hoverTip('branch-open-terminal', true)).toEqual(['Open a terminal in its folder'])
  await leave()
})

test('Disabled actions: the tip shows and says why the action is blocked', async () => {
  await openBranch('landed')
  expect(await hoverTip('branch-merge', false)).toEqual(['Nothing to merge — its work is already in main.'])
  await shot('t255-merge-disabled')
  await leave()
  expect(await hoverTip('branch-rebase', false)).toEqual(['Already up to date with main — nothing to put it on top of.'])
  await leave()
  // Remove stays available for work that has landed — and explains itself.
  expect(await hoverTip('branch-remove', true)).toEqual(['Its work is in main: remove the branch, and its worktree folder'])
  await leave()
})

test('Open on GitHub: the tip when it is available, the reason when the branch is not on the remote yet', async () => {
  await selectProject('__workspace__')
  await page.getByTestId('git-repo-row-Apps/gamma').click()
  await expect(view()).toHaveAttribute('data-repo', 'Apps/gamma')
  await openBranch('feature-x')
  expect(await hoverTip('branch-open-pr', true)).toEqual(['Open the page that starts a pull request for it, in the browser'])
  await leave()
  await openBranch('feature-y')
  expect(await hoverTip('branch-open-pr', false)).toEqual([
    'It is not on GitHub yet — publish it first (switch to it, then ⋯ › Publish branch…)'
  ])
  await shot('t255-open-pr-disabled')
  await leave()
})

test('The tip is anchored on the button: no layout change, and it sits under the button', async () => {
  await openBranch('feature-x')
  const button = pane().getByTestId('branch-open-pr')
  const before = await button.boundingBox()
  await hoverTip('branch-open-pr', true)
  const box = await button.boundingBox()
  expect(box).toEqual(before)
  const tipBox = await page.getByRole('tooltip').boundingBox()
  expect(tipBox!.y).toBeGreaterThanOrEqual(box!.y + box!.height - 1)
  expect(tipBox!.x + tipBox!.width / 2).toBeGreaterThan(box!.x)
  expect(tipBox!.x).toBeLessThan(box!.x + box!.width)
})
