// modules: core, editor
// Pomade T-138 e2e — stable scrollbar gutter. DOM-probe only (no terminal/agent), so this file
// runs in the LIGHT pass; the zsh-bound layout suite (E-007) lives in layout.spec.ts (heavy).

import {
  test,
  expect,
  type ElectronApplication,
  type Page
} from '@playwright/test'

import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'
import { launchAppPage } from './fixtures/app'

interface Launched {
  app: ElectronApplication
  page: Page
}

async function launch(fixture: Fixture): Promise<Launched> {
  const { app, page } = await launchAppPage(fixture)
  await expect(page.getByTestId('app-shell')).toBeVisible()
  // Wait for app-settings hydration so layout reflects persisted values, not defaults.
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__pomadeStores.useAppSettingsStore.getState().hydrated
      )
    )
    .toBe(true)
  return { app, page }
}

// ─── T-138 — stable scrollbar gutter: a vertical scrollbar never reflows a scroll container ──
// When a scroll container crosses its fill threshold the vertical scrollbar appears/disappears.
// With the app's CUSTOM ::-webkit-scrollbar styling (global.css, width:10px) the bar is a
// classic, space-occupying scrollbar in BOTH macOS scrollbar modes ("Always" and "When
// scrolling"), so its appearance used to narrow the content box and shift every row/icon left
// by the bar width — most visibly the file-tree top-strip icons. `scrollbar-gutter: stable`
// reserves that gutter permanently, so the content-box width (and any right-aligned child) is
// identical whether the bar is present or absent. These specs assert exactly that invariant,
// independent of window size / item count: bar-absent is forced by making the container tall
// enough for its content to fit; bar-present by appending a tall spacer.
interface GutterProbe {
  found: boolean
  refFound: boolean
  gutter: string
  absentCw: number
  presentCw: number
  absentRight: number
  presentRight: number
  presentOverflowed: boolean
}

function probeGutter(page: Page, sel: string, refSel: string | null): Promise<GutterProbe> {
  return page.evaluate(
    ({ sel, refSel }) => {
      const empty: GutterProbe = {
        found: false,
        refFound: false,
        gutter: '',
        absentCw: 0,
        presentCw: 0,
        absentRight: 0,
        presentRight: 0,
        presentOverflowed: false
      }
      const el = document.querySelector(sel) as HTMLElement | null
      if (!el) return empty
      const ref = refSel ? (document.querySelector(refSel) as HTMLElement | null) : el
      const gutter = getComputedStyle(el).scrollbarGutter
      const prevHeight = el.style.height

      // Bar ABSENT: make the box tall enough that its content certainly fits (no vertical bar).
      el.style.height = '20000px'
      void el.offsetHeight
      const absentCw = el.clientWidth
      const absentRight = ref ? ref.getBoundingClientRect().right : 0

      // Bar PRESENT: restore height and force overflow with a tall spacer.
      el.style.height = prevHeight
      const spacer = document.createElement('div')
      spacer.style.cssText = 'height:20000px;flex:0 0 auto;pointer-events:none'
      el.appendChild(spacer)
      void el.offsetHeight
      const presentOverflowed = el.scrollHeight > el.clientHeight
      const presentCw = el.clientWidth
      const presentRight = ref ? ref.getBoundingClientRect().right : 0

      spacer.remove()
      el.style.height = prevHeight
      return {
        found: true,
        refFound: !!ref,
        gutter,
        absentCw,
        presentCw,
        absentRight,
        presentRight,
        presentOverflowed
      }
    },
    { sel, refSel }
  )
}

test.describe('T-138 — stable scrollbar gutter (no horizontal shift on scrollbar toggle)', () => {
  let fixture: Fixture

  test.beforeEach(async () => {
    fixture = await createFixtureWorkspace()
  })

  test.afterEach(async () => {
    await fixture?.cleanup()
  })

  test('file tree — content box and top-strip icons never shift when the scrollbar toggles', async () => {
    const { app, page } = await launch(fixture)
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()

    const tree = page.locator('aside[aria-label="Files"]')
    await expect(tree).toBeVisible()
    // The right-aligned header action (collapse button) is the "top-strip icon" that reflowed.
    await expect(page.getByTestId('filetree-collapse')).toBeVisible()

    const p = await probeGutter(page, 'aside[aria-label="Files"]', '[data-testid="filetree-collapse"]')
    expect(p.found).toBe(true)
    expect(p.gutter).toBe('stable') // the fix is present on the real scroll container
    expect(p.presentOverflowed).toBe(true) // the spacer genuinely forced a scrollbar
    // Content-box width identical with vs without the bar ⇒ no horizontal reflow.
    expect(p.presentCw).toBe(p.absentCw)
    // The right-aligned top-strip icon does not move when the bar appears.
    expect(Math.abs(p.presentRight - p.absentRight)).toBeLessThan(0.5)

    await app.close()
  })

  test('Projects panel — content box width is invariant to the scrollbar', async () => {
    const { app, page } = await launch(fixture)

    const scroll = page.getByTestId('projects-panel-scroll')
    await expect(scroll).toBeVisible()

    const p = await probeGutter(page, '[data-testid="projects-panel-scroll"]', null)
    expect(p.found).toBe(true)
    expect(p.gutter).toBe('stable')
    expect(p.presentOverflowed).toBe(true)
    expect(p.presentCw).toBe(p.absentCw)

    await app.close()
  })

  test('editor — the rendered-document scroll area does not reflow when the scrollbar toggles', async () => {
    const { app, page } = await launch(fixture)
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()

    // Open a markdown doc so the shared properties+body scroll area (.mdScroll) mounts.
    await page.getByTestId('tree-node-Projects/alpha/README.md').click()
    await expect(page.getByTestId('editor-pane')).toBeVisible()
    const mdScroll = page.locator('[data-testid="md-scroll"], [data-testid="live-scroll"]').first()
    await expect(mdScroll).toBeVisible()

    const p = await probeGutter(
      page,
      '[data-testid="md-scroll"], [data-testid="live-scroll"]',
      null
    )
    expect(p.found).toBe(true)
    expect(p.gutter).toBe('stable')
    expect(p.presentOverflowed).toBe(true)
    expect(p.presentCw).toBe(p.absentCw)

    await app.close()
  })
})
