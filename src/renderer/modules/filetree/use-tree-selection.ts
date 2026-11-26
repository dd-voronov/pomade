// Pomade — file-tree SELECTION hook (E-012 round-3 / E-018, extracted in T-159). Per-project
// SESSION state (never persisted): a plain click selects exactly one row, Cmd+click toggles, a
// Shift-range takes the contiguous VISIBLE-row span, Cmd+Shift adds that span. It re-roots (clears)
// on a project/workspace switch, prunes entries whose row vanished (refresh / external move), and
// clears on Escape (yielding to any open overlay or focused text field) or an empty-body click.

import { useCallback, useEffect, useMemo, useState } from 'react'

import type { FileNode } from '@shared/types'
import { parentOf, toSel, type RootDesc, type SelItem } from './filetree-ops'

export interface TreeSelectionDeps {
  childrenByPath: Record<string, FileNode[]>
  expanded: Set<string>
  roots: RootDesc[]
  collapsedSet: Set<string>
  rootPath: string
  wsRoot: string | null
}

export interface TreeSelection {
  selection: SelItem[]
  anchor: SelItem | null
  setSelection: React.Dispatch<React.SetStateAction<SelItem[]>>
  setAnchor: React.Dispatch<React.SetStateAction<SelItem | null>>
  selectedPaths: Set<string>
  primary: SelItem | null
  visibleRows: FileNode[]
  orderSelection: (items: SelItem[]) => SelItem[]
  selectOnly: (node: FileNode) => void
  clearSelection: () => void
  clearSelIfAffected: (path: string) => void
}

export function useTreeSelection(deps: TreeSelectionDeps): TreeSelection {
  const { childrenByPath, expanded, roots, collapsedSet, rootPath, wsRoot } = deps

  const [selection, setSelection] = useState<SelItem[]>([])
  // The anchor a Shift-range is measured from: the last row clicked WITHOUT Shift. A following
  // Shift+click recomputes the range from this same anchor (Finder semantics) rather than
  // extending from the previous shift target.
  const [anchor, setAnchor] = useState<SelItem | null>(null)

  const selectedPaths = useMemo(() => new Set(selection.map((s) => s.path)), [selection])
  // The row every single-target affordance acts on (header create, and the pre-E-018 fallbacks):
  // the anchor when there is one, else the most recently added item.
  const primary: SelItem | null = anchor ?? selection[selection.length - 1] ?? null

  // The tree flattened to the rows the user can actually SEE, in render order — the coordinate
  // system a Shift-range is defined in (a collapsed subtree contributes nothing by construction).
  const visibleRows = useMemo(() => {
    const out: FileNode[] = []
    const walk = (dir: string): void => {
      for (const node of childrenByPath[dir] ?? []) {
        out.push(node)
        if (node.kind === 'dir' && expanded.has(node.path)) walk(node.path)
      }
    }
    // E-026 — every root in order; a collapsed root (header only) contributes no rows.
    for (const r of roots) {
      if (collapsedSet.has(r.id)) continue
      walk(r.path)
    }
    return out
  }, [childrenByPath, expanded, roots, collapsedSet])

  // Selection in visible-row order (bulk actions apply top-to-bottom, as the user sees them).
  const orderSelection = useCallback(
    (items: SelItem[]): SelItem[] => {
      const index = new Map(visibleRows.map((n, i) => [n.path, i]))
      return [...items].sort(
        (a, b) =>
          (index.get(a.path) ?? Number.MAX_SAFE_INTEGER) - (index.get(b.path) ?? Number.MAX_SAFE_INTEGER)
      )
    },
    [visibleRows]
  )

  const selectOnly = useCallback((node: FileNode): void => {
    const item = toSel(node)
    setSelection([item])
    setAnchor(item)
  }, [])

  const clearSelection = useCallback((): void => {
    setSelection([])
    setAnchor(null)
  }, [])

  // Drop from the selection the entry at `path` and everything under it (it was deleted/moved).
  const clearSelIfAffected = useCallback((path: string): void => {
    const gone = (p: string): boolean => p === path || p.startsWith(path + '/')
    setSelection((sel) => (sel.some((s) => gone(s.path)) ? sel.filter((s) => !gone(s.path)) : sel))
    setAnchor((a) => (a && gone(a.path) ? null : a))
  }, [])

  // Selection is per-project session state — a project/workspace switch clears it entirely.
  useEffect(() => {
    setSelection([])
    setAnchor(null)
  }, [rootPath, wsRoot])

  // E-018 — prune vanished paths. A tree refresh (fs watcher, ignore-toggle, external move) can
  // remove a selected row; drop it once its parent directory is loaded and no longer lists it. A
  // path whose parent is NOT loaded is kept (we can't tell that it's gone, only that it's hidden).
  useEffect(() => {
    setSelection((prev) => {
      if (prev.length === 0) return prev
      const next = prev.filter((s) => {
        const siblings = childrenByPath[parentOf(s.path)]
        return !siblings || siblings.some((n) => n.path === s.path)
      })
      return next.length === prev.length ? prev : next
    })
    setAnchor((prev) => {
      if (!prev) return prev
      const siblings = childrenByPath[parentOf(prev.path)]
      return !siblings || siblings.some((n) => n.path === prev.path) ? prev : null
    })
  }, [childrenByPath])

  return {
    selection,
    anchor,
    setSelection,
    setAnchor,
    selectedPaths,
    primary,
    visibleRows,
    orderSelection,
    selectOnly,
    clearSelection,
    clearSelIfAffected
  }
}
