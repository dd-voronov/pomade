// Pomade — E-034: what an attached tab's header says about its session.

import type { SessionExit, SessionInfo } from 'pomade-kit/protocol'

import type { AttachedState } from '@shared/types'

export type AttachedTone = 'live' | 'muted' | 'warning' | 'danger'

export interface AttachedStatus {
  /** The chip's words. */
  label: string
  tone: AttachedTone
  /** A longer explanation (tooltip, and the pane's notice when nothing was ever shown). */
  detail: string
}

/** How a session ended, in words. */
export function exitLabel(exit: SessionExit): { label: string; tone: AttachedTone } {
  switch (exit.reason) {
    case 'exited':
      return { label: 'Exited', tone: 'muted' }
    case 'crashed':
      return { label: exit.code !== null ? `Crashed · code ${exit.code}` : exit.signal ? `Crashed · ${exit.signal}` : 'Crashed', tone: 'danger' }
    case 'stopped':
      return { label: 'Stopped', tone: 'muted' }
    case 'stopped-by-you':
      return { label: 'Stopped by you', tone: 'muted' }
    case 'time-limit':
      return { label: 'Stopped · time limit', tone: 'warning' }
    case 'lost-in-keeper-crash':
      return { label: 'Lost · keeper crashed', tone: 'danger' }
  }
}

/**
 * The header's status for a session: where the connection stands, else the session's own state.
 * `owner` is the owning app's name; `everAttached` tells a reconnect from a first attach.
 */
export function attachedStatus(state: AttachedState, info: SessionInfo | null, owner: string, everAttached: boolean): AttachedStatus {
  switch (state.kind) {
    case 'connecting':
      return everAttached
        ? { label: 'Reconnecting…', tone: 'muted', detail: `Reconnecting to ${owner}'s keeper.` }
        : { label: 'Attaching…', tone: 'muted', detail: `Attaching to ${owner}'s keeper.` }
    case 'unreachable':
      return {
        label: 'Keeper not running',
        tone: 'warning',
        detail: `${owner}'s keeper does not answer (${state.reason}). Its sessions run while its background part runs; this tab attaches as soon as it is back.`
      }
    case 'gone':
      return {
        label: 'Session not found',
        tone: 'warning',
        detail: `${owner}'s keeper holds no such session any more. This tab attaches if ${owner} starts it again.`
      }
    case 'rejected':
      return { label: 'Refused', tone: 'danger', detail: `${owner}'s keeper refused Pomade: ${state.message}` }
    case 'attached': {
      const current = info ?? state.info
      if (current.exit) {
        const { label, tone } = exitLabel(current.exit)
        return { label, tone, detail: `The session ended at ${new Date(current.exit.at).toLocaleTimeString()}.` }
      }
      return { label: 'Running', tone: 'live', detail: `Running in ${owner}'s keeper (pid ${current.pid ?? '?'}). Closing this tab leaves it running.` }
    }
  }
}
