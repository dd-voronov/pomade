// modules: core, editor, terminal
// Pomade T-153 e2e — per-surface font settings.
//
// Two new app settings (font ids): `editorRawFont` (raw editor prose) and `terminalFont` (xterm).
// The MODEL: pick your font; code-shaped regions always stay mono.
//   • Raw editor: a PROPORTIONAL selection restyles prose, but fenced/indented code blocks, inline
//     code, tables and YAML frontmatter stay pinned to the standard mono stack (var(--font-mono)).
//     A MONO selection restyles everything uniformly (no pinning; no `.cm-mono-pin` decorations).
//   • Live view: tables render mono (aligned) while surrounding prose stays proportional — the
//     inverse pin, present since E-024, locked here.
//   • Terminal: picking a font restyles the xterm live (existing session refits, no rebuild).
//   • Both settings persist across restart; defaults ('sf-mono') look identical to before.
//
// Asserts computed `font-family` on `.cm-scroller` (raw), a table line, a code line, inline code,
// a frontmatter line, a Live table line, and the xterm rows — the precedent contract from the
// ticket. Fixture mirrors REAL vault content (frontmatter + inline markup + a GFM table).
//
// New file ⇒ its own parallel worker; state does not chain with other specs.

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
import { setEditorMode } from './fixtures/stores'
import { readSettingsJson } from './fixtures/settings'

const DOC = 'Projects/alpha/fonts.md'
const DOC_BODY =
  '---\n' +
  'title: Fonts fixture\n' +
  'tags: [alpha, beta]\n' +
  '---\n' +
  '\n' +
  '# Heading\n' +
  '\n' +
  'Some **bold** prose with a [link](https://example.com) and `inline code here` in it.\n' +
  '\n' +
  '```js\n' +
  'const codeLineToken = 1\n' +
  '```\n' +
  '\n' +
  '| Column A | Column B |\n' +
  '| --- | --- |\n' +
  '| tableCellToken | two |\n' +
  '\n' +
  'More prose after the table wraps the fixture up.\n'

const vis = (page: Page, sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)

/** Computed `font-family` of the first VISIBLE element matching `sel` whose text includes `txt`
 *  (or any visible match when `txt` is undefined). Throws when nothing matches. */
function fontOf(page: Page, sel: string, txt?: string): Promise<string> {
  return page.evaluate(
    ({ s, t }) => {
      const els = [...document.querySelectorAll(s)].filter(
        (e) => (e as HTMLElement).offsetParent !== null && (t == null || (e.textContent ?? '').includes(t))
      )
      if (!els.length) throw new Error(`no visible ${s}${t ? ` containing "${t}"` : ''}`)
      return getComputedStyle(els[0]).fontFamily
    },
    { s: sel, t: txt }
  )
}

function setFont(page: Page, which: 'terminal' | 'editorRaw', id: string): Promise<void> {
  return page.evaluate(
    ({ w, v }) => {
      const s = window.__pomadeStores.useAppSettingsStore.getState()
      return w === 'terminal' ? s.setTerminalFont(v) : s.setEditorRawFont(v)
    },
    { w: which, v: id }
  )
}

function fontSettings(page: Page): Promise<{ terminalFont: string; editorRawFont: string }> {
  return page.evaluate(() => {
    const s = window.__pomadeStores.useAppSettingsStore.getState()
    return { terminalFont: s.terminalFont, editorRawFont: s.editorRawFont }
  })
}

async function openDoc(page: Page): Promise<void> {
  await page.getByTestId(`tree-node-${DOC}`).click()
  await expect(vis(page, '[data-testid="editor-pane"]')).toBeVisible()
}

async function openTerminal(page: Page): Promise<string> {
  await page.getByTestId('tab-add').click()
  await page.getByTestId('tab-add-terminal').click()
  const el = page.locator('[data-term-id]:visible').first()
  await expect(el).toBeVisible()
  await expect(el.locator('.xterm-rows')).toBeVisible()
  const id = await el.getAttribute('data-term-id')
  if (!id) throw new Error('no visible terminal')
  return id
}

test.describe('T-153 per-surface font settings', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await fs.writeFile(join(fixture.workspaceRoot, DOC), DOC_BODY)
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await expect(page.getByTestId(`tree-node-${DOC}`)).toBeVisible({ timeout: 10_000 })
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('defaults are SF Mono on both surfaces (untouched install looks unchanged)', async () => {
    expect(await fontSettings(page)).toEqual({ terminalFont: 'sf-mono', editorRawFont: 'sf-mono' })
    await openDoc(page)
    await setEditorMode(page, 'raw')
    expect(await fontOf(page, '[data-testid="raw-editor"] .cm-scroller')).toContain('SF Mono')
  })

  test('raw + PROPORTIONAL font: prose restyles, code/table/inline/frontmatter stay mono', async () => {
    await openDoc(page)
    await setEditorMode(page, 'raw')
    await setFont(page, 'editorRaw', 'ui-sans')
    // Prose scroller becomes proportional…
    await expect
      .poll(() => fontOf(page, '[data-testid="raw-editor"] .cm-scroller'))
      .not.toContain('SF Mono')
    expect(await fontOf(page, '[data-testid="raw-editor"] .cm-scroller')).toContain('SF Pro Text')
    // …but the code-shaped regions are pinned back to mono.
    const raw = '[data-testid="raw-editor"] .cm-content'
    expect(await fontOf(page, `${raw} .cm-mono-pin`, 'const codeLineToken')).toContain('SF Mono')
    expect(await fontOf(page, `${raw} .cm-mono-pin`, 'Column A')).toContain('SF Mono')
    expect(await fontOf(page, `${raw} .cm-mono-pin`, 'title: Fonts fixture')).toContain('SF Mono')
    expect(await fontOf(page, `${raw} .cm-mono-pin-inline`, 'inline code here')).toContain('SF Mono')
    // And a plain prose line follows the proportional scroller (not pinned).
    expect(await fontOf(page, `${raw} .cm-line`, 'More prose after the table')).not.toContain('SF Mono')
  })

  test('raw + MONO font: everything restyles uniformly, no mono-pin decorations', async () => {
    await openDoc(page)
    await setEditorMode(page, 'raw')
    await setFont(page, 'editorRaw', 'jetbrains-mono')
    await expect
      .poll(() => fontOf(page, '[data-testid="raw-editor"] .cm-scroller'))
      .toContain('JetBrains Mono')
    // A mono selection needs no pinning — the pin layer is gone.
    const pins = page.locator('[data-testid="raw-editor"] .cm-content .cm-mono-pin')
    await expect(pins).toHaveCount(0)
    // Restore the default for the following tests.
    await setFont(page, 'editorRaw', 'sf-mono')
    await expect
      .poll(() => fontOf(page, '[data-testid="raw-editor"] .cm-scroller'))
      .toContain('SF Mono')
  })

  test('Live view: a table renders mono while surrounding prose stays proportional', async () => {
    await openDoc(page)
    await setEditorMode(page, 'live')
    const live = '[data-testid="editor-pane"] .cm-content'
    // Prose is the proportional UI font…
    expect(await fontOf(page, `${live} .cm-line`, 'More prose after the table')).not.toContain('SF Mono')
    // …the table line is mono (aligned).
    expect(await fontOf(page, `${live} .cm-live-table`, 'Column A')).toContain('SF Mono')
  })

  test('terminal: picking a font restyles the live xterm (existing session, no rebuild)', async () => {
    const termId = await openTerminal(page)
    const rows = `[data-term-id="${termId}"] .xterm-rows`
    expect(await fontOf(page, rows)).toContain('SF Mono')
    await setFont(page, 'terminal', 'ibm-plex-mono')
    await expect.poll(() => fontOf(page, rows)).toContain('IBM Plex Mono')
    // The pane is still the SAME live terminal (restyled in place, not rebuilt/replaced).
    await expect(page.locator(`[data-term-id="${termId}"]`)).toHaveAttribute('data-status', 'live')
  })

  test('both settings persist across restart', async () => {
    await setFont(page, 'terminal', 'jetbrains-mono')
    await setFont(page, 'editorRaw', 'serif')
    await expect.poll(() => fontSettings(page)).toEqual({
      terminalFont: 'jetbrains-mono',
      editorRawFont: 'serif'
    })
    // The settings.json write must land before the app is torn down — poll the file.
    await expect
      .poll(async () => (await readSettingsJson(fixture.workspaceRoot)).terminalFont, {
        timeout: 10_000
      })
      .toBe('jetbrains-mono')
    await app.close()

    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
    expect(await fontSettings(page)).toEqual({
      terminalFont: 'jetbrains-mono',
      editorRawFont: 'serif'
    })
    // And the persisted selections are actually applied on boot.
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await expect(page.getByTestId(`tree-node-${DOC}`)).toBeVisible({ timeout: 10_000 })
    await openDoc(page)
    await setEditorMode(page, 'raw')
    expect(await fontOf(page, '[data-testid="raw-editor"] .cm-scroller')).toContain('Georgia')
  })
})
