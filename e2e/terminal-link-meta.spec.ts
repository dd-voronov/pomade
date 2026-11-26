// modules: terminal, editor, filetree
// Pomade E-020 e2e — T-092: Cmd toggles the link DECORATIONS on a stationary pointer.
//
// The regression this file locks down (it was shipped, and it never healed): the link provider
// used to return `callback(undefined)` unless Cmd was held. xterm caches ONE provider reply per
// active line, and its `Linkifier._handleMouseMove` early-returns whenever the position equals the
// last buffer cell — so the "nudge" (a synthetic mousemove dispatched on Meta keydown) could never
// make it re-query. Net effect: a row hovered WITHOUT Cmd was link-dead until the pointer changed
// row, and pressing Cmd while parked on a path never underlined it. Users learned to wiggle the
// mouse. T-092 always provides the links and flips their `decorations` in place instead.
//
// The assertions are on the RENDERED underline, not on internal state: xterm's DOM renderer paints
// a link underline as an inline `text-decoration: underline` on the covered spans
// (`DomRenderer._handleLinkHover` → `_setCellUnderline` → the row factory), which is exactly the
// affordance the user is waiting for.
//
// Own spec file (worker = spec file) so nothing here depends on the state chain in
// `terminal-links.spec.ts`.

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
import { expectQuiet } from './fixtures/timing'
import { writeWhenReady } from './fixtures/stores'

let fixture: Fixture
let app: ElectronApplication
let page: Page

/** Printed then hovered without Cmd — the poisoned-row + parked-pointer scenario. */
const META_DOC = 'Projects/alpha/meta-target.md'
/** Printed then clicked with NO modifier — a plain click must never navigate. */
const PLAIN_DOC = 'Projects/alpha/plain-click-target.md'

async function write(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content, 'utf8')
}

async function seedFixture(f: Fixture): Promise<void> {
  await write(join(f.workspaceRoot, META_DOC), '# Meta target\n\nUnderlined the moment Cmd goes down.\n')
  await write(join(f.workspaceRoot, PLAIN_DOC), '# Plain click target\n\nMust never open without Cmd.\n')
}

function readBuffer(termId: string): Promise<string> {
  return page.evaluate((tid) => window.pomade.pty.buffer(tid), termId)
}

function writePty(termId: string, data: string): Promise<void> {
  return page.evaluate(({ tid, d }) => window.pomade.pty.write(tid, d), { tid: termId, d: data })
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

/** A ready terminal in the Alpha project (fresh per test — a failed worker restarts). */
async function alphaTerminal(): Promise<string> {
  await page.getByTestId(`project-${fixture.projects.alpha}`).click()
  const termId = await openTerminal()
  await writeWhenReady(page, termId, "printf 'ALPHA_TERM_READY\\n'\r")
  await expect.poll(() => readBuffer(termId), { timeout: 10_000 }).toContain('ALPHA_TERM_READY')
  return termId
}

/** What the pane actually SHOWS — the xterm rows in the DOM (render can lag the pty buffer). */
function rowsText(termId: string): Promise<string> {
  return page.evaluate((tid) => {
    const rows = document.querySelectorAll(`[data-term-id="${tid}"] .xterm-rows > div`)
    return Array.from(rows)
      .map((r) => r.textContent ?? '')
      .join('\n')
  }, termId)
}

/** Pixel centre of one rendered character, located via a DOM Range (prompt-agnostic). */
async function charPoint(termId: string, marker: string, offsetInMarker: number): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(
    ({ tid, mk, off }) => {
      const rows = document.querySelectorAll(`[data-term-id="${tid}"] .xterm-rows > div`)
      for (const row of Array.from(rows)) {
        const idx = (row.textContent ?? '').indexOf(mk)
        if (idx < 0) continue
        let remaining = idx + off
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node) {
          const len = node.textContent?.length ?? 0
          if (remaining < len) {
            const range = document.createRange()
            range.setStart(node, remaining)
            range.setEnd(node, remaining + 1)
            const r = range.getBoundingClientRect()
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
          }
          remaining -= len
          node = walker.nextNode()
        }
      }
      return null
    },
    { tid: termId, mk: marker, off: offsetInMarker }
  )
  if (!point) throw new Error(`no rendered character for marker "${marker}" +${offsetInMarker}`)
  return point
}

/**
 * Everything xterm is currently painting as a LINK underline in this terminal, concatenated.
 * The DOM renderer expresses it as an inline style on the covered spans; SGR-underlined text
 * (which this fixture never emits) would instead carry an `xterm-underline-*` class.
 */
function underlinedText(termId: string): Promise<string> {
  return page.evaluate((tid) => {
    const spans = document.querySelectorAll(`[data-term-id="${tid}"] .xterm-rows span`)
    return Array.from(spans)
      .filter((s) => (s as HTMLElement).style.textDecoration.includes('underline'))
      .map((s) => s.textContent ?? '')
      .join('')
  }, termId)
}

interface TabSnapshot {
  id: string
  kind: string
  path?: string
}

function tabsOf(projectId: string): Promise<TabSnapshot[]> {
  return page.evaluate((pid) => {
    const tabs = window.__pomadeStores.useTabsStore.getState().tabsByProject[pid] ?? []
    return tabs.map((t) => ({ id: t.id, kind: t.kind, path: t.path }))
  }, projectId)
}

/** Paths handed to Finder by the routing matrix (recorded, not revealed, under NODE_ENV=test). */
function revealed(): Promise<string[]> {
  return app.evaluate(() => (globalThis.__pomadeRevealedPaths ?? []) as string[])
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  // Seed BEFORE launch: the basename index is built lazily on first use.
  await seedFixture(fixture)
  app = await launchApp(fixture)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test.describe('terminal links: Cmd toggles decorations (T-092)', () => {
  test('a row hovered WITHOUT Cmd underlines the instant Cmd goes down, pointer stationary', async () => {
    const alphaTerm = await alphaTerminal()
    // The `META_LINK ` prefix keeps the marker off the ECHOED command line (which contains
    // `META_LINK %s\n`, never `META_LINK Projects/...`), so the hover lands on real OUTPUT.
    await writePty(alphaTerm, `printf 'META_LINK %s\\n' ${META_DOC}\r`)
    await expect.poll(() => readBuffer(alphaTerm), { timeout: 10_000 }).toContain(`META_LINK ${META_DOC}`)
    await expect.poll(() => rowsText(alphaTerm), { timeout: 10_000 }).toContain(`META_LINK ${META_DOC}`)

    const point = await charPoint(alphaTerm, `META_LINK ${META_DOC}`, 'META_LINK '.length + 3)

    // 1. Hover with NO modifier. Pre-fix this POISONED the row: xterm cached the `undefined`
    //    reply for this line and would not ask again until the pointer changed row.
    await page.mouse.move(point.x, point.y)
    // Real-world window (async provider reply, not interval-derived): the reply must be cached
    // BEFORE Cmd goes down (step 2 flips the reply on file — a late reply would pass trivially),
    // and no underline may show while it lands. Held throughout, not slept through.
    await expectQuiet(async () => {
      expect(await underlinedText(alphaTerm)).toBe('')
    }, 600)

    // 2. Press Cmd and DO NOT MOVE THE MOUSE. The underline must appear anyway — xterm cannot be
    //    made to re-query here, so the fix flips the decorations on the reply already on file.
    await page.keyboard.down('Meta')
    await expect
      .poll(() => underlinedText(alphaTerm), { timeout: 5_000 })
      .toContain('meta-target.md')

    // 3. Still without moving: Cmd+click opens the doc.
    await page.mouse.click(point.x, point.y)
    await page.keyboard.up('Meta')
    await expect
      .poll(() => tabsOf(fixture.projects.alpha).then((t) => t.some((x) => x.path === META_DOC)), {
        timeout: 10_000
      })
      .toBe(true)
    await expect(page.locator('[data-testid="editor-pane"]:visible [data-testid="editor-title"]')).toHaveText(
      'meta-target.md'
    )

    // 4. Releasing Cmd takes the underline away again (same live setters, other direction).
    await expect.poll(() => underlinedText(alphaTerm), { timeout: 5_000 }).toBe('')
  })

  test('a plain click on a live link never activates it', async () => {
    const alphaTerm = await alphaTerminal()
    await writePty(alphaTerm, `printf 'PLAIN_LINK %s\\n' ${PLAIN_DOC}\r`)
    await expect.poll(() => readBuffer(alphaTerm), { timeout: 10_000 }).toContain(`PLAIN_LINK ${PLAIN_DOC}`)
    await expect.poll(() => rowsText(alphaTerm), { timeout: 10_000 }).toContain(`PLAIN_LINK ${PLAIN_DOC}`)

    const point = await charPoint(alphaTerm, `PLAIN_LINK ${PLAIN_DOC}`, 'PLAIN_LINK '.length + 3)
    await page.mouse.move(point.x, point.y)
    // Real-world window (async provider reply, not interval-derived) — no Cmd, so nothing may
    // underline while the reply lands. Held throughout, not slept through.
    await expectQuiet(async () => {
      expect(await underlinedText(alphaTerm)).toBe('')
    }, 600)

    // Prove the link really IS live under the pointer (otherwise this test would pass for the
    // trivial reason that there was nothing to activate): Cmd shows it, releasing Cmd hides it.
    await page.keyboard.down('Meta')
    await expect
      .poll(() => underlinedText(alphaTerm), { timeout: 5_000 })
      .toContain('plain-click-target.md')
    await page.keyboard.up('Meta')
    await expect.poll(() => underlinedText(alphaTerm), { timeout: 5_000 }).toBe('')

    // The click. xterm DOES call `activate` on any mouseup over the current link — the metaKey
    // re-check inside it is what keeps a plain click a pure selection gesture (locked decision).
    const tabsBefore = (await tabsOf(fixture.projects.alpha)).length
    const revealedBefore = (await revealed()).length
    await page.mouse.click(point.x, point.y)
    // Real-world window (activation routing latency, not interval-derived) — the plain click may
    // open nothing and reveal nothing, held throughout.
    await expectQuiet(async () => {
      expect((await tabsOf(fixture.projects.alpha)).some((t) => t.path === PLAIN_DOC)).toBe(false)
      expect(await tabsOf(fixture.projects.alpha)).toHaveLength(tabsBefore)
      expect(await revealed()).toHaveLength(revealedBefore)
    }, 700)
  })
})
