// modules: git, editor, tabs
// Pomade E-037 e2e — the comparison tab, on the git fixture (e2e/fixtures/git-repos.ts): a Changes
// click opens last commit ↔ the current doc; "take old" puts one chunk into the right side as an
// unsaved edit (Cmd+Z undoes); the doc tab shares the very same buffer; Cmd+S saves; a commit's file
// opens parent ↔ commit read-only; the amber banner's Compare opens disk ↔ my edits; file ↔ file;
// restart restores, an unresolvable version restores to a notice; hidden, never unmounted.
// Set POMADE_E037_SHOTS=<dir> to save review screenshots there.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { launchAppPage, relaunchApp } from './fixtures/app'
import { BACKLOG_V1, BACKLOG_V2, BACKLOG_WORKING, createGitFixture, git, type GitFixture } from './fixtures/git-repos'
import { humanDoubleClick } from './fixtures/interactions'
import { activeIdOf, tabsOf, waitCaretRegistered } from './fixtures/stores'
import { showGitPanel } from './fixtures/panels'
import { readViewState } from './fixtures/settings'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const SHOTS = process.env.POMADE_E037_SHOTS
const BACKLOG = 'Projects/alpha/docs/BACKLOG.md'

let fx: GitFixture
let app: ElectronApplication
let page: Page

async function shot(name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

async function openAlphaGit(): Promise<void> {
  await page.getByTestId('project-proj-alpha').click()
  await expect(page.getByTestId('panehost')).toHaveAttribute('data-active-project', 'proj-alpha')
  await showGitPanel(page)
  await expect(page.getByTestId('git-repo-view')).toBeVisible()
}

const pane = (): ReturnType<Page['locator']> => page.locator('[data-testid="compare-pane"]:visible')
/** A side's document text: its lines (CodeMirror's `.cm-line`s — the merge spacers are not lines),
 *  trailing empty lines dropped. The fixture docs are small, so every line is rendered. */
const sideText = (side: 'a' | 'b'): Promise<string> =>
  pane()
    .locator(`.cm-merge-${side} .cm-content`)
    .evaluate((el) => [...el.querySelectorAll(':scope > .cm-line')].map((l) => l.textContent ?? '').join('\n'))
    .then((t) => t.replace(/\n+$/, ''))
const tabTitles = async (): Promise<string[]> => (await tabsOf(page, 'proj-alpha')).map((t) => t.title)

test.beforeAll(async () => {
  fx = await createGitFixture()
  ;({ app, page } = await launchAppPage(fx))
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fx?.cleanupGit()
})

test('a Changes click opens last commit ↔ now: labels with short hashes, title, highlighted changes', async () => {
  await openAlphaGit()
  await page.getByTestId(`git-change-${BACKLOG}`).click()
  await expect(pane()).toHaveAttribute('data-mode', 'version-current')
  const head = git(fx.alpha, 'rev-parse', '--short=7', 'HEAD').trim()
  await expect(pane().getByTestId('compare-label-left')).toContainText(`HEAD · ${head} · Oct 17`)
  await expect(pane().getByTestId('compare-label-right')).toContainText('Now')
  await expect.poll(tabTitles).toContain('BACKLOG.md · Oct 17 ↔ now')
  await expect.poll(() => sideText('a')).toBe(BACKLOG_V2.replace(/\n$/, ''))
  expect(await sideText('b')).toBe(BACKLOG_WORKING.replace(/\n$/, ''))
  expect(await pane().locator('.cm-merge-b .cm-changedLine').count()).toBeGreaterThan(0)
  await expect(pane().getByTestId('compare-take-old')).toHaveCount(2)
  // The left side is read-only; the right side is the document.
  await expect(pane().locator('.cm-merge-a .cm-content')).toHaveAttribute('contenteditable', 'false')
  await expect(pane().locator('.cm-merge-b .cm-content')).toHaveAttribute('contenteditable', 'true')
  // Looking does not open the doc tab.
  expect((await tabsOf(page, 'proj-alpha')).filter((t) => t.kind === 'doc')).toHaveLength(0)
  await expect(pane().getByTestId('compare-save')).toHaveText('Saved')
})

test('take old changes only that chunk, as an unsaved edit of the shared buffer; Cmd+Z undoes; Cmd+S saves', async () => {
  const compareId = await activeIdOf(page, 'proj-alpha')
  await pane().getByTestId('compare-take-old').first().click()
  await expect.poll(() => sideText('b')).toContain('- **T-197** terminal Cmd+click fix\n')
  expect(await sideText('b')).toContain('Paragraph one was rewritten by an agent.')
  await expect(pane().getByTestId('compare-take-old')).toHaveCount(1)
  await expect(pane().getByTestId('compare-label-right')).toHaveAttribute('data-dirty', 'true')
  await expect(pane().getByTestId('compare-save')).toHaveText('Save')
  // The doc's own tab opened in the background, dirty with the same buffer; the disk is untouched.
  await expect.poll(async () => (await tabsOf(page, 'proj-alpha')).find((t) => t.kind === 'doc')?.dirty).toBe(true)
  expect(await activeIdOf(page, 'proj-alpha')).toBe(compareId)
  expect(await fs.readFile(join(fx.workspaceRoot, BACKLOG), 'utf8')).toBe(BACKLOG_WORKING)
  await shot('07-compare-taken-chunk')

  // Cmd+Z in the right side undoes the take.
  await pane().locator('.cm-merge-b .cm-content').click()
  await page.keyboard.press(`${MOD}+z`)
  await expect.poll(() => sideText('b')).toContain('(verified)')
  await expect(pane().getByTestId('compare-take-old')).toHaveCount(2)
  await expect.poll(async () => (await tabsOf(page, 'proj-alpha')).find((t) => t.kind === 'doc')?.dirty).toBe(false)

  // Take it again, then look at the doc tab: the same buffer.
  await pane().getByTestId('compare-take-old').first().click()
  await expect.poll(() => sideText('b')).not.toContain('(verified)')
  const doc = (await tabsOf(page, 'proj-alpha')).find((t) => t.kind === 'doc')!
  await page.getByTestId(`tab-${doc.id}`).click()
  const editor = page.locator(`[data-testid="editor-pane"][data-doc-path="${BACKLOG}"]`)
  await expect(editor).toBeVisible()
  await expect(editor).toContainText('terminal Cmd+click fix')
  await expect(editor).not.toContainText('(verified)')
  await expect(page.getByTestId(`tab-${doc.id}`).locator('[aria-label="unsaved"]')).toBeVisible()

  // An edit in the doc tab shows on the comparison's right side.
  await editor.getByText('Paragraph one was rewritten by an agent.').click()
  await waitCaretRegistered(page)
  await page.keyboard.press('End')
  await page.keyboard.type(' EXTRA')
  await page.getByTestId(`tab-${compareId}`).click()
  await expect.poll(() => sideText('b')).toContain('rewritten by an agent. EXTRA')

  // Cmd+S in the comparison saves the document.
  await pane().locator('.cm-merge-b .cm-content').click()
  await page.keyboard.press(`${MOD}+s`)
  await expect
    .poll(() => fs.readFile(join(fx.workspaceRoot, BACKLOG), 'utf8'))
    .toBe(BACKLOG_V2.replace('Paragraph one stays the same.', 'Paragraph one was rewritten by an agent. EXTRA'))
  await expect(pane().getByTestId('compare-save')).toHaveText('Saved')
  await expect(pane().getByTestId('compare-label-right')).not.toHaveAttribute('data-dirty', /.*/)
})

test('a commit file opens parent ↔ commit, both read-only, no take-old', async () => {
  const squash = git(fx.alpha, 'rev-parse', '--short=7', 'HEAD~3').trim()
  await page.getByTestId(`git-commit-${squash}`).click()
  await page.locator('[data-testid="commit-pane"]:visible').getByTestId('commit-file-docs/BACKLOG.md').click()
  await expect(pane()).toHaveAttribute('data-mode', 'version-version')
  await expect.poll(tabTitles).toContain('BACKLOG.md · Oct 10 ↔ Oct 12')
  await expect.poll(() => sideText('a')).toBe(BACKLOG_V1.replace(/\n$/, ''))
  expect(await sideText('b')).toBe(BACKLOG_V2.replace(/\n$/, ''))
  await expect(pane().getByTestId('compare-take-old')).toHaveCount(0)
  await expect(pane().locator('.cm-merge-b .cm-content')).toHaveAttribute('contenteditable', 'false')
  await expect(pane().getByTestId('compare-save')).toHaveCount(0)

  // A deleted file: its commit side reads as not in this version.
  const commitTab = (await tabsOf(page, 'proj-alpha')).find((t) => t.kind === 'commit')!
  await page.getByTestId(`tab-${commitTab.id}`).click()
  await page.locator('[data-testid="commit-pane"]:visible').getByTestId('commit-file-obsolete.md').click()
  await expect(pane().getByTestId('compare-label-right')).toContainText('not in this version')
  await expect.poll(() => sideText('a')).toBe('obsolete')
})

test('the amber banner\'s Compare opens disk ↔ my edits; saving there keeps mine', async () => {
  await humanDoubleClick(page, page.getByTestId(`git-change-${'Projects/alpha/draft.md'}`))
  await expect(pane()).toHaveAttribute('data-mode', 'version-current')
  await expect(pane().getByTestId('compare-label-left')).toContainText('not in this version')
  // A double click's two clicks open one tab, not twins.
  await expect.poll(async () => (await tabTitles()).filter((x) => x === 'draft.md · Oct 17 ↔ now')).toHaveLength(1)
  // Type at the start of the right side: the draft becomes dirty (its doc tab opens behind).
  await pane().locator('.cm-merge-b .cm-line').first().click()
  await page.keyboard.press(`${MOD}+ArrowUp`)
  await page.keyboard.type('MINE ')
  await expect(pane().getByTestId('compare-label-right')).toHaveAttribute('data-dirty', 'true')
  await fs.writeFile(join(fx.alpha, 'draft.md'), '# Draft\n\nChanged by an agent.\n')
  const amber = pane().getByTestId('editor-changed-dirty')
  await expect(amber).toHaveText(/File changed since your edits\./)

  await amber.getByTestId('editor-compare-disk').click()
  await expect(pane()).toHaveAttribute('data-mode', 'disk-mine')
  await expect.poll(tabTitles).toContain('draft.md · disk ↔ my edits')
  await expect(pane().getByTestId('compare-label-left')).toContainText('On disk now')
  await expect.poll(() => sideText('a')).toContain('Changed by an agent.')
  await expect(pane().getByTestId('compare-resolve')).toBeVisible()
  await shot('08-compare-disk-mine')
  await pane().locator('.cm-merge-b .cm-content').click()
  await page.keyboard.press(`${MOD}+s`)
  await expect(page.locator('[data-testid="save-conflict-confirm"]:visible')).toHaveCount(0)
  await expect.poll(() => fs.readFile(join(fx.alpha, 'draft.md'), 'utf8')).toBe('MINE # Draft\n\nNot committed yet.\n')
  await expect(pane().getByTestId('compare-resolve')).toHaveCount(0)
})

test('file ↔ file: left read-only, right the editable document', async () => {
  await page.evaluate(() => {
    window.__pomadeStores.useTabsStore.getState().openTab({
      id: 'cmp-files',
      projectId: 'proj-alpha',
      kind: 'compare',
      title: 'links.md ↔ terminal-links.md',
      left: { kind: 'disk', path: 'Projects/alpha/links.md' },
      right: { kind: 'file', path: 'Projects/alpha/terminal-links.md' }
    } as never)
  })
  await expect(pane()).toHaveAttribute('data-mode', 'file-file')
  await expect(pane().getByTestId('compare-label-left')).toContainText('links.md')
  await expect(pane().getByTestId('compare-label-right')).toContainText('terminal-links.md')
  await expect.poll(() => sideText('a')).toContain('Old link notes.')
  await expect(pane().locator('.cm-merge-a .cm-content')).toHaveAttribute('contenteditable', 'false')
  await expect(pane().locator('.cm-merge-b .cm-content')).toHaveAttribute('contenteditable', 'true')
  await expect(pane().getByTestId('compare-take-old').first()).toBeVisible()

  // Open in editor focuses the document's own tab.
  await pane().getByTestId('compare-open-editor').click()
  await expect(page.locator('[data-testid="editor-pane"][data-doc-path="Projects/alpha/terminal-links.md"]')).toBeVisible()
  await page.getByTestId('tab-cmp-files').click()
})

// T-267 — Changes only: a 60-line file with two changes 30 lines apart.
const FOLD_A = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
const FOLD_B = FOLD_A.replace('line 15\n', 'line 15 CHANGED\n').replace('line 45\n', 'line 45 CHANGED\n')
const range = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`)
const sideLines = async (side: 'a' | 'b'): Promise<string[]> => (await sideText(side)).split('\n')
/** The fold bars on the right side (the `⦚` glyphs are CSS pseudo-elements, not text). */
const folds = (): ReturnType<Page['locator']> => pane().locator('.cm-merge-b .cm-collapsedLines')
const changesOnly = (): ReturnType<Page['locator']> => pane().getByTestId('compare-changes-only')
/** The parts of each fold's band between the two sides (T-278). */
const bands = (): ReturnType<Page['locator']> => pane().getByTestId('compare-fold-band')
const savedSetting = async (): Promise<boolean | undefined> =>
  (await readViewState(fx.workspaceRoot)).compareChangesOnly as boolean | undefined

async function openFoldTab(id: string): Promise<void> {
  await page.evaluate((tabId) => {
    window.__pomadeStores.useTabsStore.getState().openTab({
      id: tabId,
      projectId: 'proj-alpha',
      kind: 'compare',
      title: 'fold-a.md ↔ fold-b.md',
      left: { kind: 'disk', path: 'Projects/alpha/fold-a.md' },
      right: { kind: 'file', path: 'Projects/alpha/fold-b.md' }
    } as never)
  }, id)
  await expect(pane()).toHaveAttribute('data-path', 'Projects/alpha/fold-b.md')
}

test('Changes only: off shows every line; on folds the unchanged runs to 3 lines around each change; a click unfolds', async () => {
  await fs.writeFile(join(fx.alpha, 'fold-a.md'), FOLD_A)
  await fs.writeFile(join(fx.alpha, 'fold-b.md'), FOLD_B)
  await openFoldTab('cmp-fold-1')
  await expect(changesOnly()).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(() => sideLines('a')).toEqual(range(1, 60))
  expect(await sideLines('b')).toHaveLength(60)
  await expect(folds()).toHaveCount(0)

  await changesOnly().click()
  await expect(changesOnly()).toHaveAttribute('aria-pressed', 'true')
  await expect(folds()).toHaveCount(3)
  await expect(folds().nth(0)).toHaveText('11 unchanged lines')
  await expect(folds().nth(1)).toHaveText('23 unchanged lines')
  await expect(folds().nth(2)).toHaveText('13 unchanged lines')
  expect(await sideLines('a')).toEqual([...range(12, 18), ...range(42, 48)])
  expect(await sideLines('b')).toEqual([
    ...range(12, 14),
    'line 15 CHANGED',
    ...range(16, 18),
    ...range(42, 44),
    'line 45 CHANGED',
    ...range(46, 48)
  ])
  await shot('T-267-changes-only-on')

  // T-278 — each fold is one band edge to edge: the take-old column between the sides carries the
  // bar too, at the fold's height, on top, in the bar's wash.
  const revert = (await pane().locator('.cm-merge-revert').boundingBox())!
  await expect(bands()).toHaveCount(3)
  const wash = await folds().first().evaluate((el) => getComputedStyle(el).backgroundColor)
  for (let i = 0; i < 3; i++) {
    const bar = (await folds().nth(i).boundingBox())!
    const band = (await bands().nth(i).boundingBox())!
    expect(Math.abs(band.y - bar.y)).toBeLessThan(0.5)
    expect(Math.abs(band.height - bar.height)).toBeLessThan(0.5)
    expect(band.x).toBeLessThanOrEqual(revert.x)
    expect(band.x + band.width).toBeGreaterThanOrEqual(revert.x + revert.width)
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.getAttribute('data-testid'), [
      revert.x + revert.width / 2,
      bar.y + bar.height / 2
    ])
    expect(hit).toBe('compare-fold-band')
    expect(await bands().nth(i).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(wash)
  }

  // A click on a bar shows the run it hid, on both sides; the other bars stay.
  await folds().nth(1).click()
  await expect(folds()).toHaveCount(2)
  expect(await sideLines('a')).toEqual(range(12, 48))
  expect(await sideLines('b')).toHaveLength(37)
  // A click on the band between the sides does the same, and the bands follow.
  await expect(bands()).toHaveCount(2)
  await bands().first().click()
  await expect(folds()).toHaveCount(1)
  expect(await sideLines('a')).toEqual(range(1, 48))
  expect(await sideLines('b')).toHaveLength(48)
  await expect(bands()).toHaveCount(1)
  const last = (await folds().first().boundingBox())!
  expect(Math.abs((await bands().first().boundingBox())!.y - last.y)).toBeLessThan(0.5)

  // A second comparison tab opened afterwards starts with the switch on.
  await openFoldTab('cmp-fold-2')
  await expect(changesOnly()).toHaveAttribute('aria-pressed', 'true')
  await expect(folds()).toHaveCount(3)
  // It is one setting: the first tab follows a change made in this one, and it is saved.
  await changesOnly().click()
  await expect(folds()).toHaveCount(0)
  await expect.poll(savedSetting).toBe(false)
  await page.getByTestId('tab-cmp-fold-1').click()
  await expect(changesOnly()).toHaveAttribute('aria-pressed', 'false')
  await expect(folds()).toHaveCount(0)
  await changesOnly().click()
  await expect.poll(savedSetting).toBe(true)
  await expect(folds()).toHaveCount(3)
})

test('Changes only keeps the live side\'s edit and its undo history through a toggle; a read-only tab has the switch too', async () => {
  await page.getByTestId('tab-cmp-fold-1').click()
  await expect(folds()).toHaveCount(3)
  await pane().locator('.cm-merge-b .cm-line', { hasText: /^line 13$/ }).click()
  await page.keyboard.press('End')
  // One input event, so the edit is one undo step: typed key by key under load, CodeMirror's
  // 500 ms grouping can split it and a single Cmd+Z would undo only part of it.
  await page.keyboard.insertText(' EDIT')
  await expect.poll(() => sideLines('b')).toContain('line 13 EDIT')

  await changesOnly().click()
  await expect(folds()).toHaveCount(0)
  expect(await sideLines('b')).toContain('line 13 EDIT')
  expect(await sideLines('b')).toHaveLength(60)
  await changesOnly().click()
  await expect(folds()).toHaveCount(3)
  expect(await sideLines('b')).toContain('line 13 EDIT')

  // Off again, then Cmd+Z in the live side: the edit typed before the toggles is undone.
  await changesOnly().click()
  await expect(folds()).toHaveCount(0)
  await pane().locator('.cm-merge-b .cm-content').click()
  await page.keyboard.press(`${MOD}+z`)
  await expect.poll(() => sideLines('b')).toContain('line 13')
  expect(await sideLines('b')).not.toContain('line 13 EDIT')
  await changesOnly().click()
  await expect(folds()).toHaveCount(3)

  // A read-only comparison (commit ↔ commit) has the switch as well, on its own header.
  const commitTab = (await tabsOf(page, 'proj-alpha')).find((t) => t.kind === 'commit')!
  await page.getByTestId(`tab-${commitTab.id}`).click()
  await page.locator('[data-testid="commit-pane"]:visible').getByTestId('commit-file-docs/BACKLOG.md').click()
  await expect(pane()).toHaveAttribute('data-mode', 'version-version')
  await expect(changesOnly()).toHaveAttribute('aria-pressed', 'true')
  await expect(pane().getByTestId('compare-save')).toHaveCount(0)
  await expect(pane().getByTestId('compare-open-editor')).toHaveCount(0)
})

test('hidden, never unmounted; survives a restart; a version that is gone restores to a notice', async () => {
  const el = page.locator('[data-testid="pane-cmp-files"] [data-testid="compare-pane"]')
  await el.evaluate((n) => n.setAttribute('data-mark', 'kept'))
  await page.getByTestId('project-proj-beta').click()
  await expect(el).toBeHidden()
  await page.getByTestId('project-proj-alpha').click()
  await expect(el).toHaveAttribute('data-mark', 'kept')

  await page.evaluate(() => {
    window.__pomadeStores.useTabsStore.getState().openTab({
      id: 'cmp-gone',
      projectId: 'proj-alpha',
      kind: 'compare',
      title: 'BACKLOG.md · gone ↔ now',
      left: { kind: 'rev', repo: 'Projects/alpha', rev: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', path: 'Projects/alpha/docs/BACKLOG.md' },
      right: { kind: 'file', path: 'Projects/alpha/docs/BACKLOG.md' }
    } as never)
  })
  await expect(page.getByTestId('pane-cmp-gone').getByTestId('compare-refusal')).toContainText(
    'Version deadbee is no longer in this repository.'
  )

  ;({ app, page } = await relaunchApp(app, fx))
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.getByTestId('project-proj-alpha').click()
  await expect(page.getByTestId('pane-cmp-gone').getByTestId('compare-refusal')).toBeAttached()
  const titles = await tabTitles()
  expect(titles).toContain('BACKLOG.md · Oct 10 ↔ Oct 12')
  const v = (await tabsOf(page, 'proj-alpha')).find((t) => t.title === 'BACKLOG.md · Oct 10 ↔ Oct 12')!
  await page.getByTestId(`tab-${v.id}`).click()
  // Changes only is an app setting: still on after the restart. Off, the whole version shows.
  await expect(changesOnly()).toHaveAttribute('aria-pressed', 'true')
  await changesOnly().click()
  await expect.poll(() => sideText('b')).toBe(BACKLOG_V2.replace(/\n$/, ''))
})
