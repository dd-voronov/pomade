// Pomade — T-325: the route each app panel frame is at, by strip key, once the app named one with
// `panel.show` (docs/HOST-API.md §4 `panel`). An app panel without an entry is at its icon's
// `panelRoute` (else `route`), as main resolves it. There is one panel frame per icon, not one per
// project, so the route is per icon. Kept for the run: after a restart a panel opens at its icon's
// route again.

import { create } from 'zustand'

interface AppPanelRoutesState {
  /** Strip key (`app:<appId>/<icon>`) → the route its panel frame is at. */
  routes: Record<string, string>
  setRoute: (key: string, route: string) => void
}

export const useAppPanelRoutes = create<AppPanelRoutesState>((set, get) => ({
  routes: {},
  setRoute: (key, route) => {
    if (get().routes[key] === route) return
    set((s) => ({ routes: { ...s.routes, [key]: route } }))
  }
}))
