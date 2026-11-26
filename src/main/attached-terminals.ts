// Pomade — E-034 attached terminals, main's half (docs/modules/terminal/attached-terminals.md).
//
// An attached tab shows a session an app's keeper holds. Main follows the session for the tab
// (`followSession`, pomade-kit/node): it connects to the owning app's keeper at its fixed socket,
// `<userData>/run/keepers/<appId>.sock`, attaches, and reconnects after a keeper update or restart
// — resuming from what it saw when the keeper still holds it. Pomade never calls the owner to
// attach (PLATFORM rule 4): the reference `{ app, session }` and the socket are enough. What the
// keeper sends reaches the tab's pane as `EV.attachedEvent`; the session's live output also runs
// through the kit's attention scanner, like a PTY's.
//
// The keeper is the terminal of record: it answers the program's terminal queries, so the pane
// forwards only what the user did (keystrokes, mouse, focus) and pastes as `paste`.

import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { app, type IpcMain } from 'electron'

import { checkSessionRef, keeperSocketPath, type SessionRef } from 'pomade-kit/protocol'
import { followSession, type Follower } from 'pomade-kit/node'
import { AttentionScanner } from 'pomade-kit/scanners'

import { CH, EV } from '@shared/ipc-api'
import type { AttachedEvent, AttachedEventPayload } from '@shared/types'
import { publishPlatformEventTo } from './event-bus'
import { defineHandler } from './ipc'
import { safeBroadcast } from './windows'

/** How Pomade introduces itself to a keeper. */
const CALLER = 'pomade'

interface Attachment {
  ref: SessionRef
  follower: Follower
  scanner: AttentionScanner
  /** The session on screen has ended already (attached after its end, or its exit was seen). */
  ended: boolean
}

const attachments = new Map<string, Attachment>()

/** `appId`'s keeper socket in this Pomade's user data. */
export function keeperSocketFor(appId: string): string {
  return keeperSocketPath(app.getPath('userData'), appId)
}

/** Make the keepers' socket folder (0700) — before a backend that binds there starts. */
export function ensureKeeperSocketDir(): void {
  const dir = dirname(keeperSocketFor('x'))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

function emit(tabId: string, event: AttachedEvent): void {
  const payload: AttachedEventPayload = { tabId, event }
  safeBroadcast(EV.attachedEvent, payload)
}

/** An exit the user did not cause wants attention, like a terminal's natural exit; a stop (from
 *  this tab, or the owner's own) does not. */
function exitWantsAttention(reason: string): boolean {
  return reason !== 'stopped' && reason !== 'stopped-by-you'
}

function open(tabId: string, ref: SessionRef, cols: number, rows: number): void {
  const existing = attachments.get(tabId)
  if (existing && existing.ref.app === ref.app && existing.ref.session === ref.session) {
    existing.follower.resize(cols, rows)
    existing.follower.resync()
    return
  }
  existing?.follower.close()
  const scanner = new AttentionScanner(() => emit(tabId, { type: 'attention' }))
  const a: Attachment = {
    ref,
    scanner,
    ended: false,
    follower: followSession(
      { socketPath: keeperSocketFor(ref.app), app: CALLER, role: 'viewer', session: ref.session, cols, rows },
      {
        onState: (state) => emit(tabId, { type: 'state', state }),
        onSnapshot: (data, info, resync) => {
          a.ended = info.state === 'exited'
          emit(tabId, { type: 'snapshot', data, info, resync })
        },
        onDelta: (data, info) => {
          a.ended = info.state === 'exited'
          scanner.push(data)
          emit(tabId, { type: 'delta', data, info })
        },
        onOutput: (data) => {
          scanner.push(data)
          emit(tabId, { type: 'output', data })
        },
        onResized: (c, r) => emit(tabId, { type: 'resized', cols: c, rows: r }),
        onExit: (exit) => {
          emit(tabId, { type: 'exit', exit })
          if (!a.ended && exitWantsAttention(exit.reason)) emit(tabId, { type: 'attention' })
          a.ended = true
        },
        onInfo: (info) => emit(tabId, { type: 'info', info })
      }
    )
  }
  attachments.set(tabId, a)
}

function close(tabId: string): void {
  attachments.get(tabId)?.follower.close()
  attachments.delete(tabId)
}

/** Stop following every session (the workspace closes or Pomade quits); the sessions run on. */
export function closeAllAttachments(): void {
  for (const tabId of [...attachments.keys()]) close(tabId)
}

export function registerAttachedTerminals(ipc: IpcMain): void {
  defineHandler(ipc, CH.attached.open, (_e, tabId, session, cols, rows) => {
    const ref = checkSessionRef(session)
    if (!ref.ok) throw new Error(ref.message)
    open(tabId, ref.value, cols, rows)
  })
  defineHandler(ipc, CH.attached.close, (_e, tabId) => close(tabId))
  defineHandler(ipc, CH.attached.input, (_e, tabId, data) => attachments.get(tabId)?.follower.input(data))
  defineHandler(ipc, CH.attached.paste, (_e, tabId, text) => attachments.get(tabId)?.follower.paste(text))
  defineHandler(ipc, CH.attached.resize, (_e, tabId, cols, rows) => attachments.get(tabId)?.follower.resize(cols, rows))
  defineHandler(ipc, CH.attached.stop, async (_e, tabId) => {
    await attachments.get(tabId)?.follower.stop()
  })
  defineHandler(ipc, CH.attached.action, (_e, session, action, projectId) => {
    const ref = checkSessionRef(session)
    if (!ref.ok) throw new Error(ref.message)
    publishPlatformEventTo(ref.value.app, 'attachedTab.action', { session: ref.value, action, projectId })
  })
}
