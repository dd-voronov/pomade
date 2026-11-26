// Pomade — E-020 (T-086) terminal file-link path probe. Validates ONE candidate token against
// disk before the terminal-link provider will underline it, so a Cmd+click can never produce a
// dead link. Lives in MAIN because it alone knows `$HOME` (for `~/…`), may stat paths OUTSIDE the
// workspace (the escape-refusing `abs()` helper cannot — and a terminal legitimately `cd`s
// anywhere), and can compare CANONICAL paths: on macOS realpath rewrites /var → /private/var, so
// an inside/outside test done on raw strings would misclassify every path under a /tmp workspace
// (which is exactly what the e2e fixtures are). The canonical-root cache is the sole piece of
// state, encapsulated in one `PathProbeService` instance.

import { promises as fs } from 'node:fs'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { homedir } from 'node:os'

import type { PathProbe } from '@shared/types'

class PathProbeService {
  // The workspace root's canonical path, cached per root (realpath is a syscall per component).
  private canonRootCache: { root: string; canon: string } | null = null

  private async canonicalRoot(root: string): Promise<string> {
    if (this.canonRootCache?.root === root) return this.canonRootCache.canon
    let canon = root
    try {
      canon = await fs.realpath(root)
    } catch {
      /* a vanished root — fall back to the literal path */
    }
    this.canonRootCache = { root, canon }
    return canon
  }

  async probePath(root: string, input: string, baseAbs?: string): Promise<PathProbe | null> {
    const raw = input.trim()
    if (!raw) return null
    let target: string
    if (raw === '~' || raw.startsWith('~/')) target = join(homedir(), raw.slice(1))
    else if (isAbsolute(raw)) target = raw
    else if (baseAbs && isAbsolute(baseAbs)) target = resolve(baseAbs, raw)
    else return null
    let st
    try {
      st = await fs.stat(target) // follows symlinks: a link to a real file IS a real link target
    } catch {
      return null // nothing there ⇒ not a link (this is what keeps dead links un-underlined)
    }
    if (!st.isFile() && !st.isDirectory()) return null
    // T-170 — one `lstat` on the RAW target (before the realpath-follow below), so a caller can
    // still tell "the referenced path was itself a symlink" even though `abs`/`wsRel` name the
    // resolved real target. A failed lstat (races with the stat above are astronomically unlikely
    // outside a hostile filesystem) is treated as "not a symlink" — the safe default.
    let isSymbolicLink = false
    try {
      isSymbolicLink = (await fs.lstat(target)).isSymbolicLink()
    } catch {
      /* keep false */
    }
    let abs = target
    try {
      abs = await fs.realpath(target)
    } catch {
      /* keep the literal path */
    }
    const rp = relative(await this.canonicalRoot(root), abs)
    const inside = !rp.startsWith('..') && !isAbsolute(rp)
    return { abs, wsRel: inside ? rp.split(sep).join('/') : null, isFile: st.isFile(), isSymbolicLink }
  }
}

export const pathProbe = new PathProbeService()
