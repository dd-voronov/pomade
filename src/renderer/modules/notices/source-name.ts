// Pomade — E-032: a notice source as people read it: Pomade for its own notices, an installed app's
// name, else the id.

import type { HostedApp } from '@shared/types'

export function sourceName(source: string, apps: readonly HostedApp[]): string {
  if (source === 'pomade') return 'Pomade'
  return apps.find((a) => a.id === source)?.name ?? source
}
