// modules: terminal, editor
// Pomade E-020 e2e — a `:line` suffix survives the AMBIGUITY PICKER leg (T-086).
//
// The unique-match jump was already proven (terminal-link-line-range.spec.ts); this pins the
// PICKED-match jump: an ambiguous bare filename with a `:N-M` range must open the chosen match at
// line N, not at the top. (Origin: a live report of `TerminalPane.tsx:132-134` opening at line 1 —
// reproduced only against a stale HMR mix, green on a fresh build; kept as the missing coverage.)

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
import { writeWhenReady } from './fixtures/stores'

let fixture: Fixture
let app: ElectronApplication
let page: Page

// TWO files with the SAME basename in different dirs → findByName is ambiguous → picker.
const DUP_A = 'Projects/alpha/src/dupfile.ts'
const DUP_B = 'Projects/beta/lib/dupfile.ts'

function fileLines(): string[] {
  const out: string[] = []
  for (let i = 1; i <= 140; i++) out.push(`line ${String(i).padStart(3, '0')} marker${i}`)
  return out
}

async function write(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content, 'utf8')
}

async function seed(f: Fixture): Promise<void> {
  await write(join(f.workspaceRoot, DUP_A), fileLines().join('\n') + '\n')
  await write(join(f.workspaceRoot, DUP_B), fileLines().join('\n') + '\n')
}

function readBuffer(termId: string): Promise<string> {
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
  await page.getByTestId(`project-${fixture.projects.alpha}`).click()
  const termId = await openTerminal()
  await writeWhenReady(page, termId, "printf 'ALPHA_TERM_READY\\n'\r")
  await expect.poll(() => readBuffer(termId), { timeout: 10_000 }).toContain('ALPHA_TERM_READY')
  return termId
}

/** Activate TOKEN exactly as a Cmd+click would (the provider's own scan+resolve+route). */
function activateLink(termId: string, token: string): Promise<void> {
  return page.evaluate(
    ({ tid, tk }) => window.__pomadeTermLinks[tid](tk),
    { tid: termId, tk: token }
  )
}

test.beforeAll(async () => {
  fixture = await createFixtureWorkspace()
  await seed(fixture)
  app = await launchApp(fixture)
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByTestId('app-shell')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  await fixture?.cleanup()
})

test('an ambiguous `name.ts:132-134` opens the PICKED match at line 132', async () => {
  const term = await alphaTerminal()
  await activateLink(term, 'dupfile.ts:132-134')

  const picker = page.getByTestId('terminal-link-picker')
  await expect(picker).toBeVisible({ timeout: 10_000 })
  await expect(picker.locator('[data-testid^="terminal-link-candidate-"]')).toHaveCount(2)
  await picker.locator(`[data-path="${DUP_A}"]`).click()

  const pane = page.locator('[data-testid="editor-pane"]:visible')
  await expect(pane).toBeVisible({ timeout: 10_000 })
  await expect(pane).toHaveAttribute('data-mode', 'raw')
  await expect(pane.locator('.cm-lineNumbers .cm-activeLineGutter')).toHaveText('132', { timeout: 10_000 })
  const scrollTop = await pane.locator('.cm-scroller').evaluate((el) => el.scrollTop)
  expect(scrollTop).toBeGreaterThan(0)
})

test('re-activating a link to an ALREADY-OPEN doc jumps again (`:7`, picked from the picker)', async () => {
  // Chains on the test above: dupfile.ts (DUP_A) is open and active at line 132. A second link
  // to the same file with a different line must re-jump the existing tab, not sit at the old spot.
  const term = await alphaTerminal()
  await activateLink(term, 'dupfile.ts:7')
  const picker = page.getByTestId('terminal-link-picker')
  await expect(picker).toBeVisible({ timeout: 10_000 })
  await picker.locator(`[data-path="${DUP_A}"]`).click()

  const pane = page.locator('[data-testid="editor-pane"]:visible')
  await expect(pane).toBeVisible({ timeout: 10_000 })
  await expect(pane.locator('.cm-lineNumbers .cm-activeLineGutter')).toHaveText('7', { timeout: 10_000 })
})
