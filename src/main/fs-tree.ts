// Pomade — filesystem tree walk. `buildTree` renders a depth-bounded, symlink-aware FileNode
// tree for the workspace file tree; `treeOutside` is the outside-workspace mount analogue.

import { promises as fs } from 'node:fs'
import { join, sep } from 'node:path'

import { isLocalHistoryStorePath } from '@shared/local-history'
import type { FileNode } from '@shared/types'

import { INDEX_IGNORE_NAMES, requireAbs, toRel } from './fs-shared'
import { unwatchedFolders } from './skipped-paths'

export interface TreeOpts {
  ignoreSet: Set<string>
  includeIgnored: boolean
}

export async function buildTree(
  root: string,
  absPath: string,
  depth: number,
  opts: TreeOpts,
  // E-012 — true only for the explicit root of a tree() call. A symlinked directory is
  // walked ONLY when it is that root (the user expanded it, renderer loads depth 1); it is
  // never auto-followed deeper inside a multi-level walk, which keeps the walk cycle-safe.
  isRoot: boolean,
  // T-131 (E-026) — how a node's `path` is derived from its absolute on-disk path. In-workspace
  // trees pass `toRel(root, …)` (workspace-relative); an outside mount passes identity (there is
  // no ws-relative form outside the workspace). Defaults to ws-relative for existing callers.
  toPath: (absPath: string) => string = (p) => toRel(root, p)
): Promise<FileNode> {
  const name = absPath === root ? '' : absPath.slice(absPath.lastIndexOf(sep) + 1)
  // E-012 — lstat first so a symlink is detected without following it (one lstat per entry).
  // For a non-symlink this single call also tells us dir-vs-file; only for an actual symlink
  // do we follow (one extra stat) to resolve the TARGET's kind so links stay transparent.
  const lst = await fs.lstat(absPath)
  const symlink = lst.isSymbolicLink()
  let isDir = lst.isDirectory()
  let broken = false
  if (symlink) {
    try {
      isDir = (await fs.stat(absPath)).isDirectory()
    } catch {
      isDir = false // broken link → treat as a leaf; still flagged as a symlink
      broken = true // E-012 (final) — the follow-stat already told us the target is gone
    }
  }
  const node: FileNode = {
    name: name || (root.slice(root.lastIndexOf(sep) + 1) || root),
    path: toPath(absPath),
    kind: isDir ? 'dir' : 'file'
  }
  if (symlink) node.symlink = true
  if (broken) node.broken = true
  if (isDir && depth > 0 && (!symlink || isRoot)) {
    const entries = await fs.readdir(absPath, { withFileTypes: true })
    const children: FileNode[] = []
    for (const entry of entries) {
      const childAbs = join(absPath, entry.name)
      // A local-history store is shown only with the ignored items, dimmed, like node_modules —
      // matched by its workspace-relative path (an outside mount's absolute paths never match).
      const ignored = opts.ignoreSet.has(entry.name) || isLocalHistoryStorePath(toPath(childAbs))
      if (ignored && !opts.includeIgnored) continue
      const child = await buildTree(root, childAbs, depth - 1, opts, false, toPath)
      if (ignored) child.ignored = true
      if (child.kind === 'dir' && unwatchedFolders().includes(child.path)) child.unwatched = true
      children.push(child)
    }
    children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    node.children = children
  }
  return node
}

// ─── T-131 (E-026): outside-workspace tree read ───────────────────────────────
// The mount door's read side. `treeOutside` is the outside-workspace analogue of `tree()`: it
// takes ONE ABSOLUTE path (via requireAbs, so a relative token can never be laundered through it
// to sidestep the escape guard), walks `depth` levels with buildTree's symlink/sort logic, and
// returns FileNodes whose `path` is the ABSOLUTE on-disk path (there is no ws-relative form
// outside the workspace). The ignore-set is the hardcoded INDEX_IGNORE superset — no
// per-workspace ignored items apply outside the workspace. It throws (ENOENT from buildTree's
// lstat) when the root is gone, which drives the renderer's missing-root state.
//
// Outside mounts are TREE-DISPLAY ONLY: no basename/link index, no terminal Cmd+click
// resolution, no git/repo discovery follows an outside path (T-102 stays workspace-bounded).
export async function treeOutside(absPath: string, depth: number): Promise<FileNode> {
  const root = requireAbs(absPath)
  return buildTree(
    root,
    root,
    depth,
    { ignoreSet: new Set(INDEX_IGNORE_NAMES), includeIgnored: false },
    true,
    (p) => p // absolute paths — no ws-relative form exists outside the workspace
  )
}
