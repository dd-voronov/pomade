// Pomade — T-226: a version tab. An earlier version of a document (a commit's, a local-history
// snapshot, a discarded draft) opened in an ordinary, editable editor tab. The tab is a `DocTab`
// whose `path` is the document and whose `version` names where its text came from; it is not the
// document's own tab. Its Save replaces the document with the tab's text after a confirm, and the
// text it replaces is kept in History first. Pure: no I/O, no React.
//
//   isVersionSource(s)          a comparison side that can open as a version tab
//   versionLabel(s, now)        `0b8e744` / `Nov 17 12:49` / `draft Nov 8 14:32`
//   versionPath(s, docPath)     the path the version was kept under (its tab title's name)
//   versionTabTitle(path, l)    `notes.md @ 0b8e744`
//   retargetVersion(s, from, to) a version source after its document moved
//   sameVersion(a, b)           one tab per version of a document

import type { CompareSource } from './compare'
import { versionTime } from './doc-history'

/** The comparison sources a version tab can hold: a fixed, read-only version of the doc. */
export type VersionSource = Extract<CompareSource, { kind: 'rev' | 'draft' | 'snapshot' }>

/** What a version tab persists next to its document `path`. */
export interface DocVersion {
  source: VersionSource
  /** The tab title's part after `@` (fixed at open time). */
  label: string
}

export function isVersionSource(s: CompareSource): s is VersionSource {
  return s.kind === 'rev' || s.kind === 'draft' || s.kind === 'snapshot'
}

/** A commit's short hash (`HEAD` for HEAD), a snapshot's time, a draft's `draft <time>`. */
export function versionLabel(s: VersionSource, now: number): string {
  if (s.kind === 'rev') return s.rev === 'HEAD' ? 'HEAD' : s.rev.slice(0, 7)
  if (s.kind === 'draft') return `draft ${versionTime(s.at, now)}`
  return versionTime(s.at, now)
}

function base(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}

/** The path the document had in this version: a commit's path at that commit, a local version's
 *  path when it was kept (before a rename), else the document's. */
export function versionPath(s: VersionSource, docPath: string): string {
  if (s.kind === 'rev') return s.path
  if (s.kind === 'snapshot' && s.pathThen) return s.pathThen
  return docPath
}

/** A version source once its document moved to `to`: local versions follow the file (their store
 *  path is the new one; `pathThen` is dropped when it is the new path); commits and drafts stay. */
export function retargetVersion(s: VersionSource, to: string): VersionSource {
  if (s.kind !== 'snapshot') return s
  const { pathThen, ...rest } = s
  return pathThen && pathThen !== to ? { ...rest, path: to, pathThen } : { ...rest, path: to }
}

/** `notes.md @ 0b8e744`. */
export function versionTabTitle(path: string, label: string): string {
  return `${base(path)} @ ${label}`
}

/** The same version of the same document: opening it again focuses the open tab. */
export function sameVersion(a: VersionSource, b: VersionSource): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'rev' && b.kind === 'rev') return a.repo === b.repo && a.rev === b.rev && a.path === b.path
  if (a.kind === 'draft' && b.kind === 'draft') return a.id === b.id
  if (a.kind === 'snapshot' && b.kind === 'snapshot') return a.path === b.path && a.id === b.id
  return false
}

/** The Save confirm's question. */
export function replaceQuestion(path: string): string {
  return `Replace ${base(path)} with this version? The current text stays in History.`
}

/** The confirm's extra line when the document has unsaved edits in its own tab. */
export function replaceDirtyLine(path: string): string {
  return `${base(path)} has unsaved edits in its tab. They are kept in History as a discarded draft, and the tab shows this version.`
}

interface TabLike {
  kind: string
  path?: string
  version?: DocVersion
}

/** The document's own tab for `path` — never a version tab of it. */
export function isDocTabOf(t: TabLike, path: string): boolean {
  return t.kind === 'doc' && t.path === path && !t.version
}

/** Two tabs showing the same thing: the same document, or the same version of it. */
export function sameDocTab(a: TabLike, b: TabLike): boolean {
  if (a.kind !== 'doc' || b.kind !== 'doc' || !a.path || a.path !== b.path) return false
  if (!a.version || !b.version) return !a.version && !b.version
  return sameVersion(a.version.source, b.version.source)
}
