// Pomade — the stored layout (`layout` in AppSettings). The Projects panel's keys were once stored
// as `sidebarWidth` / `sidebarCollapsed`; a stored layout that still holds them goes through
// `upgradeLayout`, so a saved width and collapsed state survive and only the current keys are
// written.

import type { LayoutSettings } from '@shared/types'

const RENAMED = [
  ['sidebarWidth', 'projectsPanelWidth'],
  ['sidebarCollapsed', 'projectsPanelCollapsed']
] as const satisfies ReadonlyArray<readonly [string, keyof LayoutSettings]>

/** The stored layout under the current keys: an old key's value moves to its new key unless the
 *  new key is already set; old keys never come back out. */
export function upgradeLayout(stored: object | undefined): Partial<LayoutSettings> {
  if (!stored) return {}
  const out: Record<string, unknown> = { ...stored }
  for (const [from, to] of RENAMED) {
    if (from in out) {
      if (!(to in out)) out[to] = out[from]
      delete out[from]
    }
  }
  return out as Partial<LayoutSettings>
}
