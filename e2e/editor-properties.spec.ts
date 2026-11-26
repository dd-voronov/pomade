// modules: editor
// Pomade E-013 e2e — frontmatter properties panel v1.
// Acceptance (docs/roadmap/E-013-properties-panel-v1.md):
//  • a vault-shaped note renders TYPED rows (strings/dates/tags/lists/boolean); body below; raw untouched;
//  • edit scalar / toggle boolean / add chip / remove chip → dirty; Cmd+S → ONLY the edited keys'
//    lines differ on disk (every other key + order byte-identical);
//  • a hostile fixture (comment + nested map + multiline block scalar) shows read-only fallback rows;
//    editing a sibling simple key leaves the complex blocks + comment BYTE-IDENTICAL;
//  • add a property on a file with NO frontmatter creates a valid block; removing the last property
//    drops the whole block;
//  • collapse toggle applies LIVE to a second already-open pane and survives an app restart.
//
// As with T-036/E-007, each test seeds files + tab state, then launches the real Electron app.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { present } from './fixtures/assert'
import { launchAppPage } from './fixtures/app'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

const vis = (page: Page, sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)

// Drive the property panel's HTML5 row-reorder deterministically (Playwright mouse gestures
// don't reliably trigger native DnD — see filetree-manage/tabs). One DataTransfer is shared
// across dragstart→dragover→drop→dragend; `half` picks the drop side (the panel reads clientY
// vs the target row's mid-line to decide before/after).
async function dragRowOnto(
  page: Page,
  sourceTestId: string,
  targetTestId: string,
  half: 'top' | 'bottom'
): Promise<void> {
  const dt = await page.evaluateHandle(() => new DataTransfer())
  const source = page.getByTestId(sourceTestId)
  const target = page.getByTestId(targetTestId)
  const box = await target.boundingBox()
  if (!box) throw new Error(`no box for ${targetTestId}`)
  const clientX = Math.round(box.x + box.width / 2)
  const clientY = Math.round(half === 'top' ? box.y + 3 : box.y + box.height - 3)
  await source.dispatchEvent('dragstart', { dataTransfer: dt })
  await target.dispatchEvent('dragover', { dataTransfer: dt, clientX, clientY })
  await target.dispatchEvent('drop', { dataTransfer: dt, clientX, clientY })
  await source.dispatchEvent('dragend', { dataTransfer: dt })
}

// ── Fixture documents (byte-exact so writeback can be asserted against them) ──
const VAULT = [
  '---',
  'title: Arthur Pemberton',
  'page_type: wiki',
  'aliases:',
  '  - Arthur',
  '  - Art',
  'tags: [work, acmecorp]',
  'type: person',
  'created: 2026-06-15',
  'updated: 2026-06-15',
  'done: false',
  '---',
  '',
  '# Arthur Pemberton',
  '',
  'Lead of the design team.',
  ''
].join('\n')

const HOSTILE = [
  '---',
  '# top comment',
  'title: Deploy runbook',
  'tags: [ops]',
  'environments:',
  '  production:',
  '    region: eu-west-1',
  '    approvers: [sre, lead]',
  '  staging:',
  '    region: local',
  'rollback_note: |',
  '  Call the on-duty SRE first.',
  '  Then revert the release tag.',
  '---',
  '',
  '# Runbook',
  '',
  'Body.',
  ''
].join('\n')

const NOFM = ['# Plain Doc', '', 'No frontmatter here.', ''].join('\n')
const SINGLE = ['---', 'only: value', '---', '', '# Body', '', 'x.', ''].join('\n')
const FM_TWO = ['---', 'title: Two', 'tags: [a, b]', '---', '', '# Two', '', 'Body.', ''].join('\n')

const PID = 'proj-alpha'

interface SeedTab {
  id: string
  name: string
}

function docTab(t: SeedTab): Record<string, unknown> {
  return {
    id: t.id,
    projectId: PID,
    kind: 'doc',
    title: t.name,
    path: `Projects/alpha/${t.name}`,
    mode: 'rendered',
    dirty: false
  }
}

async function seed(
  fixture: Fixture,
  files: Record<string, string>,
  tabs: SeedTab[]
): Promise<void> {
  const root = fixture.workspaceRoot
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(join(root, 'Projects/alpha', name), content)
  }
  const state = { openTabs: tabs.map(docTab), activeTabId: tabs[0].id }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(root, '.pomade/state', `${PID}.json`), JSON.stringify(state, null, 2))
}

interface Launched {
  app: ElectronApplication
  page: Page
}

async function launch(fixture: Fixture): Promise<Launched> {
  const { app, page } = await launchAppPage(fixture)
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__pomadeStores.useAppSettingsStore.getState().hydrated
      )
    )
    .toBe(true)
  await page.getByTestId(`project-${PID}`).click()
  return { app, page }
}

async function read(fixture: Fixture, name: string): Promise<string> {
  // T-037 — tolerate a transient read error (EPERM/ENOENT) if the app is mid-save/replace:
  // under parallel-worker IO load the read can catch the sub-instant window of an atomic write,
  // so return '' and let the caller's expect.poll retry rather than throw.
  return fs.readFile(join(fixture.workspaceRoot, 'Projects/alpha', name), 'utf8').catch(() => '')
}

test.describe('E-013 — frontmatter properties panel', () => {
  let fixture: Fixture

  test.beforeEach(async () => {
    fixture = await createFixtureWorkspace()
  })

  test.afterEach(async () => {
    await fixture?.cleanup()
  })

  test('renders typed rows above the body; raw mode is untouched', async () => {
    await seed(fixture, { 'vault.md': VAULT }, [{ id: 'doc-v', name: 'vault.md' }])
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-v').click()

    const editor = vis(page, '[data-testid="editor-pane"]')
    await expect(editor).toHaveAttribute('data-mode', 'rendered')

    const panel = vis(page, '[data-testid="properties-panel"]')
    await expect(panel).toBeVisible()
    await expect(panel).toHaveAttribute('data-expanded', 'true')
    await expect(vis(page, '[data-testid="properties-count"]')).toContainText('8')

    // Typed rows: scalar, list chips, tag chips, date, boolean.
    await expect(vis(page, '[data-testid="prop-scalar-title"]')).toHaveText('Arthur Pemberton')
    await expect(vis(page, '[data-testid="prop-chip-aliases-0"]')).toContainText('Arthur')
    await expect(vis(page, '[data-testid="prop-chip-tags-0"]')).toContainText('work')
    await expect(vis(page, '[data-testid="prop-row-created"]')).toHaveAttribute('data-type', 'date')
    await expect(vis(page, '[data-testid="prop-bool-done"]')).not.toBeChecked()

    // Body renders below the panel.
    await expect(vis(page, '[data-testid="rendered-editor"] .ProseMirror')).toContainText(
      'Lead of the design team.'
    )

    // Raw mode shows the YAML as text and hides the panel.
    await vis(page, '[data-testid="mode-toggle"]').click()
    await expect(editor).toHaveAttribute('data-mode', 'raw')
    await expect(vis(page, '[data-testid="raw-editor"] .cm-content')).toContainText(
      'title: Arthur Pemberton'
    )
    await expect(page.locator('[data-testid="properties-panel"]:visible')).toHaveCount(0)
    await app.close()
  })

  test('edit scalar + toggle boolean + add chip + remove chip → dirty → Cmd+S writes only those keys', async () => {
    await seed(fixture, { 'vault.md': VAULT }, [{ id: 'doc-v', name: 'vault.md' }])
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-v').click()
    await expect(vis(page, '[data-testid="properties-panel"]')).toBeVisible()

    // Edit a scalar.
    await vis(page, '[data-testid="prop-scalar-title"]').click()
    await vis(page, '[data-testid="prop-input-title"]').fill('Art Pemberton')
    await page.keyboard.press('Enter')
    await expect(vis(page, '[data-testid="editor-dirty"]')).toBeVisible()

    // Toggle a boolean.
    await vis(page, '[data-testid="prop-bool-done"]').click()
    await expect(vis(page, '[data-testid="prop-bool-done"]')).toBeChecked()

    // Add a chip to the (flow) tags list.
    await vis(page, '[data-testid="prop-chip-input-tags"]').fill('design')
    await page.keyboard.press('Enter')
    await expect(vis(page, '[data-testid="prop-chip-tags-2"]')).toContainText('design')

    // Remove a chip from the (block) aliases list — "Art" at index 1.
    await vis(page, '[data-testid="prop-chip-remove-aliases-1"]').click()

    await page.keyboard.press(`${MOD}+s`)

    const expected = [
      '---',
      'title: Art Pemberton',
      'page_type: wiki',
      'aliases:',
      '  - Arthur',
      'tags: [work, acmecorp, design]',
      'type: person',
      'created: 2026-06-15',
      'updated: 2026-06-15',
      'done: true',
      '---',
      '',
      '# Arthur Pemberton',
      '',
      'Lead of the design team.',
      ''
    ].join('\n')
    await expect.poll(() => read(fixture, 'vault.md')).toBe(expected)
    await app.close()
  })

  test('a control character in a property value is written quoted and the doc still parses', async () => {
    await seed(fixture, { 'vault.md': VAULT }, [{ id: 'doc-v', name: 'vault.md' }])
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-v').click()
    await expect(vis(page, '[data-testid="properties-panel"]')).toBeVisible()

    // A pasted bell character: written plain it would make the whole block unreadable YAML.
    await vis(page, '[data-testid="prop-scalar-title"]').click()
    await vis(page, '[data-testid="prop-input-title"]').fill('Art\u0007Pemberton')
    await page.keyboard.press('Enter')
    await expect(vis(page, '[data-testid="editor-dirty"]')).toBeVisible()
    await page.keyboard.press(`${MOD}+s`)

    await expect
      .poll(() => read(fixture, 'vault.md'))
      .toBe(VAULT.replace('title: Arthur Pemberton', 'title: "Art\\u0007Pemberton"'))
    // The panel still reads the block: every row typed, no raw-frontmatter fallback.
    const panel = vis(page, '[data-testid="properties-panel"]')
    await expect(panel).not.toHaveAttribute('data-parse', 'failed')
    await expect(vis(page, '[data-testid="properties-count"]')).toContainText('8')
    await expect(vis(page, '[data-testid="prop-scalar-title"]')).toHaveText('Art\u0007Pemberton')
    await app.close()
  })

  test('hostile YAML: complex rows are read-only; editing a sibling key keeps them byte-identical', async () => {
    await seed(fixture, { 'hostile.md': HOSTILE }, [{ id: 'doc-h', name: 'hostile.md' }])
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-h').click()
    await expect(vis(page, '[data-testid="properties-panel"]')).toBeVisible()

    // Nested map + multiline block scalar → read-only fallback rows with an "edit in Raw" marker.
    await expect(vis(page, '[data-testid="prop-complex-environments"]')).toContainText(
      'region: eu-west-1'
    )
    await expect(vis(page, '[data-testid="prop-rawonly-environments"]')).toHaveText('edit in Raw')
    await expect(vis(page, '[data-testid="prop-complex-rollback_note"]')).toContainText(
      'Call the on-duty SRE first.'
    )
    // Complex rows carry no remove affordance (not editable).
    await expect(page.locator('[data-testid="prop-remove-environments"]')).toHaveCount(0)
    // The simple keys around them stay editable.
    await expect(vis(page, '[data-testid="prop-scalar-title"]')).toBeVisible()
    await expect(vis(page, '[data-testid="prop-chip-input-tags"]')).toBeVisible()

    // Edit the sibling simple key.
    await vis(page, '[data-testid="prop-scalar-title"]').click()
    await vis(page, '[data-testid="prop-input-title"]').fill('New Runbook')
    await page.keyboard.press('Enter')
    await page.keyboard.press(`${MOD}+s`)

    const expected = HOSTILE.replace('title: Deploy runbook', 'title: New Runbook')
    await expect.poll(() => read(fixture, 'hostile.md')).toBe(expected)
    // Byte-exactness of the untouched constructs, spelled out.
    const onDisk = await read(fixture, 'hostile.md')
    expect(onDisk).toContain('# top comment')
    expect(onDisk).toContain('  production:\n    region: eu-west-1\n    approvers: [sre, lead]')
    expect(onDisk).toContain('rollback_note: |\n  Call the on-duty SRE first.')
    await app.close()
  })

  test('add a property on a file with no frontmatter creates a valid block', async () => {
    await seed(fixture, { 'nofm.md': NOFM }, [{ id: 'doc-n', name: 'nofm.md' }])
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-n').click()
    const editor = vis(page, '[data-testid="editor-pane"]')
    await expect(editor).toHaveAttribute('data-mode', 'rendered')

    // No permanent empty panel.
    await expect(page.locator('[data-testid="properties-panel"]:visible')).toHaveCount(0)

    // ⋯ → Add properties.
    await vis(page, '[data-testid="doc-actions"]').click()
    await vis(page, '[data-testid="action-add-properties"]').click()
    await expect(vis(page, '[data-testid="properties-panel"]')).toBeVisible()

    await vis(page, '[data-testid="prop-add-key"]').fill('title')
    await vis(page, '[data-testid="prop-add-value"]').fill('Plain Doc')
    await vis(page, '[data-testid="prop-add-confirm"]').click()
    await expect(vis(page, '[data-testid="editor-dirty"]')).toBeVisible()

    await page.keyboard.press(`${MOD}+s`)
    const expected = `---\ntitle: Plain Doc\n---\n\n${NOFM}`
    await expect.poll(() => read(fixture, 'nofm.md')).toBe(expected)
    // The new property now shows as a typed row.
    await expect(vis(page, '[data-testid="prop-scalar-title"]')).toHaveText('Plain Doc')
    await app.close()
  })

  test('removing the last property drops the whole frontmatter block', async () => {
    await seed(fixture, { 'single.md': SINGLE }, [{ id: 'doc-s', name: 'single.md' }])
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-s').click()
    await expect(vis(page, '[data-testid="prop-row-only"]')).toBeVisible()

    await vis(page, '[data-testid="prop-remove-only"]').click()
    await expect(vis(page, '[data-testid="editor-dirty"]')).toBeVisible()
    // Panel disappears (no permanent empty panel).
    await expect(page.locator('[data-testid="properties-panel"]:visible')).toHaveCount(0)

    await page.keyboard.press(`${MOD}+s`)
    const expected = ['# Body', '', 'x.', ''].join('\n')
    await expect.poll(() => read(fixture, 'single.md')).toBe(expected)
    await app.close()
  })

  test('collapse toggle applies live to a second open pane and survives restart (per-project)', async () => {
    // T-053 round-3: the collapse state is now PER-PROJECT (ProjectState), no longer a global
    // AppSetting — so it persists in .pomade/state/<projectId>.json and applies to every open pane
    // of the same project.
    await seed(fixture, { 'a.md': FM_TWO, 'b.md': FM_TWO }, [
      { id: 'doc-a', name: 'a.md' },
      { id: 'doc-b', name: 'b.md' }
    ])
    const first = await launch(fixture)
    const { page } = first
    await page.getByTestId('tab-doc-a').click()

    const panelA = page.locator('[data-testid="pane-doc-a"] [data-testid="properties-panel"]')
    const panelB = page.locator('[data-testid="pane-doc-b"] [data-testid="properties-panel"]')
    // Both panes mounted (PaneHost keeps inactive tabs mounted); default expanded.
    await expect(panelA).toHaveAttribute('data-expanded', 'true')
    await expect(panelB).toHaveAttribute('data-expanded', 'true')

    // Collapse via the visible pane's header → the hidden pane collapses LIVE (store subscription).
    await panelA.getByTestId('properties-header').click()
    await expect(panelA).toHaveAttribute('data-expanded', 'false')
    await expect(panelB).toHaveAttribute('data-expanded', 'false')

    // Persisted per-project to .pomade/state/<projectId>.json (NOT app.json).
    await expect
      .poll(async () => {
        const j = JSON.parse(
          await fs.readFile(join(fixture.workspaceRoot, '.pomade/state', `${PID}.json`), 'utf8')
        )
        return j.propertiesPanelExpanded
      })
      .toBe(false)
    await first.app.close()

    // Restart: still collapsed.
    const second = await launch(fixture)
    await second.page.getByTestId('tab-doc-a').click()
    await expect(
      second.page.locator('[data-testid="pane-doc-a"] [data-testid="properties-panel"]')
    ).toHaveAttribute('data-expanded', 'false')
    await second.app.close()
  })

  test('collapse is isolated per project (collapsing alpha leaves beta expanded)', async () => {
    // T-053 round-3 (3a): the fixture has two real projects (alpha + beta).
    await seed(fixture, { 'a.md': FM_TWO }, [{ id: 'doc-a', name: 'a.md' }])
    // Seed a beta doc + its own ProjectState.
    await fs.writeFile(join(fixture.workspaceRoot, 'Projects/beta', 'bd.md'), FM_TWO)
    const betaState = {
      openTabs: [
        {
          id: 'doc-bd',
          projectId: fixture.projects.beta,
          kind: 'doc',
          title: 'bd.md',
          path: 'Projects/beta/bd.md',
          mode: 'rendered',
          dirty: false
        }
      ],
      activeTabId: 'doc-bd'
    }
    await fs.writeFile(
      join(fixture.workspaceRoot, '.pomade/state', `${fixture.projects.beta}.json`),
      JSON.stringify(betaState, null, 2)
    )

    const { app, page } = await launch(fixture) // opens project alpha
    await page.getByTestId('tab-doc-a').click()
    const panelA = vis(page, '[data-testid="properties-panel"]')
    await expect(panelA).toHaveAttribute('data-expanded', 'true')
    await panelA.getByTestId('properties-header').click()
    await expect(panelA).toHaveAttribute('data-expanded', 'false')

    // Switch to beta — its panel is untouched (still expanded).
    await page.getByTestId(`project-${fixture.projects.beta}`).click()
    await page.getByTestId('tab-doc-bd').click()
    await expect(vis(page, '[data-testid="properties-panel"]')).toHaveAttribute(
      'data-expanded',
      'true'
    )
    await app.close()
  })

  test('click outside the open add-property row cancels it (typed input discarded, no write)', async () => {
    await seed(fixture, { 'vault.md': VAULT }, [{ id: 'doc-v', name: 'vault.md' }])
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-v').click()
    await expect(vis(page, '[data-testid="properties-panel"]')).toBeVisible()

    await vis(page, '[data-testid="prop-add"]').click()
    await vis(page, '[data-testid="prop-add-key"]').fill('scratch')
    // Mousedown OUTSIDE the row (the rendered body) → the row cancels. (Not the header, which
    // would toggle collapse; this proves a plain outside click cancels.)
    await vis(page, '[data-testid="rendered-editor"] .ProseMirror').click()
    await expect(page.locator('[data-testid="prop-add-editing"]')).toHaveCount(0)
    // Reopening shows an empty row (the typed "scratch" was discarded), and nothing was written.
    await vis(page, '[data-testid="prop-add"]').click()
    await expect(vis(page, '[data-testid="prop-add-key"]')).toHaveValue('')
    await expect(page.locator('[data-testid="editor-dirty"]')).toHaveCount(0)
    await app.close()
  })

  test('chips edit in place for tags AND aliases; commit is surgical + dirty (no auto-save)', async () => {
    await seed(fixture, { 'vault.md': VAULT }, [{ id: 'doc-v', name: 'vault.md' }])
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-v').click()
    await expect(vis(page, '[data-testid="properties-panel"]')).toBeVisible()

    // Tag chip (flow list) — Enter commits.
    await vis(page, '[data-testid="prop-chip-text-tags-0"]').click()
    const tagInput = vis(page, '[data-testid="prop-chip-edit-tags-0"]')
    await expect(tagInput).toBeVisible()
    await tagInput.fill('worklife')
    await page.keyboard.press('Enter')
    await expect(vis(page, '[data-testid="prop-chip-tags-0"]')).toContainText('worklife')
    await expect(vis(page, '[data-testid="editor-dirty"]')).toBeVisible()

    // Alias chip (block list) — blur commits (click the rendered body).
    await vis(page, '[data-testid="prop-chip-text-aliases-0"]').click()
    await vis(page, '[data-testid="prop-chip-edit-aliases-0"]').fill('Anatolii')
    await vis(page, '[data-testid="rendered-editor"] .ProseMirror').click()
    await expect(vis(page, '[data-testid="prop-chip-aliases-0"]')).toContainText('Anatolii')

    // NOT auto-saved: disk is still the original until Cmd+S.
    expect(await read(fixture, 'vault.md')).toBe(VAULT)

    await page.keyboard.press(`${MOD}+s`)
    const expected = VAULT.replace('tags: [work, acmecorp]', 'tags: [worklife, acmecorp]').replace(
      '  - Arthur\n',
      '  - Anatolii\n'
    )
    await expect.poll(() => read(fixture, 'vault.md')).toBe(expected)
    await app.close()
  })

  test('clicking a short chip’s text opens edit and does NOT delete it (X hit zone is separate)', async () => {
    // A single-character tag is the worst case for the old X/edit hit-target collision.
    const SHORT = ['---', 'tags: [x]', '---', '', '# S', '', 'body.', ''].join('\n')
    await seed(fixture, { 'short.md': SHORT }, [{ id: 'doc-sh', name: 'short.md' }])
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-sh').click()
    await expect(vis(page, '[data-testid="prop-chip-tags-0"]')).toContainText('x')

    // Click the text zone → edit opens; the chip is NOT removed and nothing is written.
    await vis(page, '[data-testid="prop-chip-text-tags-0"]').click()
    await expect(vis(page, '[data-testid="prop-chip-edit-tags-0"]')).toBeVisible()
    await expect(vis(page, '[data-testid="prop-chip-tags-0"]')).toBeVisible()
    await expect(page.locator('[data-testid="editor-dirty"]')).toHaveCount(0)
    await app.close()
  })

  // ── E-014 (properties panel v2) ──────────────────────────────────────────────

  test('E-014a/T-065: a date row is ONE box — text input + embedded calendar icon; picking writes surgically', async () => {
    await seed(fixture, { 'vault.md': VAULT }, [{ id: 'doc-v', name: 'vault.md' }])
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-v').click()
    await expect(vis(page, '[data-testid="properties-panel"]')).toBeVisible()
    await expect(vis(page, '[data-testid="prop-row-created"]')).toHaveAttribute('data-type', 'date')

    // Enter edit mode → ONE visible box: the text input shows the value exactly once.
    await vis(page, '[data-testid="prop-scalar-created"]').click()
    const input = vis(page, '[data-testid="prop-input-created"]')
    await expect(input).toBeVisible()
    await expect(input).toHaveValue('2026-06-15')

    // T-065 — the calendar icon (which opens the picker) lives INSIDE the input's field bounds,
    // at the right edge; there is no separate visible date control duplicating the value.
    const icon = vis(page, '[data-testid="prop-date-created"]')
    await expect(icon).toBeVisible()
    const inBox = present(await input.boundingBox(), 'date field box')
    const iconBox = present(await icon.boundingBox(), 'date icon box')
    expect(iconBox.x).toBeGreaterThanOrEqual(inBox.x - 1)
    expect(iconBox.x + iconBox.width).toBeLessThanOrEqual(inBox.x + inBox.width + 1)
    expect(iconBox.y).toBeGreaterThanOrEqual(inBox.y - 1)
    expect(iconBox.y + iconBox.height).toBeLessThanOrEqual(inBox.y + inBox.height + 1)

    // Picking a date via the native date input (what the OS picker writes) fills the text input.
    await page.getByTestId('prop-date-native-created').evaluate((el) => {
      const el2 = el as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(el2, '2027-01-02')
      el2.dispatchEvent(new Event('input', { bubbles: true }))
      el2.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await expect(vis(page, '[data-testid="prop-scalar-created"]')).toHaveText('2027-01-02')
    await expect(vis(page, '[data-testid="editor-dirty"]')).toBeVisible()

    await page.keyboard.press(`${MOD}+s`)
    // Only `created` changed (unquoted); `updated` (same original value) is untouched.
    const expected = VAULT.replace('created: 2026-06-15', 'created: 2027-01-02')
    await expect.poll(() => read(fixture, 'vault.md')).toBe(expected)

    // Typing still works and validates: a bad value shows the hint; a valid one clears it.
    await vis(page, '[data-testid="prop-scalar-created"]').click()
    await vis(page, '[data-testid="prop-input-created"]').fill('nope')
    await expect(vis(page, '[data-testid="prop-date-hint-created"]')).toBeVisible()
    await vis(page, '[data-testid="prop-input-created"]').fill('2027-03-04')
    await expect(page.locator('[data-testid="prop-date-hint-created"]')).toHaveCount(0)
    await app.close()
  })

  test('E-014b: workspace autocomplete suggests keys (add) and list values from another file', async () => {
    const MAIN_FM = ['---', 'title: Doc', 'tags: [work]', '---', '', '# Doc', '', 'Body.', ''].join('\n')
    const SEED2 = ['---', 'title: Other', 'status: active', 'priority: high', 'tags: [alpha, beta]', '---', '', '# Other', '', 'x.', ''].join('\n')
    await seed(fixture, { 'main.md': MAIN_FM, 'seed2.md': SEED2 }, [{ id: 'doc-m', name: 'main.md' }])
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-m').click()
    await expect(vis(page, '[data-testid="properties-panel"]')).toBeVisible()

    // KEY autocomplete: adding a property, "stat" suggests "status" (from seed2, not on this doc).
    await vis(page, '[data-testid="prop-add"]').click()
    await vis(page, '[data-testid="prop-add-key"]').fill('stat')
    await expect(vis(page, '[data-testid="prop-key-suggest-status"]')).toBeVisible()
    await vis(page, '[data-testid="prop-key-suggest-status"]').click()
    await expect(vis(page, '[data-testid="prop-add-key"]')).toHaveValue('status')
    await page.keyboard.press('Escape') // dismiss the add row (nothing written yet)
    await expect(page.locator('[data-testid="editor-dirty"]')).toHaveCount(0)

    // VALUE autocomplete: for the tags list, "al" suggests "alpha" (existing value elsewhere).
    await vis(page, '[data-testid="prop-chip-input-tags"]').click()
    await vis(page, '[data-testid="prop-chip-input-tags"]').fill('al')
    await expect(vis(page, '[data-testid="prop-val-suggest-tags-alpha"]')).toBeVisible()
    await vis(page, '[data-testid="prop-val-suggest-tags-alpha"]').click()
    await expect(vis(page, '[data-testid="prop-chip-tags-1"]')).toContainText('alpha')
    await expect(vis(page, '[data-testid="editor-dirty"]')).toBeVisible()
    await app.close()
  })

  test('E-014c: dragging a property row reorders only that key’s line-block (bytes identical)', async () => {
    const REORDER = ['---', 'title: T', 'alpha: 1', 'beta: 2', 'gamma: 3', '---', '', '# R', '', 'b.', ''].join('\n')
    await seed(fixture, { 'reorder.md': REORDER }, [{ id: 'doc-r', name: 'reorder.md' }])
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-r').click()
    await expect(vis(page, '[data-testid="prop-row-gamma"]')).toBeVisible()

    // Drag `gamma` to the TOP half of the `alpha` row → gamma lands before alpha.
    // The panel uses HTML5 DnD; Playwright's mouse-based dragTo() triggers it unreliably (it
    // flaked under parallel load), so drive the native drag events deterministically with a
    // shared DataTransfer — the same idiom filetree-manage/tabs use (T-037).
    await dragRowOnto(page, 'prop-row-gamma', 'prop-row-alpha', 'top')
    await expect(vis(page, '[data-testid="editor-dirty"]')).toBeVisible()

    await page.keyboard.press(`${MOD}+s`)
    const expected = ['---', 'title: T', 'gamma: 3', 'alpha: 1', 'beta: 2', '---', '', '# R', '', 'b.', ''].join('\n')
    await expect.poll(() => read(fixture, 'reorder.md')).toBe(expected)
    await app.close()
  })

  test('E-014d: complex value edits inline — valid YAML writes, invalid shows an error and does not', async () => {
    await seed(fixture, { 'hostile.md': HOSTILE }, [{ id: 'doc-h', name: 'hostile.md' }])
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-h').click()
    await expect(vis(page, '[data-testid="properties-panel"]')).toBeVisible()

    // Invalid YAML → inline error, no write (doc stays clean).
    await vis(page, '[data-testid="prop-rawonly-environments"]').click()
    const textarea = vis(page, '[data-testid="prop-complex-edit-environments"]')
    await expect(textarea).toBeVisible()
    await textarea.fill('environments: [oops')
    await vis(page, '[data-testid="prop-complex-save-environments"]').click()
    await expect(vis(page, '[data-testid="prop-complex-error-environments"]')).toBeVisible()
    await expect(page.locator('[data-testid="editor-dirty"]')).toHaveCount(0)

    // Valid YAML → replaces exactly that key's lines; siblings stay byte-identical.
    await textarea.fill('environments:\n  production:\n    region: us-east-1')
    await vis(page, '[data-testid="prop-complex-save-environments"]').click()
    await expect(vis(page, '[data-testid="editor-dirty"]')).toBeVisible()
    await page.keyboard.press(`${MOD}+s`)
    await expect.poll(() => read(fixture, 'hostile.md')).toContain('    region: us-east-1')
    const onDisk = await read(fixture, 'hostile.md')
    expect(onDisk).not.toContain('eu-west-1')
    expect(onDisk).toContain('# top comment')
    expect(onDisk).toContain('rollback_note: |\n  Call the on-duty SRE first.')
    await app.close()
  })

  test('E-013 round-4: the chip edit input auto-grows for a long value', async () => {
    const LONG = '/Users/me/Documents/git-base/Knowledge/_meta/sources'
    const LONGCHIP = ['---', `sources: [${LONG}]`, '---', '', '# L', '', 'b.', ''].join('\n')
    await seed(fixture, { 'long.md': LONGCHIP }, [{ id: 'doc-l', name: 'long.md' }])
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-l').click()
    await expect(vis(page, '[data-testid="prop-chip-sources-0"]')).toContainText('_meta')

    await vis(page, '[data-testid="prop-chip-text-sources-0"]').click()
    const input = vis(page, '[data-testid="prop-chip-edit-sources-0"]')
    await expect(input).toBeVisible()
    await expect(input).toHaveValue(LONG)
    // A long value grows the input well beyond the old fixed ~8ch box.
    const box = await input.boundingBox()
    expect(box).not.toBeNull()
    expect((box as { width: number }).width).toBeGreaterThan(120)
    await app.close()
  })
})
