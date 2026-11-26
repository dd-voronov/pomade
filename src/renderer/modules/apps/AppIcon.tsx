// Pomade — E-027: an app's icon (tab strip, new-tab menu, E-029 icon strip). A strip icon's own
// image, else the manifest's `icon`, else a generic app glyph — so a missing or broken icon never
// leaves an empty slot. T-244 — a one-colour SVG (`iconTint`) is drawn as a CSS mask filled with
// `currentColor`, so it takes its button's colour — hover, selected, theme — exactly like a
// built-in glyph; any other image is shown as it is. T-268 — a keyed tab of an app tab kind shows
// the kind's image (else the app's icon), like a strip icon's tab.

import { useState } from 'react'

import { useShallow } from 'zustand/react/shallow'

import { useAppsStore } from '../../stores/apps-store'
import { tabKindOf } from './open-app'
import styles from './AppPane.module.css'

/** Four rounded tiles — the fallback app glyph, same 16px stroke language as the tab icons. */
export function AppGlyph(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.1">
        <rect x="2.4" y="2.4" width="4.6" height="4.6" rx="1.2" />
        <rect x="9" y="2.4" width="4.6" height="4.6" rx="1.2" />
        <rect x="2.4" y="9" width="4.6" height="4.6" rx="1.2" />
        <rect x="9" y="9" width="4.6" height="4.6" rx="1.2" />
      </g>
    </svg>
  )
}

/** A CSS `url()` for `href` (a quoted string, so any path character is safe). */
function cssUrl(href: string): string {
  return `url(${JSON.stringify(href)})`
}

export function AppIcon({ appId, icon, tabKind }: { appId: string; icon?: string; tabKind?: string }): React.JSX.Element {
  const { iconUrl, iconTint } = useAppsStore(
    useShallow((s) => {
      const app = s.apps.find((a) => a.id === appId)
      const stripIcon = icon === undefined ? undefined : app?.strip.find((x) => x.id === icon)
      const kind = app ? tabKindOf(app, tabKind) : undefined
      const own = stripIcon?.iconUrl ? stripIcon : kind?.iconUrl ? kind : app?.iconUrl ? app : null
      return { iconUrl: own?.iconUrl ?? null, iconTint: own?.iconTint ?? false }
    })
  )
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  if (!iconUrl || failedUrl === iconUrl) return <AppGlyph />
  if (iconTint) {
    const mask = cssUrl(iconUrl)
    return (
      <span
        className={`${styles.icon} ${styles.tinted}`}
        style={{ maskImage: mask, WebkitMaskImage: mask }}
        aria-hidden="true"
        data-app-icon=""
        data-icon-url={iconUrl}
        data-testid={`app-icon-${appId}`}
      />
    )
  }
  return (
    <img
      className={styles.icon}
      src={iconUrl}
      alt=""
      draggable={false}
      data-app-icon=""
      data-testid={`app-icon-${appId}`}
      onError={() => setFailedUrl(iconUrl)}
    />
  )
}
