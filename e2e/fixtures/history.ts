import { expect, type Locator } from '@playwright/test'

/** The element's text shows whole: single-line text clipped by `text-overflow: ellipsis` has a
 *  scroll width wider than its box. */
export async function expectNotTruncated(el: Locator): Promise<void> {
  await expect
    .poll(() => el.evaluate((n) => n.scrollWidth <= n.clientWidth))
    .toBe(true)
}
