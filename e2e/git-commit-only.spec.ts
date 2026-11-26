// modules: git, core
// Pomade T-221 e2e — commit without pushing on a repo with a remote, on fixture repos with LOCAL
// BARE remotes (e2e/fixtures/git-ops-repos.ts): the commit box's "Push after committing" drives the
// preview line and the button; off → the commit lands and the remote is untouched (↑1); the box
// opens with it on again and the default flow pushes; Commit staged follows the same choice. Every
// ticket Acceptance bullet is an assertion here. Set POMADE_T221_SHOTS=<dir> for screenshots.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { launchAppPage } from './fixtures/app'
import { createGitOpsFixture, gitIn, write, type GitOpsFixture } from './fixtures/git-ops-repos'
import { showGitPanel } from './fixtures/panels'

let fx: GitOpsFixture
let app: ElectronApplication
let page: Page

const SHOTS = process.env.POMADE_T221_SHOTS

async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  for (const t of await page.getByTestId('toast').all()) await t.click({ timeout: 500 }).catch(() => {})
  await view().getByTestId('git-commit-box').screenshot({ path: join(SHOTS, `${name}-box.png`) })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

const g = (cwd: string, ...args: string[]): string => gitIn(fx.scratch, cwd, ...args).trim()
const head = (cwd: string, rev = 'HEAD'): string => g(cwd, 'rev-parse', rev)
const remoteMain = (): string => g(fx.remote, 'rev-parse', 'refs/heads/main')
const subject = (cwd: string, rev = 'HEAD'): string => g(cwd, 'log', '-1', '--format=%s', rev)
const where = (): string => fx.remote.replace(/\.git$/, '')

const view = (): ReturnType<Page['locator']> => page.getByTestId('git-repo-view')
const box = (): ReturnType<Page['locator']> => view().getByTestId('git-commit-box')
const toast = (text: string | RegExp): ReturnType<Page['locator']> => page.getByTestId('toast').filter({ hasText: text })
const ahead = (): ReturnType<Page['locator']> => view().getByTestId('git-ahead-Projects/alpha')

async function selectProject(id: string): Promise<void> {
  await page.getByTestId(`project-${id}`).click()
  await expect(page.getByTestId('panehost')).toHaveAttribute('data-active-project', id)
  await showGitPanel(page)
  await expect(page.getByTestId('git-panel')).toBeVisible()
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

test('Push after committing off: the commit lands, nothing is pushed — ↑1 and the remote unchanged', async () => {
  await write(join(fx.alpha, 'notes.md'), '# Notes\n\nLocal only for now.\n')
  await selectProject(fx.projects.alpha)
  await expect(view().getByTestId('git-changes-count')).toHaveText('1')
  const remoteBefore = remoteMain()
  const before = head(fx.alpha)

  await view().getByTestId('git-commit-open').click()
  // With a remote, the box offers the choice — on by default, the button and line say push.
  await expect(box().getByTestId('git-commit-push-after')).toBeChecked()
  await expect(box().getByTestId('git-commit-preview')).toHaveText(`This will commit 1 file and push 1 commit to ${where()} (origin/main).`)
  await expect(box().getByTestId('git-commit-run')).toHaveText('Commit & push')
  await box().getByTestId('git-commit-message').fill('Alpha: notes, kept local')
  await shot('commit-box-push-on')

  await box().getByTestId('git-commit-push-after').uncheck()
  await expect(box().getByTestId('git-commit-preview')).toHaveText('This will commit 1 file. Nothing is pushed — the commit stays on this Mac until you push.')
  await expect(box().getByTestId('git-commit-run')).toHaveText('Commit')
  await shot('commit-box-push-off')
  await expect(box().getByTestId('git-commit-run')).toBeEnabled()
  await box().getByTestId('git-commit-run').click()

  await expect(box()).toHaveCount(0)
  await expect(toast(/^Committed [0-9a-f]{7} — not pushed\.$/)).toBeVisible()
  expect(subject(fx.alpha)).toBe('Alpha: notes, kept local')
  expect(head(fx.alpha, 'HEAD^')).toBe(before)
  expect(remoteMain()).toBe(remoteBefore)
  await expect(view().getByTestId('git-changes-empty')).toBeVisible()
  await expect(ahead()).toHaveAttribute('data-count', '1')
})

test('The box opens with Push after committing on again; the default flow pushes both commits', async () => {
  await write(join(fx.alpha, 'plan.md'), '# Plan\n\nShip it.\n')
  await expect(view().getByTestId('git-changes-count')).toHaveText('1')
  await view().getByTestId('git-commit-open').click()
  await expect(box().getByTestId('git-commit-push-after')).toBeChecked()
  await expect(box().getByTestId('git-commit-preview')).toHaveText(`This will commit 1 file and push 2 commits to ${where()} (origin/main).`)
  await expect(box().getByTestId('git-commit-run')).toHaveText('Commit & push')
  await box().getByTestId('git-commit-message').fill('Alpha: plan')
  await box().getByTestId('git-commit-run').click()

  await expect(box()).toHaveCount(0)
  await expect(toast(/^Committed [0-9a-f]{7} and pushed to .+ \(origin\/main\)\.$/)).toBeVisible()
  expect(remoteMain()).toBe(head(fx.alpha))
  expect(subject(fx.alpha, 'origin/main^')).toBe('Alpha: notes, kept local')
  await expect(ahead()).toHaveCount(0)
})

test('Commit staged follows the choice: on → commits only the staged file and pushes it; off → nothing is pushed', async () => {
  await write(join(fx.alpha, 'README.md'), '# Alpha\n\nStaged and pushed.\n')
  await write(join(fx.alpha, 'todo.md'), '# Todo\n')
  await expect(view().getByTestId('git-changes-count')).toHaveText('2')
  const row = view().getByTestId('git-change-Projects/alpha/README.md')
  await row.hover()
  await row.getByTestId('git-stage-Projects/alpha/README.md').click()
  await expect(view().getByTestId('git-staged-count')).toHaveText('1')

  await view().getByTestId('git-commit-open').click()
  await expect(box().getByTestId('git-commit-push-after')).toBeChecked()
  await expect(box().getByTestId('git-commit-staged-preview')).toHaveText(
    `This will commit the staged file (README.md) and push 1 commit to ${where()} (origin/main). 1 other change stays uncommitted.`
  )
  await expect(box().getByTestId('git-commit-staged-line')).toContainText('Commit staged & push')
  await expect(box().getByTestId('git-commit-staged-run')).toHaveText('Commit staged & push')
  await expect(box().getByTestId('git-commit-run')).toHaveText('Commit & push')
  await box().getByTestId('git-commit-message').fill('Alpha: readme, staged')
  await shot('commit-staged-push-on')

  // Off and on again: the labels and the line follow the box each time.
  await box().getByTestId('git-commit-push-after').uncheck()
  await expect(box().getByTestId('git-commit-staged-run')).toHaveText('Commit staged')
  await expect(box().getByTestId('git-commit-run')).toHaveText('Commit')
  await expect(box().getByTestId('git-commit-staged-preview')).toHaveText(
    'This will commit the staged file (README.md). 1 other change stays uncommitted; nothing is pushed.'
  )
  await shot('commit-staged-push-off')
  await box().getByTestId('git-commit-push-after').check()
  await expect(box().getByTestId('git-commit-staged-preview')).toContainText('and push 1 commit to')
  await expect(box().getByTestId('git-commit-staged-run')).toBeEnabled()
  await box().getByTestId('git-commit-staged-run').click()

  await expect(box()).toHaveCount(0)
  await expect(toast(/^Committed [0-9a-f]{7} — 1 staged file — and pushed to .+ \(origin\/main\)\. 1 other change stays uncommitted\.$/)).toBeVisible()
  expect(subject(fx.alpha)).toBe('Alpha: readme, staged')
  expect(g(fx.alpha, 'show', '--name-only', '--format=', 'HEAD')).toBe('README.md')
  expect(remoteMain()).toBe(head(fx.alpha))
  expect(g(fx.alpha, 'status', '--porcelain')).toBe('?? todo.md')

  // Staged again, Push after committing off: committed, the remote stays where it was.
  const remoteBefore = remoteMain()
  const todo = view().getByTestId('git-change-Projects/alpha/todo.md')
  await todo.hover()
  await todo.getByTestId('git-stage-Projects/alpha/todo.md').click()
  await expect(view().getByTestId('git-staged-count')).toHaveText('1')
  await view().getByTestId('git-commit-open').click()
  await box().getByTestId('git-commit-push-after').uncheck()
  await expect(box().getByTestId('git-commit-staged-preview')).toHaveText('This will commit the staged file (todo.md). Nothing is pushed.')
  await box().getByTestId('git-commit-message').fill('Alpha: todo, staged, local')
  await expect(box().getByTestId('git-commit-staged-run')).toBeEnabled()
  await box().getByTestId('git-commit-staged-run').click()
  await expect(box()).toHaveCount(0)
  await expect(toast(/^Committed [0-9a-f]{7} — 1 staged file\.$/)).toBeVisible()
  expect(subject(fx.alpha)).toBe('Alpha: todo, staged, local')
  expect(remoteMain()).toBe(remoteBefore)
  await expect(ahead()).toHaveAttribute('data-count', '1')
})

test('No remote: no choice offered — the commit stays on this Mac, as before', async () => {
  await selectProject(fx.projects.beta)
  await write(join(fx.beta, 'local.md'), '# Local\n')
  await expect(view().getByTestId('git-commit-open')).toHaveText('Commit…')
  await view().getByTestId('git-commit-open').click()
  await expect(box().getByTestId('git-commit-preview')).toContainText('No remote — the commit stays on this Mac.')
  await expect(box().getByTestId('git-commit-push-after')).toHaveCount(0)
  await expect(box().getByTestId('git-commit-run')).toHaveText('Commit')
  await box().getByTestId('git-commit-cancel').click()
})
