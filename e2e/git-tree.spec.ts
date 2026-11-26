// modules: git, filetree, projects
// Pomade E-036 e2e — git in the tree. A fixture workspace whose ROOT is a repo holding a NESTED
// repo (Projects/alpha, with a bare remote as its upstream): discovery + folder names, nearest-repo
// attribution, the letters / tints / folder dots / dimmed ignored rows, ghost rows for deleted
// files and folders, the deleted-file view with Restore file, the remembered "Show git status"
// toggle, and the Projects panel's `● n ↑n` (expanded + rail) going away after commit + push.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchAppPage } from './fixtures/app'
import { tempDir } from './fixtures/temp'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}
function configRepo(dir: string): void {
  git(dir, 'config', 'user.email', 't@pomade.test')
  git(dir, 'config', 'user.name', 'Pomade Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
}
async function write(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content, 'utf8')
}

const A = 'Projects/alpha'

let fixture: Fixture
let remote: string
let alpha: string
let app: ElectronApplication
let page: Page

async function launch(): Promise<void> {
  ;({ app, page } = await launchAppPage(fixture))
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.getByTestId('filetree-root')).toBeVisible()
}

/** Expand a collapsed folder (a plain click toggles it). */
async function expandFolder(path: string): Promise<void> {
  await page.getByTestId(`tree-node-${path}`).click()
  await expect(page.getByTestId(`tree-node-${path}`).locator('[data-testid="tree-chevron"]')).toHaveClass(/twistyOpen/)
}

/** A row's name span (twisty, icon, name, …). */
function nameOf(testId: string): ReturnType<Page['locator']> {
  return page.getByTestId(testId).locator(':scope > span').nth(2)
}

async function hoverText(target: string, tip: string): Promise<string> {
  await page.getByTestId(target).hover()
  const t = page.getByTestId(tip)
  await expect(t).toBeVisible()
  // Every line stays inside the tooltip's box (long repo lines wrap instead of spilling out).
  const spill = await t.evaluate((el) => {
    const box = el.getBoundingClientRect()
    return [...el.children].some((line) => line.getBoundingClientRect().right > box.right)
  })
  expect(spill).toBe(false)
  const text = (await t.textContent()) ?? ''
  await page.mouse.move(0, 0)
  return text
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const root = fixture.workspaceRoot
  alpha = join(root, A)

  // The nested repo, pushed to a bare remote, then one local commit that is NOT pushed.
  remote = await tempDir('pomade-remote-')
  git(remote, 'init', '-q', '--bare', '-b', 'main')
  await write(join(alpha, '.gitignore'), '*.log\n')
  await write(join(alpha, 'old.md'), '# Old\n')
  await write(join(alpha, 'docs/inside.md'), 'inside\n')
  await write(join(alpha, 'gone/a.md'), 'gone a\n')
  await write(join(alpha, 'gone/b.md'), 'gone b\n')
  git(alpha, 'init', '-q', '-b', 'main')
  configRepo(alpha)
  git(alpha, 'add', '-A')
  git(alpha, 'commit', '-q', '-m', 'alpha v1')
  git(alpha, 'remote', 'add', 'origin', remote)
  git(alpha, 'push', '-q', '-u', 'origin', 'main')
  await write(join(alpha, 'committed.md'), 'local only\n')
  git(alpha, 'add', 'committed.md')
  git(alpha, 'commit', '-q', '-m', 'alpha local')

  // The workspace-root repo: tracks everything except the nested repo (which it sees as an
  // untracked folder — the nested repo's own view must win).
  await write(join(root, '.gitignore'), '.pomade/\nnode_modules/\n')
  git(root, 'init', '-q', '-b', 'main')
  configRepo(root)
  git(root, 'add', '.gitignore', 'welcome.md', 'todo.txt', 'Projects/beta', 'Apps', 'Agents', 'Templates')
  git(root, 'commit', '-q', '-m', 'root v1')

  // Working changes in the nested repo: modify, add, delete, rename, ignored, a changed file in a
  // folder, and a whole deleted folder. One change in the root repo.
  await fs.appendFile(join(alpha, 'README.md'), 'changed\n')
  await write(join(alpha, 'new.md'), 'brand new\n')
  await fs.rm(join(alpha, 'notes.txt'))
  git(alpha, 'mv', 'old.md', 'renamed.md')
  await write(join(alpha, 'debug.log'), 'noise\n')
  await fs.appendFile(join(alpha, 'docs/inside.md'), 'more\n')
  await fs.rm(join(alpha, 'gone'), { recursive: true })
  await fs.appendFile(join(root, 'todo.txt'), 'second todo\n')

  await launch()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
  if (remote) await rm(remote, { recursive: true, force: true })
})

test('discovers the root and the nested repo, names them by folder, attributes nearest-repo', async () => {
  // Workspace row: both repos, each under its folder name — never "Workspace root".
  const ws = page.getByTestId('project-git-__workspace__')
  await expect(ws).toHaveAttribute('data-uncommitted', '8')
  await expect(ws).toHaveAttribute('data-unpushed', '1')
  const tip = await hoverText('project-git-__workspace__', 'project-git-__workspace__-tooltip')
  expect(tip).toContain(`${basename(fixture.workspaceRoot)}: 1 uncommitted file`)
  expect(tip).toContain('alpha: 7 uncommitted files · 1 unpushed commit')
  expect(tip).not.toContain('Workspace root')

  // The nested repo's folder is not "untracked" in the parent's view; its changes stay its own.
  await expandFolder('Projects')
  await expect(page.getByTestId('tree-git-dot-Projects')).toBeVisible()
  await expect(page.getByTestId(`tree-node-${A}`)).not.toHaveAttribute('data-git-status', /.*/)
  await expect(page.getByTestId(`tree-git-dot-${A}`)).toBeVisible()
  await expect(page.getByTestId('tree-git-dot-Projects/beta')).toHaveCount(0)
  await expect(page.getByTestId('tree-node-todo.txt')).toHaveAttribute('data-git-status', 'M')
  await expect(page.getByTestId('project-git-proj-beta')).toHaveCount(0)
})

test('letters, tints, hover explanations, folder dots and dimmed ignored files', async () => {
  await expandFolder(A)
  await expect(page.getByTestId(`tree-node-${A}/README.md`)).toHaveAttribute('data-git-status', 'M')
  await expect(page.getByTestId(`tree-git-${A}/README.md`)).toHaveText('M')
  expect(await hoverText(`tree-git-${A}/README.md`, `tree-git-hint-${A}/README.md`)).toBe(
    'M — Modified: changed since the last commit'
  )
  await expect(page.getByTestId(`tree-node-${A}/new.md`)).toHaveAttribute('data-git-status', 'U')
  expect(await hoverText(`tree-git-${A}/new.md`, `tree-git-hint-${A}/new.md`)).toBe('U — New: not in any commit yet')

  // Renamed: shown at the new name only, with where it came from on hover.
  await expect(page.getByTestId(`tree-node-${A}/renamed.md`)).toHaveAttribute('data-git-status', 'R')
  expect(await hoverText(`tree-git-${A}/renamed.md`, `tree-git-hint-${A}/renamed.md`)).toBe('R — Renamed from old.md')
  await expect(page.getByTestId(`tree-ghost-${A}/old.md`)).toHaveCount(0)

  // A tinted name reads in the status color; a clean one does not.
  const tint = (path: string): Promise<string> =>
    nameOf(`tree-node-${path}`).evaluate((el) => getComputedStyle(el).color)
  expect(await tint(`${A}/new.md`)).not.toBe(await tint(`${A}/committed.md`))

  // Collapsed folder with a change inside: dot. Ignored file: dimmed.
  await expect(page.getByTestId(`tree-git-dot-${A}/docs`)).toBeVisible()
  await expect(page.getByTestId(`tree-node-${A}/debug.log`)).toHaveAttribute('data-git-ignored', 'true')
  await expect(page.getByTestId(`tree-node-${A}/committed.md`)).not.toHaveAttribute('data-git-status', /.*/)
})

test('deleted files and folders show as ghost rows in their old place', async () => {
  const ghost = page.getByTestId(`tree-ghost-${A}/notes.txt`)
  await expect(ghost).toBeVisible()
  await expect(ghost).toHaveAttribute('data-git-status', 'D')
  await expect(nameOf(`tree-ghost-${A}/notes.txt`)).toHaveCSS('text-decoration-line', 'line-through')

  const ghostDir = page.getByTestId(`tree-ghost-${A}/gone`)
  await expect(ghostDir).toHaveAttribute('data-kind', 'dir')
  await ghostDir.click()
  await expect(page.getByTestId(`tree-ghost-${A}/gone/a.md`)).toBeVisible()
  await expect(page.getByTestId(`tree-ghost-${A}/gone/b.md`)).toBeVisible()
})

// T-220 — a ghost (deleted) row has no Rename: a double-click opens no prompt, and a ghost folder
// toggles once (not twice) like a single click.
test('double-clicking a ghost row opens no Rename prompt and toggles a ghost folder once', async () => {
  const ghostDir = page.getByTestId(`tree-ghost-${A}/gone`)
  await expect(page.getByTestId(`tree-ghost-${A}/gone/a.md`)).toBeVisible() // open from the test above
  await ghostDir.dblclick()
  await expect(page.getByTestId(`tree-ghost-${A}/gone/a.md`)).toHaveCount(0) // one toggle → collapsed
  await expect(page.getByTestId('name-prompt')).toHaveCount(0)
  await ghostDir.click()
  await expect(page.getByTestId(`tree-ghost-${A}/gone/a.md`)).toBeVisible()
})

test('a change on disk shows up live (watcher), in the right repo', async () => {
  await write(join(alpha, 'live.md'), 'live\n')
  await expect(page.getByTestId(`tree-node-${A}/live.md`)).toHaveAttribute('data-git-status', 'U')
  await fs.appendFile(join(fixture.workspaceRoot, 'welcome.md'), 'edit\n')
  await expect(page.getByTestId('tree-node-welcome.md')).toHaveAttribute('data-git-status', 'M')
  await expect(page.getByTestId('project-git-proj-alpha')).toHaveAttribute('data-uncommitted', '8')
})

test('clicking a ghost opens the last committed version read-only; Restore file brings it back', async () => {
  await page.getByTestId(`tree-ghost-${A}/notes.txt`).click()
  await expect(page.getByTestId('deleted-file-overlay')).toBeVisible()
  await expect(page.getByTestId('deleted-file-title')).toHaveText('notes.txt · deleted')
  await expect(page.getByTestId('deleted-file-content')).toContainText('alpha notes')
  await expect(page.getByTestId('deleted-file-content').locator('.cm-content')).toHaveAttribute(
    'contenteditable',
    'false'
  )

  await page.getByTestId('deleted-file-restore').click()
  await expect(page.getByTestId('deleted-file-overlay')).toHaveCount(0)
  expect(await fs.readFile(join(alpha, 'notes.txt'), 'utf8')).toBe('alpha notes\n')
  await expect(page.getByTestId(`tree-ghost-${A}/notes.txt`)).toHaveCount(0)
  const row = page.getByTestId(`tree-node-${A}/notes.txt`)
  await expect(row).toBeVisible()
  await expect(row).not.toHaveAttribute('data-git-status', /.*/)
})

test('the Projects panel shows ● n ↑n per project, in the rail too, and nothing after commit + push', async () => {
  const badge = page.getByTestId('project-git-proj-alpha')
  await expect(badge).toHaveAttribute('data-unpushed', '1')
  await expect(page.getByTestId('project-git-proj-alpha-uncommitted')).toHaveText('7')
  await expect(page.getByTestId('project-git-proj-alpha-unpushed')).toHaveText('↑1')
  expect(await hoverText('project-git-proj-alpha', 'project-git-proj-alpha-tooltip')).toBe(
    'alpha: 7 uncommitted files · 1 unpushed commit'
  )
  // Hovering the row brings up its kebab (and the fade before it) in the counter's slot, clear of
  // the counts.
  await page.getByTestId('project-name-proj-alpha').hover()
  const slab = await page.getByTestId('project-menu-proj-alpha').locator('..').boundingBox()
  const counts = await badge.boundingBox()
  expect(counts!.x + counts!.width).toBeLessThanOrEqual(slab!.x + 0.5)
  await page.mouse.move(0, 0)

  // Rail: a corner dot on the launcher.
  await page.getByTestId('projects-panel-collapse').click()
  await expect(page.getByTestId('rail-git-proj-alpha')).toBeVisible()
  await expect(page.getByTestId('rail-git-proj-beta')).toHaveCount(0)
  await page.getByTestId('projects-panel-expand').click()

  git(alpha, 'add', '-A')
  git(alpha, 'commit', '-q', '-m', 'alpha v2')
  git(alpha, 'push', '-q')
  await expect(badge).toHaveCount(0)
  await expect(page.getByTestId(`tree-ghost-${A}/gone`)).toHaveCount(0)
  await expect(page.getByTestId(`tree-node-${A}/README.md`)).not.toHaveAttribute('data-git-status', /.*/)
})

test('"Show git status" off hides every mark and ghost; on brings them back; it is remembered', async () => {
  await fs.rm(join(alpha, 'renamed.md'))
  await expect(page.getByTestId(`tree-ghost-${A}/renamed.md`)).toBeVisible()
  await expect(page.locator('[data-git-status]').first()).toBeVisible()

  await page.getByTestId('tree-section-kebab').click()
  await expect(page.getByTestId('menu-toggle-git-status')).toHaveText('Hide git status')
  await page.getByTestId('menu-toggle-git-status').click()
  await expect(page.locator('[data-git-status]')).toHaveCount(0)
  await expect(page.locator('[data-git-ignored]')).toHaveCount(0)
  await expect(page.locator('[data-testid^="tree-git-dot-"]')).toHaveCount(0)
  await expect(page.getByTestId(`tree-ghost-${A}/renamed.md`)).toHaveCount(0)

  // Remembered across a relaunch — once main holds the setting (the click's save is async; closing
  // before it lands would relaunch with the old value).
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.pomade.app.getSettings()).showGitStatus
      )
    )
    .toBe(false)
  await app.close()
  await launch()
  await expandFolder('Projects')
  await expandFolder(A)
  await expect(page.getByTestId(`tree-node-${A}/README.md`)).toBeVisible()
  await expect(page.locator('[data-git-status]')).toHaveCount(0)

  await page.getByTestId('tree-section-kebab').click()
  await expect(page.getByTestId('menu-toggle-git-status')).toHaveText('Show git status')
  await page.getByTestId('menu-toggle-git-status').click()
  await expect(page.getByTestId(`tree-ghost-${A}/renamed.md`)).toBeVisible()
  await expect(page.getByTestId('tree-node-welcome.md')).toHaveAttribute('data-git-status', 'M')
})
