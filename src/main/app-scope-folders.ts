// Pomade — E-047 (T-291): app scope folders — the folders hosted apps put in a project's scope
// through the Host API (docs/HOST-API.md §4 "project.write"). Stored per project and machine in
// `ProjectState.appScopeFolders` (`.pomade/state/<projectId>.json`), each tagged with its app;
// main owns the field: it serves the calls, deletes a removed app's folders (at start, on every
// registry change, on a workspace switch) and tells the window each change (EV.appScopeFolders).
// Which folders apply — their app hosted and available — the window decides from its app list
// (`renderer/stores/project-scope.ts`), so an app that comes and goes needs nothing done here.

import { app } from 'electron'

import { WORKSPACE_PROJECT_ID, scopeFolderPath, SCOPE_FOLDERS_MAX, type MethodParams } from 'pomade-kit/protocol'

import { EV } from '@shared/ipc-api'
import type { AppScopeFolder } from '@shared/types'
import { readRemovals } from './app-install-core'
import { appsScanned, knownAppIds, onAppsChanged } from './app-registry'
import { foldersOf, removedApps, withFolder, withoutApps, withoutFolder } from './app-scope-folders-core'
import { configStore, onWorkspaceReady } from './config-store'
import { CallError } from './host-api-fs'
import { safeBroadcast } from './windows'

export type ScopeFolderMethod = 'project.getScopeFolders' | 'project.addScopeFolder' | 'project.removeScopeFolder'

/** Every change to the field runs here, one at a time: each reads the list as the last left it. */
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn)
  queue = run.catch(() => undefined)
  return run
}

/** Replace `projectId`'s folders through `change` (null = no change); the window hears a change. */
async function update(
  projectId: string,
  change: (list: AppScopeFolder[]) => AppScopeFolder[] | null
): Promise<void> {
  const changed: { folders: AppScopeFolder[] | null } = { folders: null }
  await configStore.updateState(projectId, (state) => {
    changed.folders = change(state?.appScopeFolders ?? [])
    return changed.folders ? { appScopeFolders: changed.folders } : null
  })
  if (changed.folders) safeBroadcast(EV.appScopeFolders, { projectId, folders: changed.folders })
}

async function realProject(projectId: string): Promise<void> {
  if (projectId === WORKSPACE_PROJECT_ID) throw new CallError('invalid-params', 'The Workspace project has no scope folders')
  if (!(await configStore.projectIds()).includes(projectId)) {
    throw new CallError('not-found', `No project ${JSON.stringify(projectId)}`)
  }
}

function storedPath(raw: string): string {
  const root = configStore.getRoot()
  if (!root) throw new CallError('not-ready', 'No workspace is open')
  const p = scopeFolderPath(raw, root)
  if (!p.ok) throw new CallError(p.error.code, p.error.message)
  return p.path
}

/** Serve one scope-folder call for `appId` (capability already gated, params shape-checked). */
export async function callScopeFolders(method: ScopeFolderMethod, params: MethodParams<ScopeFolderMethod>, appId: string): Promise<unknown> {
  await realProject(params.projectId)
  switch (method) {
    case 'project.getScopeFolders': {
      const state = await serial(() => configStore.loadState(params.projectId))
      return { paths: foldersOf(state?.appScopeFolders ?? [], appId) }
    }
    case 'project.addScopeFolder': {
      const path = storedPath((params as MethodParams<'project.addScopeFolder'>).path)
      const outcome = { full: false }
      await serial(() =>
        update(params.projectId, (list) => {
          const next = withFolder(list, appId, path)
          outcome.full = next === 'full'
          return typeof next === 'string' ? null : next
        })
      )
      if (outcome.full) throw new CallError('invalid-params', `An app keeps at most ${SCOPE_FOLDERS_MAX} scope folders per project`)
      return { path }
    }
    case 'project.removeScopeFolder': {
      const path = storedPath((params as MethodParams<'project.removeScopeFolder'>).path)
      await serial(() =>
        update(params.projectId, (list) => {
          const next = withoutFolder(list, appId, path)
          return next === 'unchanged' ? null : next
        })
      )
      return {}
    }
  }
}

/** Delete the folders of every app the user removed that is not hosted now, in every project. */
export function sweepRemovedApps(): Promise<void> {
  return serial(async () => {
    if (!configStore.getRoot()) return
    await appsScanned()
    const gone = removedApps(await readRemovals(app.getPath('userData')), knownAppIds())
    if (gone.size === 0) return
    for (const projectId of await configStore.projectIds()) {
      await update(projectId, (list) => {
        const next = withoutApps(list, gone)
        return next === 'unchanged' ? null : next
      })
    }
  }).catch((err: unknown) => console.error('[app-scope-folders] sweep failed', err))
}

/** Follow app removals: on every registry change and workspace switch (the boot sweep is
 *  `sweepRemovedApps()` after the registry's first scan, in main/index.ts). */
export function registerAppScopeFolders(): void {
  onAppsChanged(() => void sweepRemovedApps())
  onWorkspaceReady(() => void sweepRemovedApps())
}
