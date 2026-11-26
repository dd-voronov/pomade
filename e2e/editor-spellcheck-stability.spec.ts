// modules: editor
// Pomade T-083 round-3 e2e — spellcheck STABILITY invariant.
//
// The Owner reported OS spellcheck squiggles flickering (a typo's red squiggle vanishing when the
// caret leaves the line, reappearing later). Chromium draws native spell markers on the TEXT
// NODES inside each line; those markers are wiped only when the text node itself is replaced or
// its character data rewritten. So the app-level failure mode would be: a decoration that churns
// an UNCHANGED line's DOM on every caret move (e.g. a per-line decoration whose class/attr toggle
// makes CodeMirror rebuild the line's inline DOM, or a MatchDecorator re-decorating the whole
// viewport). Probe investigation (see docs/contracts/renderer.md "Editor invariants") found NO such churn: the
// only per-caret DOM change is the `cm-activeLine` class/style on the line WRAPPER div — the text
// nodes keep their identity, so this test locks that invariant in for both editor engines.
//
// This is a GUARD, not a fix's revert-proof: the reported flicker turned out to be Chromium's own
// asynchronous selection-triggered spell re-check (no DOM churn on our side, unfixable without a
// hack — see docs/contracts/renderer.md "Editor invariants"). If a future decoration ever regresses into rebuilding unchanged
// lines' text nodes on caret move, THIS spec fails before the spellcheck breakage ships.

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
import { setEditorMode, waitCaretRegistered } from './fixtures/stores'
import { expectQuiet } from './fixtures/timing'

const vis = (page: Page, sel: string): ReturnType<Page['locator']> => page.locator(`${sel}:visible`)

// Tag every text node under `containerSel` with a stable expando id and start a MutationObserver
// recording text-node churn (characterData + text-node add/remove). Returns nothing; state lives
// on window.__spellStable.
async function installProbe(page: Page, containerSel: string): Promise<void> {
  await page.evaluate((sel) => {
    const content = [...document.querySelectorAll(sel)].find(
      (el) => (el as HTMLElement).offsetParent !== null
    ) as HTMLElement
    let nextId = 1
    const idOf = (n: Node): string => {
      const e = n as unknown as { __sid?: number }
      if (!e.__sid) e.__sid = nextId++
      return `#${e.__sid}`
    }
    const textChurn: string[] = []
    const isText = (n: Node): boolean => n.nodeType === Node.TEXT_NODE
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'characterData' && isText(m.target)) {
          textChurn.push(`characterData ${idOf(m.target)}="${m.target.nodeValue}"`)
        } else if (m.type === 'childList') {
          for (const rn of m.removedNodes) if (isText(rn)) textChurn.push(`removed ${idOf(rn)}="${rn.nodeValue}"`)
          for (const an of m.addedNodes) if (isText(an)) textChurn.push(`added ${idOf(an)}="${an.nodeValue}"`)
        }
      }
    })
    obs.observe(content, { subtree: true, childList: true, characterData: true })
    const tag = (): void => {
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) idOf(walker.currentNode)
    }
    // Return the expando ids of the text nodes inside the block whose textContent contains `line`.
    const idsFor = (line: string): string[] => {
      const blocks = [...content.querySelectorAll('.cm-line'), ...content.children].filter(
        (b) => (b as HTMLElement).textContent?.includes(line)
      )
      const ids: string[] = []
      for (const b of blocks) {
        const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) ids.push(idOf(walker.currentNode))
      }
      return ids
    }
    window.__spellStable = { tag, textChurn, idsFor }
    tag()
  }, containerSel)
}

async function clickWord(page: Page, containerSel: string, word: string): Promise<void> {
  const pt = await page.evaluate(
    ({ sel, wrd }) => {
      const roots = document.querySelectorAll(sel)
      for (const root of roots) {
        if ((root as HTMLElement).offsetParent === null) continue
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
          const node = walker.currentNode
          const i = node.textContent?.indexOf(wrd) ?? -1
          if (i >= 0) {
            const r = document.createRange()
            r.setStart(node, i)
            r.setEnd(node, i + wrd.length)
            const b = r.getBoundingClientRect()
            return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
          }
        }
      }
      throw new Error(`word "${wrd}" not found under ${sel}`)
    },
    { sel: containerSel, wrd: word }
  )
  await page.mouse.click(pt.x, pt.y)
}

test.describe('spellcheck stability (line text nodes survive caret movement)', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    // Real-vault-shaped content: inline markup + a wikilink, so the wikilink/pairs/swatch
    // decorators are all exercised — none of them may churn an unchanged line on caret move.
    await fs.writeFile(
      join(fixture.workspaceRoot, 'Projects/alpha/stable.md'),
      '# Stability\n\n' +
        'The quick [[wikilink]] and **bold** wrold here.\n\n' +
        'A second paragraph with more prose and a mistaek in it.\n\n' +
        'A third line rounds the fixture out nicely.\n'
    )
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId('project-proj-alpha').click()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('raw mode: an inactive line keeps its text node identity when the caret moves away', async () => {
    await page.getByTestId('tree-node-Projects/alpha/stable.md').click()
    await setEditorMode(page, 'raw')
    const sel = '[data-testid="raw-editor"] .cm-content'
    await expect(vis(page, sel)).toHaveAttribute('spellcheck', 'true')

    await installProbe(page, sel)

    // Focus the line carrying the first typo ("wrold"); it becomes the active line.
    await clickWord(page, sel, 'wrold')
    await waitCaretRegistered(page)

    // Record the identity of THIS line's text nodes, then reset the churn log.
    const before = await page.evaluate(() => {
      const ids = window.__spellStable.idsFor('wrold')
      window.__spellStable.textChurn.length = 0
      return ids
    })
    expect(before.length).toBeGreaterThan(0)

    // Move the caret away by every means a user has: click another line, arrow keys, and Enter
    // (a doc change on a DIFFERENT line). None may touch the typo line's text nodes.
    await clickWord(page, sel, 'mistaek')
    await waitCaretRegistered(page)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowUp')
    await waitCaretRegistered(page)
    // Enter at the end of the LAST line — a doc change well away from the typo line.
    await clickWord(page, sel, 'nicely')
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('tail')

    // Held while the moves' decoration updates land (an empirical window, not a tuned interval).
    await expectQuiet(async () => {
      const { after, churn } = await page.evaluate(() => {
        return { after: window.__spellStable.idsFor('wrold'), churn: [...window.__spellStable.textChurn] }
      })
      // Same text-node objects (expando ids preserved) → Chromium's spell markers on that line
      // were never wiped by our decorations.
      expect(after).toEqual(before)
      // And no text-node churn (characterData / add / remove) anywhere touched the typo word.
      const touchedTypoLine = churn.filter((c) => c.includes('wrold') || before.some((id) => c.includes(`${id}=`)))
      expect(touchedTypoLine).toEqual([])
    }, 200)
  })

  test('rendered mode: an inactive paragraph keeps its text node identity when the caret moves away', async () => {
    await page.getByTestId('tree-node-Projects/alpha/stable.md').click()
    // E-024: a fresh tree open (or a raw→rich toggle) lands in the LIVE view under the Keep
    // default — this test is about the MILKDOWN engine's node identity, so route this doc
    // to Rendered explicitly via the ⋯ per-doc rich-view override.
    await setEditorMode(page, 'rendered')
    const sel = '[data-testid="editor-pane"] .ProseMirror'
    await expect(vis(page, sel)).toBeVisible()
    // Milkdown has finished mounting: the pane's editor controller is live (so the probe below
    // observes the final ProseMirror element, not one about to be replaced).
    await expect.poll(() => page.evaluate(() => window.__pomadeEditorSelectionFrom?.() ?? -1)).toBeGreaterThanOrEqual(0)

    await installProbe(page, sel)

    await clickWord(page, sel, 'wrold')
    await waitCaretRegistered(page)
    const before = await page.evaluate(() => {
      const ids = window.__spellStable.idsFor('wrold')
      window.__spellStable.textChurn.length = 0
      return ids
    })
    expect(before.length).toBeGreaterThan(0)

    await clickWord(page, sel, 'mistaek')
    await waitCaretRegistered(page)
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowDown')

    // Held while the moves' decoration updates land (an empirical window, not a tuned interval).
    await expectQuiet(async () => {
      const { after, churn } = await page.evaluate(() => {
        return { after: window.__spellStable.idsFor('wrold'), churn: [...window.__spellStable.textChurn] }
      })
      expect(after).toEqual(before)
      const touchedTypoPara = churn.filter((c) => c.includes('wrold') || before.some((id) => c.includes(`${id}=`)))
      expect(touchedTypoPara).toEqual([])
    }, 200)
  })
})
