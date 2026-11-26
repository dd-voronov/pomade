// Pomade — E-027 app pane: a hosted app's tab (docs/HOST-API.md §5). An <iframe> on the app's
// entry URL, bridged to the Host API by a FrameBridge. `AppFrame` and `AppUnavailable` are shared
// with the side panel (E-029), whose app panels are the same frame on the `panel` surface. Like every pane it is hidden, never
// unmounted (PaneHost), so the app's JS state survives tab and project switches and events still
// reach it while hidden. The frame element itself is replaced only when the app changes on disk
// (a new revision: install / update / relink) — that is the "open frames reload" of §2. A
// missing, removed or invalid app renders the in-tab "App unavailable" state instead; Pomade is
// unaffected either way.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { AppFrameRequest, HostedApp, Id } from '@shared/types'
import { useAppsStore } from '../../stores/apps-store'
import { useTabsStore } from '../../stores/tabs-store'
import type { PaneProps } from '../../panes/registry'
import { FrameBridge } from './frame-bridge'
import { activeProjectRef } from './project-ref'
import { AppGlyph } from './AppIcon'
import styles from './AppPane.module.css'

/** The project whose tab strip holds `tabId` now. */
function projectOfTab(tabId: string): Id | undefined {
  for (const [projectId, tabs] of Object.entries(useTabsStore.getState().tabsByProject)) {
    if (tabs.some((t) => t.id === tabId)) return projectId
  }
  return undefined
}

/** Give an app frame keyboard focus, keeping the element focused inside it. `iframe.focus()` on the
 *  frame Pomade's document already has focused moves focus out of the frame and back, and Chromium
 *  clears the element the app focused (an overlay's input, focused before its frame finished loading,
 *  lost focus that way): then focus goes through the frame's window instead, which only makes sure
 *  the frame's document has it. */
export function focusAppFrame(iframe: HTMLIFrameElement): void {
  if (document.activeElement !== iframe) iframe.focus()
  else iframe.contentWindow?.focus()
}

export function AppFrame({
  app,
  request,
  testId,
  onCloseRequest,
  autoFocus = false,
  tabId
}: {
  app: HostedApp
  request: AppFrameRequest
  testId: string
  /** The overlay frame asked to close (`overlay.close`, a forwarded Escape). */
  onCloseRequest?: () => void
  /** Take keyboard focus when mounted and when the document loads (the overlay). */
  autoFocus?: boolean
  /** A tab frame's tab: the frame belongs to that tab's project (wherever the tab is now). */
  tabId?: string
}): React.JSX.Element {
  const ref = useRef<HTMLIFrameElement | null>(null)
  const bridgeRef = useRef<FrameBridge | null>(null)
  const { surface, icon, route, key, kind } = request
  // The route a NEW bridge opens at; a route change on a live frame is a navigation, not a new frame.
  const routeRef = useRef(route)
  routeRef.current = route
  const onCloseRef = useRef(onCloseRequest)
  onCloseRef.current = onCloseRequest

  // Layout effect: the bridge listens before the frame's first script can run (the frame
  // document loads asynchronously after commit).
  useLayoutEffect(() => {
    const iframe = ref.current
    if (!iframe) return
    const initialRoute = routeRef.current
    const bridge = new FrameBridge(
      iframe,
      app.id,
      {
        surface,
        ...(icon ? { icon } : {}),
        ...(initialRoute !== undefined ? { route: initialRoute } : {}),
        ...(key !== undefined ? { key } : {}),
        ...(kind !== undefined ? { kind } : {})
      },
      activeProjectRef,
      () => onCloseRef.current?.(),
      () => (tabId === undefined ? undefined : projectOfTab(tabId)),
      tabId
    )
    bridgeRef.current = bridge
    window.addEventListener('message', bridge.handleMessage)
    return () => {
      window.removeEventListener('message', bridge.handleMessage)
      bridge.dispose()
      bridgeRef.current = null
    }
  }, [app.id, surface, icon, key, kind, tabId])

  useEffect(() => {
    if (route !== undefined) bridgeRef.current?.setRoute(route)
  }, [route])

  useEffect(() => {
    if (autoFocus && ref.current) focusAppFrame(ref.current)
  }, [autoFocus])

  return (
    <iframe
      ref={ref}
      className={styles.frame}
      src={app.entryUrl ?? undefined}
      title={app.name}
      data-testid={testId}
      data-revision={app.revision}
      // The app's own origin (pomade-app://<id>) is what isolates it from Pomade; the sandbox is
      // defense in depth. allow-same-origin keeps that origin, so its scripts and fetches work;
      // allow-forms lets an app's <form> submit (a quick-add form submits on Enter).
      sandbox="allow-scripts allow-same-origin allow-forms"
      // The frame may write text to the clipboard (navigator.clipboard.writeText after a click).
      // Reading stays denied: only clipboard-write is delegated to the cross-origin frame, so its
      // clipboard-read is blocked by the permissions policy.
      allow="clipboard-write"
      onLoad={autoFocus ? (e) => focusAppFrame(e.currentTarget) : undefined}
    />
  )
}

export function AppUnavailable({
  appId,
  app,
  surface,
  testId
}: {
  appId: string
  app: HostedApp | undefined
  surface: AppFrameRequest['surface']
  testId: string
}): React.JSX.Element {
  const refresh = useAppsStore((s) => s.refresh)
  const [busy, setBusy] = useState(false)
  const reason = app?.unavailable ?? 'This app is not installed or linked — it may have been removed.'
  return (
    <div className={styles.unavailable} data-testid={testId} role="status">
      <div className={styles.card}>
        <span className={styles.glyph} aria-hidden="true">
          <AppGlyph />
        </span>
        <div className={styles.title}>App unavailable</div>
        <p className={styles.reason} data-testid={`${testId}-reason`}>
          {reason}
        </p>
        <dl className={styles.facts}>
          <dt>App</dt>
          <dd>
            <code>{appId}</code>
          </dd>
          {app && (
            <>
              <dt>{app.source === 'dev-link' ? 'Linked from' : 'Installed at'}</dt>
              <dd>
                <code>{app.location}</code>
              </dd>
            </>
          )}
        </dl>
        <p className={styles.hint}>
          Pomade is unaffected. Reinstall with <code>pomade apps install</code>
          {surface === 'tab' ? ', or close this tab.' : '.'}
        </p>
        <button
          type="button"
          className={styles.retry}
          disabled={busy}
          data-testid={`${testId}-retry`}
          onClick={() => {
            setBusy(true)
            void refresh().finally(() => setBusy(false))
          }}
        >
          {busy ? 'Checking…' : 'Retry'}
        </button>
      </div>
    </div>
  )
}

export function AppPane({ tab }: PaneProps): React.JSX.Element | null {
  const appId = tab.kind === 'app' ? tab.appId : ''
  const app = useAppsStore((s) => s.apps.find((a) => a.id === appId))
  const loaded = useAppsStore((s) => s.loaded)
  if (tab.kind !== 'app') return null

  let body: React.JSX.Element | null = null
  if (!loaded) body = null
  else if (!app || app.unavailable || !app.entryUrl) {
    body = <AppUnavailable appId={appId} app={app} surface="tab" testId={`app-unavailable-${tab.id}`} />
  } else {
    // A new revision (or entry URL) is a new frame element: the app reloads on its new files.
    body = (
      <AppFrame
        key={`${app.revision}|${app.entryUrl}`}
        app={app}
        request={{
          surface: 'tab',
          ...(tab.icon ? { icon: tab.icon, ...(tab.route !== undefined ? { route: tab.route } : {}) } : { route: tab.route ?? '' }),
          ...(tab.key !== undefined ? { key: tab.key } : {}),
          ...(tab.tabKind !== undefined ? { kind: tab.tabKind } : {})
        }}
        testId={`app-frame-${app.id}`}
        tabId={tab.id}
      />
    )
  }
  return (
    <div className={styles.pane} data-testid={`app-pane-${tab.id}`} data-app-id={appId}>
      {body}
    </div>
  )
}
