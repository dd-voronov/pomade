// Pomade — E-027 app shortcuts (docs/HOST-API.md §1 `shortcuts`). Apps declare Pomade-wide
// chords in their manifest; main drops the ones Pomade uses or another app took first
// (`HostedApp.shortcuts` holds the live ones). One capture-phase window listener matches every
// keydown — from a terminal, an editor, Pomade's chrome, or an app frame (its forwarded keys
// arrive as a synthetic keydown on the <iframe> element, HOST-API §3 "Keys") — before any pane
// handler sees it, so the chord never leaks into a terminal or an editor.

import { useEffect } from 'react'

import { chordMatches, parseChord, type AppShortcut, type ChordEvent } from 'pomade-kit/protocol'

import type { HostedApp } from '@shared/types'
import { useAppsStore } from '../../stores/apps-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { openAppRoute } from './open-app'
import { useOverlayStore } from './overlay-store'

/** The available app shortcut this keydown is, if any. */
export function findAppShortcut(
  apps: readonly HostedApp[],
  e: ChordEvent
): { app: HostedApp; shortcut: AppShortcut } | null {
  if (!e.metaKey) return null
  for (const app of apps) {
    if (app.unavailable) continue
    for (const shortcut of app.shortcuts) {
      const chord = parseChord(shortcut.key)
      if (chord && chordMatches(chord, e)) return { app, shortcut }
    }
  }
  return null
}

/** Do what a pressed shortcut says. */
export function runAppShortcut(app: HostedApp, shortcut: AppShortcut): void {
  const projectId = useWorkspaceStore.getState().activeProjectId
  switch (shortcut.action) {
    case 'tab':
      openAppRoute(app, shortcut.route, projectId)
      return
    case 'overlay':
      useOverlayStore.getState().show(app.id, shortcut.route, { shortcutId: shortcut.id })
      return
  }
}

/** Mount once (App): dispatch app shortcuts from anywhere in the window. */
export function useAppShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const hit = findAppShortcut(useAppsStore.getState().apps, e)
      if (!hit) return
      e.preventDefault()
      e.stopPropagation()
      if (!e.repeat) runAppShortcut(hit.app, hit.shortcut)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])
}
