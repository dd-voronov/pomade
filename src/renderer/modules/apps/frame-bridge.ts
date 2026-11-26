// Pomade — E-027 frame bridge: the renderer half of the Host API host (docs/HOST-API.md §3).
//
// One bridge per app <iframe> element — a tab's or a side panel's (E-029); the frame request
// (surface + strip icon) goes to main with every hello, and main's resolved target (surface,
// icon, route) rides the `welcome`. It accepts protocol messages ONLY from that frame's
// window (the app is identified by the frame Pomade created for its tab — never by a message
// field), ignores anything the kit's `parseAppMessage` rejects (and any `key` that is not a
// Cmd/Ctrl chord, or is one main runs natively — see `isForwardedKey`), and relays:
//   hello → `apps.openFrame` (main negotiates; each hello is a new handshake with a fresh frameId,
//           and closing the previous one drops its watches)
//   call  → `apps.call` (main gates capabilities and runs the method; a call it hands back as
//           `{ delegate }` — renderer-owned state, E-030 — is served by `delegated-calls.ts`).
//           Every call is answered exactly once while the frame lives (T-271): a call still in
//           flight when a new handshake starts is answered before that handshake's `welcome` —
//           with its result when it has one by then, else `not-ready`. Before the new `welcome`
//           the frame's document has no calls of its own, so a late answer can never meet the id
//           of a call a reloaded document made; a frame that is gone (disposed) is answered nothing.
//   key   → a synthetic keydown on the <iframe> element, so Pomade's window-level shortcuts run
//           as if the key had been pressed in Pomade; a plain Escape from an overlay frame
//           closes the overlay instead. A chord main runs (`MAIN_SHORTCUTS`: the menu
//           accelerators, Cmd+Shift+B) is not relayed — it reached main natively, and relaying
//           it too would run it twice
// and delivers events: the bus's (E-031 — `project.changed` and `theme.changed` for every frame,
// hidden ones too, and whatever the frame subscribed to; main decides what reaches which frame),
// `files.changed`, `state.changed` and `git.changed` (`git-calls.ts` holds the frame's git watches).

import { nanoid } from 'nanoid'

import {
  chordMatches,
  parseAppMessage,
  parseChord,
  type EventMessage,
  type HostToAppMessage,
  type IncomingCall,
  type IncomingResponse,
  type KeyMessage,
  type ProjectRef
} from 'pomade-kit/protocol'

import { MAIN_SHORTCUTS } from '@shared/app-manifest'
import type { AppApiRequest, AppBusEvent, AppCallOutcome, AppFilesChanged, AppFrameRequest, AppStateChanged, Id } from '@shared/types'
import { serveDelegated } from './delegated-calls'
import { onGitChanged } from './git-calls'
import { projectRefOf } from './project-ref'

// ─── One shared IPC listener per frame event, dispatched by frameId ───────────
function perFrame<T extends { frameId: string }>(
  subscribe: (cb: (payload: T) => void) => () => void
): (frameId: string, cb: (payload: T) => void) => () => void {
  const listeners = new Map<string, (payload: T) => void>()
  let subscribed = false
  return (frameId, cb) => {
    if (!subscribed) {
      subscribed = true
      subscribe((payload) => listeners.get(payload.frameId)?.(payload))
    }
    listeners.set(frameId, cb)
    return () => {
      if (listeners.get(frameId) === cb) listeners.delete(frameId)
    }
  }
}
const onFilesChanged = perFrame<AppFilesChanged>((cb) => window.pomade.apps.onFilesChanged(cb))
const onStateChanged = perFrame<AppStateChanged>((cb) => window.pomade.apps.onStateChanged(cb))
const onBusEvent = perFrame<AppBusEvent>((cb) => window.pomade.apps.onEvent(cb))
const onApiRequest = perFrame<AppApiRequest>((cb) => window.pomade.apps.onApiRequest(cb))

/** A call the frame made that has not been answered yet, and the session it was made in. */
interface PendingCall {
  id: string
  frameId: string
}

const SESSION_ENDED: AppCallOutcome = {
  ok: false,
  error: { code: 'not-ready', message: 'The frame started a new handshake before this call was answered' }
}

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Shift', 'Alt', 'AltGraph', 'CapsLock', 'Fn', 'OS'])

const MAIN_CHORDS = Object.keys(MAIN_SHORTCUTS).flatMap((key) => parseChord(key) ?? [])

/** The forwarded keys Pomade relays (§3): made with Cmd or Ctrl held, not a modifier key pressed
 *  alone (so an app can never inject plain keystrokes into Pomade's shortcut handling), and not a
 *  chord main runs — the frame left it unhandled, so the menu (or main's before-page match) has
 *  already run it once. */
export function isForwardedKey(msg: KeyMessage): boolean {
  if (!(msg.metaKey || msg.ctrlKey) || MODIFIER_KEYS.has(msg.key)) return false
  return !MAIN_CHORDS.some((chord) => chordMatches(chord, msg))
}

/** A plain Escape (no modifier): forwarded by an overlay frame, it closes the overlay (§3). */
export function isOverlayEscape(msg: KeyMessage): boolean {
  return msg.key === 'Escape' && !msg.metaKey && !msg.ctrlKey && !msg.altKey && !msg.shiftKey
}

export class FrameBridge {
  private frameId: string | null = null
  /** The latest handshake; calls wait for it, so a call sent right after `welcome` is never
   *  answered `not-ready` by a race. */
  private handshake: Promise<void> = Promise.resolve()
  /** The route the welcomed frame renders now (its welcome route, then each navigation). */
  private route: string | null = null
  private offFrameEvents: (() => void)[] = []
  private disposed = false
  /** Calls not answered yet (T-271): each is answered once, before the next handshake's welcome. */
  private readonly pending = new Set<PendingCall>()

  constructor(
    private readonly iframe: HTMLIFrameElement,
    private readonly appId: string,
    private request: AppFrameRequest,
    private readonly activeProject: () => ProjectRef,
    /** The overlay frame asked to close (`overlay.close`, a forwarded plain Escape). */
    private readonly onClose: () => void,
    /** The frame's own project now — a tab frame's tab's project; none = the active project. */
    private readonly ownProject: () => Id | undefined = () => undefined,
    /** T-268 — a tab frame's tab: what `tabs.setTitle` / `tabs.close` act on. */
    private readonly tabId?: Id
  ) {}

  private post(msg: HostToAppMessage): void {
    // The frame is ours; '*' because a custom-scheme origin has no portable string form.
    this.iframe.contentWindow?.postMessage(msg, '*')
  }

  /** The window `message` listener. */
  handleMessage = (e: MessageEvent): void => {
    if (this.disposed || e.source === null || e.source !== this.iframe.contentWindow) return
    const msg = parseAppMessage(e.data)
    if (!msg) return
    if (msg.type === 'hello') {
      const hostApi = msg.hostApi
      // A failed handshake leaves the frame without a session (its calls answer `not-ready`);
      // it never stalls the handshakes and calls queued after it.
      this.handshake = this.handshake
        .then(() => this.open(hostApi))
        .catch((err: unknown) => console.error('[apps] handshake failed', err))
    } else if (msg.type === 'call') this.onCall(msg)
    else if (msg.type === 'response') this.onResponse(msg)
    else if (this.request.surface === 'overlay' && isOverlayEscape(msg)) this.onClose()
    else if (isForwardedKey(msg)) this.onKey(msg)
  }

  /** A new handshake: end the previous session (dropping its watches), then open a new one. */
  private async open(hostApi: number): Promise<void> {
    this.closeSession()
    const frameId = nanoid()
    // Main delivers `project.changed` only when the active project differs from the one in front now.
    const active = this.activeProject()
    const res = await window.pomade.apps.openFrame(frameId, this.appId, hostApi, { ...this.request, project: active })
    if (this.disposed) {
      if (res.status === 'welcome') void window.pomade.apps.closeFrame(frameId)
      return
    }
    // The previous session's calls still in flight are answered now, before this handshake's answer.
    this.endPendingCalls()
    if (res.status === 'reject') {
      this.post({ channel: 'pomade', type: 'reject', reason: res.reason, hostApi: res.hostApi })
      return
    }
    if (res.status === 'unavailable') return // the pane shows "App unavailable"
    this.frameId = frameId
    this.offFrameEvents = [
      onFilesChanged(frameId, (batch) =>
        this.postEvent({
          channel: 'pomade',
          type: 'event',
          name: 'files.changed',
          payload: { watchId: batch.watchId, changes: batch.changes }
        })
      ),
      onStateChanged(frameId, (change) =>
        this.postEvent({
          channel: 'pomade',
          type: 'event',
          name: 'state.changed',
          payload: { key: change.key, value: change.value }
        })
      ),
      onGitChanged(frameId, (payload) => this.postEvent({ channel: 'pomade', type: 'event', name: 'git.changed', payload })),
      onBusEvent(frameId, (event) =>
        this.postEvent({ channel: 'pomade', type: 'event', name: event.name, payload: event.payload } as EventMessage)
      ),
      // E-028 — the broker's requests for a frame that serves its app's API.
      onApiRequest(frameId, (req) => {
        if (this.frameId === frameId && !this.disposed) {
          this.post({ channel: 'pomade', type: 'request', id: req.requestId, from: req.from, method: req.method, params: req.params })
        }
      })
    ]
    this.route = res.target.route
    this.post({
      channel: 'pomade',
      type: 'welcome',
      hostApi: res.hostApi,
      pomadeVersion: res.pomadeVersion,
      appId: this.appId,
      ...res.target,
      project: this.welcomeProject(active),
      theme: res.theme
    })
  }

  /** The welcome's project: a tab frame's own project, else (panel, overlay) the active one. */
  private welcomeProject(active: ProjectRef): ProjectRef {
    const own = this.ownProject()
    return own === undefined ? active : projectRefOf(own)
  }

  private onCall(msg: IncomingCall): void {
    void this.handshake.then(async () => {
      const frameId = this.frameId
      if (frameId === null) {
        this.post({
          channel: 'pomade',
          type: 'result',
          id: msg.id,
          ok: false,
          error: { code: 'not-ready', message: 'Call before welcome' }
        })
        return
      }
      const call: PendingCall = { id: msg.id, frameId }
      this.pending.add(call)
      try {
        const activeProject = this.activeProject()
        const answer = await window.pomade.apps.call(frameId, msg.method, msg.params, { activeProject })
        if (!('delegate' in answer)) {
          this.answer(call, answer)
          return
        }
        // E-030 — main validated it; the work is renderer-owned state. Done only for the session
        // that asked: once a new handshake started, the call is answered `not-ready`, never served.
        if (!this.pending.has(call)) return
        if (this.frameId !== frameId) {
          this.answer(call, SESSION_ENDED)
          return
        }
        const res = await serveDelegated(answer.delegate, activeProject, frameId, this.ownProject(), {
          isShown: () => this.isShown(),
          element: this.iframe,
          ...(this.tabId !== undefined ? { tabId: this.tabId } : {}),
          atRoute: (route) => this.atRoute(frameId, route)
        })
        // E-027 — after the answer: closing takes this very frame away.
        if (this.answer(call, res) && res.ok && answer.delegate.method === 'overlay.close') this.onClose()
      } catch (err) {
        this.answer(call, { ok: false, error: { code: 'io-error', message: err instanceof Error ? err.message : String(err) } })
      }
    })
  }

  /** Post a pending call's result — once, and only while the frame lives. */
  private answer(call: PendingCall, res: AppCallOutcome): boolean {
    if (!this.pending.delete(call) || this.disposed) return false
    this.post(
      res.ok
        ? { channel: 'pomade', type: 'result', id: call.id, ok: true, value: res.value }
        : { channel: 'pomade', type: 'result', id: call.id, ok: false, error: res.error }
    )
    return true
  }

  /** A new handshake is answered: every call the frame made before it, still in flight, gets `not-ready` first. */
  private endPendingCalls(): void {
    for (const call of [...this.pending]) this.answer(call, SESSION_ENDED)
  }

  /** T-236 — the frame is on screen: no hidden ancestor (an inactive tab's pane, a panel not shown,
   *  the collapsed side panel, a project in the background). */
  private isShown(): boolean {
    return this.iframe.isConnected && this.iframe.checkVisibility()
  }

  /** E-028 — the frame answers a broker request; main checks it was this frame's. */
  private onResponse(msg: IncomingResponse): void {
    const frameId = this.frameId
    if (frameId === null) return
    void window.pomade.apps.apiResponse(
      frameId,
      msg.id,
      msg.ok ? { ok: true, value: msg.value } : { ok: false, error: msg.error ?? { code: 'app-error', message: 'Malformed response' } }
    )
  }

  private onKey(msg: KeyMessage): void {
    this.iframe.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: msg.key,
        code: msg.code,
        metaKey: msg.metaKey,
        ctrlKey: msg.ctrlKey,
        altKey: msg.altKey,
        shiftKey: msg.shiftKey,
        bubbles: true,
        cancelable: true,
        composed: true
      })
    )
  }

  private postEvent(msg: EventMessage): void {
    if (this.frameId !== null && !this.disposed) this.post(msg)
  }

  /** The frame's tab was navigated (`AppTab.route`): a welcomed frame gets `route.changed` and
   *  main's `host.info` follows; a reload opens at the new route either way. */
  setRoute(route: string): void {
    this.request = { ...this.request, route }
    const frameId = this.frameId
    if (frameId === null || this.route === route) return
    this.route = route
    void window.pomade.apps.setRoute(frameId, route)
    this.postEvent({ channel: 'pomade', type: 'event', name: 'route.changed', payload: { route } })
  }

  /** T-269 — the frame navigated by itself (`tabs.setRoute`; main already recorded it for
   *  `host.info`): it renders `route` now, so its tab moving there sends no `route.changed`. */
  private atRoute(frameId: string, route: string): void {
    this.request = { ...this.request, route }
    if (this.frameId === frameId) this.route = route
  }

  private closeSession(): void {
    for (const off of this.offFrameEvents) off()
    this.offFrameEvents = []
    if (this.frameId) void window.pomade.apps.closeFrame(this.frameId)
    this.frameId = null
    this.route = null
  }

  /** The frame element is going away (tab closed, app updated or removed). */
  dispose(): void {
    this.disposed = true
    this.pending.clear()
    this.closeSession()
  }
}
