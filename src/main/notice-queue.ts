// Pomade — E-032: the closed-Pomade notice queue, served. `<userData>/notices/queue/` (a dev
// Pomade has its own user data) is drained when the renderer attaches — the notices posted while
// Pomade was closed — and watched from then on, so a backend or a command posting while Pomade
// runs is shown within moments. Drains are serialized; the folder logic is `notice-queue-core.ts`.

import { mkdirSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

import { app, type IpcMain } from 'electron'

import { NOTICE_QUEUE_DIR, type QueuedNotice } from 'pomade-kit/protocol'

import { CH, EV } from '@shared/ipc-api'
import { defineHandler } from './ipc'
import { drainQueueDir } from './notice-queue-core'
import { safeBroadcast } from './windows'

/** A burst of files (one poster writing several) is drained once. */
const DRAIN_DEBOUNCE_MS = 100

let watcher: FSWatcher | null = null
let chain: Promise<unknown> = Promise.resolve()
let timer: NodeJS.Timeout | null = null

function queueDir(): string {
  return join(app.getPath('userData'), NOTICE_QUEUE_DIR)
}

function drain(): Promise<QueuedNotice[]> {
  const next = chain.then(() => drainQueueDir(queueDir(), (m) => console.warn(`[pomade] ${m}`)))
  chain = next.catch(() => {})
  return next
}

function startWatching(): void {
  if (watcher) return
  mkdirSync(queueDir(), { recursive: true })
  watcher = watch(queueDir(), () => {
    timer ??= setTimeout(() => {
      timer = null
      void drain().then((notices) => {
        if (notices.length > 0) safeBroadcast(EV.noticesQueued, notices)
      })
    }, DRAIN_DEBOUNCE_MS)
  })
  watcher.on('error', () => {
    watcher?.close()
    watcher = null
  })
}

export function registerNoticeQueue(ipc: IpcMain): void {
  // The renderer is ready for notices: everything queued so far, then pushes as files arrive.
  defineHandler(ipc, CH.notices.attach, async () => {
    startWatching()
    return drain()
  })
  app.on('will-quit', () => {
    watcher?.close()
    watcher = null
  })
}
