// Pomade — shared per-project state persistence (renderer). T-157.
//
// tabs-store and mounts-store each own a DISJOINT slice of `.pomade/state/<projectId>.json`
// (main's `config-store.saveState` merges each partial payload over its stateCache). This module
// owns the plumbing both need — one implementation instead of a per-store copy, so a future
// per-project store cannot re-create the quit-loss bug by forgetting to wire a flush:
//
//   • SAVES ARE IMMEDIATE. `persist(projectId)` sends the store's partial `state.save` right
//     away; main's config-store debounce is the ONE coalescing point between a mutation and the
//     disk. (The renderer used to stack its own 500ms debounce on top — ~1s total latency — and
//     the copy in mounts-store had no flush at all, so a mount mutated within 500ms of quit was
//     silently lost.) Same doctrine workspace-store and workspace-ui-store already follow.
//     Per-project mutations are event-frequency (a close, a mount, a status flip — never
//     per-keystroke), so there is nothing for a renderer debounce to usefully coalesce.
//   • IN-FLIGHT TRACKING + `flush()`. Every `state.save` promise is tracked until it settles;
//     `flush()` awaits them all, so by the time the quit handshake acks (App's `app.onFlush`) or
//     a workspace switch proceeds, main has folded every save into its write queue — which
//     `flushPendingWrites` then drains (quit: `will-quit`; switch: `changeRoot`).
//   • HYDRATE SHARING. Concurrent `hydrateProject` calls for one project share ONE load (T-097:
//     without this, a cross-project action hydrating its target while App's start-up hydration of
//     the same project is still awaiting `state.load` would have its mutation overwritten by the
//     slower load's set()).
//   • `resetForWorkspaceSwitch()`. Clears the store's per-project fields AND hydration flags via
//     the store's own `reset` (ONE atomic set() — the T-116 snapshot-forgetter relies on the tab
//     caches and `hydratedProjects` vanishing together to read a wholesale drop as "forget
//     nothing"), and bumps the hydration GENERATION: an in-flight hydration from the old
//     workspace checks `isCurrent()` before its set(), so a slow load can never repopulate a
//     store — or re-mark a project hydrated — after the switch tore it down.
//
// Every instance self-registers. App's quit handler awaits `flushAllProjectState()` and
// `workspace-store.changeWorkspace` calls `flushAllProjectState()` then
// `resetAllProjectStateForWorkspaceSwitch()`, so a new per-project store gets quit-flush and
// switch-teardown by construction — it only supplies the four callbacks below.

import type { Id, ProjectState } from '@shared/types'

export interface ProjectStatePersistenceConfig {
  /** Is this project hydrated in the store right now? (Reads live store state — the guard that
   *  keeps a save from writing an unhydrated project's empty fields over its state file.) */
  isHydrated: (projectId: Id) => boolean
  /** The partial `state.save` payload — ONLY the fields this store owns (main merges partials
   *  over its stateCache; sending a foreign field would clobber the other store's slice). */
  payload: (projectId: Id) => Partial<ProjectState>
  /** Load this project's slice and set() it into the store — INCLUDING flipping the store's
   *  hydration flag in the same set(). MUST check `isCurrent()` immediately before the set():
   *  false means a workspace switch reset the store while the load was in flight, and applying
   *  the stale data would resurrect the old workspace's state. */
  hydrate: (projectId: Id, isCurrent: () => boolean) => Promise<void>
  /** Clear EVERY per-project field this store owns plus its hydration flags, in ONE atomic
   *  set(). Called on a workspace switch (after the old workspace's state was flushed). */
  reset: () => void
}

export interface ProjectStatePersistence {
  /** Hydrate a project once, sharing an in-flight load between concurrent callers. */
  hydrateProject: (projectId: Id) => Promise<void>
  /** Persist the project's slice now (no-op while unhydrated). Fire-and-track: the returned-void
   *  save is awaited later by `flush()`. */
  persist: (projectId: Id) => void
  /** T-156 project teardown: drop this project's hydration bookkeeping. (Saves already sent ride
   *  ahead of the teardown's `state.remove` on the ordered IPC pipe, and main's `removeState`
   *  cancels/awaits them — nothing here can resurrect the removed file.) */
  dropProject: (projectId: Id) => void
  /** Await every in-flight `state.save` for this store. */
  flush: () => Promise<void>
  /** Workspace switch: run the store's atomic reset and invalidate in-flight hydrations. */
  resetForWorkspaceSwitch: () => void
}

const registry: ProjectStatePersistence[] = []

export function createProjectStatePersistence(
  cfg: ProjectStatePersistenceConfig
): ProjectStatePersistence {
  const hydrationsInFlight = new Map<Id, Promise<void>>()
  const inFlightSaves = new Set<Promise<void>>()
  let generation = 0

  const handle: ProjectStatePersistence = {
    hydrateProject: async (projectId) => {
      if (cfg.isHydrated(projectId)) return
      const inFlight = hydrationsInFlight.get(projectId)
      if (inFlight) return inFlight
      const gen = generation
      const run = cfg.hydrate(projectId, () => gen === generation)
      hydrationsInFlight.set(projectId, run)
      try {
        await run
      } finally {
        // Only clear our own entry — a reset may have started a new generation's map already.
        if (hydrationsInFlight.get(projectId) === run) hydrationsInFlight.delete(projectId)
      }
    },

    persist: (projectId) => {
      if (!cfg.isHydrated(projectId)) return
      const p: Promise<void> = window.pomade.state
        .save(projectId, cfg.payload(projectId))
        .catch((err) => {
          console.error('[project-state] save failed', projectId, err)
        })
        .finally(() => {
          inFlightSaves.delete(p)
        })
      inFlightSaves.add(p)
    },

    dropProject: (projectId) => {
      hydrationsInFlight.delete(projectId)
    },

    flush: async () => {
      // Snapshot: saves added while awaiting belong to whoever fired them, not this flush.
      await Promise.all([...inFlightSaves])
    },

    resetForWorkspaceSwitch: () => {
      generation += 1
      hydrationsInFlight.clear()
      cfg.reset()
    }
  }

  registry.push(handle)
  return handle
}

/** Quit handshake / pre-switch flush: await every registered store's in-flight saves, so main's
 *  write queue holds the final state before `flushPendingWrites` drains it. */
export function flushAllProjectState(): Promise<void> {
  return Promise.all(registry.map((h) => h.flush())).then(() => undefined)
}

/** Workspace switch: atomically reset every registered per-project store (all per-project fields
 *  + hydration state), so nothing from the old workspace can leak into — or mask hydration of —
 *  the new one. */
export function resetAllProjectStateForWorkspaceSwitch(): void {
  for (const h of registry) h.resetForWorkspaceSwitch()
}
