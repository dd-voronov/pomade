// modules: tabs, terminal
// Pomade T-181 e2e — TabStrip subscription hygiene.
//
// Before T-181, TabStrip subscribed to the ENTIRE `tabsByProject` record, so a `cd` in ANY
// project's terminal — including one the user isn't even looking at — re-rendered the active
// project's tab strip and recomputed its duplicate-open scan. This spec proves the fix with a
// render-count probe (dev/render-counts.ts, bumped once in TabStrip's body, exposed on
// `window.__pomadeRenderCounts`): a real `cd` in a BACKGROUND project's live terminal must not
// move that counter, while a `cd` in the ACTIVE project's own terminal still must (the strip is
// showing that tab; it has to reflect it) — the negative and positive halves of the same
// assertion, so a broken probe (frozen, or one that never counts) cannot pass by accident.

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchApp } from './fixtures/app'
import { writePty, writeWhenReady } from './fixtures/stores'



/** Create a real terminal in `projectId` via the store (works even when the project is hidden —
 *  the T-181 background-project scenario), returning its tab id + termId. */
function newTerminalIn(page: Page, projectId: string): Promise<{ tabId: string; termId: string }> {
  return page.evaluate(async (pid) => {
    const stores = window.__pomadeStores
    const project = stores.useWorkspaceStore.getState().projectById(pid)
    const before = new Set(
      (stores.useTabsStore.getState().tabsByProject[pid] ?? []).map((t) => t.termId)
    )
    await stores.useTerminalsStore.getState().newTerminal(project)
    const tabs = stores.useTabsStore.getState().tabsByProject[pid] ?? []
    const created = tabs.find((t) => t.termId && !before.has(t.termId))
    return { tabId: created?.id as string, termId: created?.termId as string }
  }, projectId)
}

function tabCwd(page: Page, projectId: string, tabId: string): Promise<string> {
  return page.evaluate(
    ({ pid, tid }) => {
      const stores = window.__pomadeStores
      const tab = (stores.useTabsStore.getState().tabsByProject[pid] ?? []).find(
        (t) => t.id === tid
      )
      return tab?.cwd ?? ''
    },
    { pid: projectId, tid: tabId }
  )
}

/** Current bump count of a probed component (dev/render-counts.ts). Absent (never rendered) ⇒ 0. */
function renderCount(page: Page, name: string): Promise<number> {
  return page.evaluate(
    (n) => window.__pomadeRenderCounts?.[n] ?? 0,
    name
  )
}

test.describe('T-181 — TabStrip does not re-render for a background project mutation', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('app-shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  test('cd in a hidden project leaves TabStrip untouched; cd in the active one re-renders it', async () => {
    test.slow()
    const { alpha, beta } = fixture.projects

    // Alpha is the ACTIVE project — its strip is what's on screen.
    await page.getByTestId(`project-${alpha}`).click()
    const alphaTerm = await newTerminalIn(page, alpha)
    // Beta stays HIDDEN throughout — its PaneHost pane is mounted (never unmounted) but
    // display:none, exactly the "hidden, not unmounted" invariant this ticket must not disturb.
    const betaTerm = await newTerminalIn(page, beta)

    await writeWhenReady(page, alphaTerm.termId, '\r') // settle the first prompt
    await writeWhenReady(page, betaTerm.termId, '\r')
    await expect.poll(() => tabCwd(page, alpha, alphaTerm.tabId)).not.toBe('')
    await expect.poll(() => tabCwd(page, beta, betaTerm.tabId)).not.toBe('')

    const baseline = await renderCount(page, 'TabStrip')

    // A real `cd` in BETA's live terminal — a background project. This is exactly the
    // `handleCwd` → `updateTab` path the audit flagged: before T-181 it replaced the top-level
    // `tabsByProject` record and re-rendered every subscriber of the whole map, TabStrip
    // included, even though the active strip (alpha's) shows none of beta's tabs.
    const betaCwdBefore = await tabCwd(page, beta, betaTerm.tabId)
    await writePty(page, betaTerm.termId, 'cd ..\r')
    await expect
      .poll(() => tabCwd(page, beta, betaTerm.tabId), { timeout: 20_000 })
      .not.toBe(betaCwdBefore)

    expect(await renderCount(page, 'TabStrip')).toBe(baseline)

    // Positive control: the SAME mutation, but on ALPHA's own terminal — the tab the strip is
    // actually showing. This one MUST re-render TabStrip (its tab set/identity subscription is
    // still live for its own project), which rules out a probe that is simply frozen or a
    // TabStrip that stopped reacting to anything at all.
    const alphaCwdBefore = await tabCwd(page, alpha, alphaTerm.tabId)
    await writePty(page, alphaTerm.termId, 'cd ..\r')
    await expect
      .poll(() => tabCwd(page, alpha, alphaTerm.tabId), { timeout: 20_000 })
      .not.toBe(alphaCwdBefore)

    await expect.poll(() => renderCount(page, 'TabStrip')).toBeGreaterThan(baseline)
  })
})
