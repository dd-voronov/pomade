// modules: core, editor
// Pomade T-082/T-083 e2e — the Projects panel version label and the spellcheck plumbing.
// The full spell flow needs a REAL OS right-click (Chromium populates misspelledWord only
// on the browser-side hit test, which synthetic input never reaches — probe-verified), so
// these specs pin everything up to that link: the raw-editor spellcheck attribute gating
// and the context menu's suggestion-merge when the spell context arrives.

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
import { setEditorMode, waitCaretRegistered } from './fixtures/stores'

const vis = (page: Page, sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)

// T-083 round 2 — the spell section is decided at right-click time: if the native checker
// hasn't MARKED the word yet (slower under 4-way parallel load), that menu instance opens
// without the section and it never appears for that menu. So the spec retries the
// right-click, it doesn't wait longer on one menu.
async function openSpellMenu(page: Page, pt: { x: number; y: number }): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    await page.mouse.click(pt.x, pt.y, { button: 'right' })
    await expect(page.locator('[data-testid="editor-context-menu"]:visible')).toBeVisible()
    try {
      await expect(page.getByTestId('menu-spell-add')).toBeVisible({ timeout: 1500 })
      return
    } catch {
      if (attempt >= 3) throw new Error('spell section never appeared after 4 right-clicks')
      await page.keyboard.press('Escape')
      // eslint-disable-next-line playwright/no-wait-for-timeout -- give the macOS spellchecker another marking pass; its marks are not in the DOM
      await page.waitForTimeout(800)
    }
  }
}

// T-083 round 2 — click a WORD, not the element containing it: getByText resolves to the
// whole line span, so locator clicks land at the LINE's center and miss the word entirely
// (Chromium then finds no spell marker at the point). Compute the substring's own rect.
async function wordPoint(page: Page, containerSel: string, word: string): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ sel, w }) => {
      const roots = document.querySelectorAll(sel)
      for (const root of roots) {
        if ((root as HTMLElement).offsetParent === null) continue // hidden pane
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
          const node = walker.currentNode
          const i = node.textContent?.indexOf(w) ?? -1
          if (i >= 0) {
            const r = document.createRange()
            r.setStart(node, i)
            r.setEnd(node, i + w.length)
            const b = r.getBoundingClientRect()
            return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
          }
        }
      }
      throw new Error(`word "${w}" not found under ${sel}`)
    },
    { sel: containerSel, w: word }
  )
}

test.describe('app version + spellcheck plumbing', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await fs.writeFile(join(fixture.workspaceRoot, 'Projects/alpha/prose.md'), '# T\n\nSome text here.\n')
    await fs.writeFile(join(fixture.workspaceRoot, 'Projects/alpha/code.json'), '{ "a": 1 }\n')
    // The full native-chain specs TYPE their typo (see T-175 note on those tests), so the
    // fixture is a clean line the test types into (bold neighbor mirrors real vault lines per
    // the T-004 fixture rule).
    await fs.writeFile(
      join(fixture.workspaceRoot, 'Projects/alpha/typo.md'),
      '# Spell\n\nThe **quick** brown fox jumps here.\n'
    )
    app = await launchApp(fixture)
    page = await firstAppWindow(app)
    await page.getByTestId('project-proj-alpha').click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test("Projects panel footer shows the app version (Pomade's own, not Electron's)", async () => {
    const label = page.getByTestId('app-version')
    await expect(label).toBeVisible()
    const text = (await label.textContent()) ?? ''
    // Three-segment semver is the policy (the Owner, 2026-08-19): patch = fix rounds,
    // minor = feature drops. This regex deliberately enforces it.
    expect(text).toMatch(/^v\d+\.\d+\.\d+$/)
    // The app.getVersion() dev trap (T-082): in an unpackaged run app.getVersion() returns
    // ELECTRON's version, so the footer must never equal it. Read the live Electron version
    // rather than hardcode it, so this guard can't go stale on the next Electron bump.
    const electronVersion = await app.evaluate(({ app: a }) => a.getVersion())
    expect(text).not.toBe(`v${electronVersion}`)
  })

  test('raw editor spellchecks prose files but not code files', async () => {
    await page.getByTestId('tree-node-Projects/alpha/prose.md').click()
    await setEditorMode(page, 'raw')
    await expect(vis(page, '[data-testid="raw-editor"] .cm-content')).toHaveAttribute('spellcheck', 'true')

    await page.getByTestId('tree-node-Projects/alpha/code.json').click()
    await expect(vis(page, '[data-testid="raw-editor"] .cm-content')).not.toHaveAttribute('spellcheck', 'true')
  })

  test('an open context menu merges arriving spell suggestions; empty word shows none', async () => {
    // Preview-tab mode replaced the raw prose tab with code.json in the previous test —
    // reopening lands a FRESH tab in the default (rendered) mode, so go raw again.
    await page.getByTestId('tree-node-Projects/alpha/prose.md').click()
    await setEditorMode(page, 'raw')
    await vis(page, '[data-testid="raw-editor"] .cm-content').getByText('Some text here').click({ button: 'right' })
    const menu = vis(page, '[data-testid="editor-context-menu"]')
    await expect(menu).toBeVisible()

    // Simulate main's spell context (the part a synthetic click can't produce).
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('app:spell-context', {
        misspelledWord: 'definately',
        suggestions: ['definitely', 'defiantly']
      })
    })
    await expect(page.getByTestId('menu-spell-definitely')).toBeVisible()
    await expect(page.getByTestId('menu-spell-defiantly')).toBeVisible()
    await expect(page.getByTestId('menu-spell-add')).toContainText('definately')

    // A follow-up context with no misspelling clears the section.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('app:spell-context', {
        misspelledWord: '',
        suggestions: []
      })
    })
    await expect(page.getByTestId('menu-spell-add')).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  // T-083 round 2 — the FULL native chain, no injection. This was believed unreachable by
  // automation ("synthetic clicks never populate misspelledWord") — that lore was an artifact
  // of the round-1 bug: the menu used to mount synchronously in onContextMenu, so Chromium's
  // context-menu hit test landed on the SCRIM and the spellcheck params died for every click,
  // real or synthetic. With the menu parked until main's EV.spellContext push, a plain
  // Playwright right-click exercises marker hit-test → macOS suggestions → replaceMisspelling.
  //
  // T-175 (Electron 44): the typo is TYPED (a trailing space closes the word) so it arrives
  // through the INPUT pipeline, which Chromium spell-marks in either engine. Chromium does NOT
  // paint markers on already-LOADED CodeMirror text — under CDP the loaded-text idle spell pass
  // is suppressed outright, and even off-CDP CodeMirror's programmatic content DOM is skipped by
  // Chromium ≥ the 44 line (a real Chromium/CodeMirror limitation, not the app; see
  // cm-spellcheck.ts + docs/modules/editor/spellcheck.md). So this spec pins the TYPED native chain (the path that
  // works in both engines); loaded-text squiggles are not automation-assertable.
  test('raw mode: right-click on a typo shows real OS suggestions; picking one replaces the word', async () => {
    await page.getByTestId('tree-node-Projects/alpha/typo.md').click()
    await setEditorMode(page, 'raw')
    // Type the typo through the input pipeline (trailing space completes the word), so Chromium's
    // native checker marks it; then right-click it.
    await vis(page, '[data-testid="raw-editor"] .cm-content').click()
    await page.keyboard.press('End')
    await page.keyboard.type(' wrld ')
    // The macOS spellchecker marks the typed word asynchronously and its marks are not in the DOM;
    // 1.5 s covers one pass under 4-way parallel load (openSpellMenu retries a late one).
    // eslint-disable-next-line playwright/no-wait-for-timeout -- spellchecker pass: no observable signal
    await page.waitForTimeout(1500)
    const pt = await wordPoint(page, '[data-testid="raw-editor"] .cm-content', 'wrld')
    await openSpellMenu(page, pt)
    // Real macOS suggestions — assert shape, not the exact list (it belongs to the OS).
    await expect(page.getByTestId('menu-spell-add')).toContainText('wrld')
    const suggestions = page.locator('[data-testid^="menu-spell-"]:not([data-testid="menu-spell-add"]):not([data-testid="menu-spell-empty"])')
    expect(await suggestions.count()).toBeGreaterThan(0)
    const picked = (await suggestions.first().textContent()) ?? ''
    await suggestions.first().click()
    // Chromium's replaceMisspelling swapped the marker word — its own undo entry.
    await expect(vis(page, '[data-testid="raw-editor"] .cm-content')).not.toContainText('wrld')
    await expect(vis(page, '[data-testid="raw-editor"] .cm-content')).toContainText(picked.trim())
  })

  test('rendered mode: the same native chain works in the Milkdown view', async () => {
    // Switch the (raw) doc from the previous test into the rendered Milkdown view. E-024: the
    // toggle re-enters the doc's LIVE view — this test is about the MILKDOWN chain, so the helper
    // switches the doc's rich view to Rendered.
    await setEditorMode(page, 'rendered')
    // T-175 (see the raw-mode test above): TYPE the typo through Milkdown's input pipeline so
    // Chromium's native checker marks it, then right-click it.
    const prose = vis(page, '[data-testid="editor-pane"] .ProseMirror')
    await prose.click()
    await waitCaretRegistered(page)
    await page.keyboard.press('End')
    await page.keyboard.type(' wrld ')
    // The macOS spellchecker marks the typed word asynchronously and its marks are not in the DOM;
    // 1.5 s covers one pass under 4-way parallel load (openSpellMenu retries a late one).
    // eslint-disable-next-line playwright/no-wait-for-timeout -- spellchecker pass: no observable signal
    await page.waitForTimeout(1500)
    const pt = await wordPoint(page, '[data-testid="editor-pane"] .ProseMirror', 'wrld')
    await openSpellMenu(page, pt)
    await expect(page.getByTestId('menu-spell-add')).toContainText('wrld')
    const suggestions = page.locator('[data-testid^="menu-spell-"]:not([data-testid="menu-spell-add"]):not([data-testid="menu-spell-empty"])')
    expect(await suggestions.count()).toBeGreaterThan(0)
    await suggestions.first().click()
    await expect(vis(page, '[data-testid="editor-pane"] .ProseMirror')).not.toContainText('wrld')
  })
})
