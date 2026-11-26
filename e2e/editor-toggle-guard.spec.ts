// modules: editor
// Pomade E-023 — every parseable markdown opens RENDERED by default; the round-trip guard no
// longer decides the default open mode (it was demoted to a parse-only safety net, T-075's
// "guard owns the default" doctrine superseded). Canonicalization-on-save is accepted policy
// (the Owner, 2026-08-19): a note whose body Milkdown would re-format on save STILL opens rendered.
//
// This file was the T-075 "explicit toggle wins even for a guard-lossy doc" spec. Its three
// realistic fixtures (nested list, Obsidian callout wrapping a list, GFM table) were the
// guard-lossy shapes that used to open RAW by default. Under E-023 all three open RENDERED —
// so the file now asserts:
//   1. each fixture opened in 'rendered' by the opener STAYS rendered (revert-proof vs the guard
//      demotion: the old byte-exact `rendersLosslessly` flagged callout + table lossy → raw);
//   2. a tab seeded in raw still reaches rendered on one explicit toggle, both directions (the
//      T-075 toggle-wins path, still meaningful);
//   3. toggling in and out of rendered WITHOUT editing leaves the file byte-identical and clean.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp, firstAppWindow } from './fixtures/app'
import { expectQuiet } from './fixtures/timing'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

const PID = 'proj-alpha'

const FM = ['---', 'id: T-075', 'tags: [editor, guard]', 'updated: 2026-07-24', '---', ''].join('\n')

// Nested bullet + nested ordered list under real prose with inline markup and a wikilink.
const NESTED = `${FM}
# Sprint notes

Prose with \`inline code\`, **bold**, and a [[wikilink]].

- Editor
  - Round-trip guard *must* stay strict
  - Toggle should always win
- Projects panel
  1. Nested groups
  2. Tier rail

Closing line.
`

// An Obsidian-style callout blockquote carrying a nested list — the shape vault review notes use.
// This canonicalizes on save (paragraph-then-list at blockquote level gains a blank line), so the
// old byte-exact guard forced it RAW; under E-023 it opens rendered.
const QUOTE = `${FM}
# Review notes

Alex, on the guard:

> [!note] Guard doctrine
> - Protects \`frontmatter\` and [[wikilinks]]
>   - Never weakened to make a toggle work
> - An explicit toggle still wins

Follow-up prose with a [link](https://example.dev).
`

// A GFM table written the way humans write them (`| --- |`), not remark's padded output — the
// delimiter row re-pads on save, another canonicalization the old guard flagged lossy.
const TABLE = `${FM}
# Coverage

Status of the **lossless** work:

| Structure | Round-trips | Notes |
| --- | --- | --- |
| Nested list | no | item \`spread\` |
| Table | no | delimiter row |

See [[T-005]] for the plan.
`

interface Case {
  key: string
  label: string
  body: string
}

const CASES: Case[] = [
  { key: 'nested', label: 'nested list', body: NESTED },
  { key: 'quote', label: 'callout blockquote', body: QUOTE },
  { key: 'table', label: 'GFM table', body: TABLE }
]

let fixture: Fixture
let app: ElectronApplication
let page: Page

function docTab(id: string, name: string, mode: 'raw' | 'rendered'): Record<string, unknown> {
  return {
    id,
    projectId: PID,
    kind: 'doc',
    title: name,
    path: `Projects/alpha/${name}`,
    mode,
    dirty: false,
    // E-024: this file tests the MILKDOWN (Rendered) engine's contract, so pin every doc's
    // rich view to Rendered — otherwise a raw tab's toggle would enter the Keep default
    // (Live) and never exercise the parse-gate path these specs are about.
    richView: 'rendered'
  }
}

// Every doc pane stays MOUNTED (PaneHost hides the inactive one), so a `:visible` locator can
// transiently match a sibling pane while a tab flip settles — scope everything to `pane-<tabId>`.
const pane = (tabId: string): ReturnType<Page['locator']> =>
  page.locator(`[data-testid="pane-${tabId}"] [data-testid="editor-pane"]`)
const toggle = (tabId: string): ReturnType<Page['locator']> =>
  page.locator(`[data-testid="pane-${tabId}"] [data-testid="mode-toggle"]`)

const read = (name: string): Promise<string> =>
  fs.readFile(join(fixture.workspaceRoot, 'Projects/alpha', name), 'utf8')

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  const root = fixture.workspaceRoot
  const tabs: Record<string, unknown>[] = []
  for (const c of CASES) {
    // Two identical notes per structure: one tab left in RAW (the toggle path under test) and
    // one opened in RENDERED (the default-open path — E-023: must STAY rendered).
    await fs.writeFile(join(root, `Projects/alpha/${c.key}.md`), c.body)
    await fs.writeFile(join(root, `Projects/alpha/${c.key}-open.md`), c.body)
    tabs.push(docTab(`doc-${c.key}`, `${c.key}.md`, 'raw'))
    tabs.push(docTab(`doc-${c.key}-open`, `${c.key}-open.md`, 'rendered'))
  }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(
    join(root, '.pomade/state/proj-alpha.json'),
    JSON.stringify({ openTabs: tabs, activeTabId: 'doc-nested' }, null, 2)
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

for (const c of CASES) {
  test(`E-023: a ${c.label} note opens RENDERED by default and an explicit toggle reaches rendered too`, async () => {
    // Default open (opener seeded 'rendered'): under E-023 a canonicalizing body STAYS rendered.
    // Revert-proof — the old byte-exact guard flagged callout + table lossy and bounced them to raw.
    await page.getByTestId(`tab-doc-${c.key}-open`).click()
    await expect(pane(`doc-${c.key}-open`)).toHaveAttribute('data-mode', 'rendered')
    await expect(page.locator(`[data-testid="pane-doc-${c.key}-open"] [data-testid="rendered-editor"]`)).toBeVisible()

    // A tab sitting in raw: one explicit click must reach rendered and STAY there (T-075 path).
    const id = `doc-${c.key}`
    await page.getByTestId(`tab-${id}`).click()
    await expect(pane(id)).toHaveAttribute('data-mode', 'raw')
    await expect(toggle(id)).toHaveText('Raw')

    await toggle(id).click()
    await expect(pane(id)).toHaveAttribute('data-mode', 'rendered')
    await expect(toggle(id)).toHaveText('Rendered')
    await expect(page.locator(`[data-testid="pane-${id}"] [data-testid="rendered-editor"]`)).toBeVisible()
    // No dialog on the way in (T-042) and the pane must not bounce back after the check
    // resolves — held for the window a bounce would need.
    await expect(page.locator('[data-testid="render-confirm"]')).toHaveCount(0)
    await expectQuiet(async () => {
      await expect(pane(id)).toHaveAttribute('data-mode', 'rendered')
    }, 500)

    // …and back to raw, then into rendered again — both directions keep working.
    await toggle(id).click()
    await expect(pane(id)).toHaveAttribute('data-mode', 'raw')
    await toggle(id).click()
    await expect(pane(id)).toHaveAttribute('data-mode', 'rendered')
  })
}

test('E-023: toggling in and out of rendered without editing leaves the file byte-identical', async () => {
  // The core promise survives the demotion: entering rendered on a canonicalizing doc must not
  // rewrite it by itself — only an actual edit + save canonicalizes.
  for (const c of CASES) {
    const id = `doc-${c.key}`
    const before = await read(`${c.key}.md`)
    expect(before).toBe(c.body)

    await page.getByTestId(`tab-${id}`).click()
    // The previous test left this tab rendered: out to raw, then the round trip under test.
    await expect(pane(id)).toHaveAttribute('data-mode', 'rendered')
    await toggle(id).click()
    await expect(pane(id)).toHaveAttribute('data-mode', 'raw')
    await toggle(id).click()
    await expect(pane(id)).toHaveAttribute('data-mode', 'rendered')
    await toggle(id).click()
    await expect(pane(id)).toHaveAttribute('data-mode', 'raw')

    // No edit happened → the tab is clean and an explicit save is a byte-for-byte no-op.
    await expect(page.locator(`[data-testid="pane-${id}"] [data-testid="editor-dirty"]`)).toHaveCount(0)
    await page.locator(`[data-testid="pane-${id}"] [data-testid="raw-editor"] .cm-content`).click()
    await page.keyboard.press(`${MOD}+s`)
    // The no-op save may not rewrite the file — held for the window a write would need.
    await expectQuiet(async () => {
      expect(await read(`${c.key}.md`)).toBe(c.body)
    }, 300)
  }
})
