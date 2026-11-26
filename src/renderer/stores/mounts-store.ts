// Pomade — mounts-store (renderer). E-026: the extra file-tree roots a project mounts below
// its own root, plus which roots are collapsed to their header line. Per-project, persisted via
// the SAME per-project state file tabs-store uses (`.pomade/state/<projectId>.json`).
//
// Persistence discipline (shared with tabs-store via createProjectStatePersistence, T-157): a
// mutation immediately sends ONE state.save carrying ONLY the fields this store owns — `mounts`
// and `collapsedRoots`. main (config-store.saveState) merges that partial over the last-known
// state, so this writer never clobbers tabs-store's fields and vice versa. We do NOT
// read-modify-write on the renderer side (that would race main's coalescing debounce); the
// merge lives in main.

import { create } from 'zustand'
import { nanoid } from 'nanoid'

import { createProjectStatePersistence } from './project-state-persistence'

import type { Id, Mount } from '@shared/types'
import { PROJECT_ROOT_ID } from '@shared/types'
import { classifyScope, normalizeWorkspaceRelPath, type Scope } from '@shared/paths'

// ── Pure path validation (T-129) — the mount popup's brain ─────────────────────
// Takes a hand-typed raw path plus the active project root, the workspace root, the home dir,
// and the paths of every root already showing. Returns the canonical stored form, its scope
// tier, whether it lands OUTSIDE the workspace (which routes the fs read in Slice 2), and — when
// it can't be mounted — a machine reason. `ok` means "a distinct, non-empty path": empty and
// duplicate are the only hard rejections. An outside-workspace path is `ok` (Slice 2 will mount
// it); the Slice-1 popup gates on `scope`/`outside` separately.
export interface MountValidation {
  ok: boolean
  /** Stored form: workspace-relative when inside the workspace, absolute when outside it. */
  canonicalPath: string
  scope: Scope
  /** True iff canonicalPath is an absolute outside-workspace path (routes fs.tree vs treeOutside). */
  outside: boolean
  reason?: 'empty' | 'duplicate'
}

export interface ValidateCtx {
  projectRoot: string
  workspaceRoot: string
  home?: string
  /** Paths of every root already visible (the project root's path + each mount's path). */
  existingRootPaths: string[]
}

export function validateMountPath(raw: string, ctx: ValidateCtx): MountValidation {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { ok: false, canonicalPath: '', scope: 'in-project', outside: false, reason: 'empty' }
  }

  // Expand a leading `~` to the home dir (paths pasted straight from a shell). Without a known
  // home we can't expand, so a `~`-path falls through as-is and reads as workspace-relative.
  let input = trimmed
  if (ctx.home && (input === '~' || input.startsWith('~/'))) {
    input = ctx.home + input.slice(1)
  }

  let canonicalPath: string
  let outside: boolean
  const ws = ctx.workspaceRoot
  if (input.startsWith('/')) {
    const abs = input.replace(/\/+$/, '') // drop trailing slash(es)
    if (ws && (abs === ws || abs.startsWith(ws + '/'))) {
      // Absolute but INSIDE the workspace → store workspace-relative, same class as a typed
      // relative path (Slice 1 reuses fs.tree).
      canonicalPath = abs === ws ? '' : abs.slice(ws.length + 1)
      outside = false
    } else {
      canonicalPath = abs
      outside = true
    }
  } else {
    canonicalPath = normalizeWorkspaceRelPath(input)
    outside = false
  }

  const scope = classifyScope(canonicalPath, ctx.projectRoot)

  // Duplicate / self: the pasted path already backs a visible root (the project root or a mount).
  // Compare on the canonical form so `./Knowledge`, `Knowledge/`, and `Knowledge` all collide.
  const existing = new Set(ctx.existingRootPaths.map((p) => (p.startsWith('/') ? p : normalizeWorkspaceRelPath(p))))
  if (existing.has(canonicalPath)) {
    return { ok: false, canonicalPath, scope, outside, reason: 'duplicate' }
  }

  return { ok: true, canonicalPath, scope, outside }
}

// ── Store ──────────────────────────────────────────────────────────────────────
interface MountsState {
  mountsByProject: Record<Id, Mount[]>
  collapsedByProject: Record<Id, string[]> // root ids (mount ids + PROJECT_ROOT_ID)
  hydratedProjects: Record<Id, boolean>

  hydrateProject: (projectId: Id) => Promise<void>
  /** Add a mount with an already-canonical path (the popup validates first). No-op on a
   *  duplicate (defensive — the popup catches it and flashes the existing root). Returns the
   *  new mount id, or null if it was a duplicate. */
  addMount: (projectId: Id, path: string, outside: boolean, inScope?: boolean) => Id | null
  removeMount: (projectId: Id, mountId: Id) => void
  /** T-144 — set (or clear) a mount's custom display name. A trimmed-empty name clears it
   *  (the header reverts to the path). No-op for an unknown mount id. */
  renameMount: (projectId: Id, mountId: Id, name: string | undefined) => void
  /** E-047 — put a mount in the project's scope or take it out. No-op for an unknown mount id. */
  setMountInScope: (projectId: Id, mountId: Id, inScope: boolean) => void
  setRootCollapsed: (projectId: Id, rootId: string, collapsed: boolean) => void
  // T-156 — project TEARDOWN: drop this store's per-project entries (mounts, collapsed roots,
  // hydration flag) for a DELETED project; the caller's state.remove cancels/awaits the already-
  // sent saves in main, so nothing re-creates the file main is about to remove.
  dropProject: (projectId: Id) => void
}

export const useMountsStore = create<MountsState>((set, get) => {
  // T-157 — the shared per-project persistence plumbing (immediate partial state.save with
  // in-flight tracking, hydrate-sharing, quit flush, workspace-switch reset). Self-registers with
  // the flush/reset registries, so a mount mutated moments before quit is flushed like a tab —
  // the old per-store copy of this plumbing had no flush and lost it.
  const persistence = createProjectStatePersistence({
    isHydrated: (projectId) => get().hydratedProjects[projectId] === true,
    // Partial patch: only the fields this store owns. main merges over tabs-store's fields.
    payload: (projectId) => ({
      mounts: get().mountsByProject[projectId] ?? [],
      collapsedRoots: get().collapsedByProject[projectId] ?? []
    }),

    hydrate: async (projectId, isCurrent) => {
      const loaded = await window.pomade.state.load(projectId)
      // T-157 — a workspace switch reset the store while this load was in flight; applying the
      // stale data would show the old workspace's mounts in the new one.
      if (!isCurrent()) return
      set((s) => ({
        mountsByProject: { ...s.mountsByProject, [projectId]: loaded?.mounts ?? [] },
        collapsedByProject: { ...s.collapsedByProject, [projectId]: loaded?.collapsedRoots ?? [] },
        hydratedProjects: { ...s.hydratedProjects, [projectId]: true }
      }))
    },

    // Workspace switch — one atomic set clearing every per-project field + the hydration flags.
    // Clearing hydratedProjects is what makes a LATER switch back to a previously-visited
    // workspace re-hydrate from that workspace's disk state instead of serving the old
    // workspace's in-memory mounts (the pre-T-157 stale-mounts bug: this store was never reset).
    reset: () =>
      set({
        mountsByProject: {},
        collapsedByProject: {},
        hydratedProjects: {}
      })
  })

  const afterMutation = (projectId: Id): void => persistence.persist(projectId)

  return {
    mountsByProject: {},
    collapsedByProject: {},
    hydratedProjects: {},

    hydrateProject: (projectId) => persistence.hydrateProject(projectId),

    addMount: (projectId, path, outside, inScope) => {
      const current = get().mountsByProject[projectId] ?? []
      if (current.some((m) => m.path === path)) return null
      const mount: Mount = {
        id: nanoid(),
        path,
        ...(outside ? { outside: true } : {}),
        ...(inScope ? { inScope: true } : {})
      }
      set((s) => ({
        mountsByProject: { ...s.mountsByProject, [projectId]: [...current, mount] }
      }))
      afterMutation(projectId)
      return mount.id
    },

    removeMount: (projectId, mountId) => {
      const current = get().mountsByProject[projectId] ?? []
      if (!current.some((m) => m.id === mountId)) return
      set((s) => ({
        mountsByProject: {
          ...s.mountsByProject,
          [projectId]: current.filter((m) => m.id !== mountId)
        },
        // A removed mount can't stay in the collapsed set.
        collapsedByProject: {
          ...s.collapsedByProject,
          [projectId]: (s.collapsedByProject[projectId] ?? []).filter((id) => id !== mountId)
        }
      }))
      afterMutation(projectId)
    },

    renameMount: (projectId, mountId, name) => {
      const current = get().mountsByProject[projectId] ?? []
      const idx = current.findIndex((m) => m.id === mountId)
      if (idx < 0) return
      const trimmed = name?.trim()
      const nextMount: Mount = { ...current[idx] }
      if (trimmed) nextMount.name = trimmed
      else delete nextMount.name
      // No-op if nothing actually changed (avoids a redundant persist/render).
      if (nextMount.name === current[idx].name) return
      const next = [...current]
      next[idx] = nextMount
      set((s) => ({ mountsByProject: { ...s.mountsByProject, [projectId]: next } }))
      afterMutation(projectId)
    },

    setMountInScope: (projectId, mountId, inScope) => {
      const current = get().mountsByProject[projectId] ?? []
      const idx = current.findIndex((m) => m.id === mountId)
      if (idx < 0 || !!current[idx].inScope === inScope) return
      const nextMount: Mount = { ...current[idx] }
      if (inScope) nextMount.inScope = true
      else delete nextMount.inScope
      const next = [...current]
      next[idx] = nextMount
      set((s) => ({ mountsByProject: { ...s.mountsByProject, [projectId]: next } }))
      afterMutation(projectId)
    },

    setRootCollapsed: (projectId, rootId, collapsed) => {
      const current = get().collapsedByProject[projectId] ?? []
      const has = current.includes(rootId)
      if (collapsed === has) return
      const next = collapsed ? [...current, rootId] : current.filter((id) => id !== rootId)
      set((s) => ({
        collapsedByProject: { ...s.collapsedByProject, [projectId]: next }
      }))
      afterMutation(projectId)
    },

    // T-156 — project teardown (see the interface note). No snapshot concern here, so a single set.
    dropProject: (projectId) => {
      const drop = <T>(m: Record<Id, T>): Record<Id, T> => {
        if (!(projectId in m)) return m
        const next = { ...m }
        delete next[projectId]
        return next
      }
      set((s) => ({
        mountsByProject: drop(s.mountsByProject),
        collapsedByProject: drop(s.collapsedByProject),
        hydratedProjects: drop(s.hydratedProjects)
      }))
      // Drop the hydration bookkeeping; already-sent saves are cancelled/awaited by the caller's
      // state.remove in main, and the retired hydration flag blocks any later stray save.
      persistence.dropProject(projectId)
    }
  }
})

// Re-export for callers that want the sentinel alongside the store.
export { PROJECT_ROOT_ID }
