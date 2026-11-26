// Pomade — E-027: open a hosted app in a project. An app already open in that project for the
// same strip icon (or, from the new-tab menu, with none) is focused instead of opening a second
// frame: one tab per (app, icon) per project. `openAppRoute` is the one entry point for opening
// an app at a route — `tabs.openApp`, an app shortcut, and later a notice's click action.
// T-244 — an app tab's title follows its manifest (`startAppTabTitles`) until the user renames it.
// T-268 — keyed tabs (`openKeyedAppTab`): one per (app, key, project), each at its own route, titled
// by the app or by its app tab kind, never matched by a route or an icon.

import { nanoid } from 'nanoid'

import type { AppTab, HostedApp, HostedTabKind, Id, Tab } from '@shared/types'
import { useAppsStore } from '../../stores/apps-store'
import { useTabsStore } from '../../stores/tabs-store'
import { useWorkspaceStore } from '../../stores/workspace-store'

/** Open (or focus) `app`'s tab in `projectId`; `icon` = the strip icon it is opened for, whose
 *  title the tab takes. `route` navigates an open tab whose recorded route differs (T-269: an icon's
 *  tab too, once the app moved it with `tabs.setRoute`); without it — a strip icon click, the
 *  new-tab menu — an open tab is only focused and stays where the app is. */
export function openAppTab(projectId: Id, app: HostedApp, icon?: string, route?: string): void {
  const tabs = useTabsStore.getState()
  const existing = tabs
    .tabsFor(projectId)
    .find((t): t is AppTab => t.kind === 'app' && t.appId === app.id && t.key === undefined && t.icon === icon)
  if (existing) {
    if (route !== undefined && recordedRoute(app, existing) !== route) tabs.updateTab(projectId, existing.id, { route })
    tabs.setActive(projectId, existing.id)
    return
  }
  const title = appTabTitle(app, { icon }) ?? app.name
  const tab: AppTab = {
    id: nanoid(),
    projectId,
    kind: 'app',
    appId: app.id,
    ...(icon !== undefined ? { icon } : {}),
    ...(icon === undefined && route ? { route } : {}),
    title
  }
  tabs.openTab(tab)
}

/** T-269 — the route an icon-less or icon tab renders now: its recorded route, else its icon's
 *  (the icon-less tab's: ""). */
export function recordedRoute(app: HostedApp, tab: Pick<AppTab, 'icon' | 'route'>): string {
  if (tab.route !== undefined) return tab.route
  return tab.icon === undefined ? '' : (app.strip.find((s) => s.id === tab.icon)?.route ?? '')
}

/** The title an app tab takes from the manifest: its strip icon's title; a keyed tab's kind's
 *  title, else the app's name (a kind the manifest dropped included); the app's name for the
 *  icon-less tab. Null when the manifest no longer declares the icon (the tab keeps its title). */
export function appTabTitle(app: HostedApp, tab: Pick<AppTab, 'icon' | 'key' | 'tabKind'>): string | null {
  if (tab.key !== undefined) return tabKindOf(app, tab.tabKind)?.title ?? app.name
  if (tab.icon === undefined) return app.name
  return app.strip.find((s) => s.id === tab.icon)?.title ?? null
}

/** T-268 — the app tab kind `id` names in `app`'s manifest; undefined for none or one it dropped. */
export function tabKindOf(app: HostedApp, id: string | undefined): HostedTabKind | undefined {
  return id !== undefined && Object.prototype.hasOwnProperty.call(app.tabKinds, id) ? app.tabKinds[id] : undefined
}

/** What `tabs.openApp` with `key` opens (T-268). */
export interface KeyedAppTabOpen {
  key: string
  route: string
  /** The app's title for the tab, exactly as given. */
  title?: string
  /** An app tab kind the manifest declares. */
  kind?: string
}

/** T-268 — the keyed tab for (`appId`, `key`) among one project's tabs: a keyed tab is one per
 *  (app, key, project); other tabs of the app (icon-less, icons) never match. */
export function keyedAppTab(projectTabs: readonly Tab[], appId: string, key: string): AppTab | undefined {
  return projectTabs.find((t): t is AppTab => t.kind === 'app' && t.appId === appId && t.key === key)
}

/** T-268 — open or focus `app`'s keyed tab for `open.key` in `projectId`: a new one right of the
 *  active tab at `open.route`, titled `open.title`, else its kind's title, else the app's name; an
 *  open one focused, navigated to `open.route` when it differs (its frame gets `route.changed`) and
 *  retitled to `open.title` unless the user renamed it. */
export function openKeyedAppTab(projectId: Id, app: HostedApp, open: KeyedAppTabOpen): void {
  const tabs = useTabsStore.getState()
  const existing = keyedAppTab(tabs.tabsFor(projectId), app.id, open.key)
  if (existing) {
    const patch: Partial<AppTab> = {}
    if ((existing.route ?? '') !== open.route) patch.route = open.route
    if (open.title !== undefined && !existing.renamed) {
      if (existing.title !== open.title) patch.title = open.title
      if (existing.appTitled !== true) patch.appTitled = true
    }
    if (Object.keys(patch).length > 0) tabs.updateTab(projectId, existing.id, patch)
    tabs.setActive(projectId, existing.id)
    return
  }
  const tab: AppTab = {
    id: nanoid(),
    projectId,
    kind: 'app',
    appId: app.id,
    key: open.key,
    ...(open.kind !== undefined ? { tabKind: open.kind } : {}),
    ...(open.route ? { route: open.route } : {}),
    title: open.title ?? appTabTitle(app, { key: open.key, ...(open.kind !== undefined ? { tabKind: open.kind } : {}) }) ?? app.name,
    ...(open.title !== undefined ? { appTitled: true } : {})
  }
  tabs.openTab(tab)
}

/** T-244 — the retitles that bring app tabs in line with the current manifests: every tab of an
 *  available app the user has not renamed — nor the app titled (T-268) — whose title differs from
 *  `appTabTitle`. */
export function appTabRetitles(
  tabsByProject: Record<Id, readonly Tab[]>,
  apps: readonly HostedApp[]
): { projectId: Id; tabId: Id; title: string }[] {
  const out: { projectId: Id; tabId: Id; title: string }[] = []
  for (const [projectId, tabs] of Object.entries(tabsByProject)) {
    for (const t of tabs) {
      if (t.kind !== 'app' || t.renamed || t.appTitled) continue
      const app = apps.find((a) => a.id === t.appId)
      if (!app || app.unavailable !== null) continue
      const title = appTabTitle(app, t)
      if (title !== null && title !== t.title) out.push({ projectId, tabId: t.id, title })
    }
  }
  return out
}

/** T-244 — keep app tab titles following the manifests: a reinstall (or relink) that renames a
 *  strip icon, or the app, retitles its open tabs in every project — restored ones included.
 *  Returns the unsubscribe. */
export function startAppTabTitles(): () => void {
  const sync = (): void => {
    const tabs = useTabsStore.getState()
    for (const r of appTabRetitles(tabs.tabsByProject, useAppsStore.getState().apps)) {
      tabs.updateTab(r.projectId, r.tabId, { title: r.title })
    }
  }
  sync()
  const offApps = useAppsStore.subscribe((s, prev) => {
    if (s.apps !== prev.apps) sync()
  })
  const offTabs = useTabsStore.subscribe((s, prev) => {
    if (s.tabsByProject !== prev.tabsByProject) sync()
  })
  return () => {
    offApps()
    offTabs()
  }
}

/** The strip icon whose tab already renders `route` (an icon with action `tab` or `both`), if any:
 *  opening the app at that route is opening that icon's tab. */
export function iconForRoute(app: HostedApp, route: string): string | undefined {
  return app.strip.find((s) => s.action !== 'panel' && s.route === route)?.id
}

/** Open or focus `app`'s tab at `route` in `projectId` and bring the user there: with `keyed`, that
 *  keyed tab (T-268); else the matching icon's tab, else the app's one icon-less tab — either
 *  navigated to `route` when its recorded route differs. */
export function openAppRoute(
  app: HostedApp,
  route: string,
  projectId: Id,
  keyed?: Omit<KeyedAppTabOpen, 'route'>
): void {
  if (keyed) openKeyedAppTab(projectId, app, { ...keyed, route })
  else {
    const icon = iconForRoute(app, route)
    openAppTab(projectId, app, icon, route)
  }
  const ws = useWorkspaceStore.getState()
  if (ws.activeProjectId !== projectId) ws.setActiveProject(projectId)
}
