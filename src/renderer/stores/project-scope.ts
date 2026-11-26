// Pomade — a project's in-scope folders (E-047): the folders outside its root whose files count as
// the project's — its in-scope mounts and the app scope folders that apply now. The scope
// classifiers (`classifyScope`, `scopeRelativePath`) take this list next to the project root.
// Derived, never stored.

import { useEffect, useMemo } from 'react'

import type { AppScopeFolder, HostedApp, Id, Mount } from '@shared/types'

import { useAppScopeFoldersStore } from './app-scope-folders-store'
import { useAppsStore } from './apps-store'
import { useMountsStore } from './mounts-store'

const NO_MOUNTS: Mount[] = []
const NO_FOLDERS: AppScopeFolder[] = []

/** The paths of a project's in-scope mounts. */
export function inScopeMountPaths(mounts: readonly Mount[]): string[] {
  return mounts.filter((m) => m.inScope).map((m) => m.path)
}

/** The paths of the app scope folders that apply: their app is hosted (installed or dev-linked)
 *  and available. A missing or unavailable app's folders stay stored and apply again once it is
 *  back. */
export function appliedAppScopePaths(folders: readonly AppScopeFolder[], apps: readonly HostedApp[]): string[] {
  const live = new Set(apps.filter((a) => a.unavailable === null).map((a) => a.id))
  return folders.filter((f) => live.has(f.appId)).map((f) => f.path)
}

/** The project's in-scope folders, as a stable array (a new one only when they change). */
export function useProjectScopeFolders(projectId: Id): readonly string[] {
  const mounts = useMountsStore((s) => s.mountsByProject[projectId] ?? NO_MOUNTS)
  const appFolders = useAppScopeFoldersStore((s) => s.foldersByProject[projectId] ?? NO_FOLDERS)
  // The app list is pushed again on every backend status change: key on what applies, not on it.
  const applied = useAppsStore((s) => JSON.stringify(appliedAppScopePaths(appFolders, s.apps)))
  useEffect(() => {
    void useAppScopeFoldersStore.getState().hydrateProject(projectId)
  }, [projectId])
  return useMemo(
    () => [...new Set([...inScopeMountPaths(mounts), ...(JSON.parse(applied) as string[])])],
    [mounts, applied]
  )
}
