// Pomade — main-process typed IPC registration (T-164).
// `defineHandler` ties every `ipcMain.handle` site to `PomadeApi` (via `ChannelMap`):
// the handler's args after `event` are exactly the channel's parameter tuple and its
// return type is the channel's (a value OR a promise of it, since a handler may resolve
// synchronously). A signature that disagrees with `PomadeApi` fails `npm run typecheck`.

import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import type { ChannelMap } from '@shared/ipc-api'

/** The main-process handler signature for invoke channel `K`, derived from `PomadeApi`. */
export type Handler<K extends keyof ChannelMap> = ChannelMap[K] extends (
  ...args: infer A
) => infer R
  ? (event: IpcMainInvokeEvent, ...args: A) => R | Awaited<R>
  : never

/** Register `channel`'s invoke handler, typed against `PomadeApi`. */
export function defineHandler<K extends keyof ChannelMap>(
  ipc: IpcMain,
  channel: K,
  handler: Handler<K>
): void {
  ipc.handle(channel, handler as Parameters<IpcMain['handle']>[1])
}
