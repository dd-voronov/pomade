// Pomade — E-027/E-030 host side of the Host API (docs/HOST-API.md §3–§4).
//
// The renderer owns each app <iframe>: it accepts protocol messages only from the frame it
// created and relays them here keyed by a renderer-minted frameId, together with the app id of
// the tab that frame belongs to — the app is identified by its frame, never by a message field.
// E-028 — a backend's or command's connection on the local socket (`host-socket.ts`) is a session
// here too, keyed by a socket session id, its app identified by the key it presented. Main owns
// everything that matters for safety: the sessions, the manifest's capability gate (enforced
// HERE, not only in the renderer), params validation, the workspace-escape guard and every
// method. Each session has a sink — how its events reach it (IPC to the frame's window, or lines
// on the socket). File watches ride the single platform watcher (`fs-watch.ts`). E-031 — each
// session is one connection on the event bus (`event-bus.ts`); a frame is subscribed to
// `project.changed` and `theme.changed` from its handshake on.

import { promises as fs, type Dirent } from 'node:fs'
import { join } from 'node:path'

import type { IpcMain, WebContents } from 'electron'

import {
  HOST_API_VERSION,
  isMarkdownPath,
  isPomadeFolderPath,
  readFrontmatter,
  resolveFrameTarget,
  checkNotice,
  noticeActionCapability,
  panelShowIcon,
  panelShowNotFound,
  type FileChange,
  type FileEntry,
  type BusMember,
  type FrameTarget,
  type JsonValue,
  type MethodParams,
  type MethodResult,
  type ProjectRef
} from 'pomade-kit/protocol'

import { CH, EV } from '@shared/ipc-api'
import { createSettler, type Settler } from '@shared/settle'
import type {
  AppBadge,
  AppBusEvent,
  AppCallContext,
  AppCallOutcome,
  AppCallResult,
  AppFilesChanged,
  AppFrameOpen,
  AppFrameRequest,
  AppStateChanged,
  AppApiRequest
} from '@shared/types'
import { appFolder, appManifest, listApps, refreshApps } from './app-registry'
import { getAppState, setAppState } from './app-state'
import { configStore, onWorkspaceTeardown, pomadeVersion } from './config-store'
import { pomadeTheme } from './theme'
import { holdAppWatch, releaseAppWatch, tapWorkspaceChanges, type RawWorkspaceChange } from './fs-watch'
import {
  classifyChanges,
  gateMethod,
  negotiate,
  parseOpenAppParams,
  parseParams,
  watchCovers,
  workspacePath,
  type ObservedChange
} from './host-api-core'
import { hasIgnoredSegment } from './fs-shared'
import { diffReadings, readScope, readSignature, type ScopeReading } from './watch-scope'
import { defineHandler } from './ipc'
import { absOf, CallError, fsError, isRealPomadeFolder, requireNotPomadeFolder } from './host-api-fs'
import { callAgentTabs, callData, pickFolder } from './host-api-data'
import { isDataMethod } from './host-api-data-core'
import { callEvents, openBusConnection } from './event-bus'
import { callFromApp, dropSession, respond as brokerRespond, serveApi } from './app-broker'

/** Changes reach the app batched: one message per watch per window (§4 "within ~1 s"). */
const WATCH_BATCH_MS = 120
/** Parallel file reads while collecting frontmatter. */
const READ_CONCURRENCY = 16

interface AppWatch {
  id: string
  /** The watched path (workspace-relative). */
  path: string
  recursive: boolean
  /** The fs-watch entry key this watch holds. */
  heldKey: string
  /** Raw events since the last flush: path → saw a structural ('rename') event. */
  pending: Map<string, boolean>
  timer: NodeJS.Timeout | null
  /** T-243 — the scope as last read or reported (`watch-scope.ts`); the settle diffs against it. */
  reading: ScopeReading
  /** The reading covers the whole scope; false past SCOPE_MAX_ENTRIES, when the settle re-reads
   *  only `recent`. */
  whole: boolean
  /** The paths the last batch reported. */
  recent: Set<string>
  /** Resolves once the registration reading is taken; batches wait for it. */
  ready: Promise<void>
  settler: Settler
}

/** How a session's events reach its client. */
export interface SessionSink {
  /** False once the client is gone (its window destroyed, its socket closed). */
  alive(): boolean
  filesChanged(watchId: string, changes: FileChange[]): void
  stateChanged(key: string, value: AppStateChanged['value']): void
  badge(badge: AppBadge): void
  /** E-031/E-028 — a bus event for a socket client (frames get theirs through `apps:event`). */
  event(name: string, payload: unknown): void
  /** E-028 — another app's call to the API this session serves (`api.serve`). */
  request(requestId: string, from: string, method: string, params: JsonValue): void
}

interface Session {
  appId: string
  /** What the client was opened for (§3 `welcome`, `host.info`). */
  target: FrameTarget
  sink: SessionSink
  /** The window hosting a frame; null for a socket client. */
  owner: WebContents | null
  watches: Map<string, AppWatch>
  /** E-031 — the frame's connection on the event bus. */
  bus: BusMember
  /** E-031 — the project the frame last saw (its welcome's, then each `project.changed`). */
  project: ProjectRef | null
}

function sameProject(a: ProjectRef | null, b: unknown): boolean {
  const r = b as ProjectRef
  return a !== null && a.id === r.id && a.kind === r.kind && a.name === r.name && a.root === r.root
}

/** Every live session: app frames by frameId, socket clients by their socket session id. */
const frames = new Map<string, Session>()
const trackedContents = new WeakSet<WebContents>()
let watchSeq = 0
let untap: (() => void) | null = null

// ─── files.readFolder ─────────────────────────────────────────────────────────

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

async function readFolder(
  params: MethodParams<'files.readFolder'>
): Promise<MethodResult<'files.readFolder'>> {
  const rootRel = params.path
  const rootAbs = absOf(rootRel)
  let st
  try {
    st = await fs.stat(rootAbs)
  } catch (err) {
    throw fsError(err, rootRel)
  }
  if (!st.isDirectory()) throw new CallError('io-error', `${JSON.stringify(rootRel)} is not a folder`)
  await requireNotPomadeFolder(rootAbs, rootRel)
  // The workspace's tree ignored items (`.git`, `node_modules`, …) apply at every depth.
  const ignore = new Set(await configStore.getTreeIgnore())

  const entries: FileEntry[] = []
  const markdown: FileEntry[] = []
  let level = [rootRel]
  while (level.length > 0) {
    const nextLevel: string[] = []
    for (const dirRel of level) {
      let dirents: Dirent[]
      try {
        dirents = await fs.readdir(dirRel === rootRel ? rootAbs : absOf(dirRel), { withFileTypes: true })
      } catch (err) {
        // The requested folder itself failing is an error; an unreadable sub-folder stays listed
        // (as its own entry) without children.
        if (dirRel === rootRel) throw fsError(err, rootRel)
        continue
      }
      for (const d of dirents) {
        if (ignore.has(d.name)) continue
        if (!d.isDirectory() && !d.isFile() && !d.isSymbolicLink()) continue
        const rel = dirRel ? `${dirRel}/${d.name}` : d.name
        // The workspace's .pomade folder, and links into it, are never listed (rule 3).
        if (isPomadeFolderPath(rel) || (d.isSymbolicLink() && (await isRealPomadeFolder(absOf(rel))))) continue
        const entry: FileEntry = { path: rel, name: d.name, kind: 'file', size: 0, mtimeMs: 0 }
        let statError: string | null = null
        try {
          // Follows symlinks: a link reports what it points to.
          const s = await fs.stat(absOf(rel))
          entry.kind = s.isDirectory() ? 'dir' : 'file'
          entry.size = s.isDirectory() ? 0 : s.size
          entry.mtimeMs = s.mtimeMs
        } catch (err) {
          statError = (err as Error).message
          entry.kind = d.isDirectory() ? 'dir' : 'file'
        }
        entries.push(entry)
        // A symlinked folder is listed, never descended into (cycle-safe, like the tree walk).
        if (entry.kind === 'dir' && params.recursive && d.isDirectory()) nextLevel.push(rel)
        if (params.frontmatter && entry.kind === 'file' && isMarkdownPath(d.name)) {
          if (statError) entry.frontmatterError = `unreadable: ${statError}`
          else markdown.push(entry)
        }
      }
    }
    level = nextLevel
  }

  await mapLimit(markdown, READ_CONCURRENCY, async (entry) => {
    let text: string
    try {
      text = await fs.readFile(absOf(entry.path), 'utf8')
    } catch (err) {
      entry.frontmatterError = `unreadable: ${(err as Error).message}`
      return
    }
    Object.assign(entry, readFrontmatter(text))
  })

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { entries }
}

// ─── files.watch / files.unwatch ──────────────────────────────────────────────

async function probe(rel: string): Promise<{ present: boolean; isDir: boolean; signature: string | null }> {
  const signature = await readSignature(absOf(rel))
  return { present: signature !== null, isDir: signature === 'd', signature }
}

function queueFlush(frameId: string, session: Session, w: AppWatch): void {
  w.timer ??= setTimeout(() => void flushWatch(frameId, session, w), WATCH_BATCH_MS)
}

async function flushWatch(frameId: string, session: Session, w: AppWatch): Promise<void> {
  await w.ready
  w.timer = null
  const pending = [...w.pending]
  w.pending.clear()
  // The workspace's tree ignored items apply to watch events too (§4), below the watched path.
  const ignore = new Set(await configStore.getTreeIgnore())
  const observed: ObservedChange[] = []
  w.recent.clear()
  for (const [path, structural] of pending) {
    const below = w.path === '' ? path : path.slice(w.path.length + 1)
    if (below && hasIgnoredSegment(below, ignore)) continue
    const { signature, ...state } = await probe(path)
    observed.push({ path, structural, ...state })
    w.recent.add(path)
    await recordInReading(w, path, signature, ignore)
  }
  if (!session.watches.has(w.id)) return
  w.settler.kick()
  const changes: FileChange[] = classifyChanges(observed)
  if (changes.length === 0 || !session.sink.alive() || frames.get(frameId) !== session) return
  session.sink.filesChanged(w.id, changes)
}

/** Keep the watch's reading in step with what a batch reports, so the settle reports only what
 *  no batch did: a vanished folder drops its subtree; a folder that appeared brings its own. */
async function recordInReading(w: AppWatch, path: string, signature: string | null, ignore: Set<string>): Promise<void> {
  const prefix = `${path}/`
  if (signature !== 'd') {
    for (const p of [...w.reading.keys()]) if (p.startsWith(prefix)) w.reading.delete(p)
  }
  if (signature === null) {
    w.reading.delete(path)
    return
  }
  w.reading.set(path, signature)
  if (signature === 'd' && w.whole && w.recursive) {
    const sub = await readScope(path, true, ignore, absOf)
    if (sub) for (const [p, sig] of sub) w.reading.set(p, sig)
  }
}

/** T-243 — one settle re-check: re-read the scope (or, past the cap, the last batch's paths) and
 *  queue whatever differs from the reading as if the watcher had reported it. */
async function settleWatch(frameId: string, session: Session, w: AppWatch): Promise<boolean> {
  await w.ready
  if (!session.watches.has(w.id)) return false
  let found: Map<string, boolean>
  if (w.whole) {
    const ignore = new Set(await configStore.getTreeIgnore())
    const now = await readScope(w.path, w.recursive, ignore, absOf)
    if (now === null) {
      // The scope outgrew the cap: from here on only the batches' paths are re-read.
      w.whole = false
      return false
    }
    found = diffReadings(w.reading, now)
    w.reading = now
  } else {
    found = new Map()
    for (const path of w.recent) {
      const sig = await readSignature(absOf(path))
      const old = w.reading.get(path) ?? null
      if (sig === old) continue
      found.set(path, sig === null || old === null || (sig === 'd') !== (old === 'd'))
      if (sig === null) w.reading.delete(path)
      else w.reading.set(path, sig)
    }
  }
  for (const [path, structural] of found) {
    if (isPomadeFolderPath(path)) continue
    w.pending.set(path, (w.pending.get(path) ?? false) || structural)
  }
  if (w.pending.size > 0) queueFlush(frameId, session, w)
  return found.size > 0
}

function onRawChange(change: RawWorkspaceChange): void {
  for (const [frameId, session] of frames) {
    for (const w of session.watches.values()) {
      if (!watchCovers(w.path, w.recursive, change.path) || isPomadeFolderPath(change.path)) continue
      w.pending.set(change.path, (w.pending.get(change.path) ?? false) || change.event === 'rename')
      queueFlush(frameId, session, w)
    }
  }
}

async function watch(
  frameId: string,
  session: Session,
  params: MethodParams<'files.watch'>
): Promise<MethodResult<'files.watch'>> {
  const rel = params.path
  let st
  try {
    st = await fs.stat(absOf(rel))
  } catch (err) {
    throw fsError(err, rel)
  }
  await requireNotPomadeFolder(absOf(rel), rel)
  // The platform watcher works per folder; a watched file rides its parent folder's entry.
  const dirRel = st.isDirectory() ? rel : rel.split('/').slice(0, -1).join('/')
  const heldKey = holdAppWatch(dirRel)
  if (heldKey === null) throw new CallError('io-error', `Cannot watch ${JSON.stringify(rel)}`)
  untap ??= tapWorkspaceChanges(onRawChange)
  const id = `w${++watchSeq}`
  let markReady: () => void = () => {}
  const w: AppWatch = {
    id,
    path: rel,
    recursive: !!params.recursive,
    heldKey,
    pending: new Map(),
    timer: null,
    reading: new Map(),
    whole: true,
    recent: new Set(),
    ready: new Promise((resolve) => (markReady = resolve)),
    settler: createSettler(() => settleWatch(frameId, session, w))
  }
  // Registered first, so an event during the registration reading is queued, not lost; the
  // reading is the baseline the settle diffs against — taken before the app gets its id, so any
  // change after `files.watch` returns is either reported by the watcher or found by the settle.
  session.watches.set(id, w)
  const ignore = new Set(await configStore.getTreeIgnore())
  const reading = await readScope(rel, w.recursive, ignore, absOf)
  if (reading) w.reading = reading
  else w.whole = false
  markReady()
  w.settler.kick()
  return { watchId: id }
}

function dropWatch(session: Session, watchId: string): void {
  const w = session.watches.get(watchId)
  if (!w) return
  if (w.timer) clearTimeout(w.timer)
  w.settler.dispose()
  session.watches.delete(watchId)
  releaseAppWatch(w.heldKey)
}

function dropFrame(frameId: string): void {
  const session = frames.get(frameId)
  if (!session) return
  for (const id of [...session.watches.keys()]) dropWatch(session, id)
  session.bus.close()
  frames.delete(frameId)
  dropSession(frameId)
}

// ─── state.set → state.changed ─────────────────────────────────────────────────

/** Every OTHER live frame of the app hears about the change (§4 `state.changed`). */
function notifyStateChanged(fromFrameId: string, appId: string, key: string, value: AppStateChanged['value']): void {
  for (const [frameId, session] of frames) {
    if (frameId === fromFrameId || session.appId !== appId || !session.sink.alive()) continue
    session.sink.stateChanged(key, value)
  }
}

// ─── Calls ────────────────────────────────────────────────────────────────────

export async function call(
  frameId: string,
  method: unknown,
  rawParams: unknown,
  ctx: AppCallContext
): Promise<AppCallResult> {
  const session = frames.get(frameId)
  if (!session) return { ok: false, error: { code: 'not-ready', message: 'No handshake for this frame' } }
  const manifest = appManifest(session.appId)
  if (!manifest) {
    return { ok: false, error: { code: 'not-ready', message: `App "${session.appId}" is not available` } }
  }
  const gate = gateMethod(method, manifest.capabilities)
  if (!gate.ok) return gate
  try {
    switch (gate.method) {
      case 'host.info':
        return {
          ok: true,
          value: {
            pomadeVersion: pomadeVersion(),
            hostApi: HOST_API_VERSION,
            appId: session.appId,
            ...session.target,
            skills: skillLocations(session.appId, manifest.skills)
          }
        }
      case 'project.getActive':
        return { ok: true, value: ctx.activeProject }
      case 'files.readFolder': {
        const p = parseParams('files.readFolder', rawParams)
        if (!p.ok) return p
        return { ok: true, value: await readFolder(p.params) }
      }
      case 'files.watch': {
        const p = parseParams('files.watch', rawParams)
        if (!p.ok) return p
        return { ok: true, value: await watch(frameId, session, p.params) }
      }
      case 'files.unwatch': {
        const p = parseParams('files.unwatch', rawParams)
        if (!p.ok) return p
        dropWatch(session, p.params.watchId)
        return { ok: true, value: {} }
      }
      case 'strip.setBadge': {
        const p = parseParams('strip.setBadge', rawParams)
        if (!p.ok) return p
        // An app badges only its own icons: the icon id is checked against ITS manifest.
        if (!manifest.strip.some((s) => s.id === p.params.icon)) {
          return {
            ok: false,
            error: { code: 'invalid-params', message: `No strip icon ${JSON.stringify(p.params.icon)} in the manifest` }
          }
        }
        const badge: AppBadge = {
          appId: session.appId,
          icon: p.params.icon,
          count: p.params.count,
          urgent: p.params.urgent === true
        }
        if (session.sink.alive()) session.sink.badge(badge)
        return { ok: true, value: {} }
      }
      case 'state.get': {
        const p = parseParams('state.get', rawParams)
        if (!p.ok) return p
        return { ok: true, value: { value: await getAppState(session.appId, p.params.key) } }
      }
      case 'state.set': {
        const p = parseParams('state.set', rawParams)
        if (!p.ok) return p
        await setAppState(session.appId, p.params.key, p.params.value)
        notifyStateChanged(frameId, session.appId, p.params.key, p.params.value)
        return { ok: true, value: {} }
      }
      case 'tabs.openApp': {
        // The app's own tab: renderer-owned state, served by the frame bridge (the target project
        // is checked there, like tabs.openFile's).
        const p = parseOpenAppParams(rawParams, manifest.tabKinds)
        if (!p.ok) return p
        return { delegate: { method: 'tabs.openApp', params: p.params, appId: session.appId } }
      }
      case 'tabs.setRoute':
      case 'tabs.setTitle':
      case 'tabs.close': {
        // T-268 — a tab frame's own tab, renderer-owned: the frame bridge knows which tab it is. A
        // backend or a command never gets here: the methods are frame-only (`host-socket.ts`).
        if (session.target.surface !== 'tab') {
          return { ok: false, error: { code: 'invalid-params', message: `${gate.method} is only for a tab frame` } }
        }
        const p = parseParams(gate.method, rawParams)
        if (!p.ok) return p
        if (gate.method === 'tabs.setRoute') {
          // T-269 — the frame navigated by itself: `host.info` answers its route from now on.
          const params = p.params as MethodParams<'tabs.setRoute'>
          session.target = { ...session.target, route: params.route }
          return { delegate: { method: 'tabs.setRoute', params } }
        }
        return gate.method === 'tabs.setTitle'
          ? { delegate: { method: 'tabs.setTitle', params: p.params as MethodParams<'tabs.setTitle'> } }
          : { delegate: { method: 'tabs.close', params: {} } }
      }
      case 'events.publish':
      case 'events.subscribe':
      case 'events.unsubscribe':
      case 'events.hasSubscribers': {
        const p = parseParams(gate.method, rawParams)
        if (!p.ok) return p
        // A sticky event (`pomade.ready`) is sent after this call's answer is on its way.
        const params = p.params as unknown as Record<string, unknown>
        return callEvents(session.bus, manifest.events, gate.method, params, (deliver) => setImmediate(deliver))
      }
      case 'notices.post': {
        // E-032 — checked here (the notice, and the capability its action needs), shown by the renderer.
        const n = checkNotice(rawParams ?? {})
        if (!n.ok) return n
        const needs = noticeActionCapability(n.value.action)
        if (needs && !manifest.capabilities.includes(needs)) {
          return {
            ok: false,
            error: { code: 'capability-denied', message: `A notice that opens a tab needs the "${needs}" capability` }
          }
        }
        return { delegate: { method: 'notices.post', params: n.value, appId: session.appId } }
      }
      case 'apps.call':
        return await callFromApp(session.appId, rawParams)
      case 'api.serve':
        return serveApi(frameId, session.appId, session.target.surface === 'backend', (id, from, method, params) =>
          session.sink.request(id, from, method, params)
        )
      case 'agents.liveIn':
        // Unreachable for an app (the gate refused it): the platform client is served by the socket.
        return { ok: false, error: { code: 'capability-denied', message: "agents.liveIn is for Pomade's own commands" } }
      case 'agentTabs.list':
      case 'agentTabs.setTitle':
      case 'agentTabs.focus':
      case 'agentTabs.launch':
      case 'agentTabs.resume':
        // E-033 — the agent tabs are renderer-owned (`modules/agents/agent-tabs.ts`).
        return await callAgentTabs(gate.method, rawParams)
      case 'overlay.open': {
        // T-236 — the app's own overlay, from its tab or panel frame; the renderer checks the frame
        // is shown and opens it on the shortcut path (`overlay-store.ts`). A backend or a command
        // never gets here: the method is frame-only (`host-socket.ts`).
        if (session.target.surface === 'overlay') {
          return {
            ok: false,
            error: { code: 'invalid-params', message: 'overlay.open is for a tab or a panel frame; an overlay is already open' }
          }
        }
        const p = parseParams('overlay.open', rawParams)
        if (!p.ok) return p
        return { delegate: { method: 'overlay.open', params: p.params, appId: session.appId } }
      }
      case 'panel.show': {
        // T-325 — the app's own side panel, from any of its frames, shown or hidden: the icon is
        // checked against ITS manifest here; the renderer shows the panel (`delegated-calls.ts`). A
        // backend or a command never gets here: the method is frame-only (`host-socket.ts`).
        const p = parseParams('panel.show', rawParams)
        if (!p.ok) return p
        const icon = panelShowIcon(manifest.strip, p.params.icon)
        if (!icon) return { ok: false, error: { code: 'not-found', message: panelShowNotFound(p.params.icon) } }
        const { route } = p.params
        return {
          delegate: { method: 'panel.show', params: { icon: icon.id, ...(route !== undefined ? { route } : {}) }, appId: session.appId }
        }
      }
      case 'overlay.resize': {
        if (session.target.surface !== 'overlay') {
          return { ok: false, error: { code: 'invalid-params', message: 'overlay.resize is only for an overlay frame' } }
        }
        const p = parseParams('overlay.resize', rawParams)
        if (!p.ok) return p
        return { delegate: { method: 'overlay.resize', params: p.params } }
      }
      case 'overlay.close':
        if (session.target.surface !== 'overlay') {
          return { ok: false, error: { code: 'invalid-params', message: 'overlay.close is only for an overlay frame' } }
        }
        return { delegate: { method: 'overlay.close', params: {} } }
      default:
        // E-030 — the workspace-data methods (`host-api-data.ts`); a method the kit knows and this
        // Pomade does not serve is `unknown-method`.
        if (!isDataMethod(gate.method)) {
          return { ok: false, error: { code: 'unknown-method', message: `No method ${JSON.stringify(gate.method)} in this Pomade` } }
        }
        return await callData(gate.method, rawParams, { appId: session.appId, symlinks: manifest.symlinks })
    }
  } catch (err) {
    if (err instanceof CallError) return { ok: false, error: { code: err.code, message: err.message } }
    return { ok: false, error: { code: 'io-error', message: (err as Error)?.message ?? String(err) } }
  }
}

/** E-030 — the dialog half of a delegated `files.pickFolder`: the frame's session and its
 *  `files.read` capability are checked again here, and both paths by the path rule. */
async function pickFolderFor(frameId: string, root: unknown, initial: unknown): Promise<AppCallOutcome> {
  const session = frames.get(frameId)
  if (!session) return { ok: false, error: { code: 'not-ready', message: 'No handshake for this frame' } }
  const manifest = appManifest(session.appId)
  if (!manifest) {
    return { ok: false, error: { code: 'not-ready', message: `App "${session.appId}" is not available` } }
  }
  const gate = gateMethod('files.pickFolder', manifest.capabilities)
  if (!gate.ok) return gate
  const rootPath = workspacePath(root)
  if (!rootPath.ok) return rootPath
  const initialPath = initial === undefined ? undefined : workspacePath(initial)
  if (initialPath && !initialPath.ok) return initialPath
  try {
    return { ok: true, value: { path: await pickFolder(rootPath.path, initialPath?.path) } }
  } catch (err) {
    if (err instanceof CallError) return { ok: false, error: { code: err.code, message: err.message } }
    return { ok: false, error: { code: 'io-error', message: (err as Error)?.message ?? String(err) } }
  }
}

/** E-027 — where each shipped skill is: its folder's absolute path in the installed or folder-linked
 *  build; null for a dev-server link (no local folder). */
function skillLocations(appId: string, skills: readonly { name: string; path: string }[]): { name: string; path: string | null }[] {
  const folder = appFolder(appId)
  return skills.map((k) => ({ name: k.name, path: folder ? join(folder, k.path) : null }))
}

/** A frame's events go to the window that hosts it, keyed by frameId. */
function frameSink(wc: WebContents, frameId: string): SessionSink {
  return {
    alive: () => !wc.isDestroyed(),
    filesChanged: (watchId, changes) => {
      const batch: AppFilesChanged = { frameId, watchId, changes }
      wc.send(EV.appsFilesChanged, batch)
    },
    stateChanged: (key, value) => {
      const change: AppStateChanged = { frameId, key, value }
      wc.send(EV.appsStateChanged, change)
    },
    badge: (badge) => wc.send(EV.appsBadge, badge),
    // A frame's bus events go through its bus connection's own delivery (`apps:event`).
    event: () => undefined,
    request: (requestId, from, method, params) => {
      const req: AppApiRequest = { frameId, requestId, from, method, params }
      wc.send(EV.appsApiRequest, req)
    }
  }
}

/** E-028 — open a socket client's session (`host-socket.ts` has authenticated it). */
export function openSession(sessionId: string, appId: string, target: FrameTarget, sink: SessionSink): void {
  dropFrame(sessionId)
  const session: Session = {
    appId,
    target,
    sink,
    owner: null,
    watches: new Map(),
    project: null,
    // A socket client hears only the events it subscribes to (`events.subscribe`, as its manifest
    // declares) — `project.changed` included.
    bus: openBusConnection({
      appId,
      deliver: (name, payload) => {
        if (frames.get(sessionId) === session && sink.alive()) sink.event(name, payload)
      }
    })
  }
  frames.set(sessionId, session)
}

/** E-028 — end a socket client's session: its watches go with it. */
export function closeSession(sessionId: string): void {
  dropFrame(sessionId)
}

function openFrame(
  wc: WebContents,
  frameId: string,
  appId: string,
  appHostApi: unknown,
  request: AppFrameRequest
): AppFrameOpen {
  dropFrame(frameId)
  const manifest = appManifest(appId)
  if (!manifest) return { status: 'unavailable', reason: `App "${appId}" is not available` }
  const verdict = negotiate(appHostApi)
  if (verdict === 'ignore') return { status: 'unavailable', reason: 'Not a hello: "hostApi" is not an integer' }
  if (verdict !== 'welcome') return { status: 'reject', reason: verdict, hostApi: HOST_API_VERSION }
  const surface = request.surface === 'panel' || request.surface === 'overlay' ? request.surface : 'tab'
  // An overlay has no strip icon: it renders the route of the shortcut that opened it (request.route).
  const target: FrameTarget =
    surface === 'overlay' ? { surface, route: '' } : resolveFrameTarget(manifest.strip, surface, request.icon)
  if (typeof request.route === 'string') target.route = request.route
  // T-268 — a keyed tab's frame knows its key and kind (as its tab recorded them).
  if (surface === 'tab' && typeof request.key === 'string') {
    target.key = request.key
    if (typeof request.kind === 'string') target.kind = request.kind
  }
  const session: Session = {
    appId,
    target,
    sink: frameSink(wc, frameId),
    owner: wc,
    watches: new Map(),
    project: request.project ?? null,
    bus: openBusConnection(
      {
        appId,
        deliver: (name, payload) => {
          if (wc.isDestroyed() || frames.get(frameId) !== session) return
          // `project.changed` only when it differs from what this frame last saw.
          if (name === 'project.changed') {
            if (sameProject(session.project, payload)) return
            session.project = payload as unknown as ProjectRef
          }
          const event: AppBusEvent = { frameId, name, payload }
          try {
            wc.send(EV.appsEvent, event)
          } catch {
            /* the window is going away (quit): nothing left to deliver to */
          }
        }
      },
      // Every frame hears `project.changed` and `theme.changed` (its welcome carries the project
      // and the theme), subscribed or not.
      ['project.changed', 'theme.changed']
    )
  }
  frames.set(frameId, session)
  if (!trackedContents.has(wc)) {
    trackedContents.add(wc)
    // A renderer reload or crash takes every frame it hosted with it.
    const dropAll = (): void => {
      for (const [id, s] of [...frames]) if (s.owner === wc) dropFrame(id)
    }
    wc.on('did-navigate', dropAll)
    wc.on('render-process-gone', dropAll)
    wc.once('destroyed', dropAll)
  }
  return { status: 'welcome', pomadeVersion: pomadeVersion(), hostApi: HOST_API_VERSION, target, theme: pomadeTheme() }
}

export function registerHostApi(ipc: IpcMain): void {
  defineHandler(ipc, CH.apps.list, () => listApps())
  defineHandler(ipc, CH.apps.refresh, async () => {
    await refreshApps()
    return listApps()
  })
  defineHandler(ipc, CH.apps.openFrame, (e, frameId, appId, appHostApi, request) =>
    openFrame(e.sender, frameId, appId, appHostApi, request)
  )
  defineHandler(ipc, CH.apps.closeFrame, (_e, frameId) => {
    dropFrame(frameId)
  })
  defineHandler(ipc, CH.apps.call, (_e, frameId, method, params, ctx) => call(frameId, method, params, ctx))
  defineHandler(ipc, CH.apps.pickFolder, (_e, frameId, root, initial) => pickFolderFor(frameId, root, initial))
  // E-028 — a frame's answer to a broker request.
  defineHandler(ipc, CH.apps.apiResponse, (_e, frameId, requestId, outcome) => {
    if (typeof frameId === 'string' && typeof requestId === 'string' && outcome && typeof outcome === 'object') {
      brokerRespond(frameId, requestId, outcome)
    }
  })
  defineHandler(ipc, CH.apps.setRoute, (_e, frameId, route) => {
    const session = frames.get(frameId)
    if (session && typeof route === 'string') session.target = { ...session.target, route }
  })
  // Watches belong to the workspace they were taken in; a switch ends them (the frames
  // themselves close as the renderer tears the old workspace's tabs down).
  onWorkspaceTeardown(() => {
    for (const session of frames.values()) {
      for (const id of [...session.watches.keys()]) dropWatch(session, id)
    }
  })
}
