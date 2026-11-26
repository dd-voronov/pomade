// Pomade — E-047 (T-291): app scope folders' pure decisions (docs/HOST-API.md §4 "project.write").
// A project's `ProjectState.appScopeFolders` holds every app's folders, each tagged with its app;
// these functions read and change one app's share of the list. No Electron, no fs —
// `app-scope-folders.ts` runs them.

import { SCOPE_FOLDERS_MAX } from 'pomade-kit/protocol'

import type { AppScopeFolder } from '@shared/types'

/** `appId`'s folders, in the order added. */
export function foldersOf(list: readonly AppScopeFolder[], appId: string): string[] {
  return list.filter((f) => f.appId === appId).map((f) => f.path)
}

/** The list with `appId`'s `path` added at the end; `unchanged` when the app has it already,
 *  `full` when the app has `SCOPE_FOLDERS_MAX` already. */
export function withFolder(
  list: readonly AppScopeFolder[],
  appId: string,
  path: string
): AppScopeFolder[] | 'unchanged' | 'full' {
  const own = foldersOf(list, appId)
  if (own.includes(path)) return 'unchanged'
  if (own.length >= SCOPE_FOLDERS_MAX) return 'full'
  return [...list, { appId, path }]
}

/** The list without `appId`'s `path`; `unchanged` when the app has no such folder. */
export function withoutFolder(
  list: readonly AppScopeFolder[],
  appId: string,
  path: string
): AppScopeFolder[] | 'unchanged' {
  const next = list.filter((f) => f.appId !== appId || f.path !== path)
  return next.length === list.length ? 'unchanged' : next
}

/** The list without every folder of `appIds`; `unchanged` when none of them has one. */
export function withoutApps(list: readonly AppScopeFolder[], appIds: ReadonlySet<string>): AppScopeFolder[] | 'unchanged' {
  const next = list.filter((f) => !appIds.has(f.appId))
  return next.length === list.length ? 'unchanged' : next
}

/** The apps whose folders go: removed by the user (`pomade apps remove` records them) and not
 *  hosted now — not installed again, not dev-linked. An app that is only missing (a dev link gone,
 *  a broken update) keeps its folders, unapplied. */
export function removedApps(removals: Readonly<Record<string, string>>, hosted: readonly string[]): Set<string> {
  return new Set(Object.keys(removals).filter((id) => !hosted.includes(id)))
}
