// modules: core
// T-245 e2e — a long notice title wraps to two lines, then an ellipsis, in the toast and in the
// Notices panel row (docs/modules/core/notices.md "Notices"); a short title stays on one line
// and nothing in the row overflows sideways. Screenshots land in T245_SHOTS when set.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { expect, test, type ElectronApplication, type Frame, type Locator, type Page } from '@playwright/test'

import { firstAppWindow, launchApp } from './fixtures/app'
import { callIn, connectedFrame, HELLO_DIR } from './fixtures/hello-app'
import { createFixtureWorkspace, type Fixture } from './fixtures/workspace'

const SHOTS = process.env.T245_SHOTS
const SHORT = 'Backup finished'
const LONG =
  '2 due today, 1 overdue, Tax report due in three days, the quarterly filing and the annual summary for the accountant are both waiting for review and a signature'

async function shotOf(el: Locator | Page, name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  await el.screenshot({ path: join(SHOTS, name) })
}

interface TitleShape {
  height: number
  clamp: string
  clipped: boolean
  overflowsSideways: boolean
}

function shapeOf(title: Locator): Promise<TitleShape> {
  return title.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    clamp: getComputedStyle(el).webkitLineClamp,
    clipped: el.scrollHeight > el.clientHeight + 1,
    overflowsSideways: el.scrollWidth > el.clientWidth + 1
  }))
}

test.describe('T-245 long notice titles wrap', () => {
  let fixture: Fixture
  let app: ElectronApplication
  let page: Page
  let panel: Frame

  test.beforeAll(async () => {
    fixture = await createFixtureWorkspace()
    app = await launchApp(fixture, { POMADE_DEV_APPS: HELLO_DIR })
    page = await firstAppWindow(app)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await page.getByTestId(`project-${fixture.projects.alpha}`).click()
    await page.getByTestId('strip-app-hello-panel').click()
    panel = await connectedFrame(page.getByTestId('panel-frame-app-hello-panel'))
  })

  test.afterAll(async () => {
    await app?.close()
    await fixture?.cleanup()
  })

  async function clearToasts(): Promise<void> {
    const dismiss = page.getByTestId('notice-toast-dismiss')
    while ((await dismiss.count()) > 0) await dismiss.first().click()
  }

  test('the toast: a short title is one line; a long one wraps to two lines and is cut with an ellipsis', async () => {
    await callIn(panel, 'notices.post', { title: SHORT })
    const short = page.getByTestId('notice-toast').filter({ hasText: SHORT })
    const oneLine = await shapeOf(short.getByTestId('notice-toast-title'))
    expect(oneLine.clipped).toBe(false)
    await shotOf(short, 'toast-short.png')
    await clearToasts()

    await callIn(panel, 'notices.post', { title: LONG, body: 'Open the planner to review them.' })
    const long = page.getByTestId('notice-toast').filter({ hasText: '2 due today' })
    const title = long.getByTestId('notice-toast-title')
    await expect(title).toBeVisible()
    const two = await shapeOf(title)
    expect(two.clamp).toBe('2')
    expect(two.height).toBeCloseTo(oneLine.height * 2, 0)
    expect(two.clipped).toBe(true)
    expect(two.overflowsSideways).toBe(false)
    await shotOf(long, 'toast-long.png')
    await clearToasts()
  })

  test('the Notices row: the same — two lines, then an ellipsis; the time and the delete cross stay on the source line', async () => {
    await page.getByTestId('strip-notices').click()
    const rows = page.getByTestId('notice-row')
    const short = rows.filter({ hasText: SHORT })
    const long = rows.filter({ hasText: '2 due today' })
    const oneLine = await shapeOf(short.getByTestId('notice-row-title'))
    expect(oneLine.clipped).toBe(false)
    const two = await shapeOf(long.getByTestId('notice-row-title'))
    expect(two.clamp).toBe('2')
    expect(two.height).toBeCloseTo(oneLine.height * 2, 0)
    expect(two.clipped).toBe(true)
    expect(two.overflowsSideways).toBe(false)

    // Hovering shows the delete cross in place of the time, level with the source line.
    await long.hover()
    const cross = page.getByRole('listitem').filter({ has: long }).getByTestId('notice-row-delete')
    await expect(cross).toBeVisible()
    const rowBox = await long.boundingBox()
    const crossBox = await cross.boundingBox()
    expect(crossBox && rowBox).toBeTruthy()
    expect((crossBox?.y ?? 0) - (rowBox?.y ?? 0)).toBeLessThan(12)
    await shotOf(page.getByTestId('notices-panel'), 'panel-rows.png')
  })
})
