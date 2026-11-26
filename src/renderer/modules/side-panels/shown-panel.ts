// Pomade — E-029 side panels: the state the icon strip and the side panel share. Both read the
// active project's shown panel from the same stores, so they always agree on which icon is
// selected and which panel is visible.

import { useMemo } from 'react'

import type { HostedApp } from '@shared/types'
import { useAppSettingsStore } from '../../stores/app-settings-store'
import { useAppsStore } from '../../stores/apps-store'
import { useSidePanelStore } from '../../stores/side-panel-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { BUILTIN_PANELS } from './builtin-panels'
import { buildStrip, FILES_PANEL, resolvePanel, type StripEntry } from './strip-model'

/** A DOM-safe test id for a strip key (`app:hello/panel` → `app-hello-panel`). */
export function stripTestKey(key: string): string {
  return key.replace(/[:/]/g, '-')
}

export interface ShownPanel {
  projectId: string
  apps: readonly HostedApp[]
  strip: readonly StripEntry[]
  /** The strip key whose panel the side panel shows for the active project. */
  panel: string
  collapsed: boolean
  setCollapsed: (value: boolean) => Promise<void>
  select: (projectId: string, key: string) => void
}

export function useShownPanel(): ShownPanel {
  const projectId = useWorkspaceStore((s) => s.activeProjectId)
  const apps = useAppsStore((s) => s.apps)
  const collapsed = useAppSettingsStore((s) => s.layout.fileTreeCollapsed)
  const setCollapsed = useAppSettingsStore((s) => s.setFileTreeCollapsed)
  const stored = useSidePanelStore((s) => s.selectedByProject[projectId])
  const hydrated = useSidePanelStore((s) => s.hydratedProjects[projectId] === true)
  const select = useSidePanelStore((s) => s.select)

  const strip = useMemo(() => buildStrip(BUILTIN_PANELS, apps), [apps])
  // Until the project's selection loads, show Files — never flash an app panel the project does
  // not have selected.
  const panel = hydrated ? resolvePanel(stored, strip) : FILES_PANEL
  return { projectId, apps, strip, panel, collapsed, setCollapsed, select }
}
