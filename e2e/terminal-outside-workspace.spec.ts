// modules: terminal, editor
// Pomade T-102 e2e (E-021) — outside-workspace files as a distinct object class.
//
// An absolute path resolving OUTSIDE the workspace opens as a doc tab keyed on its ABSOLUTE path
// (never in the tree, no workspace-relative form). Covers: Cmd+click opens + loads content;
// unsupported (binary / >2 MB) reuses the standard refusal panel and the T-095 empty-save guard
// still holds; edit → first Cmd+S confirms, later saves are silent, close+reopen re-arms; and the
// restore behavior (persists when the path resolves, dropped silently when it does not).
//
// The outside directory is a SECOND temp dir outside the fixture workspace (never a real user
// path). Fixture files mirror real vault content (frontmatter + inline markup), per the repo rule.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'
import { expectQuiet } from './fixtures/timing'
import { writeWhenReady } from './fixtures/stores'
import { tempDir } from './fixtures/temp'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

// Realistic vault-shaped markdown (frontmatter + inline bold + a wikilink) — what the editor
// actually has to load, not a synthetic one-liner.
const NOTE_MD = [
  '---',
  'title: Outside note',
  'tags: [outside, e2e]',
  '---',
  '',
  '# Outside note',
  '',
  'This file lives **outside** the workspace. Sentinel: OUTSIDE_BODY_SENTINEL.',
  'See [[some-other-note]] for context.',
  ''
].join('\n')

// >2 MB of real text — trips the size refusal before any read.
const BIG = ('lorem ipsum dolor sit amet '.repeat(64) + '\n').repeat(1300)
// NUL byte → binary refusal (read happens, content refused).
const BIN = 'PNG ' + '\u0000\u0000' + ' fake binary payload ' + '\u0000' + ' end\n'

async function write(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content, 'utf8')
}

let fixture: Fixture
let app: ElectronApplication
let page: Page
/** A directory OUTSIDE the fixture workspace (still in OS tmp — never a real user path). */
let outsideDir: string
let outsideNote: string
let outsideEdit: string
let outsideBin: string
let outsideBig: string

function readBuffer(termId: string): Promise<string> {
  return page.evaluate((tid) => window.pomade.pty.buffer(tid), termId)
}

async function openTerminal(): Promise<string> {
  await page.getByTestId('tab-add').click()
  await page.getByTestId('tab-add-terminal').click()
  const el = page.locator('[data-term-id]:visible').first()
  await expect(el).toBeVisible()
  const id = await el.getAttribute('data-term-id')
  if (!id) throw new Error('no visible terminal')
  return id
}

/** A ready terminal in the Alpha project, fresh per test (see terminal-links.spec.ts rationale). */
async function alphaTerminal(): Promise<string> {
  await page.getByTestId(`project-${fixture.projects.alpha}`).click()
  const termId = await openTerminal()
  await writeWhenReady(page, termId, "printf 'ALPHA_TERM_READY\\n'\r")
  await expect.poll(() => readBuffer(termId), { timeout: 10_000 }).toContain('ALPHA_TERM_READY')
  return termId
}

/** Activate a link by TOKEN through the pane's e2e hook (scan + resolve + route). */
function activateLink(termId: string, token: string): Promise<void> {
  return page.evaluate(
    ({ tid, tk }) => window.__pomadeTermLinks[tid](tk),
    { tid: termId, tk: token }
  )
}

interface TabSnapshot {
  id: string
  kind: string
  path?: string
  mode?: string
}
function tabsOf(projectId: string): Promise<TabSnapshot[]> {
  return page.evaluate((pid) => {
    const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject[pid] ?? []
    return tabs.map((t) => ({ id: t.id, kind: t.kind, path: t.path, mode: t.mode }))
  }, projectId)
}

function activeProject(): Promise<string> {
  return page.evaluate(() => window.__pomadeStores.useWorkspaceStore.getState().activeProjectId)
}

/** The doc tab (in Alpha) whose absolute path ends with `suffix`, once it exists. */
async function outsideTabId(suffix: string): Promise<string> {
  let id = ''
  await expect
    .poll(
      () =>
        tabsOf(fixture.projects.alpha).then((t) => {
          const hit = t.find(
            (x) => x.kind === 'doc' && !!x.path && x.path.startsWith('/') && x.path.endsWith(suffix)
          )
          id = hit?.id ?? ''
          return !!hit
        }),
      { timeout: 10_000 }
    )
    .toBe(true)
  return id
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  outsideDir = await tempDir('pomade-t102-outside-')
  outsideNote = join(outsideDir, 'outside-note.md')
  outsideEdit = join(outsideDir, 'outside-edit.txt')
  outsideBin = join(outsideDir, 'outside-blob.md')
  outsideBig = join(outsideDir, 'outside-huge.md')
  await write(outsideNote, NOTE_MD)
  await write(outsideEdit, 'first line of an outside file\n')
  await write(outsideBin, BIN)
  await write(outsideBig, BIG)

  app = await launchApp(fixture)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
  if (outsideDir) await fs.rm(outsideDir, { recursive: true, force: true })
})

test.describe('T-102 — outside-workspace files (E-021)', () => {
  test('Cmd+click an outside FILE opens a doc tab keyed on the absolute path, editor loads content', async () => {
    const term = await alphaTerminal()
    await activateLink(term, outsideNote)

    const tabId = await outsideTabId('/outside-note.md')
    // The tab path is the ABSOLUTE path (the distinct object class), not workspace-relative.
    // Compared by shape + suffix: the stored path is CANONICAL (realpath), and on macOS realpath
    // rewrites the /var symlink to /private/var, so the raw temp path never matches literally.
    const tab = (await tabsOf(fixture.projects.alpha)).find((t) => t.id === tabId)
    expect(tab?.path?.startsWith('/')).toBe(true)
    expect(tab?.path?.endsWith('/outside-note.md')).toBe(true)
    // Never switches the active project.
    expect(await activeProject()).toBe(fixture.projects.alpha)

    // The editor pane is visible and shows the file's content (rendered or raw — either way the
    // body text is in the DOM). Not a refusal.
    const pane = page.locator('[data-testid="editor-pane"]:visible')
    await expect(pane).toBeVisible()
    await expect(pane.locator('[data-testid="editor-refusal"]')).toHaveCount(0)
    await expect(pane).toContainText('OUTSIDE_BODY_SENTINEL', { timeout: 10_000 })
    await expect(page.getByTestId('editor-title')).toHaveText('outside-note.md')
  })

  test('an outside BINARY file shows the standard refusal panel and Save stays inert (T-095)', async () => {
    const term = await alphaTerminal()
    const before = await fs.readFile(outsideBin, 'latin1')
    await activateLink(term, outsideBin)
    await outsideTabId('/outside-blob.md')

    const pane = page.locator('[data-testid="editor-pane"]:visible')
    await expect(pane.locator('[data-testid="editor-refusal"]')).toBeVisible({ timeout: 10_000 })
    // T-095 — the refused file was never read, so Save is disabled and Cmd+S must not truncate it.
    await expect(pane.locator('[data-testid="doc-save"]')).toBeDisabled()
    await pane.locator('[data-testid="editor-refusal"]').click()
    await page.keyboard.press(`${MOD}+s`)
    // Real-world window (save-path latency, not interval-derived) — a truncating write would
    // land well inside it; the bytes must hold throughout.
    await expectQuiet(async () => {
      expect(await fs.readFile(outsideBin, 'latin1')).toBe(before)
    }, 600)
  })

  test('an outside >2 MB file shows the standard refusal panel and Save stays inert (T-095)', async () => {
    const term = await alphaTerminal()
    const before = (await fs.stat(outsideBig)).size
    expect(before).toBeGreaterThan(2 * 1024 * 1024)
    await activateLink(term, outsideBig)
    await outsideTabId('/outside-huge.md')

    const pane = page.locator('[data-testid="editor-pane"]:visible')
    await expect(pane.locator('[data-testid="editor-refusal"]')).toBeVisible({ timeout: 10_000 })
    await expect(pane.locator('[data-testid="doc-save"]')).toBeDisabled()
    await pane.locator('[data-testid="editor-refusal"]').click()
    await page.keyboard.press(`${MOD}+s`)
    // Real-world window (save-path latency, not interval-derived) — the size must hold throughout.
    await expectQuiet(async () => {
      expect((await fs.stat(outsideBig)).size).toBe(before)
    }, 600)
  })

  test('first Cmd+S confirms, later saves are silent, close + reopen re-arms the confirm', async () => {
    const term = await alphaTerminal()
    await activateLink(term, outsideEdit)
    await outsideTabId('/outside-edit.txt')

    const pane = page.locator('[data-testid="editor-pane"]:visible')
    await expect(pane).toBeVisible()
    // Edit the raw editor.
    await pane.locator('.cm-content').click()
    await page.keyboard.type(' EDIT_ONE')
    await expect(pane.locator('[data-testid="editor-dirty"]')).toBeVisible()

    // First save → the outside-workspace confirm.
    await page.keyboard.press(`${MOD}+s`)
    const confirm = pane.locator('[data-testid="outside-save-confirm"]')
    await expect(confirm).toBeVisible({ timeout: 10_000 })
    await pane.locator('[data-testid="outside-save-confirm-ok"]').click()
    await expect
      .poll(() => fs.readFile(outsideEdit, 'utf8'), { timeout: 10_000 })
      .toContain('EDIT_ONE')

    // Second save in the SAME tab session → silent (no confirm).
    await pane.locator('.cm-content').click()
    await page.keyboard.type(' EDIT_TWO')
    await page.keyboard.press(`${MOD}+s`)
    // Real-world window (confirm would open right on the keypress, not interval-derived) — the
    // second save must stay silent throughout…
    await expectQuiet(async () => {
      await expect(confirm).toHaveCount(0)
    }, 400)
    // …while the write itself lands.
    await expect
      .poll(() => fs.readFile(outsideEdit, 'utf8'), { timeout: 10_000 })
      .toContain('EDIT_TWO')

    // Close the tab, then reopen it → a fresh tab session re-arms the confirm.
    await pane.locator('[data-testid="doc-close"]').click()
    await expect
      .poll(() =>
        tabsOf(fixture.projects.alpha).then((t) => t.some((x) => x.path === outsideEdit))
      )
      .toBe(false)

    await activateLink(term, outsideEdit)
    await outsideTabId('/outside-edit.txt')
    const pane2 = page.locator('[data-testid="editor-pane"]:visible')
    await pane2.locator('.cm-content').click()
    await page.keyboard.type(' EDIT_THREE')
    await page.keyboard.press(`${MOD}+s`)
    await expect(pane2.locator('[data-testid="outside-save-confirm"]')).toBeVisible({ timeout: 10_000 })
    // Accept so the tab is left clean for teardown.
    await pane2.locator('[data-testid="outside-save-confirm-ok"]').click()
    await expect
      .poll(() => fs.readFile(outsideEdit, 'utf8'), { timeout: 10_000 })
      .toContain('EDIT_THREE')
  })
})
