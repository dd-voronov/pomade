// modules: git, editor, core
// Pomade E-039 e2e — git operations with safety rails, on fixture repos with LOCAL BARE remotes
// (e2e/fixtures/git-ops-repos.ts): Commit & push with its preview, Undo last commit (pushed →
// revert, not pushed → back to uncommitted), the remote moved on → "Get their changes, then push",
// a conflict stopped in the conflict tab — aborted back to exactly the state before, then resolved and pushed, Discard to Document history, an auth failure
// in plain words with a copy button and attention marks, Connect remote, and the per-repo lock.
// Every ticket Acceptance bullet is an assertion here. Set POMADE_E039_SHOTS=<dir> for screenshots.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { GIT_GLOSSARY } from '../src/shared/git-glossary'
import { launchAppPage } from './fixtures/app'
import { createGitOpsFixture, gitIn, write, type GitOpsFixture } from './fixtures/git-ops-repos'
import { tabsOf } from './fixtures/stores'
import { showGitPanel } from './fixtures/panels'

let fx: GitOpsFixture
let app: ElectronApplication
let page: Page

const SHOTS = process.env.POMADE_E039_SHOTS
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  // Toasts pile up at this pace and cover the view: dismiss them (a click does) for the picture.
  for (const t of await page.getByTestId('toast').all()) await t.click({ timeout: 500 }).catch(() => {})
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

const g = (cwd: string, ...args: string[]): string => gitIn(fx.scratch, cwd, ...args).trim()
const head = (cwd: string, rev = 'HEAD'): string => g(cwd, 'rev-parse', rev)
const remoteMain = (bare: string): string => g(bare, 'rev-parse', 'refs/heads/main')
const subject = (cwd: string, rev = 'HEAD'): string => g(cwd, 'log', '-1', '--format=%s', rev)
const label = (bare: string): string => bare.replace(/\.git$/, '')

/** Everything "exactly as before" means: HEAD, the branch, the index, the full status. */
function repoSnapshot(cwd: string): string {
  return [
    head(cwd),
    g(cwd, 'symbolic-ref', 'HEAD'),
    g(cwd, 'ls-files', '-s'),
    g(cwd, 'status', '--porcelain=v2', '--branch', '--untracked-files=all', '--ignored=matching')
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
const toast = (text: string | RegExp): ReturnType<Page['locator']> => page.getByTestId('toast').filter({ hasText: text })

async function changesCount(n: number): Promise<void> {
  if (n === 0) await expect(view().getByTestId('git-changes-empty')).toBeVisible()
  else await expect(view().getByTestId('git-changes-count')).toHaveText(String(n))
}

async function openMenu(item: string): Promise<void> {
  await view().getByTestId('git-repo-menu').click()
  await page.getByTestId(item).click()
  await expect(dialog()).toBeVisible()
}

async function commitAndPush(message: string): Promise<void> {
  await view().getByTestId('git-commit-open').click()
  await expect(view().getByTestId('git-commit-preview')).toBeVisible()
  await view().getByTestId('git-commit-message').fill(message)
  await expect(view().getByTestId('git-commit-run')).toBeEnabled()
  await view().getByTestId('git-commit-run').click()
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

test('Commit & push: the preview says what will happen; the commit lands, is pushed, and History shows it', async () => {
  await write(join(fx.alpha, 'README.md'), '# Alpha\n\nAlpha project, edited.\n')
  await write(join(fx.alpha, 'plan.md'), '# Plan\n\nShip it.\n')
  await selectProject(fx.projects.alpha)
  await changesCount(2)

  await expect(view().getByTestId('git-commit-open')).toHaveText('Commit & push…')
  await view().getByTestId('git-commit-open').click()
  await expect(view().getByTestId('git-commit-preview')).toHaveText(
    `This will commit 2 files and push 1 commit to ${label(fx.remote)} (origin/main).`
  )
  // Every git term in the preview explains itself on hover — from the one glossary.
  await view().getByTestId('git-commit-preview').getByTestId('git-term-push').hover()
  await expect(page.getByTestId('git-term-tip-push')).toContainText(GIT_GLOSSARY.push.line)
  await expect(page.getByTestId('git-term-tip-push')).toContainText(GIT_GLOSSARY.push.example)
  // No message, no commit.
  await expect(view().getByTestId('git-commit-run')).toBeDisabled()
  await expect(view().getByTestId('git-commit-run')).toHaveText('Commit & push')
  await view().getByTestId('git-commit-message').fill('Alpha: plan and readme')
  await shot('commit-box')
  await view().getByTestId('git-commit-run').click()

  await expect(view().getByTestId('git-commit-box')).toHaveCount(0)
  await expect(toast(/^Committed [0-9a-f]{7} and pushed to .+ \(origin\/main\)\.$/)).toBeVisible()
  expect(subject(fx.alpha)).toBe('Alpha: plan and readme')
  expect(remoteMain(fx.remote)).toBe(head(fx.alpha))
  expect(g(fx.alpha, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['README.md', 'plan.md'])
  await changesCount(0)
  await expect(view().getByTestId('git-history').locator('[data-testid^="git-commit-subject-"]').first()).toHaveText('Alpha: plan and readme')
})

test('Undo last commit after pushing: a revert commit is added and pushed — history is not rewritten', async () => {
  const pushed = head(fx.alpha)
  await openMenu('git-menu-undo')
  await expect(dialog().getByTestId('git-op-preview')).toHaveText(
    `Already on ${label(fx.remote)} — this adds a commit that cancels “Alpha: plan and readme” (revert) and pushes it. Nothing is rewritten.`
  )
  await expect(dialog().getByTestId('git-op-run')).toHaveText('Add cancelling commit & push')
  await shot('undo-revert')
  await dialog().getByTestId('git-op-run').click()
  await expect(dialog()).toHaveCount(0)

  expect(subject(fx.alpha)).toBe('Revert "Alpha: plan and readme"')
  expect(head(fx.alpha, 'HEAD^')).toBe(pushed)
  expect(remoteMain(fx.remote)).toBe(head(fx.alpha))
  await expect.poll(() => fs.access(join(fx.alpha, 'plan.md')).then(() => true, () => false)).toBe(false)
  await changesCount(0)
})

test('Local only: the commit stays on this Mac; Undo before pushing brings its changes back as uncommitted', async () => {
  await selectProject(fx.projects.beta)
  await changesCount(0)
  await write(join(fx.beta, 'README.md'), '# Beta\n\nBeta project, edited.\n')
  await changesCount(1)
  await expect(view().getByTestId('git-commit-open')).toHaveText('Commit…')
  await view().getByTestId('git-commit-open').click()
  await expect(view().getByTestId('git-commit-preview')).toHaveText('This will commit 1 file. No remote — the commit stays on this Mac.')
  await expect(view().getByTestId('git-commit-run')).toHaveText('Commit')
  await shot('commit-box-local')
  const before = head(fx.beta)
  await view().getByTestId('git-commit-message').fill('Beta: readme')
  await view().getByTestId('git-commit-message').press(`${MOD}+Enter`)
  await expect(toast(/stays on this Mac/)).toBeVisible()
  expect(subject(fx.beta)).toBe('Beta: readme')
  await changesCount(0)

  await openMenu('git-menu-undo')
  await expect(dialog().locator('[data-mode="undo"]')).toBeVisible()
  await expect(dialog().getByTestId('git-op-preview')).toHaveText(
    'Not pushed yet — this takes back “Beta: readme”: the commit goes away and its changes are back as uncommitted.'
  )
  await dialog().getByTestId('git-op-run').click()
  await expect(dialog()).toHaveCount(0)
  expect(head(fx.beta)).toBe(before)
  expect(g(fx.beta, 'status', '--porcelain')).toBe('M  README.md')
  expect(await fs.readFile(join(fx.beta, 'README.md'), 'utf8')).toBe('# Beta\n\nBeta project, edited.\n')
  await changesCount(1)
})

test('The remote moved on: the push is turned down and "Get their changes, then push" succeeds', async () => {
  g(fx.other, 'pull', '-q')
  await write(join(fx.other, 'from-other.md'), 'pushed from another clone\n')
  g(fx.other, 'add', '-A')
  g(fx.other, 'commit', '-q', '-m', 'Other: a file')
  g(fx.other, 'push', '-q')
  const theirs = head(fx.other)

  await selectProject(fx.projects.alpha)
  await write(join(fx.alpha, 'notes.txt'), 'alpha notes, edited\n')
  await changesCount(1)
  await commitAndPush('Alpha: notes')
  const failure = view().getByTestId('git-commit-failure')
  await expect(failure).toBeVisible()
  await expect(failure.getByTestId('git-commit-failure-message')).toHaveText(
    new RegExp(`^Committed [0-9a-f]{7}, but it was not pushed\\. ${label(fx.remote).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} has commits you don’t have yet`)
  )
  await expect(toast(/Commit & push failed in alpha/)).toBeVisible()
  // A failure marks the Git icon until the repo is opened again.
  await expect(page.getByTestId('strip-badge-git')).toBeVisible()
  await shot('remote-moved')

  await failure.getByTestId('git-op-sync').click()
  await expect(view().getByTestId('git-commit-box')).toHaveCount(0)
  await expect(dialog().getByTestId('git-op-preview')).toContainText('This will get the new commits from')
  await expect(dialog().getByTestId('git-op-preview')).toContainText('put your 1 unpushed commit on top of them (rebase), then push')
  await dialog().getByTestId('git-op-run').click()
  await expect(dialog()).toHaveCount(0)
  await expect(toast(/^Got 1 commit from .+ and pushed yours\.$/)).toBeVisible()
  expect(head(fx.alpha, 'HEAD^')).toBe(theirs)
  expect(subject(fx.alpha)).toBe('Alpha: notes')
  expect(remoteMain(fx.remote)).toBe(head(fx.alpha))

  // Opening the repo again clears its mark.
  await selectProject(fx.projects.beta)
  await selectProject(fx.projects.alpha)
  await expect(page.getByTestId('strip-badge-git')).toHaveCount(0)
})

test('Get their changes is offered only with something to push, and refuses up front with uncommitted changes', async () => {
  // Nothing of its own to push: `⋯` offers Pull only.
  await view().getByTestId('git-repo-menu').click()
  await expect(page.getByTestId('git-menu-pull')).toBeVisible()
  await expect(page.getByTestId('git-menu-sync')).toHaveCount(0)
  await page.keyboard.press('Escape')

  await write(join(fx.alpha, 'local.md'), 'committed, not pushed\n')
  g(fx.alpha, 'add', 'local.md')
  g(fx.alpha, 'commit', '-q', '-m', 'Alpha: local')
  await write(join(fx.alpha, 'scratch.md'), 'not committed\n')
  await changesCount(1)
  await openMenu('git-menu-sync')
  await expect(dialog().getByTestId('git-op-blocked')).toContainText('There are uncommitted changes. Commit or discard them first')
  await expect(dialog().getByTestId('git-op-run')).toBeDisabled()
  await dialog().getByTestId('git-op-cancel').click()
  await fs.rm(join(fx.alpha, 'scratch.md'))
  g(fx.alpha, 'reset', '-q', '--hard', 'HEAD^')
  await changesCount(0)
})

test('The remote moved on and so did the branch: the bar says so, and a push alone is blocked with the way out', async () => {
  g(fx.other, 'pull', '-q')
  await write(join(fx.other, 'other-2.md'), 'theirs\n')
  g(fx.other, 'add', '-A')
  g(fx.other, 'commit', '-q', '-m', 'Other: another file')
  g(fx.other, 'push', '-q')
  await write(join(fx.alpha, 'mine-2.md'), 'mine\n')
  g(fx.alpha, 'add', '-A')
  g(fx.alpha, 'commit', '-q', '-m', 'Alpha: another file')
  g(fx.alpha, 'fetch', '-q')

  const bar = view().getByTestId('git-diverged-bar')
  await expect(bar).toHaveText(/^Your branch and origin\/main went different ways — 1 commit yours, 1 theirs\./)
  await view().getByTestId('git-commit-open').click()
  await expect(view().getByTestId('git-commit-blocked')).toContainText('origin/main has 1 commit you don’t have yet — get their changes first')
  await expect(view().getByTestId('git-commit-run')).toBeDisabled()
  await shot('diverged')
  await view().getByTestId('git-commit-blocked').getByTestId('git-op-sync').click()
  await expect(view().getByTestId('git-commit-box')).toHaveCount(0)
  await dialog().getByTestId('git-op-run').click()
  await expect(dialog()).toHaveCount(0)
  await expect(toast(/^Got 1 commit from .+ and pushed yours\.$/).last()).toBeVisible()
  expect(remoteMain(fx.remote)).toBe(head(fx.alpha))
  await expect(bar).toHaveCount(0)
})

test('A conflicting change opens the conflict tab: Abort puts everything back exactly; resolving it pushes', async () => {
  g(fx.other, 'pull', '-q')
  await write(join(fx.other, 'README.md'), '# Alpha\n\nTheir version of this line.\n')
  g(fx.other, 'commit', '-q', '-am', 'Other: readme')
  g(fx.other, 'push', '-q')

  await write(join(fx.alpha, 'README.md'), '# Alpha\n\nOur version of this line.\n')
  await changesCount(1)
  await commitAndPush('Alpha: readme')
  await expect(view().getByTestId('git-commit-failure')).toBeVisible()

  // The state Abort must return to (fetched first, so the tracking ref is current).
  g(fx.alpha, 'fetch', '-q')
  const before = repoSnapshot(fx.alpha)
  const pane = page.getByTestId('conflict-pane')
  await view().getByTestId('git-commit-failure').getByTestId('git-op-sync').click()
  await expect(view().getByTestId('git-commit-box')).toHaveCount(0)
  await expect(dialog().getByTestId('git-op-preview')).toContainText(
    'If their changes conflict with yours, a conflict tab opens: combine them there, then it pushes — or abort, back to before.'
  )
  await dialog().getByTestId('git-op-run').click()

  // The rebase stops on the conflict and the conflict tab opens — never a dead end.
  await expect(dialog()).toHaveCount(0)
  await expect(pane.getByTestId('conflict-file-Projects/alpha/README.md')).toBeVisible()
  await expect(pane.getByTestId('conflict-theirs-0')).toHaveText('Their version of this line.\n')
  await expect(pane.getByTestId('conflict-yours-0')).toHaveText('Our version of this line.\n')
  await expect(pane.getByTestId('conflict-preview')).toHaveText(
    /^This will save the result as README\.md, mark it resolved, then continue the rebase\. Once it finishes, your commits are pushed to .+\.$/
  )
  await expect(view().getByTestId('git-op-bar')).toContainText('stopped on a conflict in 1 file')
  await shot('conflict-tab')

  await pane.getByTestId('conflict-abort').click()
  await dialog().getByTestId('git-op-run').click()
  await expect(toast(/^Back to before — “main” at [0-9a-f]{7}, exactly as it was \(checked\)\.$/)).toBeVisible()
  expect(repoSnapshot(fx.alpha)).toBe(before)
  expect(await fs.readFile(join(fx.alpha, 'debug.log'), 'utf8')).toBe('ignored, never touched\n')
  expect(remoteMain(fx.remote)).toBe(head(fx.other))

  // Again, combined this time: the rebase finishes and is pushed.
  await openMenu('git-menu-sync')
  await dialog().getByTestId('git-op-run').click()
  await expect(pane.getByTestId('conflict-hunk-0')).toBeVisible()
  await pane.getByTestId('conflict-take-theirs-0').click()
  await pane.getByTestId('conflict-take-yours-0').click()
  await pane.getByTestId('conflict-resolve').click()
  await expect(toast(/^Rebase finished — “main” is on top of origin\/main — and pushed to .+\.$/)).toBeVisible()
  expect(await fs.readFile(join(fx.alpha, 'README.md'), 'utf8')).toBe('# Alpha\n\nTheir version of this line.\nOur version of this line.\n')
  expect(head(fx.alpha, 'HEAD^')).toBe(head(fx.other))
  expect(remoteMain(fx.remote)).toBe(head(fx.alpha))
  await expect(pane.getByTestId('conflict-none')).toBeVisible()
  // Seen: reopening the repo clears its marks.
  await selectProject(fx.projects.beta)
  await selectProject(fx.projects.alpha)
  await expect(page.getByTestId('strip-badge-git')).toHaveCount(0)
})

test('Discard a modified and a new file: both gone from disk, both restorable from Document history; a binary file stays', async () => {
  const committedReadme = g(fx.alpha, 'show', 'HEAD:README.md')
  await write(join(fx.alpha, 'README.md'), '# Alpha\n\nDiscard me, please.\n')
  await write(join(fx.alpha, 'ideas.md'), '# Ideas\n\nA brand-new file.\n')
  await write(join(fx.alpha, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
  await changesCount(3)

  // A binary file alone: nothing can be kept, so nothing is discarded.
  const row = view().getByTestId('git-change-Projects/alpha/photo.png')
  await row.hover()
  await row.getByTestId('git-discard-Projects/alpha/photo.png').click()
  await expect(dialog().getByTestId('git-op-blocked')).toBeVisible()
  await expect(dialog().getByTestId('git-op-skipped-Projects/alpha/photo.png')).toContainText('photo.png — stays: binary files are not discarded')
  await expect(dialog().getByTestId('git-op-run')).toBeDisabled()
  await dialog().getByTestId('git-op-cancel').click()

  await openMenu('git-menu-discard-all')
  await expect(dialog().getByTestId('git-op-preview')).toHaveText(
    'This will discard the changes to 2 files. What they hold now is kept for 7 days in Document history.'
  )
  await expect(dialog().getByTestId('git-op-file-Projects/alpha/README.md')).toHaveText('README.md — back to the last commit')
  await expect(dialog().getByTestId('git-op-file-Projects/alpha/ideas.md')).toHaveText('ideas.md — new, deleted')
  await expect(dialog().getByTestId('git-op-skipped-Projects/alpha/photo.png')).toBeVisible()
  await shot('discard-preview')
  await dialog().getByTestId('git-op-run').click()
  await expect(dialog()).toHaveCount(0)
  await expect(toast('Discarded 2 files — kept for 7 days in Document history. 1 file was left as it is.')).toBeVisible()

  expect(await fs.readFile(join(fx.alpha, 'README.md'), 'utf8')).toBe(`${committedReadme}\n`)
  expect(await fs.access(join(fx.alpha, 'ideas.md')).then(() => true, () => false)).toBe(false)
  expect(await fs.readFile(join(fx.alpha, 'photo.png'))).toHaveLength(8)
  await changesCount(1)

  // Both are listed under Discarded; the new file opens (gone from disk) with its History.
  await expect(view().getByTestId('git-discarded')).toBeVisible()
  await expect(view().getByTestId('git-discarded-Projects/alpha/README.md')).toBeVisible()
  await shot('discarded-section')
  await view().getByTestId('git-discarded-Projects/alpha/ideas.md').click()
  const panel = page.locator('[data-testid="doc-history"]:visible')
  const discardedRow = panel.locator('[data-testid^="history-row-discarded-"]')
  await expect(discardedRow).toHaveCount(1)
  await expect(discardedRow).toHaveAttribute('data-kind', 'discarded')
  await expect(discardedRow).toContainText('Discarded change')
  await shot('discarded-history')
  const id = (await discardedRow.getAttribute('data-testid'))!.replace('history-row-', '')
  await discardedRow.hover()
  await panel.getByTestId(`history-restore-${id}`).click()
  const editor = page.locator('[data-testid="editor-pane"][data-doc-path="Projects/alpha/ideas.md"]')
  await expect(editor.locator('.cm-content')).toContainText('A brand-new file.')
  await editor.locator('.cm-content').click()
  await page.keyboard.press(`${MOD}+s`)
  await expect.poll(() => fs.readFile(join(fx.alpha, 'ideas.md'), 'utf8').catch(() => '')).toBe('# Ideas\n\nA brand-new file.\n')
  // T-310: the file is back — its row hides, and stays hidden after a further edit (it was restored).
  await expect(view().getByTestId('git-discarded-Projects/alpha/ideas.md')).toHaveCount(0)
  await editor.locator('.cm-content').click()
  await page.keyboard.press(`${MOD}+End`)
  await page.keyboard.type('More.')
  await page.keyboard.press(`${MOD}+s`)
  await expect.poll(() => fs.readFile(join(fx.alpha, 'ideas.md'), 'utf8').catch(() => '')).toContain('More.')
  await changesCount(2)
  await expect(view().getByTestId('git-discarded-Projects/alpha/ideas.md')).toHaveCount(0)
  await expect(view().getByTestId('git-discarded-Projects/alpha/README.md')).toBeVisible()

  // The modified file's discarded content is a History row too, and holds exactly what was on disk.
  await selectProject(fx.projects.alpha)
  await view().getByTestId('git-discarded-Projects/alpha/README.md').click()
  await expect(page.locator('[data-testid="doc-history"]:visible [data-testid^="history-row-discarded-"]')).toHaveCount(1)
  const kept = await page.evaluate(() => window.pomade.recovery.drafts('Projects/alpha/README.md'))
  expect(kept.map((d) => [d.reason, d.content])).toEqual([['git-discard', '# Alpha\n\nDiscard me, please.\n']])

  for (const t of (await tabsOf(page, fx.projects.alpha)).filter((x) => x.kind === 'doc')) {
    await page.evaluate(({ p, id: tab }) => window.__pomadeStores.useTabsStore.getState().closeTab(p, tab), { p: fx.projects.alpha, id: t.id })
  }
  await fs.rm(join(fx.alpha, 'photo.png'))
  await fs.rm(join(fx.alpha, 'ideas.md'))
  // T-310: gone again — its row shows again.
  await expect(view().getByTestId('git-discarded-Projects/alpha/ideas.md')).toBeVisible()

  // T-310: Forget asks once inline, then deletes the kept copies; Keep leaves them.
  const readmeRow = view().getByTestId('git-discarded-Projects/alpha/README.md')
  await readmeRow.hover()
  await view().getByTestId('git-discarded-forget-Projects/alpha/README.md').click()
  await expect(readmeRow).toContainText('Forget the kept copy of README.md?')
  await shot('discarded-forget')
  await view().getByTestId('git-discarded-forget-cancel').click()
  await expect(readmeRow).toContainText('README.md')
  expect(await page.evaluate(() => window.pomade.recovery.drafts('Projects/alpha/README.md'))).toHaveLength(1)
  for (const path of ['Projects/alpha/README.md', 'Projects/alpha/ideas.md']) {
    await view().getByTestId(`git-discarded-${path}`).hover()
    await view().getByTestId(`git-discarded-forget-${path}`).click()
    await view().getByTestId('git-discarded-forget-confirm').click()
    await expect(view().getByTestId(`git-discarded-${path}`)).toHaveCount(0)
    expect(await page.evaluate((p) => window.pomade.recovery.drafts(p), path)).toHaveLength(0)
  }
  await expect(view().getByTestId('git-discarded')).toHaveCount(0)
})

test('Push with failing auth: plain words and a copy button; a mark on the Git icon and the repo row until the repo is opened', async () => {
  await expect(page.getByTestId('strip-badge-git')).toHaveCount(0)
  await selectProject('__workspace__')
  await page.getByTestId('git-repo-row-Apps/gamma').click()
  await changesCount(0)
  await write(join(fx.gamma, 'README.md'), '# Gamma\n\nGamma app, edited.\n')
  await changesCount(1)
  await view().getByTestId('git-commit-open').click()
  await expect(view().getByTestId('git-commit-preview')).toHaveText('This will commit 1 file and push 1 commit to GitHub (origin/main).')
  await view().getByTestId('git-commit-message').fill('Gamma: readme')
  await view().getByTestId('git-commit-run').click()

  const failure = view().getByTestId('git-commit-failure')
  await expect(failure.getByTestId('git-commit-failure-message')).toHaveText(
    /^Committed [0-9a-f]{7}, but it was not pushed\. GitHub refused the push — your SSH key was not accepted\. Check it with `ssh -T git@github\.com` in a terminal\.$/
  )
  await expect(failure.getByTestId('git-commit-failure-detail')).toHaveText('fatal: Could not read from remote repository.')
  await expect(toast(/GitHub refused the push/)).toBeVisible()
  await failure.getByTestId('git-op-copy').click()
  await expect(failure.getByTestId('git-op-copy')).toHaveText('Copied')
  await expect.poll(() => page.evaluate(() => window.pomade.app.clipboardRead())).toBe('ssh -T git@github.com')
  await shot('auth-failure')

  await expect(page.getByTestId('strip-badge-git')).toBeVisible()
  await page.getByTestId('git-back').click()
  await expect(page.getByTestId('git-repo-mark-Apps/gamma')).toBeVisible()
  await expect(page.getByTestId('git-repo-mark-Projects/alpha')).toHaveCount(0)
  await shot('auth-failure-marks')
  // Opening the repo clears both.
  await page.getByTestId('git-repo-row-Apps/gamma').click()
  await expect(view()).toHaveAttribute('data-repo', 'Apps/gamma')
  await expect(page.getByTestId('strip-badge-git')).toHaveCount(0)
  await page.getByTestId('git-back').click()
  await expect(page.getByTestId('git-repo-mark-Apps/gamma')).toHaveCount(0)
})

test('Connect remote: the address is checked against the remote before it is added; Commit & push then publishes the branch', async () => {
  await selectProject(fx.projects.beta)
  await openMenu('git-menu-connect')
  await dialog().getByTestId('git-remote-url').fill(join(fx.scratch, 'nothing-here.git'))
  await dialog().getByTestId('git-remote-check').click()
  await expect(dialog().getByTestId('git-op-blocked')).toContainText(`There is no repository at ${join(fx.scratch, 'nothing-here')}.`)
  await expect(dialog().getByTestId('git-op-run')).toBeDisabled()
  expect(g(fx.beta, 'remote')).toBe('')

  await dialog().getByTestId('git-remote-url').fill(fx.spare)
  await dialog().getByTestId('git-remote-check').click()
  await expect(dialog().getByTestId('git-op-preview')).toHaveText(
    `${label(fx.spare)} answered — an empty repository. This will add it as the remote “origin”; Commit & push then sends your commits there.`
  )
  await shot('connect-remote')
  await dialog().getByTestId('git-op-run').click()
  await expect(dialog()).toHaveCount(0)
  expect(g(fx.beta, 'remote', 'get-url', 'origin')).toBe(fx.spare)
  await expect(view().getByTestId('git-remote-Projects/beta')).toContainText(label(fx.spare))

  // Beta still has its undone change: commit it and publish the branch.
  await view().getByTestId('git-commit-open').click()
  await expect(view().getByTestId('git-commit-preview')).toHaveText(
    `This will commit 1 file and push 2 commits to ${label(fx.spare)} (origin/main) — a new branch there.`
  )
  await view().getByTestId('git-commit-message').fill('Beta: readme again')
  await view().getByTestId('git-commit-run').click()
  await expect(view().getByTestId('git-commit-box')).toHaveCount(0)
  expect(remoteMain(fx.spare)).toBe(head(fx.beta))
  expect(g(fx.beta, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/main')
})

test('One git operation at a time per repo: a second one is refused in plain words', async () => {
  const hook = join(fx.beta, '.git/hooks/pre-commit')
  await write(hook, '#!/bin/sh\nsleep 2\n')
  await fs.chmod(hook, 0o755)
  await write(join(fx.beta, 'slow.md'), 'a commit with a slow hook\n')
  await changesCount(1)
  const results = await page.evaluate(async () => {
    const p = await window.pomade.git.preview('Projects/beta', { op: 'commit-push' })
    const first = window.pomade.git.run('Projects/beta', { op: 'commit-push' }, { token: p.token, message: 'Beta: slow' })
    await new Promise((r) => setTimeout(r, 300))
    const second = await window.pomade.git.run('Projects/beta', { op: 'undo-commit' }, { token: 'x' })
    return [await first, second]
  })
  expect(results[0].ok).toBe(true)
  expect(results[1]).toEqual({
    ok: false,
    failure: { kind: 'busy', message: '“Commit & push” is still running in this repository — wait for it to finish, then try again.' }
  })
  expect(subject(fx.beta)).toBe('Beta: slow')
  await fs.rm(hook)
})

test('a narrow panel keeps the operations inside it (no horizontal overflow)', async () => {
  await selectProject(fx.projects.alpha)
  await write(join(fx.alpha, 'narrow.md'), 'a change\n')
  await changesCount(1)
  await page.getByTestId('side-panel').evaluate((el) => (el as HTMLElement).style.setProperty('--filetree-w', '160px'))
  const body = page.getByTestId('git-panel-body')
  const overflow = (): Promise<boolean> => body.evaluate((el) => el.scrollWidth > el.clientWidth + 1)
  await expect(view().getByTestId('git-commit-open')).toBeVisible()
  expect(await overflow()).toBe(false)
  await view().getByTestId('git-commit-open').click()
  await expect(view().getByTestId('git-commit-preview')).toBeVisible()
  expect(await overflow()).toBe(false)
  await shot('narrow-commit-box')
  await view().getByTestId('git-commit-cancel').click()
  await page.getByTestId('side-panel').evaluate((el) => (el as HTMLElement).style.removeProperty('--filetree-w'))
  await fs.rm(join(fx.alpha, 'narrow.md'))
})
