// Pomade e2e — helpers for driving the hello fixture app (e2e/fixtures/apps/hello) from specs:
// its frames, its `window.__hello` surface (state + a raw `call(method, params)`), and the stores
// specs read to check what Pomade did in response.

import { resolve } from 'node:path'

import { expect, type Frame, type Locator, type Page } from '@playwright/test'

import type { CallResult, HelloEvent, HelloWelcome } from './globals'

export type { CallResult, HelloEvent, HelloWelcome }

export const HELLO_DIR = resolve(__dirname, 'apps/hello')

export interface TabInfo {
  id: string
  kind: string
  appId?: string
  icon?: string
  route?: string
  title: string
}

/** The hello frame inside `iframe` once its handshake has completed. */
/** HOST-API §5: a frame just shown takes pointer input once the window has drawn it. */
export function afterFiveFrames(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((done) => {
        let n = 0
        const tick = (): void => void (++n === 5 ? done() : requestAnimationFrame(tick))
        requestAnimationFrame(tick)
      })
  )
}

export async function connectedFrame(iframe: Locator): Promise<Frame> {
  await expect(iframe).toHaveCount(1)
  let frame: Frame | null = null
  await expect
    .poll(async () => {
      frame = (await (await iframe.elementHandle())?.contentFrame()) ?? null
      if (!frame) return 'no frame'
      return frame.evaluate(() => window.__hello?.status ?? 'loading').catch(() => 'loading')
    })
    .toBe('connected')
  return frame!
}

export function welcomeOf(frame: Frame): Promise<HelloWelcome | null> {
  return frame.evaluate(() => {
    const w = window.__hello?.welcome
    return w ? { surface: w.surface, icon: w.icon, route: w.route } : null
  })
}

/** The project id the frame's `welcome` carried. */
export function welcomeProjectOf(frame: Frame): Promise<string | null> {
  return frame.evaluate(() => {
    const w = window.__hello?.welcome as { project?: { id: string } } | null | undefined
    return w?.project?.id ?? null
  })
}

/** The route the frame currently renders: its welcome route, then every `route.changed`. */
export function routeOf(frame: Frame): Promise<string> {
  return frame.evaluate(() => window.__hello.route)
}

export function markOf(frame: Frame): Promise<string> {
  return frame.evaluate(() => window.__hello.mark)
}

export function eventsOf(frame: Frame, name: string): Promise<unknown[]> {
  return frame.evaluate(
    (n) => window.__hello.events.filter((e) => e.name === n).map((e) => e.payload),
    name
  )
}

/** A raw Host API call from the frame; the answer as `{ ok, value }` / `{ ok, error }`. */
export async function callIn(frame: Frame, method: string, params?: unknown): Promise<CallResult> {
  const r = await frame.evaluate(
    ([m, p]) => window.__hello.call(m as string, p),
    [method, params] as const
  )
  return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error }
}

export function tabsOf(page: Page, projectId: string): Promise<TabInfo[]> {
  return page.evaluate((pid) => {
    const s = window.__pomadeStores.useTabsStore.getState()
    return s.tabsFor(pid).map((t) => ({
      id: t.id,
      kind: t.kind,
      appId: t.appId,
      icon: t.icon,
      route: t.route,
      title: t.title
    }))
  }, projectId)
}

export function activeTabOf(page: Page, projectId: string): Promise<string | undefined> {
  return page.evaluate(
    (pid) =>
      window.__pomadeStores.useTabsStore.getState().activeTabByProject[pid],
    projectId
  )
}

export function activeProjectOf(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      window.__pomadeStores.useWorkspaceStore.getState().activeProjectId
  )
}

export function setActiveProject(page: Page, id: string): Promise<void> {
  return page.evaluate((pid) => {
    window.__pomadeStores.useWorkspaceStore.getState()
      .setActiveProject(pid)
  }, id)
}

/** Open the hello app from the tab strip's new-tab menu (its default view, no icon). */
export async function openHelloFromMenu(page: Page, appId = 'hello'): Promise<void> {
  await page.getByTestId('tab-add').click()
  await page.getByTestId(`tab-add-app-${appId}`).click()
}
