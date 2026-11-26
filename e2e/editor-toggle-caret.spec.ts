// modules: editor
// Pomade T-004 — the caret survives a raw ⇄ rendered toggle (best-effort, paragraph-level).
// Placing the caret in a mid-document paragraph in raw, toggling to rendered and back, lands the
// caret in the SAME paragraph (asserted via CodeMirror's active-line highlight).

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchAppPage } from './fixtures/app'

const vis = (page: Page, sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)

/** The paragraph NUMBER at the top of the visible editor's scroll container (from "Paragraph number
 *  N …"), or 0 for the heading / no paragraph — the reading-position oracle for the T-194 update
 *  below. Robust to the pixel-level height differences between the engines. */
async function topPara(page: Page): Promise<number> {
  const text = await page.evaluate(() => {
    const panes = [...document.querySelectorAll('[data-testid="editor-pane"]')] as HTMLElement[]
    const pane = panes.find((p) => p.offsetParent !== null)
    if (!pane) return ''
    const container =
      (pane.querySelector('[data-testid="md-scroll"]') as HTMLElement | null) ??
      (pane.querySelector('.cm-scroller') as HTMLElement | null)
    if (!container) return ''
    const cr = container.getBoundingClientRect()
    const lines = [...pane.querySelectorAll('.cm-line, .ProseMirror > *')] as HTMLElement[]
    let best: HTMLElement | null = null
    let bestTop = Infinity
    for (const l of lines) {
      const t = (l.textContent ?? '').trim()
      if (!t) continue
      const r = l.getBoundingClientRect()
      if (r.bottom > cr.top + 2 && r.top < bestTop) {
        bestTop = r.top
        best = l
      }
    }
    return (best?.textContent ?? '').trim()
  })
  const m = text.match(/Paragraph number (\d+)/)
  return m ? Number(m[1]) : 0
}

const PID = 'proj-alpha'
const DOC = ['# Title', '', 'Alpha paragraph.', '', 'Beta paragraph.', '', 'Gamma paragraph.', ''].join('\n')

// A vault-realistic doc: frontmatter (with an internal blank line) + a heading + a LOOSE list
// (blank lines between items). The old block-index bridge counted these incompatibly — raw sees
// blank-line groups (frontmatter = 2 blocks, the list = 3), rendered sees top-level nodes
// (frontmatter hidden, the list = 1) — so a caret below them drifted by several paragraphs on a
// rendered→raw toggle. Content-anchoring is immune, so it must land dead-on "Gamma paragraph.".
const DOC_STRUCTURED = [
  '---', 'title: Note', '', 'tags: [a, b]', '---',
  '', '# Title',
  '', '- item one', '', '- item two', '', '- item three',
  '', 'Alpha paragraph.', '', 'Beta paragraph.', '', 'Gamma paragraph.', ''
].join('\n')

async function seed(fixture: Fixture, mode: 'raw' | 'rendered' = 'raw', doc: string = DOC): Promise<void> {
  const root = fixture.workspaceRoot
  await fs.writeFile(join(root, 'Projects/alpha', 'caret.md'), doc)
  const state = {
    // E-024: richView 'rendered' pins the toggle's rich target to MILKDOWN — these are the
    // T-004 raw⇄rendered caret-bridge specs (the raw⇄live bridge is covered by the live suite).
    openTabs: [{ id: 'doc-c', projectId: PID, kind: 'doc', title: 'caret.md', path: 'Projects/alpha/caret.md', mode, richView: 'rendered', dirty: false }],
    activeTabId: 'doc-c'
  }
  await fs.mkdir(join(root, '.pomade/state'), { recursive: true })
  await fs.writeFile(join(root, '.pomade/state', `${PID}.json`), JSON.stringify(state, null, 2))
}

async function launch(fixture: Fixture): Promise<{ app: ElectronApplication; page: Page }> {
  const { app, page } = await launchAppPage(fixture)
  await expect
    .poll(() => page.evaluate(() => window.__pomadeStores.useAppSettingsStore.getState().hydrated))
    .toBe(true)
  await page.getByTestId(`project-${PID}`).click()
  return { app, page }
}

test.describe('T-004 — caret survives raw/rendered toggle', () => {
  let fixture: Fixture

  test.beforeEach(async () => {
    fixture = await createFixtureWorkspace()
  })

  test.afterEach(async () => {
    await fixture?.cleanup()
  })

  test('caret in a mid-doc paragraph survives a double toggle', async () => {
    await seed(fixture)
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-c').click()
    const editor = vis(page, '[data-testid="editor-pane"]')
    await expect(editor).toHaveAttribute('data-mode', 'raw')

    // Place the caret in the "Beta paragraph." line (raw).
    await vis(page, '[data-testid="raw-editor"] .cm-content').getByText('Beta paragraph.').click()
    await expect(vis(page, '[data-testid="raw-editor"] .cm-activeLine')).toContainText('Beta paragraph.')

    // Toggle to rendered and back.
    await vis(page, '[data-testid="mode-toggle"]').click()
    await expect(editor).toHaveAttribute('data-mode', 'rendered')
    await expect(vis(page, '[data-testid="rendered-editor"] .ProseMirror')).toContainText('Beta paragraph.')
    await vis(page, '[data-testid="mode-toggle"]').click()
    await expect(editor).toHaveAttribute('data-mode', 'raw')

    // The caret is back in the same paragraph.
    await expect(vis(page, '[data-testid="raw-editor"] .cm-activeLine')).toContainText('Beta paragraph.')
    await app.close()
  })

  // Reverse leg in isolation, over a vault-realistic doc: a caret placed by a real CLICK in the
  // rendered view (not by the forward restore) must survive the toggle to raw — SAME paragraph
  // AND a live, focused caret. The double-toggle test above set the rendered caret
  // programmatically via the raw→rendered restore on a flat all-paragraph doc, so it never
  // exercised a user-driven rendered→raw mapping past structure that the two engines count
  // differently. Here the frontmatter (internal blank) + loose list above the caret made the old
  // block-index bridge drift by several paragraphs (the "cursor disappears" report); this asserts
  // it lands dead-on. Regression: this FAILS on the pre-fix (block-index) code.
  test('caret clicked in rendered survives the toggle back to raw (structured doc)', async () => {
    await seed(fixture, 'rendered', DOC_STRUCTURED)
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-c').click()
    const editor = vis(page, '[data-testid="editor-pane"]')
    await expect(editor).toHaveAttribute('data-mode', 'rendered')

    // Place the caret in "Gamma paragraph." by clicking it in the rendered (ProseMirror) view.
    await vis(page, '[data-testid="rendered-editor"] .ProseMirror').getByText('Gamma paragraph.').click()

    // Toggle to raw.
    await vis(page, '[data-testid="mode-toggle"]').click()
    await expect(editor).toHaveAttribute('data-mode', 'raw')

    // Same paragraph, and the caret is actually live (CodeMirror only carries .cm-focused, and
    // paints .cm-cursor, while the view holds focus — "cursor disappears" = no focus).
    await expect(vis(page, '[data-testid="raw-editor"] .cm-activeLine')).toContainText('Gamma paragraph.')
    await expect(vis(page, '[data-testid="raw-editor"] .cm-editor.cm-focused')).toBeVisible()
    await app.close()
  })

  // Forward leg over the same structured doc, closing the loop: a caret clicked in raw below the
  // frontmatter + loose list lands on the SAME paragraph in the rendered view. Content-anchoring
  // must survive the block-count divergence in this direction too.
  test('caret clicked in raw survives the toggle to rendered (structured doc)', async () => {
    await seed(fixture, 'raw', DOC_STRUCTURED)
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-c').click()
    const editor = vis(page, '[data-testid="editor-pane"]')
    await expect(editor).toHaveAttribute('data-mode', 'raw')

    await vis(page, '[data-testid="raw-editor"] .cm-content').getByText('Beta paragraph.').click()
    await expect(vis(page, '[data-testid="raw-editor"] .cm-activeLine')).toContainText('Beta paragraph.')

    await vis(page, '[data-testid="mode-toggle"]').click()
    await expect(editor).toHaveAttribute('data-mode', 'rendered')

    // The rendered caret sits in the Beta paragraph (its top-level node is now the selected one).
    const betaBlock = await page.evaluate(() => {
      const sel = document.querySelector('[data-testid="rendered-editor"] .ProseMirror')?.ownerDocument.getSelection()
      let n = sel?.anchorNode as Node | null
      while (n && !(n instanceof HTMLElement && n.parentElement?.classList.contains('ProseMirror'))) n = n.parentElement
      return (n as HTMLElement | null)?.textContent ?? ''
    })
    expect(betaBlock).toContain('Beta paragraph.')
    await app.close()
  })

  // ── Round-7 regressions ─────────────────────────────────────────────────────────────────────
  // The round-6 signature bridge only stripped LEADING BLOCK markers (heading/bullet/quote), so a
  // raw line kept its INLINE markup (`**bold**`, `[text](url)`, `` `code` ``, `[[wikilink]]`) while
  // the rendered side saw markup-free textContent — the two signatures never matched on any
  // real vault line, `setCaretAnchor` found nothing and the caret was left at doc position 0
  // (raw: first line; rendered: first block). The round-5/6 specs only ever used marker-free plain
  // paragraphs, which is why they went green while the app stayed broken. These three drive the
  // real gesture (mouse click, real toggle button) over content that HAS inline markup, plus the
  // doc-end/scroll case.

  // (a) rendered → raw, a LIST-ONLY doc whose items carry inline markup.
  test('caret clicked in a rendered list item with inline markup survives the toggle to raw', async () => {
    const doc = [
      '- item **one** is bold',
      '- item two has a [link](https://example.com)',
      '- item three has `code` inside',
      ''
    ].join('\n')
    await seed(fixture, 'rendered', doc)
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-c').click()
    const editor = vis(page, '[data-testid="editor-pane"]')
    await expect(editor).toHaveAttribute('data-mode', 'rendered')

    await vis(page, '[data-testid="rendered-editor"] .ProseMirror').getByText('item two has a').click()
    await vis(page, '[data-testid="mode-toggle"]').click()
    await expect(editor).toHaveAttribute('data-mode', 'raw')

    await expect(vis(page, '[data-testid="raw-editor"] .cm-activeLine')).toContainText('item two has a')
    await expect(vis(page, '[data-testid="raw-editor"] .cm-editor.cm-focused')).toBeVisible()
    await app.close()
  })

  // (b) rendered → raw, a FRONTMATTER-ONLY doc (no list) whose paragraphs carry inline markup.
  test('caret clicked in a rendered paragraph with inline markup survives the toggle to raw', async () => {
    const doc = [
      '---', 'title: Note', 'tags: [a, b]', '---', '',
      'Alpha paragraph with **bold** text.', '',
      'Beta paragraph with a [link](https://example.com) inside.', '',
      'Gamma paragraph with `inline code` here.', ''
    ].join('\n')
    await seed(fixture, 'rendered', doc)
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-c').click()
    const editor = vis(page, '[data-testid="editor-pane"]')
    await expect(editor).toHaveAttribute('data-mode', 'rendered')

    await vis(page, '[data-testid="rendered-editor"] .ProseMirror').getByText('Gamma paragraph with').click()
    await vis(page, '[data-testid="mode-toggle"]').click()
    await expect(editor).toHaveAttribute('data-mode', 'raw')

    await expect(vis(page, '[data-testid="raw-editor"] .cm-activeLine')).toContainText('Gamma paragraph with')
    await expect(vis(page, '[data-testid="raw-editor"] .cm-editor.cm-focused')).toBeVisible()
    await app.close()
  })

  // (b2) the same leg the other way round: raw → rendered over inline markup.
  test('caret clicked in a raw line with inline markup survives the toggle to rendered', async () => {
    const doc = [
      '---', 'title: Note', 'tags: [a, b]', '---', '',
      'Alpha paragraph with **bold** text.', '',
      'Beta paragraph with a [link](https://example.com) inside.', '',
      'Gamma paragraph with `inline code` here.', ''
    ].join('\n')
    await seed(fixture, 'raw', doc)
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-c').click()
    const editor = vis(page, '[data-testid="editor-pane"]')
    await expect(editor).toHaveAttribute('data-mode', 'raw')

    // Deliberately NOT the first block: an unmatched anchor leaves the caret in the first
    // paragraph, which would let a broken mapping pass if we aimed at "Alpha".
    await vis(page, '[data-testid="raw-editor"] .cm-content').getByText('Gamma paragraph with').click()
    await vis(page, '[data-testid="mode-toggle"]').click()
    await expect(editor).toHaveAttribute('data-mode', 'rendered')

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const sel = document.getSelection()
          let n = sel?.anchorNode as Node | null
          while (n && !(n instanceof HTMLElement && n.parentElement?.classList.contains('ProseMirror'))) n = n.parentElement
          return (n as HTMLElement | null)?.textContent ?? ''
        })
      )
      .toContain('Gamma paragraph with')
    await app.close()
  })

  // (c) raw → rendered with the caret at the very END of a doc TALLER than the viewport. The
  // block mapping was right here even pre-fix, but ProseMirror's `tr.scrollIntoView()` never
  // scrolled the pane's own scroll container (`md-scroll`, an absolutely-positioned overflow
  // ancestor), so the restored caret sat ~1500px below the fold: "the caret is not restored".
  test('caret at the end of a long doc is restored AND scrolled into view (raw → rendered)', async () => {
    const doc = ['---', 'title: Long', '---', '', '# Long doc', '']
      .concat(...Array.from({ length: 60 }, (_, i) => [`Paragraph number ${i + 1} of the long document.`, '']))
      .concat(['The very last paragraph of the document.', ''])
      .join('\n')
    await seed(fixture, 'raw', doc)
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-c').click()
    const editor = vis(page, '[data-testid="editor-pane"]')
    await expect(editor).toHaveAttribute('data-mode', 'raw')

    // Real gesture: click into the text, then jump to the very end of the document.
    await vis(page, '[data-testid="raw-editor"] .cm-content').getByText('Paragraph number 3 of').click()
    await page.keyboard.press('Meta+ArrowDown')
    await vis(page, '[data-testid="mode-toggle"]').click()
    await expect(editor).toHaveAttribute('data-mode', 'rendered')

    // The caret is in the last paragraph AND inside the visible scroll viewport.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const scroll = document.querySelector('[data-testid="md-scroll"]') as HTMLElement | null
          const sel = document.getSelection()
          let n = sel?.anchorNode as Node | null
          while (n && !(n instanceof HTMLElement && n.parentElement?.classList.contains('ProseMirror'))) n = n.parentElement
          const block = (n as HTMLElement | null)?.textContent ?? ''
          if (!scroll || !sel || sel.rangeCount === 0) return { block, inView: false }
          const r = sel.getRangeAt(0).getBoundingClientRect()
          const sr = scroll.getBoundingClientRect()
          return { block, inView: r.top >= sr.top - 1 && r.bottom <= sr.bottom + 1 }
        })
      )
      .toEqual({ block: 'The very last paragraph of the document.', inView: true })
    await app.close()
  })

  // (d) the doc-end case, rendered → raw, updated to the T-194 contract. A toggle now KEEPS the
  // reading position (the outgoing on-screen viewport) instead of scrolling the caret into view: the
  // caret is restored as the SELECTION (same paragraph, focused, live) but is NOT scrolled to. Here
  // the caret sits at the doc end while the viewport shows a mid-doc paragraph (Playwright's click
  // scrolled the last paragraph into view, so the viewport top is well above it); after the toggle
  // the raw view stays on that reading position and the caret is off-screen below — the deliberate
  // inverse of the old "scroll the doc-end caret into view" behaviour this test used to pin.
  test('caret at the end of a long doc is restored as the selection but the viewport is kept (rendered → raw)', async () => {
    const doc = ['---', 'title: Long', '---', '', '# Long doc', '']
      .concat(...Array.from({ length: 60 }, (_, i) => [`Paragraph number ${i + 1} of the long document.`, '']))
      .concat(['The very last paragraph of the document.', ''])
      .join('\n')
    await seed(fixture, 'rendered', doc)
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-c').click()
    const editor = vis(page, '[data-testid="editor-pane"]')
    await expect(editor).toHaveAttribute('data-mode', 'rendered')

    await vis(page, '[data-testid="rendered-editor"] .ProseMirror').getByText('The very last paragraph').click()
    // The reading position at toggle time: a mid-doc paragraph, NOT the doc end where the caret is.
    const kept = await topPara(page)
    expect(kept).toBeGreaterThan(20)

    await vis(page, '[data-testid="mode-toggle"]').click()
    await expect(editor).toHaveAttribute('data-mode', 'raw')

    // The caret is restored (carried as the selection) and the view is focused. It sits at the doc
    // END, now OFF-SCREEN below the kept viewport, so CodeMirror doesn't render its line — the
    // selection is read from CM's state (the exposed hook), not the DOM, precisely because a
    // T-194 toggle no longer scrolls that caret into view.
    await expect(vis(page, '[data-testid="raw-editor"] .cm-editor.cm-focused')).toBeVisible()
    const selFrom = await page.evaluate(
      () => window.__pomadeEditorSelectionFrom?.() ?? -1
    )
    expect(selFrom).toBeGreaterThan(2000) // near the doc end (~2600 chars), not reset to the top
    // …but the VIEWPORT was kept at the reading position — the caret was NOT scrolled into view.
    await expect.poll(() => topPara(page)).toBeGreaterThan(kept - 6)
    expect(Math.abs((await topPara(page)) - kept)).toBeLessThanOrEqual(6)
    await app.close()
  })

  // (e) the caret keeps its position INSIDE the block, not just the block — proven the only
  // unambiguous way: toggle, then TYPE and see where the character landed. The offset travels in
  // plain-text space, so the markup the raw line carries ahead of the caret (`[[…]]`) doesn't
  // shift it.
  test('caret keeps its offset inside the line across the toggle', async () => {
    const doc = [
      'See [[jane-doe]] for the canonical profile and **note** the [spec](https://example.com).',
      '',
      'Second paragraph.',
      ''
    ].join('\n')
    await seed(fixture, 'rendered', doc)
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-c').click()
    const editor = vis(page, '[data-testid="editor-pane"]')
    await expect(editor).toHaveAttribute('data-mode', 'rendered')

    // Put the rendered caret exactly before the word "profile".
    await page.evaluate(() => {
      const pm = document.querySelector('[data-testid="rendered-editor"] .ProseMirror') as HTMLElement
      const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const t = walker.currentNode as Text
        const i = t.data.indexOf('profile')
        if (i >= 0) {
          const r = document.createRange()
          r.setStart(t, i)
          r.setEnd(t, i)
          const sel = document.getSelection()
          sel?.removeAllRanges()
          sel?.addRange(r)
          pm.focus()
          return
        }
      }
    })
    await vis(page, '[data-testid="mode-toggle"]').click()
    await expect(editor).toHaveAttribute('data-mode', 'raw')
    await expect(vis(page, '[data-testid="raw-editor"] .cm-editor.cm-focused')).toBeVisible()

    await page.keyboard.type('X')
    await expect(vis(page, '[data-testid="raw-editor"] .cm-activeLine')).toContainText('canonical Xprofile')
    await app.close()
  })

  // T-004 round 8 — SOFT BREAKS. Consecutive `key:: value` lines (every vault wiki note's
  // Relationships section) are ONE rendered paragraph with soft breaks but SEVERAL raw lines,
  // so the caret's intra-block offset must count each break as exactly one char on both sides
  // (raw: mdast `break` → ' '; rendered: explicit leafText ' ' in textBetween — previously
  // held only by Milkdown's own `leafText: '\n'` node spec). Guards line-exact landing.
  test('caret on line 3 of a soft-break block lands on that exact raw line', async () => {
    const DOC_SOFTBREAKS = [
      '# Title', '',
      'Intro paragraph.', '',
      'works-at:: [[acmecorp]]',
      'owns:: [[automation-workshop]]',
      'collaborates-with:: [[arthur-pemberton]]',
      'mentors:: [[someone-else]]', '',
      'Outro paragraph.', ''
    ].join('\n')
    await seed(fixture, 'rendered', DOC_SOFTBREAKS)
    const { app, page } = await launch(fixture)
    await page.getByTestId('tab-doc-c').click()
    const editor = vis(page, '[data-testid="editor-pane"]')
    await expect(editor).toHaveAttribute('data-mode', 'rendered')
    await expect(vis(page, '[data-testid="rendered-editor"] .ProseMirror')).toContainText('collaborates-with')

    // Caret exactly before "arthur" — third soft-break line of the block.
    await page.evaluate(() => {
      const pm = document.querySelector('[data-testid="rendered-editor"] .ProseMirror') as HTMLElement
      const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const t = walker.currentNode as Text
        const i = t.data.indexOf('arthur')
        if (i >= 0) {
          const r = document.createRange()
          r.setStart(t, i)
          r.setEnd(t, i)
          const sel = document.getSelection()
          sel?.removeAllRanges()
          sel?.addRange(r)
          pm.focus()
          return
        }
      }
    })
    await vis(page, '[data-testid="mode-toggle"]').click()
    await expect(editor).toHaveAttribute('data-mode', 'raw')
    await expect(vis(page, '[data-testid="raw-editor"] .cm-editor.cm-focused')).toBeVisible()

    // Typing must land exactly where the caret sat: before "arthur" on ITS line.
    await page.keyboard.type('X')
    await expect(vis(page, '[data-testid="raw-editor"] .cm-activeLine')).toContainText(
      'collaborates-with:: [[Xarthur-pemberton]]'
    )
    await app.close()
  })
})
