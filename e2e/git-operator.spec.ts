// modules: git, core
// Pomade E-040 e2e — the git operator layer, on fixture repos with LOCAL BARE remotes
// (e2e/fixtures/git-ops-repos.ts): staging and Commit staged, New branch + Publish branch, Rebase
// onto main stopping on a conflict — Abort back to EXACTLY the state before (HEAD, branch, porcelain
// v2 status, the index, file contents) and the three-column conflict tab resolving and continuing
// it — Switch branch refusing to replace an uncommitted change with commit / discard offered, and
// Fetch + Pull stopping on a conflict and aborted. Every ticket Acceptance bullet is an assertion
// here. Set POMADE_E040_SHOTS=<dir> for screenshots.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { GIT_GLOSSARY } from '../src/shared/git-glossary'
import { launchAppPage } from './fixtures/app'
import { createGitOpsFixture, gitIn, write, type GitOpsFixture } from './fixtures/git-ops-repos'
import { showGitPanel } from './fixtures/panels'

let fx: GitOpsFixture
let app: ElectronApplication
let page: Page

const SHOTS = process.env.POMADE_E040_SHOTS

async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  for (const t of await page.getByTestId('toast').all()) await t.click({ timeout: 500 }).catch(() => {})
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

const g = (cwd: string, ...args: string[]): string => gitIn(fx.scratch, cwd, ...args).trim()
const head = (cwd: string, rev = 'HEAD'): string => g(cwd, 'rev-parse', rev)
const subject = (cwd: string, rev = 'HEAD'): string => g(cwd, 'log', '-1', '--format=%s', rev)
const gitDirHas = (cwd: string, entry: string): Promise<boolean> => fs.access(join(cwd, '.git', entry)).then(() => true, () => false)

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
const pane = (): ReturnType<Page['locator']> => page.getByTestId('conflict-pane')
const toast = (text: string | RegExp): ReturnType<Page['locator']> => page.getByTestId('toast').filter({ hasText: text })

async function openMenu(item: string): Promise<void> {
  await view().getByTestId('git-repo-menu').click()
  await page.getByTestId(item).click()
  await expect(dialog()).toBeVisible()
}

async function runDialog(): Promise<void> {
  await expect(dialog().getByTestId('git-op-run')).toBeEnabled()
  await dialog().getByTestId('git-op-run').click()
  // The dialog closes when the real git run (a push, a pull against the fixture remote) ends —
  // seconds on a loaded machine with the suite's parallel workers.
  await expect(dialog()).toHaveCount(0, { timeout: 30_000 })
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

test('Staging: stage one of two changed files → Staged / Unstaged groups → Commit staged commits only it', async () => {
  await write(join(fx.alpha, 'README.md'), '# Alpha\n\nStaged edit.\n')
  await write(join(fx.alpha, 'plan.md'), '# Plan\n')
  await selectProject(fx.projects.alpha)
  await expect(view().getByTestId('git-changes-count')).toHaveText('2')
  // No staging yet: one list, no group titles.
  await expect(view().getByTestId('git-staged')).toHaveCount(0)

  const row = view().getByTestId('git-change-Projects/alpha/README.md')
  await row.hover()
  await row.getByTestId('git-stage-Projects/alpha/README.md').hover()
  await expect(page.getByTestId('git-stage-tip-Projects/alpha/README.md')).toContainText(GIT_GLOSSARY.stage.line)
  await row.getByTestId('git-stage-Projects/alpha/README.md').click()
  await expect(toast('Staged README.md.')).toBeVisible()
  await expect(view().getByTestId('git-staged-count')).toHaveText('1')
  await expect(view().getByTestId('git-unstaged-count')).toHaveText('1')
  await expect(view().getByTestId('git-staged-Projects/alpha/README.md')).toBeVisible()
  await expect(view().getByTestId('git-unstaged').getByTestId('git-change-Projects/alpha/plan.md')).toBeVisible()
  expect(g(fx.alpha, 'diff', '--cached', '--name-only')).toBe('README.md')

  // Unstage and stage again: the index follows.
  const staged = view().getByTestId('git-staged-Projects/alpha/README.md')
  await staged.hover()
  await staged.getByTestId('git-unstage-Projects/alpha/README.md').click()
  await expect(view().getByTestId('git-staged')).toHaveCount(0)
  expect(g(fx.alpha, 'diff', '--cached', '--name-only')).toBe('')
  await row.hover()
  await row.getByTestId('git-stage-Projects/alpha/README.md').click()
  await expect(view().getByTestId('git-staged-count')).toHaveText('1')

  const before = head(fx.alpha)
  await view().getByTestId('git-commit-open').click()
  await expect(view().getByTestId('git-commit-preview')).toContainText('This will commit 2 files and push')
  // Commit only: "Push after committing" off — both lines say nothing is pushed.
  await view().getByTestId('git-commit-push-after').uncheck()
  await expect(view().getByTestId('git-commit-staged-preview')).toHaveText(
    'This will commit the staged file (README.md). 1 other change stays uncommitted; nothing is pushed.'
  )
  await expect(view().getByTestId('git-commit-preview')).toContainText('This will commit 2 files. Nothing is pushed')
  await expect(view().getByTestId('git-commit-staged-run')).toBeDisabled()
  await view().getByTestId('git-commit-message').fill('Alpha: readme only')
  await shot('commit-staged-box')
  await view().getByTestId('git-commit-staged-run').click()
  await expect(view().getByTestId('git-commit-box')).toHaveCount(0)
  await expect(toast(/^Committed [0-9a-f]{7} — 1 staged file\. 1 other change stays uncommitted\.$/)).toBeVisible()

  expect(head(fx.alpha, 'HEAD^')).toBe(before)
  expect(subject(fx.alpha)).toBe('Alpha: readme only')
  expect(g(fx.alpha, 'show', '--name-only', '--format=', 'HEAD')).toBe('README.md')
  expect(g(fx.alpha, 'status', '--porcelain')).toBe('?? plan.md')
  await expect(view().getByTestId('git-staged')).toHaveCount(0)
  await expect(view().getByTestId('git-changes-count')).toHaveText('1')
  // Nothing was pushed: the commit is one ahead of the remote.
  await expect(view().getByTestId('git-ahead-Projects/alpha')).toHaveAttribute('data-count', '1')
  await fs.rm(join(fx.alpha, 'plan.md'))
  await expect(view().getByTestId('git-changes-empty')).toBeVisible()
  // Send it, so main and origin/main agree for what follows.
  g(fx.alpha, 'push', '-q')
})

test('New branch, commit, Publish branch → the remote has the branch and it follows it (upstream)', async () => {
  await openMenu('git-menu-new-branch')
  await expect(dialog().getByTestId('git-op-blocked')).toContainText('Name the branch')
  await dialog().getByTestId('git-branch-name').fill('bad name')
  await expect(dialog().getByTestId('git-op-blocked')).toContainText('can’t be a branch name')
  await dialog().getByTestId('git-branch-name').fill('main')
  await expect(dialog().getByTestId('git-op-blocked')).toContainText('A branch “main” already exists')
  await dialog().getByTestId('git-branch-name').fill('feature/x')
  await expect(dialog().getByTestId('git-op-preview')).toHaveText(
    new RegExp(`^This will create the branch “feature/x” from main \\(${head(fx.alpha).slice(0, 7)}\\) and switch to it\\.$`)
  )
  await shot('new-branch')
  await runDialog()
  await expect(toast('Created “feature/x” and switched to it.')).toBeVisible()
  await expect(view().getByTestId('git-repo-branch')).toContainText('feature/x')
  expect(g(fx.alpha, 'symbolic-ref', '--short', 'HEAD')).toBe('feature/x')
  // Not published yet: no upstream, and the panel says so.
  await expect(view().getByTestId('git-remote-Projects/alpha')).toContainText('branch not pushed')

  await write(join(fx.alpha, 'feature.md'), 'feature work\n')
  g(fx.alpha, 'add', 'feature.md')
  g(fx.alpha, 'commit', '-q', '-m', 'Feature: first')

  await openMenu('git-menu-publish')
  await expect(dialog().getByTestId('git-op-preview')).toHaveText(
    `This will publish the branch “feature/x” to ${fx.remote.replace(/\.git$/, '')} as origin/feature/x — 1 commit goes there — and the branch follows it from now on.`
  )
  await dialog().getByTestId('git-op-preview').getByTestId('git-term-publish').hover()
  await expect(page.getByTestId('git-term-tip-publish')).toContainText(GIT_GLOSSARY.publish.line)
  await shot('publish')
  await runDialog()
  await expect(toast(/^Published “feature\/x” to .+ \(origin\/feature\/x\) — it follows it from now on\.$/)).toBeVisible()
  expect(g(fx.remote, 'rev-parse', 'refs/heads/feature/x')).toBe(head(fx.alpha))
  expect(g(fx.alpha, 'rev-parse', '--abbrev-ref', 'feature/x@{u}')).toBe('origin/feature/x')
  await expect(view().getByTestId('git-remote-Projects/alpha')).not.toContainText('branch not pushed')
})

test('Rebase onto main with a conflict: the conflict tab opens; Abort restores the exact previous state', async () => {
  // main moves on with a change to the same line the branch changes.
  g(fx.alpha, 'switch', '-q', 'main')
  await write(join(fx.alpha, 'README.md'), '# Alpha\n\nMain’s line.\n')
  g(fx.alpha, 'commit', '-q', '-am', 'Main: readme')
  g(fx.alpha, 'switch', '-q', 'feature/x')
  await write(join(fx.alpha, 'README.md'), '# Alpha\n\nFeature’s line.\n')
  g(fx.alpha, 'commit', '-q', '-am', 'Feature: readme')
  await expect(view().getByTestId('git-repo-branch')).toContainText('feature/x')
  await expect(view().getByTestId('git-changes-empty')).toBeVisible()

  const before = await exactState(fx.alpha)
  await openMenu('git-menu-rebase-main')
  await expect(dialog()).toContainText('Rebase onto main')
  await expect(dialog().getByTestId('git-op-preview')).toHaveText(
    'This will put your 2 commits on top of main’s 1 newer commit (rebase). If their changes conflict with yours, a conflict tab opens: combine them there, or abort, back to before.'
  )
  await runDialog()
  await expect(toast(/conflict with yours in README\.md/)).toBeVisible()

  // The conflict tab: theirs / result / yours, Abort always there.
  await expect(pane()).toBeVisible()
  await expect(pane().getByTestId('conflict-summary')).toContainText('Putting your commit “Feature: readme” (2 of 2) on top of main.')
  await expect(pane().getByTestId('conflict-file-Projects/alpha/README.md')).toHaveAttribute('aria-selected', 'true')
  await expect(pane().getByTestId('conflict-theirs-0')).toHaveText('Main’s line.\n')
  await expect(pane().getByTestId('conflict-yours-0')).toHaveText('Feature’s line.\n')
  await expect(pane().getByTestId('conflict-abort')).toBeVisible()
  await expect(pane().getByTestId('conflict-resolve')).toBeDisabled()
  await expect(pane().getByTestId('conflict-preview')).toHaveText('This will save the result as README.md, mark it resolved, then continue the rebase.')
  await expect(view().getByTestId('git-op-bar')).toContainText('stopped on a conflict in 1 file')
  expect(await gitDirHas(fx.alpha, 'rebase-merge')).toBe(true)
  await shot('conflict-tab')

  await pane().getByTestId('conflict-abort').click()
  await expect(dialog().getByTestId('git-op-preview')).toHaveText(
    /^This puts everything back exactly as before the rebase: “feature\/x” at [0-9a-f]{7}, your files as they were \(abort\)\. Pomade checks it afterwards\.$/
  )
  await shot('abort-dialog')
  await runDialog()
  await expect(toast(/^Back to before — “feature\/x” at [0-9a-f]{7}, exactly as it was \(checked\)\.$/)).toBeVisible()
  expect(await gitDirHas(fx.alpha, 'rebase-merge')).toBe(false)
  expect(await exactState(fx.alpha)).toBe(before)
  await expect(pane().getByTestId('conflict-none')).toBeVisible()
  await expect(view().getByTestId('git-op-bar')).toHaveCount(0)
})

test('Rebase onto main with a conflict: take arrows build the result; Mark resolved & continue completes the rebase', async () => {
  const mainHead = head(fx.alpha, 'main')
  await openMenu('git-menu-rebase-main')
  await runDialog()
  await expect(pane().getByTestId('conflict-hunk-0')).toBeVisible()

  // ← yours, then → theirs: both, in that order.
  await pane().getByTestId('conflict-take-yours-0').click()
  await expect(pane().getByTestId('conflict-result-0')).toHaveValue('Feature’s line.\n')
  await pane().getByTestId('conflict-take-theirs-0').click()
  await expect(pane().getByTestId('conflict-result-0')).toHaveValue('Feature’s line.\nMain’s line.\n')
  // Start over, then type a result of one's own.
  await pane().getByTestId('conflict-reset-0').click()
  await expect(pane().getByTestId('conflict-result-0')).toHaveValue('')
  await expect(pane().getByTestId('conflict-resolve')).toBeDisabled()
  await pane().getByTestId('conflict-take-theirs-0').click()
  await pane().getByTestId('conflict-take-yours-0').click()
  await shot('conflict-resolved')
  await expect(pane().getByTestId('conflict-resolve')).toBeEnabled()
  await pane().getByTestId('conflict-resolve').click()

  await expect(toast(/^Rebase finished — “feature\/x” is on top of main\.$/)).toBeVisible()
  expect(await gitDirHas(fx.alpha, 'rebase-merge')).toBe(false)
  expect(g(fx.alpha, 'symbolic-ref', '--short', 'HEAD')).toBe('feature/x')
  // Main's commit is under the branch's two commits now.
  expect(head(fx.alpha, 'HEAD~2')).toBe(mainHead)
  expect(subject(fx.alpha)).toBe('Feature: readme')
  expect(await fs.readFile(join(fx.alpha, 'README.md'), 'utf8')).toBe('# Alpha\n\nMain’s line.\nFeature’s line.\n')
  expect(g(fx.alpha, 'status', '--porcelain')).toBe('')
  await expect(pane().getByTestId('conflict-none')).toBeVisible()
})

test('Switch branch with a conflicting uncommitted change: explained, with commit or discard offered — no hidden stash', async () => {
  await write(join(fx.alpha, 'README.md'), '# Alpha\n\nAn uncommitted edit.\n')
  await write(join(fx.alpha, 'loose.md'), 'a new file, the same on every branch\n')
  await expect(view().getByTestId('git-changes-count')).toHaveText('2')
  const before = await exactState(fx.alpha)

  await openMenu('git-menu-switch')
  await expect(dialog().getByTestId('git-branch-feature/x')).toHaveAttribute('data-current', 'true')
  await dialog().getByTestId('git-branch-main').click()
  await expect(dialog().getByTestId('git-op-blocked-message')).toHaveText(
    'Switching to “main” would replace a file you changed and haven’t committed: README.md. Commit or discard it first — Pomade never hides changes away.'
  )
  await expect(dialog().getByTestId('git-op-file-Projects/alpha/README.md')).toBeVisible()
  await expect(dialog().getByTestId('git-op-run')).toBeDisabled()
  await expect(dialog().getByTestId('git-switch-commit-first')).toBeVisible()
  await shot('switch-blocked')

  // Discard first → the discard dialog for exactly that file.
  await dialog().getByTestId('git-switch-discard-first').click()
  await expect(dialog()).toContainText('Discard changes')
  await expect(dialog().getByTestId('git-op-file-Projects/alpha/README.md')).toBeVisible()
  await expect(dialog().getByTestId('git-op-file-Projects/alpha/loose.md')).toHaveCount(0)
  await dialog().getByTestId('git-op-cancel').click()
  // Nothing moved; nothing was stashed.
  expect(await exactState(fx.alpha)).toBe(before)
  expect(g(fx.alpha, 'stash', 'list')).toBe('')

  // Commit first → the commit box.
  await openMenu('git-menu-switch')
  await dialog().getByTestId('git-branch-main').click()
  await dialog().getByTestId('git-switch-commit-first').click()
  await expect(dialog()).toHaveCount(0)
  await expect(view().getByTestId('git-commit-box')).toBeVisible()
  await view().getByTestId('git-commit-cancel').click()

  // With the conflicting edit gone, the switch runs and the new file comes along.
  g(fx.alpha, 'restore', 'README.md')
  await expect(view().getByTestId('git-changes-count')).toHaveText('1')
  await openMenu('git-menu-switch')
  await dialog().getByTestId('git-branch-main').click()
  await expect(dialog().getByTestId('git-op-preview')).toHaveText(
    'This will switch to “main”: the files change to that branch’s version. Your 1 uncommitted change comes along.'
  )
  await runDialog()
  await expect(toast('Switched to “main”.')).toBeVisible()
  expect(g(fx.alpha, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
  expect(await fs.readFile(join(fx.alpha, 'loose.md'), 'utf8')).toBe('a new file, the same on every branch\n')
  await fs.rm(join(fx.alpha, 'loose.md'))
  await expect(view().getByTestId('git-changes-empty')).toBeVisible()
})

test('Fetch shows what the remote has; Pull stops on a conflict in the conflict tab, and Abort puts everything back', async () => {
  g(fx.alpha, 'push', '-q', 'origin', 'main')
  g(fx.other, 'pull', '-q', 'origin', 'main')
  await write(join(fx.other, 'notes.txt'), 'their notes\n')
  g(fx.other, 'add', '-A')
  g(fx.other, 'commit', '-q', '-m', 'Other: notes')
  g(fx.other, 'push', '-q', 'origin', 'main')
  await write(join(fx.alpha, 'notes.txt'), 'our notes\n')
  g(fx.alpha, 'add', '-A')
  g(fx.alpha, 'commit', '-q', '-m', 'Alpha: notes')
  await expect(view().getByTestId('git-ahead-Projects/alpha')).toHaveAttribute('data-count', '1')
  await expect(view().getByTestId('git-behind-Projects/alpha')).toHaveCount(0)

  await view().getByTestId('git-fetch').click()
  await expect(toast(/^Fetched from .+ — origin\/main has 1 commit you don’t have yet\.$/)).toBeVisible()
  await expect(view().getByTestId('git-behind-Projects/alpha')).toHaveAttribute('data-count', '1')

  const before = await exactState(fx.alpha)
  await openMenu('git-menu-pull')
  await expect(dialog().getByTestId('git-op-preview')).toContainText('and put your 1 unpushed commit on top of them (rebase).')
  await runDialog()
  await expect(pane().getByTestId('conflict-file-Projects/alpha/notes.txt')).toBeVisible()
  await expect(pane().getByTestId('conflict-summary')).toContainText('on top of origin/main')
  await expect(pane().getByTestId('conflict-theirs-0')).toHaveText('their notes\n')
  await expect(pane().getByTestId('conflict-yours-0')).toHaveText('our notes\n')

  // Abort from the panel's bar this time.
  await view().getByTestId('git-op-bar-abort').click()
  await runDialog()
  await expect(toast(/^Back to before — “main” at [0-9a-f]{7}, exactly as it was \(checked\)\.$/)).toBeVisible()
  expect(await exactState(fx.alpha)).toBe(before)
  expect(await gitDirHas(fx.alpha, 'rebase-merge')).toBe(false)
})
