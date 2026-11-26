// Pomade — E-031 the event bus in main (docs/HOST-API.md §4 `events`, docs/modules/core/event-bus.md).
//
// One `EventBus` (pomade-kit/protocol: subscriptions, delivery, the sticky `pomade.ready`, the
// publisher's "has subscribers" news) for the whole app. A subscriber is an abstract connection:
// `openBusConnection` is the ONE way in — an app frame opens one per handshake (`host-api.ts`),
// and any other transport (a backend's socket) opens its own the same way. `callEvents` serves the
// `events.*` Host API methods for any connection, checked against the app's manifest.
//
// Platform events come from two sides: the renderer reports what it owns (Pomade ready, project
// created / renamed / opened / updated, active project changed) over `events.platform` — to one
// app when it names one (`project.updated` for that app's settings) — and main publishes
// its own (`agentTab.exited`, from `pty-manager.ts`) with `publishPlatformEvent`, and one app's
// own (`attachedTab.action`, from `attached-terminals.ts`) with `publishPlatformEventTo`.

import { appendFileSync } from 'node:fs'

import type { IpcMain } from 'electron'

import {
  EventBus,
  checkHasSubscribers,
  checkPublish,
  checkSubscribe,
  checkUnsubscribe,
  isPlatformEventName,
  type BusConnection,
  type BusMember,
  type JsonValue,
  type ManifestEvents,
  type PlatformEventName,
  type PlatformEvents
} from 'pomade-kit/protocol'

import { CH } from '@shared/ipc-api'
import type { AppCallOutcome } from '@shared/types'
import { onWorkspaceTeardown } from './config-store'
import { defineHandler } from './ipc'

const bus = new EventBus()

/** Test hook (NODE_ENV=test): every platform event is appended to this file as one JSON line,
 *  synchronously — the only witness of events published while Pomade quits. */
const testLog = process.env.NODE_ENV === 'test' ? process.env.POMADE_TEST_EVENT_LOG || null : null

/** Open a bus connection for one app: an app frame, or any other transport's client. It starts
 *  subscribed to `subscriptions`; close it when the connection ends (its subscriptions end too). */
export function openBusConnection(conn: BusConnection, subscriptions: readonly string[] = []): BusMember {
  return bus.open(conn, subscriptions)
}

/** Publish a platform event to its subscribers. `pomade.ready` is sticky until the workspace
 *  closes: a later subscription gets it at once. */
export function publishPlatformEvent<E extends PlatformEventName>(name: E, payload: PlatformEvents[E]): void {
  if (testLog) appendFileSync(testLog, `${JSON.stringify({ name, payload })}\n`)
  const json = payload as unknown as JsonValue
  if (name === 'pomade.ready') bus.publishSticky(name, json)
  else bus.publish(name, json)
}

/** Publish a platform event to one app's subscribers only (`attachedTab.action` goes to the app
 *  that owns the session, `project.updated` for a settings change to the app whose settings changed). */
export function publishPlatformEventTo<E extends PlatformEventName>(appId: string, name: E, payload: PlatformEvents[E]): void {
  if (testLog) appendFileSync(testLog, `${JSON.stringify({ name, to: appId, payload })}\n`)
  bus.publishTo(appId, name, payload as unknown as JsonValue)
}

/** The `events.*` methods for one connection, checked against the app's manifest `events`.
 *  `deliverAfter` schedules a sticky event's delivery after the call's own answer. */
export function callEvents(
  member: BusMember,
  declared: ManifestEvents,
  method: 'events.publish' | 'events.subscribe' | 'events.unsubscribe' | 'events.hasSubscribers',
  params: Record<string, unknown>,
  deliverAfter: (deliver: () => void) => void
): AppCallOutcome {
  switch (method) {
    case 'events.publish': {
      const p = checkPublish(declared, params)
      if (!p.ok) return p
      member.publish(p.name, p.payload)
      return { ok: true, value: {} }
    }
    case 'events.subscribe': {
      const p = checkSubscribe(declared, params)
      if (!p.ok) return p
      member.subscribe(p.name, deliverAfter)
      return { ok: true, value: {} }
    }
    case 'events.unsubscribe': {
      const p = checkUnsubscribe(params)
      if (!p.ok) return p
      member.unsubscribe(p.name)
      return { ok: true, value: {} }
    }
    case 'events.hasSubscribers': {
      const p = checkHasSubscribers(declared, params)
      if (!p.ok) return p
      return { ok: true, value: { subscribed: member.hasSubscribers(p.name) } }
    }
  }
}

export function registerEventBus(ipc: IpcMain): void {
  // The renderer's platform events. Pomade's own renderer is trusted for the payload; the name
  // must be a platform event.
  defineHandler(ipc, CH.events.platform, (_e, name, payload, to) => {
    if (!isPlatformEventName(name)) return
    if (typeof to === 'string') publishPlatformEventTo(to, name, payload as PlatformEvents[typeof name])
    else publishPlatformEvent(name, payload as PlatformEvents[typeof name])
  })
  // A closed workspace is no longer ready; the next one announces itself again.
  onWorkspaceTeardown(() => bus.clearSticky('pomade.ready'))
}
