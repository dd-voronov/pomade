// Pomade — E-028: the window's half of the Host API socket channel (docs/HOST-API.md §3
// "Socket"). Backends and commands reach main over the socket; for the calls whose work is
// renderer-owned state (tabs, groups and projects, the git snapshot) main hands the validated call
// here, exactly as a frame bridge would serve it (`delegated-calls.ts`), and the answer goes back
// by request id. A backend or a command has no project of its own, so whatever it does without
// naming one — a tab it opens, a notice it posts — belongs to the Workspace project (PLATFORM rule 9). The
// active project is reported to main on every change (the first report also says the window is
// ready), so socket clients get `project.changed` and `project.getActive`.

import { useEffect } from 'react'

import { useWorkspaceStore } from '../../stores/workspace-store'
import { serveDelegated } from './delegated-calls'
import { activeProjectRef, projectRefFor, WORKSPACE_REF } from './project-ref'

/** Mounted once in `App`. */
export function useSocketBridge(): void {
  useEffect(() => {
    const report = (): void => void window.pomade.apps.setActiveProject(activeProjectRef())
    report()
    let last = activeProjectRef()
    const offProject = useWorkspaceStore.subscribe((s) => {
      const ref = projectRefFor(s.activeProjectId, s.projects)
      if (ref.id === last.id && ref.name === last.name && ref.root === last.root) return
      last = ref
      void window.pomade.apps.setActiveProject(ref)
    })
    const offServe = window.pomade.apps.onServeDelegated(({ requestId, call }) => {
      // A socket client has no frame: frame-bound methods (git watches, the folder picker) never
      // reach here — main refuses them. Nor has it a project: its defaults are the Workspace project.
      void serveDelegated(call, WORKSPACE_REF, '').then(
        (outcome) => window.pomade.apps.delegatedResult(requestId, outcome),
        (err: unknown) =>
          window.pomade.apps.delegatedResult(requestId, {
            ok: false,
            error: { code: 'io-error', message: err instanceof Error ? err.message : String(err) }
          })
      )
    })
    return () => {
      offProject()
      offServe()
    }
  }, [])
}
