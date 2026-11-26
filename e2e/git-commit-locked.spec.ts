// modules: git, core
// Pomade T-232 e2e — every commit button in the box is disabled, and LOOKS disabled, while the
// message is empty, in every state of "Push after committing" and with or without staged files:
// Commit & push / Commit and Commit staged & push / Commit staged. Typing a message enables them.
// "Looks disabled" is asserted on the computed style (half opacity, not-allowed cursor), because the
// button of the lighter variant used to be disabled yet drawn like an enabled one.

import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { join } from 'node:path'

import { launchAppPage } from './fixtures/app'
import { createGitOpsFixture, write, type GitOpsFixture } from './fixtures/git-ops-repos'
import { showGitPanel } from './fixtures/panels'

let fx: GitOpsFixture
let app: ElectronApplication
let page: Page

const view = (): Locator => page.getByTestId('git-repo-view')
const box = (): Locator => view().getByTestId('git-commit-box')

async function selectProject(id: string): Promise<void> {
  await page.getByTestId(`project-${id}`).click()
  await expect(page.getByTestId('panehost')).toHaveAttribute('data-active-project', id)
  await showGitPanel(page)
  await expect(page.getByTestId('git-panel')).toBeVisible()
}

const look = (b: Locator): Promise<{ opacity: string; cursor: string }> =>
  b.evaluate((el) => {
    const s = getComputedStyle(el)
    return { opacity: s.opacity, cursor: s.cursor }
  })

// Both retry: the preview behind the buttons reloads after a toggle, and a button is briefly
// disabled while it does.
async function expectLocked(b: Locator): Promise<void> {
  await expect(b).toBeDisabled()
  await expect.poll(() => look(b)).toEqual({ opacity: '0.5', cursor: 'not-allowed' })
}

async function expectOpen(b: Locator): Promise<void> {
  await expect(b).toBeEnabled()
  await expect.poll(() => look(b)).toEqual({ opacity: '1', cursor: 'pointer' })
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

test('Nothing staged: Commit & push and Commit are locked while the message is empty, in both states of Push after committing', async () => {
  await selectProject(fx.projects.alpha)
  await write(join(fx.alpha, 'notes.md'), '# Notes\n')
  await expect(view().getByTestId('git-changes-count')).toHaveText('1')
  await view().getByTestId('git-commit-open').click()
  const run = box().getByTestId('git-commit-run')
  await expect(box().getByTestId('git-commit-staged-run')).toHaveCount(0)

  await expect(run).toHaveText('Commit & push')
  await expectLocked(run)
  await box().getByTestId('git-commit-push-after').uncheck()
  await expect(run).toHaveText('Commit')
  await expectLocked(run)

  await box().getByTestId('git-commit-message').fill('Alpha: notes')
  await expectOpen(run)
  await box().getByTestId('git-commit-push-after').check()
  await expect(run).toHaveText('Commit & push')
  await expectOpen(run)
  // Whitespace is not a message.
  await box().getByTestId('git-commit-message').fill('  \n ')
  await expectLocked(run)
})

test('Something staged: both Commit & push and Commit staged & push are locked, together, and open together', async () => {
  await box().getByTestId('git-commit-cancel').click()
  const row = view().getByTestId('git-change-Projects/alpha/notes.md')
  await row.hover()
  await row.getByTestId('git-stage-Projects/alpha/notes.md').click()
  await expect(view().getByTestId('git-staged-count')).toHaveText('1')
  await write(join(fx.alpha, 'todo.md'), '# Todo\n')
  await expect(view().getByTestId('git-changes-count')).toHaveText('2')
  await view().getByTestId('git-commit-open').click()
  const all = box().getByTestId('git-commit-run')
  const staged = box().getByTestId('git-commit-staged-run')

  for (const pushAfter of [true, false]) {
    await box().getByTestId('git-commit-push-after').setChecked(pushAfter)
    await expect(all).toHaveText(pushAfter ? 'Commit & push' : 'Commit')
    await expect(staged).toHaveText(pushAfter ? 'Commit staged & push' : 'Commit staged')
    await expectLocked(all)
    await expectLocked(staged)
  }

  await box().getByTestId('git-commit-message').fill('Alpha: notes')
  await expectOpen(all)
  await expectOpen(staged)
  await box().getByTestId('git-commit-message').fill('')
  await expectLocked(all)
  await expectLocked(staged)
  await box().getByTestId('git-commit-cancel').click()
})

test('No remote: Commit is locked while the message is empty', async () => {
  await selectProject(fx.projects.beta)
  await write(join(fx.beta, 'local.md'), '# Local\n')
  await view().getByTestId('git-commit-open').click()
  const run = box().getByTestId('git-commit-run')
  await expect(run).toHaveText('Commit')
  await expectLocked(run)
  await box().getByTestId('git-commit-message').fill('Beta: local')
  await expectOpen(run)
})
