// Pomade — E-028 the broker (docs/HOST-API.md §4 `apps`): app-to-app calls and the platform's
// reads of app APIs (PLATFORM rule 7) go through here.
//
// An app offers the methods its manifest's `api` names. A client of the app (its backend over the
// socket, or a frame) calls `api.serve` and becomes a server; `apps.call` from any client — or
// `callAppApi` from Pomade itself — is checked (the caller's `calls` declares the target, unless it
// calls its own app; the method is in the target's `api`), sent to the target's server as a
// `request`, and settled by its `response`, a timeout (`app-not-responding`) or the server going
// away. No server = `app-absent`: the caller falls back. Call cycles are not detected here: the
// manifests declare `calls` and install reports a cycle (rule 4).

import {
  PLATFORM_CLIENT_ID,
  brokerErrors,
  isJsonValue,
  parseAppCall,
  type ErrorPayload,
  type JsonValue
} from 'pomade-kit/protocol'

import type { AppCallOutcome } from '@shared/types'
import { appManifest } from './app-registry'

/** How a server receives a request (its session's sink). */
export type RequestSink = (requestId: string, from: string, method: string, params: JsonValue) => void

interface Server {
  sessionId: string
  appId: string
  /** A backend is preferred over a frame. */
  backend: boolean
  send: RequestSink
  /** Registration order: the latest frame serves when there is no backend. */
  seq: number
}

interface Pending {
  sessionId: string
  target: string
  resolve(outcome: AppCallOutcome): void
  timer: NodeJS.Timeout
}

const servers = new Map<string, Server>()
const servingListeners = new Set<(appId: string, serving: boolean) => void>()
const pending = new Map<string, Pending>()
let seq = 0
let requestSeq = 0

function fail(error: ErrorPayload): AppCallOutcome {
  return { ok: false, error }
}

/** `api.serve`: the session serves its app's API from now on. */
export function serveApi(sessionId: string, appId: string, backend: boolean, send: RequestSink): AppCallOutcome {
  const methods = appManifest(appId)?.api ?? []
  if (methods.length === 0) return fail({ code: 'capability-denied', message: 'The manifest declares no "api"' })
  const was = isServing(appId)
  servers.set(sessionId, { sessionId, appId, backend, send, seq: ++seq })
  if (!was) announceServing(appId, true)
  return { ok: true, value: { methods: [...methods] } }
}

function serverOf(appId: string): Server | null {
  let best: Server | null = null
  for (const s of servers.values()) {
    if (s.appId !== appId) continue
    if (!best || (s.backend && !best.backend) || (s.backend === best.backend && s.seq > best.seq)) best = s
  }
  return best
}

/** `listener` hears each time an app's API goes from unserved to served and back. Returns the unsubscribe. */
export function onServingChange(listener: (appId: string, serving: boolean) => void): () => void {
  servingListeners.add(listener)
  return () => servingListeners.delete(listener)
}

function announceServing(appId: string, serving: boolean): void {
  for (const l of [...servingListeners]) l(appId, serving)
}

/** True when some client serves the app's API now. */
export function isServing(appId: string): boolean {
  return serverOf(appId) !== null
}

/** Route one call from `caller` (an app id, or `PLATFORM_CLIENT_ID`). */
function route(caller: string, rawParams: unknown): Promise<AppCallOutcome> {
  const parsed = parseAppCall(rawParams)
  if (!parsed.ok) return Promise.resolve(parsed)
  const { app, method, params, timeoutMs } = parsed.call
  if (caller !== PLATFORM_CLIENT_ID && caller !== app && !(appManifest(caller)?.calls ?? []).includes(app)) {
    return Promise.resolve(fail(brokerErrors.notDeclared(caller, app)))
  }
  const target = appManifest(app)
  if (!target) return Promise.resolve(fail(brokerErrors.notInstalled(app)))
  if (!target.api.includes(method)) return Promise.resolve(fail(brokerErrors.unknownMethod(app, method)))
  const server = serverOf(app)
  if (!server) return Promise.resolve(fail(brokerErrors.notRunning(app)))
  const requestId = `q${++requestSeq}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      resolve(fail(brokerErrors.timeout(app, timeoutMs)))
    }, timeoutMs)
    pending.set(requestId, { sessionId: server.sessionId, target: app, resolve, timer })
    server.send(requestId, caller, method, params)
  })
}

/** `apps.call` from an app's client. */
export function callFromApp(callerAppId: string, rawParams: unknown): Promise<AppCallOutcome> {
  return route(callerAppId, rawParams)
}

/** `apps.call` from one of Pomade's own commands over the socket. */
export function callFromPlatform(rawParams: unknown): Promise<AppCallOutcome> {
  return route(PLATFORM_CLIENT_ID, rawParams)
}

/**
 * Rule 7 — a platform surface reads an app's API. Resolves the value, or null when the app is
 * absent, not responding or answered an error: the surface then shows nothing extra, or falls
 * back to its own behavior.
 */
export async function callAppApi(app: string, method: string, params: JsonValue = {}, timeoutMs = 2000): Promise<JsonValue | null> {
  const outcome = await route(PLATFORM_CLIENT_ID, { app, method, params, timeoutMs })
  return outcome.ok ? (outcome.value as JsonValue) : null
}

/** A server's `response`. Only the session the request went to may answer it. */
export function respond(sessionId: string, requestId: string, outcome: { ok: boolean; value?: unknown; error?: ErrorPayload }): void {
  const p = pending.get(requestId)
  if (!p || p.sessionId !== sessionId) return
  pending.delete(requestId)
  clearTimeout(p.timer)
  if (!outcome.ok) p.resolve(fail(outcome.error ?? { code: 'app-error', message: 'Malformed response' }))
  else if (!isJsonValue(outcome.value)) p.resolve(fail(brokerErrors.notJson(p.target)))
  else p.resolve({ ok: true, value: outcome.value })
}

/** A session ended: it serves no more, and the calls it was answering fail. */
export function dropSession(sessionId: string): void {
  const gone = servers.get(sessionId)
  if (gone) {
    servers.delete(sessionId)
    if (!isServing(gone.appId)) announceServing(gone.appId, false)
  }
  for (const [id, p] of [...pending]) {
    if (p.sessionId !== sessionId) continue
    pending.delete(id)
    clearTimeout(p.timer)
    p.resolve(fail(brokerErrors.gone(p.target)))
  }
}
