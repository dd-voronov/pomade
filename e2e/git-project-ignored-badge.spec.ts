// modules: git, projects
// Pomade T-265 e2e — a project folder that is not a repo, inside a repo that ignores it, has no git:
// the Projects panel badge and the Git panel agree. The workspace-root repo is one commit ahead of
// its bare remote, ignores Projects/alpha (so Alpha has no git) and tracks Projects/beta (so Beta's
// badge still counts the root repo's unpushed commit). Set POMADE_T265_SHOTS=<dir> for screenshots.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchAppPage } from './fixtures/app'
import { showGitPanel } from './fixtures/panels'
import { tempDir } from './fixtures/temp'

const SHOTS = process.env.POMADE_T265_SHOTS

/** A screenshot of the window into POMADE_T265_SHOTS, when set. */
async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, name) })
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

let fixture: Fixture
let remote: string
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const root = fixture.workspaceRoot
  remote = await tempDir('pomade-remote-')
  git(remote, 'init', '-q', '--bare', '-b', 'main')

  await fs.writeFile(join(root, '.gitignore'), '.pomade/\nnode_modules/\nProjects/alpha/\n', 'utf8')
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 't@pomade.test')
  git(root, 'config', 'user.name', 'Pomade Test')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'root v1')
  git(root, 'remote', 'add', 'origin', remote)
  git(root, 'push', '-q', '-u', 'origin', 'main')
  await fs.appendFile(join(root, 'todo.txt'), 'second todo\n')
  git(root, 'commit', '-q', '-am', 'root local')

  ;({ app, page } = await launchAppPage(fixture))
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
  if (remote) await rm(remote, { recursive: true, force: true })
})

test('a project the enclosing repo ignores has no badge; one it tracks counts the repo', async () => {
  const rootName = basename(fixture.workspaceRoot)
  // The tracked project counts the root repo's unpushed commit — and by then every row has its
  // git state, so the ignored project's missing badge is not just "not loaded yet".
  const beta = page.getByTestId(`project-git-${fixture.projects.beta}`)
  await expect(beta).toHaveAttribute('data-unpushed', '1')
  await page.getByTestId(`project-git-${fixture.projects.beta}`).hover()
  await expect(page.getByTestId(`project-git-${fixture.projects.beta}-tooltip`)).toHaveText(`${rootName}: 1 unpushed commit`)
  await page.mouse.move(0, 0)

  // The Workspace row sums every repo: the root repo's commit is there.
  await expect(page.getByTestId('project-git-__workspace__')).toHaveAttribute('data-unpushed', '1')

  // The ignored project: no badge, and the Git panel says it has no git.
  await expect(page.getByTestId(`project-git-${fixture.projects.alpha}`)).toHaveCount(0)
  await page.getByTestId(`project-${fixture.projects.alpha}`).click()
  await expect(page.getByTestId('panehost')).toHaveAttribute('data-active-project', fixture.projects.alpha)
  await showGitPanel(page)
  await expect(page.getByTestId('git-panel-empty')).toHaveText('This project is not in a git repository.')
  await expect(page.getByTestId(`project-git-${fixture.projects.alpha}`)).toHaveCount(0)
  await shot('t-265-ignored-project.png')
})
