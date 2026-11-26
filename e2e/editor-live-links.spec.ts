// modules: editor
// Pomade E-024 slice 3 — LIVE view links.
//   • [[wikilinks]] are link-styled literal text (parity with the other views; not
//     clickable in v1) and round-trip byte-exact;
//   • a regular link shows its TEXT only — `[`, `](url)` are hidden and the URL is NEVER
//     inline-revealed, caret or not (zero-reveal);
//   • clicking the link text opens a POPOVER carrying the URL: editing it writes the URL
//     back as the only byte change, an Open control exists;
//   • link TEXT edits letter-by-letter (byte-diff inside the brackets);
//   • deleting the last text letter takes the whole `[…](url)` with it — the buffer never
//     holds an orphaned empty link.

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

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

let fixture: Fixture
let app: ElectronApplication
let page: Page

const vis = (sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)

const FM = '---\ntitle: Links Note\n---\n\n'
const LINKS_BODY =
  '# Links\n\nSee the [Pomade docs](https://example.com/pomade) for details, and the [[vault-structure]] page.\n\nTail paragraph.\n'
const LINKS = FM + LINKS_BODY
// Single-letter link text — the whole-link-removal case.
const GONE = '# Gone\n\nBefore [a](https://example.com/x) after.\n'

function docTab(id: string, name: string): Record<string, unknown> {
  return {
    id,
    projectId: 'proj-alpha',
    kind: 'doc',
    title: name,
    path: `Projects/alpha/${name}`,
    mode: 'live',
    dirty: false
  }
}

const read = (name: string): Promise<string> =>
  fs.readFile(join(fixture.workspaceRoot, 'Projects/alpha', name), 'utf8')

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const root = fixture.workspaceRoot
  await fs.writeFile(join(root, 'Projects/alpha/links.md'), LINKS)
  await fs.writeFile(join(root, 'Projects/alpha/gone.md'), GONE)

  const state = {
    openTabs: [docTab('doc-links', 'links.md'), docTab('doc-gone', 'gone.md')],
    activeTabId: 'doc-links'
  }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(root, '.pomade/state/proj-alpha.json'), JSON.stringify(state, null, 2))

  app = await launchApp({ workspaceRoot: root, userDataDir: fixture.userDataDir })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByTestId('project-proj-alpha').click()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test('wikilink is link-styled literal text; regular link shows TEXT only, URL never in the DOM', async () => {
  await page.getByTestId('tab-doc-links').click()
  const content = vis('[data-testid="live-editor"] .cm-content')
  await expect(content).toBeVisible()

  // Wikilink: brackets stay literal, the run is styled (T-054 parity), not hidden.
  const wiki = content.locator('.cm-wikilink')
  await expect(wiki).toHaveText('[[vault-structure]]')

  // Regular link: text visible + link-styled…
  await expect(content.locator('.cm-live-link', { hasText: 'Pomade docs' }).first()).toBeVisible()
  const text = (await content.textContent()) ?? ''
  // …markers and URL hidden — never inline-revealed.
  expect(text).toContain('Pomade docs')
  expect(text).not.toContain('[Pomade docs]')
  expect(text).not.toContain('https://example.com/pomade')
  expect(text).not.toContain('](')

  // Clicking INTO the link text (caret lands there) still reveals nothing.
  await content.locator('.cm-live-link', { hasText: 'Pomade docs' }).first().click()
  expect((await content.textContent()) ?? '').not.toContain('https://example.com/pomade')
  // Dismiss the popover that click opened (its own test follows).
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-testid="link-popover"]')).toHaveCount(0)

  expect(await read('links.md')).toBe(LINKS)
})

test('clicking the link text opens the URL popover; editing writes the URL as the only byte change', async () => {
  await page.getByTestId('tab-doc-links').click()
  const content = vis('[data-testid="live-editor"] .cm-content')
  await content.locator('.cm-live-link', { hasText: 'Pomade docs' }).first().click()

  const pop = vis('[data-testid="link-popover"]')
  await expect(pop).toBeVisible()
  const input = vis('[data-testid="link-popover-url"]')
  await expect(input).toHaveValue('https://example.com/pomade')
  await expect(vis('[data-testid="link-popover-open"]')).toBeVisible()

  await input.fill('https://example.com/pomade-v2')
  await input.press('Enter')
  await expect(page.locator('[data-testid="link-popover"]')).toHaveCount(0)
  await page.keyboard.press(`${MOD}+s`)
  await expect
    .poll(() => read('links.md'))
    .toBe(LINKS.replace('https://example.com/pomade', 'https://example.com/pomade-v2'))

  // Restore for later tests (popover round-trip again).
  await content.locator('.cm-live-link', { hasText: 'Pomade docs' }).first().click()
  await vis('[data-testid="link-popover-url"]').fill('https://example.com/pomade')
  await vis('[data-testid="link-popover-url"]').press('Enter')
  await page.keyboard.press(`${MOD}+s`)
  await expect.poll(() => read('links.md')).toBe(LINKS)
})

test('link TEXT edits letter-by-letter (byte-diff inside the brackets)', async () => {
  await page.getByTestId('tab-doc-links').click()
  const content = vis('[data-testid="live-editor"] .cm-content')
  const link = content.locator('.cm-live-link', { hasText: 'Pomade docs' }).first()
  // Click inside the text, then move to just after 'docs' and type.
  await link.click()
  const pop = page.locator('[data-testid="link-popover"]')
  await expect(pop).toBeVisible()
  await page.keyboard.press('Escape') // the popover is read/edit UI; text edits happen in place
  await expect(pop).toHaveCount(0)
  // Caret is in the link text where we clicked; jump to the text's end via End→ArrowLeft?
  // End would leave the link (past the hidden tail). Type right where the click landed
  // instead: deterministic — click positions at the nearest char edge inside 'Pomade docs'.
  await page.keyboard.type('X')
  await page.keyboard.press(`${MOD}+s`)
  const onDisk = await read('links.md')
  // Exactly one 'X' landed INSIDE the link text; URL + everything else untouched.
  const m = /\[([^\]]*)\]\(https:\/\/example\.com\/pomade\)/.exec(onDisk)
  expect(m).not.toBeNull()
  expect(m![1].replace('X', '')).toBe('Pomade docs')
  expect(m![1]).toContain('X')
  expect(onDisk.replace(m![0], '[Pomade docs](https://example.com/pomade)')).toBe(LINKS)
  // Restore.
  await page.keyboard.press('Backspace')
  await page.keyboard.press(`${MOD}+s`)
  await expect.poll(() => read('links.md')).toBe(LINKS)
})

test('deleting the last text letter removes the whole […](url) — no orphaned empty link', async () => {
  await page.getByTestId('tab-doc-gone').click()
  const content = vis('[data-testid="live-editor"] .cm-content')
  const line = content.locator('.cm-line', { hasText: 'Before' })
  // Caret right after the link text 'a': click the link char, then End→skip back over
  // ' after.' to sit right past the hidden `](url)`; simpler: click 'a', ArrowRight once
  // (atomic skip over the tail), then Backspace tunnels back to delete 'a'.
  await line.locator('.cm-live-link').click()
  await page.keyboard.press('Escape') // dismiss the popover the click opened
  await page.keyboard.press('End')
  // 'after.' + the space = 7 visible chars between the caret and the link tail.
  for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Backspace') // tunnels the hidden `](url)`, deletes 'a' → empty pair
  await page.keyboard.press(`${MOD}+s`)
  // The WHOLE link went with its last letter (P-024 §4) — no `[](https://…)` orphan.
  await expect.poll(() => read('gone.md')).toBe('# Gone\n\nBefore  after.\n')
})
