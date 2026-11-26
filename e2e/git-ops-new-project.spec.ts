// modules: git, projects
// Pomade E-039 e2e — "Track with git" in the project dialog, and a missing git identity. Two apps,
// each on its own fixture with isolated git config (GIT_CONFIG_GLOBAL): one where git knows who
// you are, one where it does not. Set POMADE_E039_SHOTS=<dir> for screenshots.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { launchAppPage } from './fixtures/app'
import { createGitOpsFixture, gitIn, write, type GitOpsFixture } from './fixtures/git-ops-repos'
import { showGitPanel } from './fixtures/panels'

const SHOTS = process.env.POMADE_E039_SHOTS

let fx: GitOpsFixture
let app: ElectronApplication
let page: Page

async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

const exists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false)
const g = (cwd: string, ...args: string[]): string => gitIn(fx.scratch, cwd, ...args).trim()

async function openNewProject(mode: 'existing' | 'template', name: string): Promise<void> {
  await page.getByTestId('new-project').click()
  await expect(page.getByTestId('project-modal')).toBeVisible()
  await page.getByTestId(`create-mode-${mode}`).click()
  await page.getByTestId('project-name').fill(name)
}

test.describe('git knows who you are', () => {
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

  test('a new project from a template is tracked with git by default: a repository with one commit', async () => {
    await openNewProject('template', 'Tracked')
    await page.getByTestId('project-template').fill('Templates/basic-project')
    await page.getByTestId('project-parent').fill('Projects')
    await expect(page.getByTestId('project-track-git')).toBeChecked()
    await shot('new-project-template')
    await page.getByTestId('project-save').click()
    await expect(page.getByTestId('project-modal')).toHaveCount(0)
    const dir = join(fx.workspaceRoot, 'Projects/Tracked')
    expect(await exists(join(dir, '.git'))).toBe(true)
    expect(g(dir, 'rev-list', '--count', 'HEAD')).toBe('1')
    expect(g(dir, 'log', '-1', '--format=%s')).toBe('Start Tracked')
    expect(g(dir, 'status', '--porcelain')).toBe('')
  })

  test('unchecking "Track with git" leaves no .git', async () => {
    await openNewProject('template', 'Untracked')
    await page.getByTestId('project-template').fill('Templates/basic-project')
    await page.getByTestId('project-parent').fill('Projects')
    await page.getByTestId('project-track-git').uncheck()
    await page.getByTestId('project-save').click()
    await expect(page.getByTestId('project-modal')).toHaveCount(0)
    expect(await exists(join(fx.workspaceRoot, 'Projects/Untracked/README.md'))).toBe(true)
    expect(await exists(join(fx.workspaceRoot, 'Projects/Untracked/.git'))).toBe(false)
  })

  test('a folder that does not exist yet is created and tracked; an existing folder without git is offered unchecked', async () => {
    await openNewProject('existing', 'Fresh')
    await page.getByTestId('project-root').fill('Projects/fresh')
    await expect(page.getByTestId('project-folder-new')).toBeVisible()
    await expect(page.getByTestId('project-track-git')).toBeChecked()
    await page.getByTestId('project-save').click()
    await expect(page.getByTestId('project-modal')).toHaveCount(0)
    const fresh = join(fx.workspaceRoot, 'Projects/fresh')
    expect(g(fresh, 'rev-list', '--count', 'HEAD')).toBe('1')

    await openNewProject('existing', 'Plain')
    await write(join(fx.workspaceRoot, 'Notes/plain.md'), 'plain\n')
    await page.getByTestId('project-root').fill('Notes')
    await expect(page.getByTestId('project-track-git')).not.toBeChecked()
    await shot('new-project-existing-unchecked')
    await page.getByTestId('project-save').click()
    await expect(page.getByTestId('project-modal')).toHaveCount(0)
    expect(await exists(join(fx.workspaceRoot, 'Notes/.git'))).toBe(false)
  })

  test('a folder with .git shows its remote, or Local only', async () => {
    await openNewProject('existing', 'Alpha again')
    await page.getByTestId('project-root').fill('Projects/alpha')
    await expect(page.getByTestId('project-git-info')).toHaveAttribute('data-kind', 'repo')
    await expect(page.getByTestId('project-git-remote')).toHaveText(fx.remote.replace(/\.git$/, ''))
    await expect(page.getByTestId('project-track-git')).toHaveCount(0)
    await page.getByTestId('project-root').fill('Projects/beta')
    await expect(page.getByTestId('project-git-remote')).toHaveText('Local only — commits exist only on this Mac')
    await shot('new-project-repo-info')
    await page.getByTestId('modal-close').click()
  })
})

test.describe('git does not know who you are', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    fx = await createGitOpsFixture({ identity: false })
    ;({ app, page } = await launchAppPage(fx, fx.env))
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    await fx?.cleanupGit()
  })

  test('a new project: created, its repository started, and a plain message with what to run', async () => {
    await openNewProject('template', 'Nameless')
    await page.getByTestId('project-template').fill('Templates/basic-project')
    await page.getByTestId('project-parent').fill('Projects')
    await page.getByTestId('project-save').click()
    const note = page.getByTestId('project-git-failure')
    await expect(note).toBeVisible()
    await expect(note.getByTestId('project-git-failure-message')).toContainText(
      'Created “Nameless” and started its git repository, but the first commit was not made. Git doesn’t know your name and email yet'
    )
    await expect(note.getByTestId('project-git-failure-message')).toContainText('git config --global user.email "you@example.com"')
    await note.getByTestId('git-op-copy').click()
    await expect
      .poll(() => page.evaluate(() => window.pomade.app.clipboardRead()))
      .toBe('git config --global user.name "Your Name"\ngit config --global user.email "you@example.com"')
    await shot('new-project-identity')
    await page.getByTestId('project-done').click()
    await expect(page.getByTestId('project-modal')).toHaveCount(0)
    await expect(page.getByTestId('projects-panel-scroll').getByText('Nameless', { exact: true })).toBeVisible()
    const dir = join(fx.workspaceRoot, 'Projects/Nameless')
    expect(await exists(join(dir, '.git'))).toBe(true)
    expect(await exists(join(dir, 'README.md'))).toBe(true)
  })

  test('Commit & push is refused up front with the same message — never a silent failure', async () => {
    await page.getByTestId(`project-${fx.projects.beta}`).click()
    await showGitPanel(page)
    const view = page.getByTestId('git-repo-view')
    await expect(view).toBeVisible()
    await write(join(fx.beta, 'README.md'), '# Beta\n\nedited\n')
    await expect(view.getByTestId('git-changes-count')).toHaveText('1')
    await view.getByTestId('git-commit-open').click()
    await expect(view.getByTestId('git-commit-blocked-message')).toContainText('Git doesn’t know your name and email yet')
    await view.getByTestId('git-commit-message').fill('Beta: no identity')
    await expect(view.getByTestId('git-commit-run')).toBeDisabled()
    await shot('commit-identity')
  })
})
