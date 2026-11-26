// Pomade — E-032: what clicking a notice does. Each action is the Host API call it names, served by
// the same code the call uses (`serveDelegated`): `openFile` is `tabs.openFile`, `openTerminal` is
// `tabs.openTerminal`, `openApp` is the posting app's `tabs.openApp` (→ `openAppRoute`). A click
// that cannot run (the project or the app is gone) says why in a toast.

import type { AppCallOutcome, AppDelegatedCall } from '@shared/types'
import { serveDelegated } from '../apps/delegated-calls'
import { activeProjectRef } from '../apps/project-ref'
import type { Notice } from './notice-model'

function callFor(notice: Notice): AppDelegatedCall | null {
  const action = notice.action
  if (!action) return null
  const project = action.projectId !== undefined ? { projectId: action.projectId } : {}
  switch (action.kind) {
    case 'openFile':
      return { method: 'tabs.openFile', params: { path: action.path, ...project } }
    case 'openTerminal': {
      const { cwd, command, title } = action
      return {
        method: 'tabs.openTerminal',
        params: { cwd, ...(command !== undefined ? { command } : {}), ...(title !== undefined ? { title } : {}), ...project }
      }
    }
    case 'openApp':
      return { method: 'tabs.openApp', params: { route: action.route ?? '', ...project }, appId: notice.source }
  }
}

/** Run the notice's click action; `{ ok: true }` when it has none. */
export async function runNoticeAction(notice: Notice): Promise<AppCallOutcome> {
  const call = callFor(notice)
  if (!call) return { ok: true, value: {} }
  return serveDelegated(call, activeProjectRef(), '')
}
