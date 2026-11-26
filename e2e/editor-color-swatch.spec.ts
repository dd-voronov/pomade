// modules: editor
// Pomade E-019 — inline color previews in the RAW editor.
//   T-067: a small clickable swatch sits before every VALID color code (hex #rgb/#rrggbb/#rrggbbaa,
//          rgb()/rgba(), hsl()/hsla()) in every text format — .css, .txt (no language extension at
//          all) and .md-raw — and nowhere else: invalid codes and rendered markdown get none.
//   T-068: clicking a swatch opens an anchored picker; Apply rewrites the code IN PLACE in its
//          original notation (hex stays hex and keeps its case/short form, rgba() keeps its alpha,
//          hsl() stays hsl()), marks the doc dirty like typing, and one Cmd+Z reverts it whole.
//          Escape changes nothing.
//
// Every locator is scoped to its own `pane-<tabId>`: PaneHost keeps inactive doc panes MOUNTED
// (display:none), so a bare `[data-testid="color-swatch"]` would match other panes' swatches.

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
import { present } from './fixtures/assert'
import { launchAppPage } from './fixtures/app'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

const PID = 'proj-alpha'

const CSS_FILE = [
  ':root {',
  '  --a: #fff;',
  '  --b: #3AA6C8;',
  '  --c: rgb(255, 0, 0);',
  '  --d: rgba(255, 0, 0, 0.5);',
  '  --e: hsl(0, 100%, 50%);',
  '  --bad1: #abcd;',
  '  --bad2: rgb(300, 0, 0);',
  '  --bad3: hsl(200, 150%, 50%);',
  '}',
  ''
].join('\n')

const TXT_FILE = [
  'plain #f00 and rgb(0, 128, 255) and hsla(120, 50%, 50%, 0.25)',
  'not a color: #abcdefg rgb(1,2) #12345',
  ''
].join('\n')

const MD_FILE = ['# Palette', '', 'Brand `#3aa6c8`, danger #d1495b, ghost rgba(0, 0, 0, 0.2).', ''].join('\n')

const PICK_FILE = [
  'hex3 #f00',
  'hex6 #FF0000',
  'rgba rgba(255, 0, 0, 0.5)',
  'hsl hsl(0, 100%, 50%)',
  ''
].join('\n')

function docTab(id: string, name: string, mode: 'raw' | 'rendered'): Record<string, unknown> {
  return { id, projectId: PID, kind: 'doc', title: name, path: `Projects/alpha/${name}`, mode, dirty: false }
}

async function seed(
  fixture: Fixture,
  files: Record<string, string>,
  tabs: Record<string, unknown>[],
  activeId: string
): Promise<void> {
  const root = fixture.workspaceRoot
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(join(root, 'Projects/alpha', name), content)
  }
  const state = { openTabs: tabs, activeTabId: activeId }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(root, '.pomade/state', `${PID}.json`), JSON.stringify(state, null, 2))
}

async function launch(fixture: Fixture): Promise<{ app: ElectronApplication; page: Page }> {
  const { app, page } = await launchAppPage(fixture)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__pomadeStores.useAppSettingsStore.getState().hydrated
      )
    )
    .toBe(true)
  await page.getByTestId(`project-${PID}`).click()
  return { app, page }
}

const read = (fixture: Fixture, name: string): Promise<string> =>
  fs.readFile(join(fixture.workspaceRoot, 'Projects/alpha', name), 'utf8')

const pane = (page: Page, tabId: string): Locator => page.locator(`[data-testid="pane-${tabId}"]`)
const swatches = (page: Page, tabId: string): Locator =>
  pane(page, tabId).locator('[data-testid="color-swatch"]')
const rawText = (page: Page, tabId: string): Locator =>
  pane(page, tabId).locator('[data-testid="raw-editor"] .cm-content')

/** Open the given tab and wait for its raw editor to be live. */
async function openRaw(page: Page, tabId: string): Promise<void> {
  await page.getByTestId(`tab-${tabId}`).click()
  await expect(pane(page, tabId).locator('[data-testid="editor-pane"]')).toHaveAttribute('data-mode', 'raw')
}

/**
 * Drag the picker's saturation/value area OUT past its top-left corner. The picker clamps, so the
 * drag lands on exactly saturation 0 / value 1 — white at the current hue — regardless of the
 * panel's pixel geometry (the area's own left/top edge sits on a fractional device pixel, so
 * clicking it directly is not reliably inside the element).
 */
async function pickWhite(page: Page): Promise<void> {
  const box = await page.getByTestId('color-picker-sv').boundingBox()
  if (!box) throw new Error('color-picker-sv has no box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x - 40, box.y - 40, { steps: 4 })
  await page.mouse.up()
}

test.describe('E-019 — inline color swatches (raw mode)', () => {
  let fixture: Fixture

  test.beforeEach(async () => {
    fixture = await createFixtureWorkspace()
  })

  test.afterEach(async () => {
    await fixture?.cleanup()
  })

  test('T-067: .css — a swatch per valid hex / rgb() / hsl(), none for invalid codes', async () => {
    await seed(fixture, { 'colors.css': CSS_FILE }, [docTab('doc-css', 'colors.css', 'raw')], 'doc-css')
    const { app, page } = await launch(fixture)
    await openRaw(page, 'doc-css')

    const sw = swatches(page, 'doc-css')
    // 5 valid codes; `#abcd`, `rgb(300, 0, 0)` and `hsl(200, 150%, 50%)` get nothing.
    await expect(sw).toHaveCount(5)
    await expect(sw.nth(0)).toHaveAttribute('data-color', '#ffffff')
    await expect(sw.nth(1)).toHaveAttribute('data-color', '#3aa6c8')
    await expect(sw.nth(2)).toHaveAttribute('data-color', '#ff0000')
    // Alpha survives into the swatch identity (rendered over a checkerboard, not composited).
    await expect(sw.nth(3)).toHaveAttribute('data-color', '#ff000080')
    await expect(sw.nth(4)).toHaveAttribute('data-color', '#ff0000')
    await expect(sw.nth(1)).toHaveAttribute('data-code', '#3AA6C8')

    // The swatch must not change the line box: 10 lines of CSS still measure one line-height each.
    const lineHeights = await rawText(page, 'doc-css').evaluate((el) =>
      [...el.querySelectorAll('.cm-line')].map((l) => Math.round((l as HTMLElement).getBoundingClientRect().height))
    )
    expect(new Set(lineHeights).size).toBe(1)

    await app.close()
  })

  test('T-067: .txt (no language extension) and .md raw both get swatches; editing updates them live', async () => {
    await seed(
      fixture,
      { 'colors.txt': TXT_FILE, 'colors.md': MD_FILE },
      [docTab('doc-txt', 'colors.txt', 'raw'), docTab('doc-md', 'colors.md', 'raw')],
      'doc-txt'
    )
    const { app, page } = await launch(fixture)

    await openRaw(page, 'doc-txt')
    await expect(swatches(page, 'doc-txt')).toHaveCount(3)
    await expect(swatches(page, 'doc-txt').nth(0)).toHaveAttribute('data-color', '#ff0000')
    await expect(swatches(page, 'doc-txt').nth(1)).toHaveAttribute('data-color', '#0080ff')
    await expect(swatches(page, 'doc-txt').nth(2)).toHaveAttribute('data-color', '#40bf4040')

    await openRaw(page, 'doc-md')
    await expect(swatches(page, 'doc-md')).toHaveCount(3)
    await expect(swatches(page, 'doc-md').nth(0)).toHaveAttribute('data-color', '#3aa6c8')

    // Live update: type a fourth color at the end of the doc.
    await rawText(page, 'doc-md').click()
    await page.keyboard.press(`${MOD}+ArrowDown`)
    await page.keyboard.type(' #0f0')
    await expect(swatches(page, 'doc-md')).toHaveCount(4)
    await expect(swatches(page, 'doc-md').nth(3)).toHaveAttribute('data-color', '#00ff00')

    await app.close()
  })

  test('T-067: rendered markdown shows NO swatches; toggling to raw brings them back', async () => {
    await seed(fixture, { 'colors.md': MD_FILE }, [docTab('doc-md', 'colors.md', 'rendered')], 'doc-md')
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-md').click()
    await expect(pane(page, 'doc-md').locator('[data-testid="editor-pane"]')).toHaveAttribute(
      'data-mode',
      'rendered'
    )
    await expect(pane(page, 'doc-md').locator('[data-testid="rendered-editor"] .ProseMirror')).toContainText(
      '#3aa6c8'
    )
    await expect(swatches(page, 'doc-md')).toHaveCount(0)

    await pane(page, 'doc-md').locator('[data-testid="mode-toggle"]').click()
    await expect(pane(page, 'doc-md').locator('[data-testid="editor-pane"]')).toHaveAttribute('data-mode', 'raw')
    await expect(swatches(page, 'doc-md')).toHaveCount(3)

    await app.close()
  })

  test('T-068: click → pick → hex rewritten in place (case + short form kept); one Cmd+Z reverts', async () => {
    await seed(fixture, { 'pick.md': PICK_FILE }, [docTab('doc-pick', 'pick.md', 'raw')], 'doc-pick')
    const { app, page } = await launch(fixture)
    await openRaw(page, 'doc-pick')

    // ── #FF0000 → #FFFFFF (6-digit, uppercase preserved) ──
    await swatches(page, 'doc-pick').nth(1).click()
    const pop = page.getByTestId('color-picker')
    await expect(pop).toBeVisible()
    await expect(page.getByTestId('color-picker-original')).toHaveText('#FF0000')
    // No alpha in the notation → no alpha slider.
    await expect(page.getByTestId('color-picker-alpha')).toHaveCount(0)
    await pickWhite(page)
    await expect(page.getByTestId('color-picker-value')).toHaveText('#FFFFFF')
    await page.getByTestId('color-picker-apply').click()
    await expect(pop).toHaveCount(0)

    await expect(rawText(page, 'doc-pick')).toContainText('hex6 #FFFFFF')
    // Editing through the picker marks the doc dirty exactly like typing.
    await expect(pane(page, 'doc-pick').locator('[data-testid="editor-dirty"]')).toBeVisible()
    await page.keyboard.press(`${MOD}+s`)
    await expect.poll(() => read(fixture, 'pick.md')).toContain('hex6 #FFFFFF')

    // ONE undo reverts the whole rewrite.
    await page.keyboard.press(`${MOD}+z`)
    await expect(rawText(page, 'doc-pick')).toContainText('hex6 #FF0000')
    await expect(rawText(page, 'doc-pick')).not.toContainText('#FFFFFF')

    // ── #f00 stays SHORT hex when the new color is still expressible in 3 digits ──
    await swatches(page, 'doc-pick').nth(0).click()
    await pickWhite(page)
    await expect(page.getByTestId('color-picker-value')).toHaveText('#fff')
    await page.getByTestId('color-picker-apply').click()
    await expect(rawText(page, 'doc-pick')).toContainText('hex3 #fff')

    await app.close()
  })

  test('T-068: rgba() and hsl() keep their notation (and alpha); Escape changes nothing', async () => {
    await seed(fixture, { 'pick.md': PICK_FILE }, [docTab('doc-pick', 'pick.md', 'raw')], 'doc-pick')
    const { app, page } = await launch(fixture)
    await openRaw(page, 'doc-pick')

    // ── rgba(255, 0, 0, 0.5) → rgba(255, 255, 255, 0.5): notation + alpha preserved ──
    await swatches(page, 'doc-pick').nth(2).click()
    await expect(page.getByTestId('color-picker-original')).toHaveText('rgba(255, 0, 0, 0.5)')
    // Notation carries alpha → the alpha slider is offered.
    await expect(page.getByTestId('color-picker-alpha')).toBeVisible()
    await pickWhite(page)
    await expect(page.getByTestId('color-picker-value')).toHaveText('rgba(255, 255, 255, 0.5)')
    await page.getByTestId('color-picker-apply').click()
    await expect(rawText(page, 'doc-pick')).toContainText('rgba rgba(255, 255, 255, 0.5)')

    // ── hsl(0, 100%, 50%) → hsl(0, 0%, 100%): stays hsl() ──
    await swatches(page, 'doc-pick').nth(3).click()
    await pickWhite(page)
    await expect(page.getByTestId('color-picker-value')).toHaveText('hsl(0, 0%, 100%)')
    await page.getByTestId('color-picker-apply').click()
    await expect(rawText(page, 'doc-pick')).toContainText('hsl hsl(0, 0%, 100%)')

    // ── Escape after moving the picker = no change at all ──
    await swatches(page, 'doc-pick').nth(0).click()
    await expect(page.getByTestId('color-picker')).toBeVisible()
    await pickWhite(page)
    await expect(page.getByTestId('color-picker-value')).toHaveText('#fff')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('color-picker')).toHaveCount(0)
    await expect(rawText(page, 'doc-pick')).toContainText('hex3 #f00')

    // ── Outside click (the scrim) = no change either. The popup is anchored just under the
    //    swatch near the top of the pane, so the pane's bottom-right corner is scrim only. ──
    await swatches(page, 'doc-pick').nth(0).click()
    await pickWhite(page)
    const paneBox = present(
      await pane(page, 'doc-pick').locator('[data-testid="editor-pane"]').boundingBox(),
      'editor-pane box'
    )
    await page.mouse.click(paneBox.x + paneBox.width - 24, paneBox.y + paneBox.height - 24)
    await expect(page.getByTestId('color-picker')).toHaveCount(0)
    await expect(rawText(page, 'doc-pick')).toContainText('hex3 #f00')

    await app.close()
  })
})
