// Pomade — E-028 the Host API's socket channel (docs/HOST-API.md §3 "Socket").
//
// A unix socket at `<userData>/run/pomade.sock` (folder 0700, socket 0600) carries the same
// protocol as postMessage — one JSON message per line — for app backends, app commands and the
// platform's own commands. The first message is `hello` with the client's identity (`appId`, the
// key Pomade issued for it, its role); Pomade answers `welcome` or `reject` (`unauthorized`, or a
// version mismatch) exactly like a frame's handshake. An authenticated app client is a session in
// `host-api.ts`, so every call takes the same path as a frame's: the manifest's capability gate,
// params validation, the workspace rules. A call whose work is renderer-owned state (`{ delegate }`)
// is served by the window over IPC (`modules/apps/socket-bridge.ts`); the few methods that need an
// app frame (a folder picker, git watches) are refused.
//
// Threat model (single-user Mac): the folder's mode keeps other local users out; the key is the
// caller's identity, so an app gets exactly its own manifest's capabilities. Any process running
// as this user can read the key files and connect as any app — the socket is not a boundary
// against the user's own processes, and does not pretend to be.

import { promises as fs, rmSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { isAbsolute, join } from 'node:path'

import { app, BrowserWindow, type IpcMain } from 'electron'

import {
  APP_ID_RE,
  CHANNEL,
  FRAME_ONLY_METHODS,
  checkNotice,
  HOST_API_VERSION,
  PLATFORM_CLIENT_ID,
  WORKSPACE_PROJECT_ID,
  createLineDecoder,
  encodeLine,
  parseAppMessage,
  socketPathProblem,
  type ClientRole,
  type ErrorPayload,
  type EventMessage,
  type HostToAppMessage,
  type IncomingCall,
  type ProjectRef,
  type SocketClient
} from 'pomade-kit/protocol'

import { CH, EV } from '@shared/ipc-api'
import type { AppCallOutcome, AppDelegatedCall, AppDelegatedServe } from '@shared/types'
import { ensureAppKey, keysMatch, readAppKey } from './app-keys'
import { appManifest, appsScanned, broadcastApps, knownAppIds, onAppsChanged } from './app-registry'
import { pomadeVersion } from './config-store'
import { pomadeTheme } from './theme'
import { call, closeSession, openSession, type SessionSink } from './host-api'
import { callFromPlatform, dropSession, respond as brokerRespond } from './app-broker'
import { negotiate } from './host-api-core'
import { agentsLiveIn } from './agents-live'
import { defineHandler } from './ipc'

/** The socket, relative to user data. */
export const SOCKET_DIR = 'run'
export const SOCKET_FILE = 'pomade.sock'
/** A connection that has not said `hello` by then is closed. */
const HELLO_TIMEOUT_MS = 5000
/** How long a delegated call waits for the window (startup, a reload) and then for its answer. */
const DELEGATE_TIMEOUT_MS = 10000

const WORKSPACE_SCOPE: ProjectRef = { id: WORKSPACE_PROJECT_ID, kind: 'workspace', name: 'Workspace', root: '' }

interface Connection {
  socket: Socket
  /** The `host-api.ts` session id while welcomed. */
  sessionId: string
  welcomed: boolean
  appId: string
  role: ClientRole
}

let server: Server | null = null
let socketPath: string | null = null
const connections = new Set<Connection>()
let connectionSeq = 0

// ─── The window's half: active project, delegated calls ─────────────────────────

let activeProject: ProjectRef = WORKSPACE_SCOPE
let rendererReady = false
const readyWaiters = new Set<() => void>()
let delegateSeq = 0
const pendingDelegates = new Map<string, { resolve(outcome: AppCallOutcome): void; timer: NodeJS.Timeout }>()

/** The active project as the window reported it (the Workspace project until it does). */
export function currentActiveProject(): ProjectRef {
  return activeProject
}

function setActiveProject(ref: ProjectRef): void {
  rendererReady = true
  for (const wake of [...readyWaiters]) wake()
  readyWaiters.clear()
  // `project.changed` reaches a socket client through the event bus, when it subscribes.
  activeProject = ref
}

function waitForRenderer(ms: number): Promise<boolean> {
  if (rendererReady) return Promise.resolve(true)
  return new Promise((resolve) => {
    const wake = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      readyWaiters.delete(wake)
      resolve(false)
    }, ms)
    readyWaiters.add(wake)
  })
}

function notReady(message: string): AppCallOutcome {
  return { ok: false, error: { code: 'not-ready', message } }
}

/** Serve a delegated call in the window (renderer-owned state), as a frame's bridge would. */
async function serveInRenderer(delegate: AppDelegatedCall): Promise<AppCallOutcome> {
  if (!(await waitForRenderer(DELEGATE_TIMEOUT_MS))) return notReady("Pomade's window is not ready")
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.webContents.isDestroyed())
  if (!win) return notReady("Pomade's window is closed")
  const requestId = `d${++delegateSeq}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingDelegates.delete(requestId)
      resolve(notReady("Pomade's window did not answer"))
    }, DELEGATE_TIMEOUT_MS)
    pendingDelegates.set(requestId, { resolve, timer })
    const serve: AppDelegatedServe = { requestId, call: delegate }
    win.webContents.send(EV.appsServeDelegated, serve)
  })
}

function delegatedResult(requestId: unknown, outcome: unknown): void {
  if (typeof requestId !== 'string') return
  const pending = pendingDelegates.get(requestId)
  if (!pending) return
  pendingDelegates.delete(requestId)
  clearTimeout(pending.timer)
  const o = outcome as AppCallOutcome | null
  pending.resolve(o && typeof o === 'object' && 'ok' in o ? o : { ok: false, error: { code: 'io-error', message: 'Malformed answer' } })
}

// ─── Connections ──────────────────────────────────────────────────────────────

function send(c: Connection, message: HostToAppMessage): void {
  if (!c.socket.destroyed) c.socket.write(encodeLine(message))
}

/** E-028 — deliver an event to one socket session (E-031: events for backends ride this). */
export function sendEventToSession(sessionId: string, event: EventMessage): boolean {
  for (const c of connections) {
    if (c.welcomed && c.sessionId === sessionId) {
      send(c, event)
      return true
    }
  }
  return false
}

/** The welcomed socket sessions of one app, with their roles. */
export function socketSessionsOf(appId: string): { sessionId: string; role: ClientRole }[] {
  return [...connections].filter((c) => c.welcomed && c.appId === appId).map((c) => ({ sessionId: c.sessionId, role: c.role }))
}

function socketSink(c: Connection): SessionSink {
  return {
    alive: () => !c.socket.destroyed,
    filesChanged: (watchId, changes) => send(c, { channel: CHANNEL, type: 'event', name: 'files.changed', payload: { watchId, changes } }),
    stateChanged: (key, value) => send(c, { channel: CHANNEL, type: 'event', name: 'state.changed', payload: { key, value } }),
    // A backend has no frame: its badge goes to every window, like the strip itself.
    badge: (badge) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send(EV.appsBadge, badge)
    },
    request: (id, from, method, params) => send(c, { channel: CHANNEL, type: 'request', id, from, method, params }),
    // E-031 — a bus event the client subscribed to (sent after the reply of the call that caused it).
    event: (name, payload) => send(c, { channel: CHANNEL, type: 'event', name, payload } as EventMessage)
  }
}

type Verdict = { ok: true; appId: string; role: ClientRole } | { ok: false }

/** Is the presented identity one Pomade issued? An app must be hosted (installed or dev-linked,
 *  with a valid manifest) and present its own key; the platform client presents the platform key.
 *  The socket listens before the registry's first scan, so a client that connects at start (a
 *  backend launching Pomade, a command) is judged once the apps are known — never refused because
 *  the scan had not finished. */
async function authenticate(client: SocketClient | undefined, userData: string): Promise<Verdict> {
  if (!client) return { ok: false }
  await appsScanned()
  if (client.appId !== PLATFORM_CLIENT_ID && !appManifest(client.appId)) return { ok: false }
  const issued = await readAppKey(userData, client.appId)
  if (issued === null || !keysMatch(client.key, issued)) return { ok: false }
  if (client.appId === PLATFORM_CLIENT_ID) return client.role === 'command' ? { ok: true, appId: client.appId, role: client.role } : { ok: false }
  // A backend's identity is only for an app that declares one.
  if (client.role === 'backend' && !appManifest(client.appId)?.backend) return { ok: false }
  // Likewise a command's, for an app that ships commands.
  if (client.role === 'command' && (appManifest(client.appId)?.commands.length ?? 0) === 0) return { ok: false }
  return { ok: true, appId: client.appId, role: client.role }
}

function endSession(c: Connection): void {
  if (!c.welcomed) return
  if (c.appId === PLATFORM_CLIENT_ID) dropSession(c.sessionId)
  else closeSession(c.sessionId)
  c.welcomed = false
  if (c.role === 'backend') broadcastApps()
}

async function onHello(c: Connection, hostApi: number, client: SocketClient | undefined, userData: string): Promise<void> {
  endSession(c)
  const verdict = negotiate(hostApi)
  if (verdict === 'ignore') return
  if (verdict !== 'welcome') {
    send(c, { channel: CHANNEL, type: 'reject', reason: verdict, hostApi: HOST_API_VERSION })
    return
  }
  const auth = await authenticate(client, userData)
  if (!auth.ok) {
    send(c, { channel: CHANNEL, type: 'reject', reason: 'unauthorized', hostApi: HOST_API_VERSION })
    return
  }
  c.appId = auth.appId
  c.role = auth.role
  c.sessionId = `socket:${++connectionSeq}`
  c.welcomed = true
  if (auth.appId !== PLATFORM_CLIENT_ID) openSession(c.sessionId, auth.appId, { surface: auth.role, route: '' }, socketSink(c))
  // A backend that connects changes its app's status.
  if (auth.role === 'backend') broadcastApps()
  send(c, {
    channel: CHANNEL,
    type: 'welcome',
    hostApi: HOST_API_VERSION,
    pomadeVersion: pomadeVersion(),
    appId: auth.appId,
    surface: auth.role,
    route: '',
    project: activeProject,
    theme: pomadeTheme()
  })
}

function errorOutcome(code: ErrorPayload['code'], message: string): AppCallOutcome {
  return { ok: false, error: { code, message } }
}

/** `agents.liveIn` — agents running at or below an absolute folder (the answer `pomade-git` asks
 *  before committing): Pomade's terminals and the agents app's tabs and runs (agents-live.ts), each
 *  with its state when known and the shells of the Pomade terminals it runs in. */
async function agentsLiveInCall(params: unknown): Promise<AppCallOutcome> {
  const folder = (params as { folder?: unknown } | null)?.folder
  if (typeof folder !== 'string' || !isAbsolute(folder)) return errorOutcome('invalid-params', '"folder" must be an absolute path')
  const agents = await agentsLiveIn(folder)
  return { ok: true, value: { live: agents.length > 0, agents } }
}

/** `notices.post` from a platform command: the same check as an app's (its action needs no
 *  capability here — the platform may open any tab), shown with the `source` it names
 *  (`pomade-git`), else `pomade`. */
function platformNotice(params: unknown): Promise<AppCallOutcome> {
  const n = checkNotice(params ?? {})
  if (!n.ok) return Promise.resolve(n)
  const source = (params as { source?: unknown }).source
  const appId = typeof source === 'string' && APP_ID_RE.test(source) ? source : PLATFORM_CLIENT_ID
  return serveInRenderer({ method: 'notices.post', params: n.value, appId })
}

/** One of Pomade's own commands (`PLATFORM_CLIENT_ID`). */
async function platformCall(method: string, params: unknown): Promise<AppCallOutcome> {
  if (method === 'apps.call') return callFromPlatform(params)
  if (method === 'agents.liveIn') return agentsLiveInCall(params)
  if (method === 'notices.post') return platformNotice(params)
  if (method === 'host.info') {
    return { ok: true, value: { pomadeVersion: pomadeVersion(), hostApi: HOST_API_VERSION, appId: PLATFORM_CLIENT_ID, surface: 'command', route: '', skills: [] } }
  }
  return errorOutcome('capability-denied', `${method} is not available to a platform command`)
}

async function answer(c: Connection, msg: IncomingCall): Promise<AppCallOutcome> {
  if (!c.welcomed) return notReady('Call before welcome')
  if (c.appId === PLATFORM_CLIENT_ID) return platformCall(msg.method, msg.params)
  if (FRAME_ONLY_METHODS.includes(msg.method)) {
    return errorOutcome('capability-denied', `${msg.method} needs an app frame; a backend or a command cannot call it`)
  }
  const outcome = await call(c.sessionId, msg.method, msg.params, { activeProject })
  return 'delegate' in outcome ? serveInRenderer(outcome.delegate) : outcome
}

function onConnection(socket: Socket, userData: string): void {
  const c: Connection = { socket, sessionId: '', welcomed: false, appId: '', role: 'command' }
  connections.add(c)
  const decoder = createLineDecoder()
  const helloTimer = setTimeout(() => {
    if (!c.welcomed) socket.destroy()
  }, HELLO_TIMEOUT_MS)
  // Messages are handled in order: a call right after `hello` waits for the handshake.
  let queue: Promise<void> = Promise.resolve()
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    let messages: unknown[]
    try {
      messages = decoder.push(chunk)
    } catch {
      socket.destroy()
      return
    }
    for (const raw of messages) {
      const msg = parseAppMessage(raw)
      if (!msg) continue
      if (msg.type === 'hello') {
        queue = queue.then(() => onHello(c, msg.hostApi, msg.client, userData))
      } else if (msg.type === 'call') {
        // Calls run concurrently once the handshake before them is done; each answers by id.
        queue = queue.then(() => {
          void answer(c, msg).then((res) =>
            send(c, res.ok
              ? { channel: CHANNEL, type: 'result', id: msg.id, ok: true, value: res.value }
              : { channel: CHANNEL, type: 'result', id: msg.id, ok: false, error: res.error })
          )
        })
      }
      else if (msg.type === 'response') {
        if (c.welcomed) brokerRespond(c.sessionId, msg.id, msg)
      }
      // `key` messages are a frame's; a socket client has no keyboard.
    }
  })
  const close = (): void => {
    clearTimeout(helloTimer)
    endSession(c)
    connections.delete(c)
  }
  socket.on('close', close)
  socket.on('error', () => socket.destroy())
}

/** True when something answers on `path` (another Pomade with the same user data). */
function probe(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(path)
    s.once('connect', () => {
      s.destroy()
      resolve(true)
    })
    s.once('error', () => resolve(false))
  })
}

/** Start listening. The socket is optional infrastructure: a failure is logged and Pomade runs
 *  without it (apps' UIs still work; backends and commands answer "Pomade not running"). */
export async function startHostSocket(userData: string): Promise<string | null> {
  const dir = join(userData, SOCKET_DIR)
  const path = join(dir, SOCKET_FILE)
  const tooLong = socketPathProblem(path)
  if (tooLong) {
    console.error(`[host-socket] not started: ${tooLong}`)
    return null
  }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.chmod(dir, 0o700)
  if (await probe(path)) {
    console.error(`[host-socket] not started: another Pomade is listening on ${path}`)
    return null
  }
  await fs.rm(path, { force: true })
  // The platform client's key, for Pomade's own commands.
  await ensureAppKey(userData, PLATFORM_CLIENT_ID)
  const srv = createServer((socket) => onConnection(socket, userData))
  try {
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject)
      srv.listen(path, () => {
        srv.off('error', reject)
        resolve()
      })
    })
  } catch (err) {
    console.error(`[host-socket] not started: ${(err as Error).message}`)
    return null
  }
  await fs.chmod(path, 0o600)
  server = srv
  socketPath = path
  return path
}

/** The socket's path while listening. */
export function hostSocketPath(): string | null {
  return socketPath
}

/** Close every connection and remove the socket file (quit). */
export function stopHostSocket(): void {
  for (const c of connections) c.socket.destroy()
  connections.clear()
  server?.close()
  server = null
  if (socketPath) {
    rmSync(socketPath, { force: true })
    socketPath = null
  }
}

/** Every hosted app has a key, whoever made it available (an install while Pomade was closed, a
 *  dev link, `POMADE_DEV_APPS`). */
async function issueKeys(userData: string): Promise<void> {
  for (const id of knownAppIds()) {
    if (appManifest(id)) await ensureAppKey(userData, id)
  }
}

export function registerHostSocket(ipc: IpcMain): void {
  onAppsChanged(() => {
    issueKeys(app.getPath('userData')).catch((err: unknown) => console.error('[host-socket] issuing app keys failed', err))
  })
  defineHandler(ipc, CH.apps.setActiveProject, (_e, ref) => setActiveProject(ref))
  defineHandler(ipc, CH.apps.delegatedResult, (_e, requestId, outcome) => delegatedResult(requestId, outcome))
}
