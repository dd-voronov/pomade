// Pomade — file-tree DATA hook (T-159): the lazy per-directory children cache, per-node expansion,
// the "show ignored items" toggle, the per-root missing/flash markers, and the live fs.watch wiring. Every
// loader routes an ABSOLUTE outside-workspace path through the T-131/T-132 door and a ws-relative
// path through the escape-guarded fs.tree (see `fetchTree`). Selection state lives in
// `useTreeSelection`; this hook resets only its own tree state on a project/workspace switch.

import { useCallback, useEffect, useRef, useState } from 'react'

import { createChangeBatch } from '@shared/change-batch'
import { INDEX_IGNORE_NAMES } from '@shared/ignore-names'
import { createSettler } from '@shared/settle'
import { isInFolders } from '@shared/skipped-paths'
import type { FileNode } from '@shared/types'
import { fetchTree, parentOf, type RootDesc } from './filetree-ops'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { foldersToReread, skipListFolders } from './tree-refresh'

// What `fs.treeOutside` always leaves out of an outside folder's listing.
const OUTSIDE_HIDDEN = new Set<string>(INDEX_IGNORE_NAMES)

/** How often the tree re-reads the expanded folders on the watcher's skip-list (T-296). */
export const SKIP_LIST_POLL_MS = 2000

export interface TreeDataDeps {
  roots: RootDesc[]
  rootPath: string
  wsRoot: string | null
  activeProjectId: string
  mounts: { id: string; path: string; name?: string }[]
  hydrateMounts: (projectId: string) => Promise<void> | void
}

export interface TreeData {
  childrenByPath: Record<string, FileNode[]>
  expanded: Set<string>
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>
  missingRoots: Set<string>
  showIgnored: boolean
  setShowIgnored: React.Dispatch<React.SetStateAction<boolean>>
  flashRootId: string | null
  loadDir: (path: string) => Promise<void>
  refreshLoaded: () => void
  toggle: (path: string) => void
  scrollToRow: (path: string, tries?: number) => void
  flashRoot: (rootId: string) => void
}

/** What a listing shows, as one comparable string; null when nothing is cached. */
function listingKey(children: FileNode[] | undefined): string | null {
  if (!children) return null
  return children
    .map((c) => `${c.kind}:${c.name}:${c.ignored ? 1 : 0}:${c.symlink ? 1 : 0}:${c.unwatched ? 1 : 0}`)
    .join('\n')
}

export function useTreeData(deps: TreeDataDeps): TreeData {
  const { roots, rootPath, wsRoot, activeProjectId, mounts, hydrateMounts } = deps

  const [childrenByPath, setChildren] = useState<Record<string, FileNode[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // T-019 — local, session-only: reveal ignored entries (dimmed) without changing the
  // persisted ignored items. Off by default (today's hide-by-design behavior, unchanged).
  const [showIgnored, setShowIgnored] = useState(false)
  // E-026 — roots (by path) whose fs.tree currently throws: rendered in the muted "doesn't
  // exist anymore" state, kept (never auto-removed), still unmountable.
  const [missingRoots, setMissingRoots] = useState<Set<string>>(new Set())
  // E-026 — a root id briefly flashed (a duplicate paste, or a just-added mount) to draw the eye.
  const [flashRootId, setFlashRootId] = useState<string | null>(null)

  const childrenRef = useRef(childrenByPath)
  childrenRef.current = childrenByPath
  const showIgnoredRef = useRef(showIgnored)
  showIgnoredRef.current = showIgnored
  // E-026 — the current roots, for the reset/watch effects (they must cover every root, not
  // just the project root, without re-subscribing on every children change).
  const rootsRef = useRef(roots)
  rootsRef.current = roots
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

  // Each reader resolves true when what it read differs from what the tree showed — what the
  // watch's settle (T-243) needs to know whether to keep re-checking.
  const readDir = useCallback(async (path: string): Promise<boolean> => {
    const before = listingKey(childrenRef.current[path])
    try {
      const node = await fetchTree(path, 1, showIgnoredRef.current)
      setChildren((prev) => ({ ...prev, [path]: node.children ?? [] }))
      return listingKey(node.children ?? []) !== before
    } catch {
      // Directory vanished (e.g. deleted on disk) — drop it from the cache.
      setChildren((prev) => {
        const next = { ...prev }
        delete next[path]
        return next
      })
      return before !== null
    }
  }, [])
  const loadDir = useCallback(
    async (path: string): Promise<void> => {
      await readDir(path)
    },
    [readDir]
  )

  // E-026 — load a ROOT's direct children, tracking the "doesn't exist anymore" state: on a
  // throw (deleted on disk, or an outside root whose treeOutside read fails) the root is marked
  // missing and its cached children dropped; a later successful load clears the mark. Keyed by root
  // path — an absolute outside root reads through the T-131 door via fetchTree (T-132).
  const loadRootDir = useCallback(async (path: string): Promise<boolean> => {
    const before = listingKey(childrenRef.current[path])
    try {
      const node = await fetchTree(path, 1, showIgnoredRef.current)
      setChildren((prev) => ({ ...prev, [path]: node.children ?? [] }))
      setMissingRoots((prev) => {
        if (!prev.has(path)) return prev
        const next = new Set(prev)
        next.delete(path)
        return next
      })
      return listingKey(node.children ?? []) !== before
    } catch {
      setChildren((prev) => {
        const next = { ...prev }
        delete next[path]
        return next
      })
      setMissingRoots((prev) => {
        if (prev.has(path)) return prev
        const next = new Set(prev)
        next.add(path)
        return next
      })
      return before !== null
    }
  }, [])

  // Reset and load every root whenever the active project's root — or the workspace itself
  // (T-027 switch) — changes.
  useEffect(() => {
    setChildren({})
    setExpanded(new Set())
    setMissingRoots(new Set())
    for (const r of rootsRef.current) void loadRootDir(r.path)
  }, [rootPath, wsRoot, loadRootDir])

  // E-026 — hydrate this project's mounts (idempotent; shares an in-flight load).
  useEffect(() => {
    void hydrateMounts(activeProjectId)
  }, [activeProjectId, hydrateMounts])

  // E-026 — load any mount root not yet in the cache (a freshly-added mount, or mounts that
  // arrived from hydration after the reset effect ran). The project root is handled above.
  useEffect(() => {
    for (const m of mounts) {
      if (!(m.path in childrenRef.current) && !missingRoots.has(m.path)) void loadRootDir(m.path)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the mount list; missingRoots is only read to skip a root already known missing, and its changes come from loadRootDir itself
  }, [mounts, loadRootDir])

  // E-012 (final) / P-021 — scroll a (possibly just-rendered) row into view. Retries across
  // frames because the row appears only after the async loadDir + setExpanded state commits.
  const scrollToRow = useCallback((path: string, tries = 12): void => {
    const el = document.querySelector(`[data-testid="tree-node-${CSS.escape(path)}"]`)
    if (el) {
      ;(el as HTMLElement).scrollIntoView({ block: 'nearest' })
      return
    }
    if (tries > 0) requestAnimationFrame(() => scrollToRow(path, tries - 1))
  }, [])

  // E-026 — scroll a root HEADER into view (by root id) and briefly flash it: a duplicate paste
  // jumps to the root already showing; a fresh mount draws the eye to the new header.
  const flashRoot = useCallback((rootId: string): void => {
    const el = document.querySelector(`[data-root-id="${CSS.escape(rootId)}"]`)
    if (el) (el as HTMLElement).scrollIntoView({ block: 'nearest' })
    setFlashRootId(rootId)
  }, [])

  // Clear the flash after its animation window.
  useEffect(() => {
    if (!flashRootId) return
    const t = setTimeout(() => setFlashRootId(null), 900)
    return () => clearTimeout(t)
  }, [flashRootId])

  // E-026 — reload every loaded directory AND re-check every root's existence. Root paths go
  // through loadRootDir (which flips the missing marker); a deleted mount has no cached children
  // to iterate, so re-checking the roots explicitly is what surfaces its "doesn't exist" state.
  // Resolves true when anything the tree shows changed.
  const refreshAll = useCallback(async (): Promise<boolean> => {
    const rootPaths = new Set(rootsRef.current.map((r) => r.path))
    const reads = rootsRef.current.map((r) => loadRootDir(r.path))
    for (const p of Object.keys(childrenRef.current)) if (!rootPaths.has(p)) reads.push(readDir(p))
    return (await Promise.all(reads)).some(Boolean)
  }, [readDir, loadRootDir])
  const refreshLoaded = useCallback((): void => {
    void refreshAll()
  }, [refreshAll])

  // T-273 — re-read only `folders` (roots through loadRootDir). Resolves true when anything the
  // tree shows changed.
  const refreshFolders = useCallback(
    async (folders: Iterable<string>): Promise<boolean> => {
      const rootPaths = new Set(rootsRef.current.map((r) => r.path))
      const reads = [...folders].map((p) => (rootPaths.has(p) ? loadRootDir(p) : readDir(p)))
      return (await Promise.all(reads)).some(Boolean)
    },
    [readDir, loadRootDir]
  )

  // T-019 — the ignore-visibility toggle changes what fs.tree returns; refetch every
  // directory currently in the cache (open or not) so newly-revealed/hidden ignored
  // entries appear immediately instead of waiting for the next fs change or expand.
  useEffect(() => {
    refreshLoaded()
    // Intentionally keyed only on showIgnored — root/mount changes are handled by the effects
    // above; re-running this one on every root change too would just be a redundant fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on showIgnored only; root and mount changes reload through the effects above
  }, [showIgnored])

  // The unwatched folders changed: every loaded listing may now mark a folder differently, and a
  // folder that left the list may have changed while nothing watched it.
  const unwatched = useWorkspaceStore((s) => s.fileTree.unwatched)
  const unwatchedSeen = useRef(unwatched)
  useEffect(() => {
    if (unwatchedSeen.current === unwatched) return
    unwatchedSeen.current = unwatched
    refreshLoaded()
  }, [unwatched, refreshLoaded])

  // Live watching (E-026): one recursive workspace watcher per in-workspace root, plus each
  // within-workspace mount's PARENT dir so the mount's OWN deletion is observed (a recursive watch
  // on a folder that is itself deleted may error out before broadcasting). An OUTSIDE-workspace
  // root (T-132) is watched through the T-131 door instead (fs.watchOutside): its change events
  // arrive on the SAME fs.onChanged channel keyed by the ABSOLUTE root path, and watching the root
  // there already catches the root's own deletion (no parent watch needed). Watchers dedupe by key
  // in main, so overlapping keys cost nothing.
  // T-273 — each event names the changed paths and whether each exists; the tree collects them over
  // a debounce window with a maximum wait (`@shared/change-batch`) and re-reads only the loaded
  // folders whose listing they contradict (`foldersToReread`). A batch that cannot name its paths
  // re-reads everything; a batch of writes to listed files reads nothing.
  // T-243 — the native watcher can miss a change (a descriptor not live yet, a second change
  // dropped), so the tree SETTLES (`@shared/settle`), re-reading at bounded delays until a re-read
  // finds nothing new. Once its watches are registered, and after a batch that cannot name its
  // paths, it re-reads everything it shows — nothing narrower is known. After a targeted refresh
  // (T-296) it re-reads only the folders the batches of that settle re-read: a dropped event is a
  // second change to a path changed moments before, whose folder the first change already named.
  useEffect(() => {
    const inKeys = new Set<string>() // ws-relative → escape-guarded fs.watch
    const outKeys = new Set<string>() // absolute → fs.watchOutside (the mount door)
    for (const r of roots) {
      if (r.path.startsWith('/')) {
        outKeys.add(r.path)
      } else {
        inKeys.add(r.path)
        if (r.kind === 'mount') inKeys.add(parentOf(r.path))
      }
    }
    const fullSettler = createSettler(refreshAll)
    const settling = new Set<string>()
    const targetedSettler = createSettler(
      () => refreshFolders(settling),
      undefined,
      () => settling.clear()
    )
    const registered = [
      ...[...inKeys].map((k) => window.pomade.fs.watch(k)),
      ...[...outKeys].map((k) => window.pomade.fs.watchOutside(k))
    ]
    void Promise.allSettled(registered).then(() => fullSettler.kick())
    // The onChanged handler matches ANY watched key — absolute (outside) keys included, since they
    // never collide with the ws-relative ones.
    const watched = new Set<string>([...inKeys, ...outKeys])
    const batch = createChangeBatch<boolean>((changes) => {
      if (changes === null) {
        void refreshAll().finally(() => fullSettler.kick())
        return
      }
      // A name the tree hides — the workspace's ignored items unless shown, the index ignore set
      // outside the workspace — is in no listing, so its changes re-read nothing.
      const ignored = showIgnoredRef.current ? null : new Set(useWorkspaceStore.getState().fileTree.ignore)
      const hidden = (path: string): boolean => {
        const name = path.slice(path.lastIndexOf('/') + 1)
        return path.startsWith('/') ? OUTSIDE_HIDDEN.has(name) : (ignored?.has(name) ?? false)
      }
      const folders = foldersToReread(
        [...changes].map(([path, exists]) => ({ path, exists })),
        childrenRef.current,
        rootsRef.current.map((r) => r.path),
        hidden
      )
      if (folders.size === 0) return
      void refreshFolders(folders).finally(() => {
        for (const f of folders) settling.add(f)
        targetedSettler.kick()
      })
    }, 150)
    const off = window.pomade.fs.onChanged(({ root, changes }) => {
      if (!watched.has(root)) return
      if (changes === null) batch.add(null, true)
      else for (const c of changes) batch.add(c.path, c.exists)
    })
    return () => {
      batch.cancel()
      fullSettler.dispose()
      targetedSettler.dispose()
      off()
      for (const k of inKeys) void window.pomade.fs.unwatch(k)
      for (const k of outKeys) void window.pomade.fs.unwatchOutside(k)
    }
  }, [roots, wsRoot, refreshAll, refreshFolders])

  // T-296 — the watcher reports nothing inside a skip-list folder (`node_modules`, `dist`, …), so
  // the tree re-reads the expanded ones itself, at a bounded rate, never two passes at once.
  useEffect(() => {
    let reading = false
    const timer = setInterval(() => {
      if (reading) return
      const folders = skipListFolders(
        Object.keys(childrenRef.current).filter((p) => expandedRef.current.has(p)),
        rootsRef.current.map((r) => r.path)
      )
      if (folders.length === 0) return
      reading = true
      void refreshFolders(folders).finally(() => {
        reading = false
      })
    }, SKIP_LIST_POLL_MS)
    return () => clearInterval(timer)
  }, [refreshFolders])

  const toggle = useCallback(
    (path: string): void => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
          // A skip-list folder's cached listing went stale while it was collapsed (T-296); so did
          // an unwatched folder's, which nothing refreshes while it is open either.
          const stale =
            skipListFolders([path], rootsRef.current.map((r) => r.path)).length > 0 ||
            (!path.startsWith('/') && isInFolders(path, useWorkspaceStore.getState().fileTree.unwatched))
          if (!childrenRef.current[path] || stale) void loadDir(path)
        }
        return next
      })
    },
    [loadDir]
  )

  return {
    childrenByPath,
    expanded,
    setExpanded,
    missingRoots,
    showIgnored,
    setShowIgnored,
    flashRootId,
    loadDir,
    refreshLoaded,
    toggle,
    scrollToRow,
    flashRoot
  }
}
