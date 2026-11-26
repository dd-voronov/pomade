// Pomade — E-029 side panels: the strip's pure model. Which icons the strip shows, which panel
// a project's stored selection resolves to, and what a click does. No React, no stores — the
// component layer (IconStrip, SidePanel) wires these to state.

import type { StripAction } from 'pomade-kit/protocol'
import type { HostedApp } from '@shared/types'

/** The Files panel's strip key — the default selection. */
export const FILES_PANEL = 'files'

/** One icon in the strip. Built-in panels (Files, later Git) come first, then each available
 *  app's icons in manifest order. */
export type StripEntry =
  | { kind: 'builtin'; key: string; title: string; action: 'panel' }
  | { kind: 'app'; key: string; title: string; action: StripAction; appId: string; icon: string }

/** The key of an app strip icon (also the badge key). */
export function appStripKey(appId: string, icon: string): string {
  return `app:${appId}/${icon}`
}

export function buildStrip(
  builtins: readonly { key: string; title: string }[],
  apps: readonly HostedApp[]
): StripEntry[] {
  const out: StripEntry[] = builtins.map((b) => ({ kind: 'builtin', key: b.key, title: b.title, action: 'panel' }))
  for (const app of apps) {
    if (app.unavailable) continue
    for (const s of app.strip) {
      out.push({
        kind: 'app',
        key: appStripKey(app.id, s.id),
        title: s.title,
        action: s.action,
        appId: app.id,
        icon: s.id
      })
    }
  }
  return out
}

/** The panel a project shows: its stored selection while that icon exists and fills the panel,
 *  else Files. The stored value is left alone, so an app that is briefly unavailable (a dev
 *  server restarting) gets its panel back when it returns. */
export function resolvePanel(stored: string | undefined, strip: readonly StripEntry[]): string {
  const e = stored === undefined ? undefined : strip.find((x) => x.key === stored)
  return e && e.action !== 'tab' ? e.key : FILES_PANEL
}

export interface ClickOutcome {
  /** Make this icon the project's panel. */
  select: boolean
  /** Open or focus the icon's tab. */
  openTab: boolean
  /** Expand a collapsed column. */
  expand: boolean
}

/** What clicking `entry` does. A panel icon shows its panel — expanding a collapsed column; a tab
 *  icon only opens (or focuses) its tab and leaves the column as it is; `both` does the two. */
export function clickOutcome(entry: StripEntry, collapsed: boolean): ClickOutcome {
  const panel = entry.action !== 'tab'
  return { select: panel, openTab: entry.action !== 'panel', expand: panel && collapsed }
}

/** The strip keys of the panels that load at launch: each available app's `launchPanel`. */
export function launchPanelKeys(apps: readonly HostedApp[]): string[] {
  return apps.filter((a) => !a.unavailable && a.launchPanel !== null).map((a) => appStripKey(a.id, a.launchPanel!))
}
