// Pomade — T-246: Pomade's theme, the one source apps are told about (docs/HOST-API.md §3
// `welcome.theme`, §4 `theme.changed`). Pomade has its light theme only (`src/renderer/tokens.css`),
// so the theme is "light"; a theme setting would drive `setPomadeTheme`. Every app frame's welcome
// carries the theme, and each change reaches every frame (and every socket client that
// subscribed) as `theme.changed`.

import type { Theme } from 'pomade-kit/protocol'

import { publishPlatformEvent } from './event-bus'

let current: Theme = 'light'

/** Pomade's theme now. */
export function pomadeTheme(): Theme {
  return current
}

/** Change Pomade's theme; `theme.changed` goes out when it changes. */
export function setPomadeTheme(theme: Theme): void {
  if (theme === current) return
  current = theme
  publishPlatformEvent('theme.changed', { theme })
}

/** Testing hook (NODE_ENV=test only, docs/contracts/test-hooks.md): `globalThis.__pomadeTheme`
 *  sets the theme source as a theme setting would, so a spec can watch app frames follow it. */
export function registerThemeTestHook(): void {
  if (process.env.NODE_ENV !== 'test') return
  ;(globalThis as { __pomadeTheme?: { set(theme: Theme): void; get(): Theme } }).__pomadeTheme = {
    set: setPomadeTheme,
    get: pomadeTheme
  }
}
