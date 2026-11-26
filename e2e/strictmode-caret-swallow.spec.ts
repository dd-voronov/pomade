// modules: editor, terminal
// Pomade — StrictMode one-shot swallow (dev-only regime).
//
// React.StrictMode (src/renderer/main.tsx) double-invokes every mount effect in a DEVELOPMENT
// React bundle: mount → simulated unmount → remount. `npm run dev` runs exactly that bundle, so
// RawEditor/LiveEditor register TWO controllers on a single mount (the first destroyed at once),
// and two one-shot consumers used to fire against the DOOMED first controller:
//   1. T-004 pending caret — cleared at schedule time by the doomed controller, so the survivor
//      found nothing to restore → caret landed on line 1 after a raw⇄live / rendered→raw toggle.
//   2. T-086 jump slot — consumed into the doomed CM → destroyed → a `:line` link opened at line 1.
// The normal e2e build is PRODUCTION React (no double invoke), so the suite never saw either. This
// spec runs against a DEV-React build (electron.vite.dev-react.config.ts, `process.env.NODE_ENV`
// forced to "development"), so the double invoke — and the Owner's live symptom — is real.
//
// Regime marker (first test): a SINGLE editor mount must register TWO controllers (proven via the
// caret-trace `register` ring). On a production bundle it registers once, so that test FAILS —
// the spec can never pass vacuously against the wrong build.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp, launchAppPage } from './fixtures/app'
import { writeWhenReady } from './fixtures/stores'

const vis = (page: Page, sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)

const PID = 'proj-alpha'

// No frontmatter — the live view shows the body verbatim, so a raw line maps to the same live
// line. Line 1 is the heading; the caret target is a mid-doc paragraph, clearly not line 1, so a
// swallow (which lands the caret at line 1, unfocused) is unmistakable.
const DOC = [
  '# Title',
  '',
  'Alpha paragraph.',
  '',
  'Beta paragraph.',
  '',
  'Gamma paragraph.',
  ''
].join('\n')

async function seedDoc(
  fixture: Fixture,
  mode: 'raw' | 'rendered' | 'live',
  richView: 'live' | 'rendered'
): Promise<void> {
  const root = fixture.workspaceRoot
  await fs.writeFile(join(root, 'Projects/alpha', 'caret.md'), DOC)
  const state = {
    openTabs: [
      {
        id: 'doc-c',
        projectId: PID,
        kind: 'doc',
        title: 'caret.md',
        path: 'Projects/alpha/caret.md',
        mode,
        richView,
        dirty: false
      }
    ],
    activeTabId: 'doc-c'
  }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(root, '.pomade/state', `${PID}.json`), JSON.stringify(state, null, 2))
}

interface TraceEntry {
  stage: string
  [k: string]: unknown
}
function readCaretTrace(page: Page): Promise<TraceEntry[]> {
  return page.evaluate(
    () => window.__pomadeCaretTrace ?? []
  )
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

// ── Bug 1: caret survives a toggle (the pending-caret swallow) ──────────────────────────────────
test.describe('StrictMode one-shot swallow — caret toggle (dev-React regime)', () => {
  let fixture: Fixture

  test.beforeEach(async () => {
    fixture = await createFixtureWorkspace()
  })

  test.afterEach(async () => {
    await fixture?.cleanup()
  })

  // Regime guard — the spec is meaningless unless the bundle is DEV React (StrictMode
  // double-invokes). Proven structurally: a single editor mount registers the controller TWICE.
  test('regime: a single editor mount registers TWO controllers (dev StrictMode double invoke)', async () => {
    await seedDoc(fixture, 'raw', 'live')
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-c').click()
    await expect(vis(page, '[data-testid="raw-editor"]')).toBeVisible()
    // The caret-trace ring records every controller registration (stage 'register'). One logical
    // raw-editor mount ⇒ two entries in a dev bundle, one in production.
    await expect
      .poll(async () => (await readCaretTrace(page)).filter((e) => e.stage === 'register').length)
      .toBeGreaterThanOrEqual(2)
    await app.close()
  })

  // NOTE: the LIVE view is CodeMirror but has no `highlightActiveLine` extension (no
  // `.cm-activeLine`), so the caret's LINE is proven the unambiguous way: put the caret at the
  // START of the target line (Home), toggle, then TYPE a sentinel — it lands contiguous with the
  // line's text ("ZZZBeta paragraph.") iff the caret was restored to that line. A swallow (caret
  // at line 1) puts the sentinel on the heading line, so "ZZZBeta paragraph." never appears.
  test('raw → live keeps the caret on its line (not line 1)', async () => {
    await seedDoc(fixture, 'raw', 'live')
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-c').click()
    const editor = vis(page, '[data-testid="editor-pane"]')
    await expect(editor).toHaveAttribute('data-mode', 'raw')

    await vis(page, '[data-testid="raw-editor"] .cm-content').getByText('Beta paragraph.').click()
    await page.keyboard.press('Home')
    await expect(vis(page, '[data-testid="raw-editor"] .cm-activeLine')).toContainText('Beta paragraph.')

    await vis(page, '[data-testid="mode-toggle"]').click()
    await expect(editor).toHaveAttribute('data-mode', 'live')

    // The restored caret must be live and focused in the live view, on the Beta line.
    await expect(vis(page, '[data-testid="live-editor"] .cm-editor.cm-focused')).toBeVisible()
    await page.keyboard.type('ZZZ')
    await expect(vis(page, '[data-testid="live-editor"] .cm-content')).toContainText('ZZZBeta paragraph.')
    await app.close()
  })

  // Reverse leg: seeded directly in LIVE. The raw target HAS `.cm-activeLine`, which shows the
  // whole restored line regardless of the in-line offset — so a plain activeLine assertion proves
  // the line, no sentinel needed.
  test('live → raw keeps the caret on its line (not line 1)', async () => {
    await seedDoc(fixture, 'live', 'live')
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-c').click()
    const editor = vis(page, '[data-testid="editor-pane"]')
    await expect(editor).toHaveAttribute('data-mode', 'live')

    await expect(vis(page, '[data-testid="live-editor"] .cm-content')).toContainText('Beta paragraph.')
    await vis(page, '[data-testid="live-editor"] .cm-content').getByText('Beta paragraph.').click()

    await vis(page, '[data-testid="mode-toggle"]').click()
    await expect(editor).toHaveAttribute('data-mode', 'raw')

    await expect(vis(page, '[data-testid="raw-editor"] .cm-editor.cm-focused')).toBeVisible()
    await expect(vis(page, '[data-testid="raw-editor"] .cm-activeLine')).toContainText('Beta paragraph.')
    await app.close()
  })

  test('rendered → raw keeps the caret on its paragraph (not line 1)', async () => {
    await seedDoc(fixture, 'rendered', 'rendered')
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-c').click()
    const editor = vis(page, '[data-testid="editor-pane"]')
    await expect(editor).toHaveAttribute('data-mode', 'rendered')

    await vis(page, '[data-testid="rendered-editor"] .ProseMirror').getByText('Beta paragraph.').click()
    await vis(page, '[data-testid="mode-toggle"]').click()
    await expect(editor).toHaveAttribute('data-mode', 'raw')

    await expect(vis(page, '[data-testid="raw-editor"] .cm-editor.cm-focused')).toBeVisible()
    await expect(vis(page, '[data-testid="raw-editor"] .cm-activeLine')).toContainText('Beta paragraph.')
    await app.close()
  })
})

// ── Bug 2: a `:line` link jumps to the line even under the double mount (the jump swallow) ───────
// A fresh doc mount that carries a pending jump double-invokes RawEditor: the jump could be
// consumed into the doomed controller (destroyed → line 1). Driven exactly as a terminal Cmd+click
// does, via the `__pomadeTermLinks` provider hook (scan + resolve + route), the model the
// terminal-link jump specs use.
const RANGE_DOC = 'Projects/alpha/rangefile.ts'
function rangeLines(): string[] {
  const out: string[] = []
  for (let i = 1; i <= 140; i++) out.push(`line ${String(i).padStart(3, '0')} marker${i} const x = ${i}`)
  return out
}

test.describe('StrictMode one-shot swallow — `:line` jump (dev-React regime)', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  async function readBuffer(termId: string): Promise<string> {
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
  async function alphaTerminal(): Promise<string> {
    await page.getByTestId(`project-${PID}`).click()
    const termId = await openTerminal()
    await writeWhenReady(page, termId, "printf 'ALPHA_TERM_READY\\n'\r")
    await expect.poll(() => readBuffer(termId), { timeout: 10_000 }).toContain('ALPHA_TERM_READY')
    return termId
  }
  function activateLink(termId: string, token: string): Promise<void> {
    return page.evaluate(
      ({ tid, tk }) => window.__pomadeTermLinks[tid](tk),
      { tid: termId, tk: token }
    )
  }

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    await fs.mkdir(join(fixture.workspaceRoot, 'Projects/alpha'), { recursive: true })
    await fs.writeFile(join(fixture.workspaceRoot, RANGE_DOC), rangeLines().join('\n') + '\n')
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('a fresh-open `:132` link lands on line 132, not line 1 (jump not swallowed)', async () => {
    const term = await alphaTerminal()
    await activateLink(term, `${RANGE_DOC}:132`)

    const pane = page.locator('[data-testid="editor-pane"]:visible')
    await expect(pane).toBeVisible({ timeout: 10_000 })
    await expect(pane).toHaveAttribute('data-mode', 'raw')
    await expect(pane.locator('.cm-lineNumbers .cm-activeLineGutter')).toHaveText('132', { timeout: 10_000 })
    const scrollTop = await pane.locator('.cm-scroller').evaluate((el) => el.scrollTop)
    expect(scrollTop).toBeGreaterThan(0)
  })

  test('re-activating a `:40` link to the ALREADY-OPEN doc re-jumps to line 40', async () => {
    // Chains on the test above: rangefile.ts is open at line 132. A second link to the same file
    // must re-jump the existing tab (no remount, so this exercises the store re-fire, not the
    // mount double-invoke — kept green in both regimes).
    const term = await alphaTerminal()
    await activateLink(term, `${RANGE_DOC}:40`)

    const pane = page.locator('[data-testid="editor-pane"]:visible')
    await expect(pane).toBeVisible({ timeout: 10_000 })
    await expect(pane.locator('.cm-lineNumbers .cm-activeLineGutter')).toHaveText('40', { timeout: 10_000 })
  })
})
