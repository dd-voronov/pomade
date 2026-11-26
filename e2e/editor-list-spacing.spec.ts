// modules: editor
// Pomade T-126 — tight lists RENDER tight (the visual sibling of T-124's serializer fix).
//
// The rendered view had no tight-list CSS at all: `.ProseMirror p` carries a 0.9em bottom
// margin, so the moment an item gains a nested <ul> its paragraph stops being :last-child and
// keeps the full margin, plus the nested list's own 0.5em — ~1.4em of air at every nesting
// boundary even for tight lists (the Owner's screenshot, 2026-08-19). The fix keys loose spacing
// on the LIST node's data-spread (parser-sourced, default false) — deliberately NOT the list
// ITEM's data-spread, which is boolean-true schema-default junk on freshly created items.
// These specs pin the pixels via bounding-box gaps:
//   1. a parsed tight nested list shows no extra air at nesting boundaries;
//   2. a FRESHLY created nesting level (Enter + Tab — the screenshot gesture) renders tight
//      immediately, even though the new item carries data-spread="true" junk;
//   3. a genuinely loose list keeps visible air between items and between an item's paragraphs;
//   4. a nested task list renders tight through the .taskContent content host.
// Fixtures mirror real vault content: inline **bold** and [[wikilinks]].

import {
  test,
  expect,
  type ElectronApplication,
  type Page,
  type Locator
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp, firstAppWindow } from './fixtures/app'
import { waitCaretRegistered } from './fixtures/stores'

const PID = 'proj-alpha'

const FM = ['---', 'id: T-126', 'tags: [editor]', '---', ''].join('\n')

// 1/2 — a tight two-level list (parsed), also the host for the fresh Enter+Tab nesting probe.
const TIGHT = `${FM}
# Tight

- **Alpha** parent
  - Child with a [[wiki-link]]
  - Second child
- Beta parent
`

// 3 — a genuinely LOOSE list: blank-separated items, multi-paragraph first item.
const LOOSE = `${FM}
# Loose

- First item

  Second paragraph in first item

- Second item
`

// 4 — a tight nested GFM task list (content lives in the .taskContent div, not the li itself).
const TASKS = `${FM}
# Tasks

- [ ] Parent task
  - [x] Done subtask
- [ ] Second parent
`

// Tight boundaries must sit flush (pre-fix they showed ~22px of margin air); loose ones must
// keep the deliberate 0.9em (~13px+) of air.
const TIGHT_MAX = 8
const LOOSE_MIN = 10

let fixture: Fixture
let app: ElectronApplication
let page: Page

const vis = (sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)
const prose = (): Locator => vis('[data-testid="rendered-editor"] .ProseMirror')

// Vertical gap between two paragraphs' boxes: top of `below` minus bottom of `above`.
async function gap(above: Locator, below: Locator): Promise<number> {
  const a = await above.boundingBox()
  const b = await below.boundingBox()
  if (!a || !b) throw new Error('paragraph not visible')
  return b.y - (a.y + a.height)
}

// Anchored regex: `hasText` with a plain string is case-insensitive substring matching, which
// makes e.g. 'First item' ambiguously match "Second paragraph in first item" too.
const para = (re: RegExp): Locator => prose().locator('p').filter({ hasText: re })

function docTab(id: string, name: string): Record<string, unknown> {
  return {
    id,
    projectId: PID,
    kind: 'doc',
    title: name,
    path: `Projects/alpha/${name}`,
    mode: 'rendered',
    dirty: false
  }
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const root = fixture.workspaceRoot
  const seed: { key: string; body: string }[] = [
    { key: 'tight', body: TIGHT },
    { key: 'loose', body: LOOSE },
    { key: 'tasks', body: TASKS }
  ]
  const tabs: Record<string, unknown>[] = []
  for (const s of seed) {
    await fs.writeFile(join(root, `Projects/alpha/${s.key}.md`), s.body)
    tabs.push(docTab(`doc-${s.key}`, `${s.key}.md`))
  }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(
    join(root, '.pomade/state/proj-alpha.json'),
    JSON.stringify({ openTabs: tabs, activeTabId: 'doc-tight' }, null, 2)
  )

  app = await launchApp({ workspaceRoot: root, userDataDir: fixture.userDataDir })
  page = await firstAppWindow(app)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__pomadeStores.useAppSettingsStore.getState().hydrated
      )
    )
    .toBe(true)
  await page.getByTestId(`project-${PID}`).click()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test('1: a parsed tight nested list shows no extra air at nesting boundaries', async () => {
  await page.getByTestId('tab-doc-tight').click()
  await expect(vis('[data-testid="editor-pane"]')).toHaveAttribute('data-mode', 'rendered')
  await expect(prose()).toBeVisible()

  // Parent paragraph → first nested item (the item's <p> is no longer :last-child here).
  expect(await gap(para(/^Alpha parent$/), para(/^Child with a/))).toBeLessThanOrEqual(TIGHT_MAX)
  // Nested siblings stay tight too.
  expect(await gap(para(/^Child with a/), para(/^Second child$/))).toBeLessThanOrEqual(TIGHT_MAX)
  // Closing boundary: last nested item → next top-level item (nested <ul> bottom margin).
  expect(await gap(para(/^Second child$/), para(/^Beta parent$/))).toBeLessThanOrEqual(TIGHT_MAX)
})

test('2: a freshly created nesting level (Enter + Tab) renders tight immediately', async () => {
  await page.getByTestId('tab-doc-tight').click()
  await prose().getByText('Beta parent', { exact: true }).click()
  await waitCaretRegistered(page) // Electron 44: let the click register in the freshly-shown editor
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await page.keyboard.type('Fresh child')
  await expect(prose()).toContainText('Fresh child')

  // The rendering keys on the LIST node — the fresh nested <ul> defaults to data-spread="false"
  // (the list ITEM's data-spread is untrustworthy creation junk) — so it sits tight immediately.
  const freshUl = prose().locator('ul[data-spread="false"]', {
    has: page.locator('li', { hasText: 'Fresh child' })
  })
  await expect(freshUl.last()).toBeVisible()
  expect(await gap(para(/^Beta parent$/), para(/^Fresh child$/))).toBeLessThanOrEqual(TIGHT_MAX)
})

test('3: a genuinely loose list keeps visible air between items and inner paragraphs', async () => {
  await page.getByTestId('tab-doc-loose').click()
  await expect(vis('[data-testid="editor-pane"]')).toHaveAttribute('data-mode', 'rendered')
  await expect(prose()).toBeVisible()

  // Between the first item's two paragraphs (p:not(:last-child) inside a loose item).
  expect(await gap(para(/^First item$/), para(/^Second paragraph/))).toBeGreaterThanOrEqual(
    LOOSE_MIN
  )
  // Between the two loose items (li:not(:last-child) margin).
  expect(await gap(para(/^Second paragraph/), para(/^Second item$/))).toBeGreaterThanOrEqual(
    LOOSE_MIN
  )
})

test('4: a nested task list renders tight through the .taskContent host', async () => {
  await page.getByTestId('tab-doc-tasks').click()
  await expect(vis('[data-testid="editor-pane"]')).toHaveAttribute('data-mode', 'rendered')
  const boxes = page.locator('[data-testid="rendered-editor"]:visible input[data-testid="task-checkbox"]')
  await expect(boxes).toHaveCount(3)

  expect(await gap(para(/^Parent task$/), para(/^Done subtask$/))).toBeLessThanOrEqual(TIGHT_MAX)
  expect(await gap(para(/^Done subtask$/), para(/^Second parent$/))).toBeLessThanOrEqual(TIGHT_MAX)
})
