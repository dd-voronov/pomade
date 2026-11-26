// Pomade — the one workspace-escape guard. Every module that resolves a workspace-relative path
// to an absolute one (the fs subsystem, git-service) goes through `abs()` here — a hardening fix
// to the guard lands once, for both, instead of needing to be copied into a second implementation.

import { promises as fs } from 'node:fs'
import { resolve, relative, isAbsolute, sep } from 'node:path'

import { configStore } from './config-store'

export function requireRoot(): string {
  const root = configStore.getRoot()
  if (!root) throw new Error('No workspace open')
  return root
}

/** Resolve a workspace-relative path to an absolute one, refusing escapes. */
export function abs(rel: string): string {
  const root = requireRoot()
  const target = resolve(root, rel)
  const rp = relative(root, target)
  if (rp.startsWith('..') || isAbsolute(rp)) {
    throw new Error(`Path escapes workspace: ${rel}`)
  }
  return target
}

// ─── T-102: the sanctioned outside-workspace door (E-021) ─────────────────────
// An absolute path resolving OUTSIDE the workspace can be opened as a doc tab (a distinct
// object class that never assumes workspace membership). The editor must read/write it, but the
// escape-refusing `abs()` guard above cannot — by design it refuses everything outside the root.
// The outside doors are the narrow, explicit exception: each takes ONE ABSOLUTE path and acts on
// it directly, no workspace-relative resolution. They REQUIRE an absolute path (via `requireAbs`)
// so a relative token can never be laundered through them to sidestep the guard.
export function requireAbs(p: string): string {
  if (typeof p !== 'string' || !isAbsolute(p)) {
    throw new Error(`Absolute path required: ${p}`)
  }
  return p
}

export function toRel(root: string, absPath: string): string {
  const r = relative(root, absPath)
  return r.split(sep).join('/')
}

/** True when `p` (absolute) exists — a stat-free existence check. */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
