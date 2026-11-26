// Pomade — E-027 apps-store (renderer). The hostable apps (installed + dev-linked) as main's
// app registry reports them; kept live by EV.appsChanged (install / update / remove / link).
// E-029/E-032 — the strip-icon badges apps set with `strip.setBadge` (EV.appsBadge) are marks
// (marks-store) from the source `app:<appId>`.

import { create } from 'zustand'

import type { AppBadge, HostedApp } from '@shared/types'
import { appStripKey } from '../modules/side-panels/strip-model'
import { stripTarget, useMarksStore } from './marks-store'

interface AppsState {
  apps: HostedApp[]
  /** False until the first list arrives — panes hold off on "unavailable" until then. */
  loaded: boolean
  hydrate: () => Promise<void>
  /** Ask main to rescan now (the "Retry" of an unavailable app tab). */
  refresh: () => Promise<void>
}

let subscribed = false
// Bumped by every pushed list, so a slower `list()` reply can never overwrite a newer push.
let pushSeq = 0

/** The apps whose badges go: reloaded (update, relink), unavailable or removed. Each starts
 *  badge-less and sets its badges again once running. */
export function appsWithStaleBadges(prev: HostedApp[], next: HostedApp[]): string[] {
  return prev
    .filter((p) => {
      const now = next.find((a) => a.id === p.id)
      return !now || now.unavailable !== null || now.revision !== p.revision
    })
    .map((p) => p.id)
}

/** The mark source of an app's badges. */
export const appBadgeSource = (appId: string): string => `app:${appId}`

/** Apply one EV.appsBadge: a mark on the icon from the app; count 0 removes it. */
export function applyBadge(b: AppBadge): void {
  useMarksStore
    .getState()
    .setMark(stripTarget(appStripKey(b.appId, b.icon)), appBadgeSource(b.appId), { count: b.count, urgent: b.urgent })
}

function dropStaleBadges(prev: HostedApp[], next: HostedApp[]): void {
  for (const id of appsWithStaleBadges(prev, next)) useMarksStore.getState().clearSource(appBadgeSource(id))
}

export const useAppsStore = create<AppsState>((set, get) => {
  const setApps = (apps: HostedApp[]): void => {
    dropStaleBadges(get().apps, apps)
    set({ apps, loaded: true })
  }
  return {
    apps: [],
    loaded: false,
    hydrate: async () => {
      if (!subscribed) {
        subscribed = true
        window.pomade.apps.onChanged((apps) => {
          pushSeq += 1
          setApps(apps)
        })
        window.pomade.apps.onBadge(applyBadge)
      }
      const seq = pushSeq
      const apps = await window.pomade.apps.list()
      if (seq === pushSeq) setApps(apps)
    },
    refresh: async () => {
      const seq = pushSeq
      const apps = await window.pomade.apps.refresh()
      if (seq === pushSeq) setApps(apps)
    }
  }
})
