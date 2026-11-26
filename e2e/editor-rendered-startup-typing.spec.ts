// modules: editor
// Pomade T-206 e2e — typing into a restored Rendered doc right after it opens.
//
// ProseMirror's focus handler re-asserts ITS selection onto the DOM 20 ms after the editor gains
// focus. A native caret move made inside that window (Cmd+ArrowDown to the document end) is read by
// ProseMirror only from the queued `selectionchange` event; on a busy renderer the timer runs first,
// puts the caret back where it was, and everything typed next lands at the stale position (in the
// fixture: inside the code block). The editor syncs the DOM selection into its state when the key is
// released, so the move survives and every character lands at the document end.
//
// The "overtaken" variant pins that ordering: the 20 ms timer is held and `selectionchange` is kept
// from ProseMirror until the key press is done, then the timer runs — so without the fix it fails
// every run. The "natural speed" variant is the same flow with no help, the shape the em-dash spec's
// rendered test hit about once in 40.

import { test, expect, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchAppPage } from './fixtures/app'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const PID = 'proj-alpha'
const REND = '# Rendered\n\nProse with **bold** and a [link](x).\n\n```\ncode line\n```\n\nTail'
const TYPED = ' typed right away'
const SAVED = REND + TYPED + '\n'

async function seedRendered(fixture: Fixture): Promise<void> {
  const root = fixture.workspaceRoot
  await fs.writeFile(join(root, 'Projects/alpha', 'r.md'), REND)
  const tab = {
    id: 'doc-r',
    projectId: PID,
    kind: 'doc',
    title: 'r.md',
    path: 'Projects/alpha/r.md',
    mode: 'rendered',
    dirty: false
  }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(
    join(root, '.pomade/state', `${PID}.json`),
    JSON.stringify({ openTabs: [tab], activeTabId: 'doc-r' }, null, 2)
  )
}

async function openRestored(fixture: Fixture): Promise<{ page: Page; closeApp: () => Promise<void> }> {
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
  return { page, closeApp: () => app.close() }
}

/** Restore the doc, click into it, jump to the end and type at once; assert the editor and the file.
 *  `overtaken` holds ProseMirror's 20 ms focus timer and keeps `selectionchange` from it until the
 *  key press is done. */
async function typeRightAfterOpen(overtaken: boolean): Promise<string> {
  const fixture = await createFixtureWorkspace()
  try {
    await seedRendered(fixture)
    const { page, closeApp } = await openRestored(fixture)
    const prose = page.locator('[data-testid="pane-doc-r"] [data-testid="rendered-editor"] .ProseMirror')
    await expect(prose).toBeVisible()
    if (overtaken) await holdFocusTimer(page)

    await prose.click() // lands in the code block
    await page.keyboard.press(`${MOD}+ArrowDown`) // → the end of the document, the "Tail" paragraph
    if (overtaken) await releaseFocusTimer(page)
    await page.keyboard.type(TYPED)

    // Wait on the typed text being in the editor (not on the dirty dot), then save.
    await expect(prose.locator('p').last()).toHaveText(`Tail${TYPED}`)
    await expect(prose.locator('pre')).toHaveText('code line')
    await page.keyboard.press(`${MOD}+s`)
    const file = join(fixture.workspaceRoot, 'Projects/alpha/r.md')
    await expect.poll(() => fs.readFile(file, 'utf8')).toContain(TYPED)
    const saved = await fs.readFile(file, 'utf8')
    await closeApp()
    return saved
  } finally {
    await fixture.cleanup()
  }
}

async function holdFocusTimer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const held: (() => void)[] = []
    const orig = window.setTimeout.bind(window)
    window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (ms !== 20 || typeof fn !== 'function') return orig(fn, ms, ...args)
      held.push(() => fn(...args))
      return 0
    }) as typeof window.setTimeout
    const swallow = (e: Event): void => e.stopImmediatePropagation()
    document.addEventListener('selectionchange', swallow, true)
    window.__releaseFocusTimer = () => {
      document.removeEventListener('selectionchange', swallow, true)
      for (const run of held.splice(0)) run()
    }
  })
}

async function releaseFocusTimer(page: Page): Promise<void> {
  await page.evaluate(() => window.__releaseFocusTimer())
}

test('T-206 — typing right after a restored Rendered doc opens lands at the caret (focus re-assert overtakes the selection event)', async () => {
  expect(await typeRightAfterOpen(true)).toBe(SAVED)
})

test('T-206 — typing right after a restored Rendered doc opens lands at the caret (natural speed)', async () => {
  expect(await typeRightAfterOpen(false)).toBe(SAVED)
})
