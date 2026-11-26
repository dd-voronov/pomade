// Pomade — E-028: how an app backend's status reads on its strip icon (tooltip lines + the warning
// dot). Pure.

import type { AppBackendStatus } from '@shared/types'
import type { TooltipLine } from '../../components/Tooltip'

const STATE: Record<AppBackendStatus['state'], string> = {
  running: 'running',
  starting: 'starting',
  stopped: 'stopped',
  restarting: 'crashed — restarting'
}

const MODE: Record<AppBackendStatus['mode'], string> = {
  'always-on': 'always on',
  'with-pomade': 'with Pomade'
}

/** The tooltip lines for an app's backend — "Background: running (always on)", then its detail
 *  muted; [] when it has none. */
export function backendLines(status: AppBackendStatus | null): TooltipLine[] {
  if (!status) return []
  const summary = `Background: ${STATE[status.state]} (${MODE[status.mode]})`
  return status.detail ? [summary, { text: status.detail, muted: true }] : [summary]
}

/** True when the backend is not doing its job — the strip icon shows a warning dot. */
export function backendNeedsAttention(status: AppBackendStatus | null): boolean {
  return status !== null && (status.state === 'restarting' || status.state === 'stopped')
}
