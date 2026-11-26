// Pomade e2e — shared interaction helpers for hover-revealed controls.
//
// T-037 — Projects panel/tree rows expose their actions (edit, delete, reveal, copy) only on
// :hover. Playwright's hover() is a ONE-SHOT gesture: it moves the pointer once. Under
// parallel-worker CPU load an async reflow (a project icon image or the workspace config
// loading a beat late) shifts the row out from under the pointer AFTER the hover, so the CSS
// :hover drops and the revealed control reverts to hidden. click()/toBeVisible() then retry
// forever without ever re-hovering, timing out at 30s — which, in the state-chaining
// projects-panel-identity spec, cascades into the whole file failing. These helpers re-hover on each
// attempt until the control is actually actionable, so the gesture survives a late reflow.
// Coverage is unchanged: the control is still hover-gated; we merely make the hover resilient.

import { expect, type Locator, type Page } from '@playwright/test'

const REVEAL_TIMEOUT = 15_000

/** Hover `row` until its hover-only `control` is visible (re-hovering to survive reflow). */
export async function hoverReveal(row: Locator, control: Locator): Promise<void> {
  await expect(async () => {
    await row.hover()
    await expect(control).toBeVisible()
  }).toPass({ timeout: REVEAL_TIMEOUT })
}

/** Hover `row` and click its hover-only `control`, re-hovering until the click lands. Safe for
 *  controls that open a modal/dialog: the click resolves once and the retry loop stops. */
export async function hoverClick(row: Locator, control: Locator): Promise<void> {
  await expect(async () => {
    await row.hover()
    await control.click({ timeout: 2_000 })
  }).toPass({ timeout: REVEAL_TIMEOUT })
}

/** T-228 — a double click the way a real mouse sends it: press + release (click count 1), a pause,
 *  press + release (click count 2) at the same point. Playwright's `dblclick()` fires both presses
 *  back to back, so the page never shows anything between them; here the first click's effect (a
 *  tab opening over the row) is on screen when the second press lands. */
export async function humanDoubleClick(page: Page, target: Locator, pauseMs = 150): Promise<void> {
  const box = await target.boundingBox()
  if (!box) throw new Error('humanDoubleClick: the target has no box')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down({ clickCount: 1 })
  await page.mouse.up({ clickCount: 1 })
  // The pause IS the gesture (a hand's double click), not a wait for app state.
  await new Promise((r) => setTimeout(r, pauseMs))
  await page.mouse.down({ clickCount: 2 })
  await page.mouse.up({ clickCount: 2 })
}
