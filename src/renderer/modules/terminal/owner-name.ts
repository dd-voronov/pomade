// Pomade — E-034: the name an attached tab shows for the app that owns its session.

import { useAppsStore } from '../../stores/apps-store'

/** The owning app's name ("Runner"), else its id (an app that is not installed here). */
export function useOwnerName(appId: string): string {
  return useAppsStore((s) => s.apps.find((a) => a.id === appId)?.name ?? appId)
}
