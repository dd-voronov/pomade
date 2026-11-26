// Pomade — E-029: the side panel, between the icon strip and the main area. It shows the panel
// the strip selected for the active project — Files, Git, Notices or an app's panel; each project
// remembers which (side-panel-store).
//
// Panels obey the PaneHost invariant: hidden, never unmounted. An app panel's frame mounts the
// first time it is shown and then stays — across panel switches, project switches and collapse —
// so the app keeps its JS state and keeps receiving events. Collapsing leaves only the icon strip.
// An app that starts on launch (`launchPanel`) has its panel frame mounted — hidden — from the
// moment it is listed, so it can badge its icon before the user opens it.

import { useEffect, useMemo, useState } from 'react'

import type { HostedApp } from '@shared/types'
import { Tooltip } from '../../components/Tooltip'
import { useRevealStore } from '../../stores/reveal-store'
import { useSidePanelStore } from '../../stores/side-panel-store'
import { AppFrame, AppUnavailable } from '../apps/AppPane'
import { useAppPanelRoutes } from './app-panel-routes'
import { BUILTIN_PANELS } from './builtin-panels'
import { stripTestKey, useShownPanel } from './shown-panel'
import { FILES_PANEL, launchPanelKeys, type StripEntry } from './strip-model'
import styles from './SidePanel.module.css'

function CollapseButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <Tooltip lines={['Collapse side panel (Cmd+Shift+B)']}>
      <button
        type="button"
        className={styles.headerBtn}
        aria-label="Collapse side panel"
        data-testid="side-panel-collapse"
        onClick={onClick}
      >
        «
      </button>
    </Tooltip>
  )
}

/** An app's panel: a header with the icon's title, then the app frame on the `panel` surface. */
function AppPanel({
  entry,
  app,
  visible,
  onCollapse
}: {
  entry: Extract<StripEntry, { kind: 'app' }>
  app: HostedApp | undefined
  visible: boolean
  onCollapse: () => void
}): React.JSX.Element {
  const testKey = stripTestKey(entry.key)
  // T-325 — the route the app named with `panel.show`; none = the icon's panel route.
  const route = useAppPanelRoutes((s) => s.routes[entry.key])
  return (
    <section
      className={`${styles.slot} ${styles.appSlot}`}
      hidden={!visible}
      aria-label={entry.title}
      data-testid={`side-panel-${testKey}`}
    >
      <header className={styles.header}>
        <span className={styles.headerTitle}>{entry.title}</span>
        <CollapseButton onClick={onCollapse} />
      </header>
      <div className={styles.frameWrap}>
        {app && !app.unavailable && app.entryUrl ? (
          <AppFrame
            key={`${app.revision}|${app.entryUrl}`}
            app={app}
            request={{ surface: 'panel', icon: entry.icon, ...(route !== undefined ? { route } : {}) }}
            testId={`panel-frame-${testKey}`}
          />
        ) : (
          <AppUnavailable appId={entry.appId} app={app} surface="panel" testId={`panel-unavailable-${testKey}`} />
        )}
      </div>
    </section>
  )
}

export function SidePanel(): React.JSX.Element {
  const { projectId, apps, strip, panel, collapsed, setCollapsed, select } = useShownPanel()
  const hydrateProject = useSidePanelStore((s) => s.hydrateProject)
  const revealRequest = useRevealStore((s) => s.request)

  useEffect(() => {
    void hydrateProject(projectId)
  }, [hydrateProject, projectId])

  // A reveal in the tree (symlink popover, go-to-path, "Reveal in tree") brings Files forward.
  useEffect(() => {
    if (revealRequest && revealRequest.projectId === projectId) select(projectId, FILES_PANEL)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire per request, not per project switch
  }, [revealRequest])

  // App panels mount the first time they are shown and stay mounted from then on.
  const [mounted, setMounted] = useState<readonly string[]>([])
  useEffect(() => {
    if (!collapsed && panel !== FILES_PANEL && !mounted.includes(panel)) setMounted([...mounted, panel])
  }, [collapsed, panel, mounted])

  const collapse = (): void => void setCollapsed(true)

  const launched = useMemo(() => launchPanelKeys(apps), [apps])
  const appPanels = strip.filter(
    (e): e is Extract<StripEntry, { kind: 'app' }> =>
      e.kind === 'app' && (mounted.includes(e.key) || launched.includes(e.key))
  )

  return (
    <div className={styles.panels} hidden={collapsed} data-testid="side-panel">
      {BUILTIN_PANELS.map(({ key, Panel }) => (
        <div key={key} className={styles.slot} hidden={key !== panel} data-testid={`side-panel-${key}`}>
          <Panel />
        </div>
      ))}
      {appPanels.map((e) => (
        <AppPanel
          key={e.key}
          entry={e}
          app={apps.find((a) => a.id === e.appId)}
          visible={e.key === panel}
          onCollapse={collapse}
        />
      ))}
    </div>
  )
}
