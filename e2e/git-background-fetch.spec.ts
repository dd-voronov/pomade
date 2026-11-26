// modules: git
// Pomade T-225 e2e — the repo view's quiet background fetch never refuses what the user asks for.
// Opening a repo view fetches in the background; here that fetch is HELD in flight (the remote's
// upload-pack — a wrapper for alpha's local remote, the fake ssh for gamma's — waits while a hold
// file exists), so every user operation below deterministically meets the fetch holding the repo
// lock. Each must run (the fetch gives way), not be refused with "“Fetch” is still running".

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { launchAppPage } from './fixtures/app'
import { createGitOpsFixture, gitIn, write, type GitOpsFixture } from './fixtures/git-ops-repos'
import { showGitPanel } from './fixtures/panels'

let fx: GitOpsFixture
let app: ElectronApplication
let page: Page

const view = (): ReturnType<Page['locator']> => page.getByTestId('git-repo-view')
const toast = (text: string | RegExp): ReturnType<Page['locator']> => page.getByTestId('toast').filter({ hasText: text })
const hold = (): string => join(fx.scratch, 'fetch-hold')
const started = (): string => join(fx.scratch, 'fetch-started')
const exists = (p: string): Promise<boolean> =>
  fs.access(p).then(
    () => true,
    () => false
  )

/** Waits (bounded: 30 s) while the hold file exists — a fetch stuck talking to its remote. */
const HELD = `i=0
touch "${'$'}{SCRATCH}/fetch-started"
while [ -e "${'$'}{SCRATCH}/fetch-hold" ] && [ ${'$'}i -lt 300 ]; do sleep 0.1; i=${'$'}((i+1)); done`

async function selectProject(id: string): Promise<void> {
  await page.getByTestId(`project-${id}`).click()
  await expect(page.getByTestId('panehost')).toHaveAttribute('data-active-project', id)
  await showGitPanel(page)
  await expect(page.getByTestId('git-panel')).toBeVisible()
}

/** Open a repo view with the fetch held, and wait until the background fetch is in flight (it
 *  holds the repo lock before git starts the upload-pack). */
async function openWithFetchHeld(open: () => Promise<void>, repo: string): Promise<void> {
  await fs.rm(started(), { force: true })
  await write(hold(), '')
  await open()
  await expect(view()).toHaveAttribute('data-repo', repo)
  await expect.poll(() => exists(started()), { timeout: 10_000 }).toBe(true)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  fx = await createGitOpsFixture()
  const scratch = `SCRATCH='${fx.scratch}'`
  await write(join(fx.scratch, 'held-upload-pack'), `#!/bin/sh\n${scratch}\n${HELD}\nexec git upload-pack "$@"\n`)
  await fs.chmod(join(fx.scratch, 'held-upload-pack'), 0o755)
  gitIn(fx.scratch, fx.alpha, 'config', 'remote.origin.uploadpack', join(fx.scratch, 'held-upload-pack'))
  // gamma's fake ssh: a fetch (upload-pack) is held first, then refused like GitHub does.
  await write(
    join(fx.scratch, 'fake-ssh'),
    `#!/bin/sh\n${scratch}\ncase "$*" in *upload-pack*) ${HELD.replace(/\n/g, '; ')} ;; esac\necho "git@github.com: Permission denied (publickey)." >&2\nexit 255\n`
  )
  ;({ app, page } = await launchAppPage(fx, fx.env))
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterEach(async () => {
  await fs.rm(hold(), { force: true })
})

test.afterAll(async () => {
  await fs.rm(hold(), { force: true })
  await app?.close()
  await fx?.cleanupGit()
})

test('Stage while the background fetch is in flight: the fetch gives way and the file is staged', async () => {
  await openWithFetchHeld(() => selectProject(fx.projects.alpha), 'Projects/alpha')
  // Written once the project is on screen: the live watcher reports it (a write before the
  // project is selected can land before its watch starts and never show).
  await write(join(fx.alpha, 'README.md'), '# Alpha\n\nStaged edit.\n')
  const row = view().getByTestId('git-change-Projects/alpha/README.md')
  await row.hover()
  await row.getByTestId('git-stage-Projects/alpha/README.md').click()
  await expect(toast('Staged README.md.')).toBeVisible()
  await expect(view().getByTestId('git-staged-Projects/alpha/README.md')).toBeVisible()
  await expect(toast(/still running in this repository/)).toHaveCount(0)
  expect(gitIn(fx.scratch, fx.alpha, 'diff', '--cached', '--name-only').trim()).toBe('README.md')
  // The fetch let go while still held: the user's operation did not wait for it to end.
  expect(await exists(hold())).toBe(true)
  await expect.poll(() => exists(join(fx.alpha, '.git', 'pomade-operation.lock'))).toBe(false)
})

test('Commit & push while the background fetch is in flight: the commit runs (the push then fails on auth, in plain words)', async () => {
  await write(join(fx.gamma, 'README.md'), '# Gamma\n\nGamma app, edited.\n')
  await openWithFetchHeld(async () => {
    await selectProject('__workspace__')
    await page.getByTestId('git-repo-row-Apps/gamma').click()
  }, 'Apps/gamma')
  await view().getByTestId('git-commit-open').click()
  await expect(view().getByTestId('git-commit-preview')).toBeVisible()
  await view().getByTestId('git-commit-message').fill('Gamma: readme')
  await view().getByTestId('git-commit-run').click()
  await expect(view().getByTestId('git-commit-failure-message')).toHaveText(/^Committed [0-9a-f]{7}, but it was not pushed\. GitHub refused the push/)
  expect(gitIn(fx.scratch, fx.gamma, 'log', '-1', '--format=%s').trim()).toBe('Gamma: readme')
  expect(await exists(hold())).toBe(true)
})
