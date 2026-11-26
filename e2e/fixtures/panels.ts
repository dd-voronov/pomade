// Pomade e2e — the side-panel strip, driven from a spec.

import { expect, type Page } from '@playwright/test'

/** Show the Git side panel of the active project: select it from the icon strip unless it is already
 *  showing (a collapsed panel counts as not showing), then wait until it is. */
export async function showGitPanel(page: Page): Promise<void> {
  const panel = page.getByTestId('side-panel-git')
  if (!(await panel.isVisible())) await page.getByTestId('strip-git').click()
  await expect(panel).toBeVisible()
}
