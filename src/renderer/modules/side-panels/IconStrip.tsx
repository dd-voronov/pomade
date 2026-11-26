// Pomade — E-029: the icon strip, the always-visible column of strip icons between the Projects
// panel and the side panel. It holds the built-in panels (Files, Git, Notices) and every
// available app's manifest `strip` icons. A click fills the side panel, opens (or focuses) a tab,
// or both (`clickOutcome`); the main-area tab strip is never touched by an icon otherwise. While
// the side panel is collapsed the strip also carries its expand button.

import type { AppBackendStatus } from '@shared/types'
import { Tooltip } from '../../components/Tooltip'
import { useStripMark, type Mark } from '../../stores/marks-store'
import { AppIcon } from '../apps/AppIcon'
import { backendLines, backendNeedsAttention } from '../apps/backend-status'
import { openAppTab } from '../apps/open-app'
import { BUILTIN_PANELS } from './builtin-panels'
import { stripTestKey, useShownPanel } from './shown-panel'
import { clickOutcome, type StripEntry } from './strip-model'
import styles from './SidePanel.module.css'

function badgeText(count: number): string {
  return count > 99 ? '99+' : String(count)
}

function StripButton({
  entry,
  selected,
  backend,
  onClick
}: {
  entry: StripEntry
  selected: boolean
  /** E-028 — the app's backend status; null for a built-in panel or an app without one. */
  backend: AppBackendStatus | null
  onClick: () => void
}): React.JSX.Element {
  // E-032 — the icon's badge is its mark (marks-store): an app's `strip.setBadge`, unread notices,
  // the platform's own producers — one mechanism for every icon, built-in or app.
  const badge: Mark | undefined = useStripMark(entry.key)
  const builtin = entry.kind === 'builtin' ? BUILTIN_PANELS.find((b) => b.key === entry.key) : undefined
  const hint = entry.action === 'tab' ? 'Opens in a tab' : entry.action === 'both' ? 'Opens a tab and the panel' : null
  const testKey = stripTestKey(entry.key)
  const lines = [entry.title, ...(hint ? [hint] : []), ...backendLines(backend)]
  return (
    <Tooltip lines={lines} testId={`strip-tip-${testKey}`}>
      <button
        type="button"
        className={styles.stripBtn}
        aria-label={badge ? `${entry.title} (${badge.count})` : entry.title}
        aria-pressed={entry.action === 'tab' ? undefined : selected}
        data-active-panel={selected || undefined}
        data-action={entry.action}
        data-testid={`strip-${testKey}`}
        data-backend-state={backend?.state}
        onClick={onClick}
      >
        {builtin ? <builtin.Glyph /> : entry.kind === 'app' && <AppIcon appId={entry.appId} icon={entry.icon} />}
        {badge && (
          <span
            className={styles.badge}
            data-urgent={badge.urgent || undefined}
            data-quiet={badge.quiet || undefined}
            data-testid={`strip-badge-${testKey}`}
            aria-hidden="true"
          >
            {badgeText(badge.count)}
          </span>
        )}
        {backendNeedsAttention(backend) && (
          <span className={styles.backendDot} data-testid={`strip-backend-down-${testKey}`} aria-hidden="true" />
        )}
      </button>
    </Tooltip>
  )
}

export function IconStrip(): React.JSX.Element {
  const { projectId, apps, strip, panel, collapsed, setCollapsed, select } = useShownPanel()

  const onIcon = (entry: StripEntry): void => {
    const outcome = clickOutcome(entry, collapsed)
    if (outcome.openTab && entry.kind === 'app') {
      const app = apps.find((a) => a.id === entry.appId)
      if (app) openAppTab(projectId, app, entry.icon)
    }
    if (outcome.select) select(projectId, entry.key)
    if (outcome.expand) void setCollapsed(false)
  }

  return (
    <nav className={styles.strip} aria-label="Icon strip" data-testid="icon-strip">
      <div className={styles.icons}>
        {strip.map((e) => (
          <StripButton
            key={e.key}
            entry={e}
            selected={e.action !== 'tab' && e.key === panel}
            backend={e.kind === 'app' ? (apps.find((a) => a.id === e.appId)?.backend ?? null) : null}
            onClick={() => onIcon(e)}
          />
        ))}
      </div>
      {collapsed && (
        <div className={styles.stripFoot}>
          <Tooltip lines={['Expand side panel (Cmd+Shift+B)']}>
            <button
              type="button"
              className={styles.stripBtn}
              aria-label="Expand side panel"
              data-testid="filetree-expand"
              onClick={() => void setCollapsed(false)}
            >
              »
            </button>
          </Tooltip>
        </div>
      )}
    </nav>
  )
}
