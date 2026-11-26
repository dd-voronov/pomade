// Pomade — workspace-store (renderer). Groups, projects, active project.
// The Workspace project (WORKSPACE_PROJECT_ID) is always present and
// is NOT persisted to workspace.json. Every mutation persists via workspace.saveConfig (debounced).
//
// T-019 — the store also carries `fileTree: FileTreeSettings` (tree ignored items, see docs/contracts/types.md "Workspace config")
// because WorkspaceConfig.saveConfig requires it.

import { create } from 'zustand'

import {
  WORKSPACE_PROJECT_ID,
  DEFAULT_FILETREE_SETTINGS,
  type FileTreeSettings,
  type Group,
  type Id,
  type Project,
  type WorkspaceConfig,
  type WorkspaceIdentity
} from '@shared/types'
import { useTabsStore } from './tabs-store'
import { useMountsStore } from './mounts-store'
import { useSidePanelStore } from './side-panel-store'
import {
  flushAllProjectState,
  resetAllProjectStateForWorkspaceSwitch
} from './project-state-persistence'
import { useWorkspaceUiStore } from './workspace-ui-store'
import { useAppSettingsStore } from './app-settings-store'
import {
  normalizeGroupTree,
  childGroups,
  topLevelTokens,
  UNGROUPED_ID
} from '../modules/projects-panel/reorder'

export const WORKSPACE_PROJECT: Project = {
  id: WORKSPACE_PROJECT_ID,
  name: 'Workspace',
  rootPath: '',
  visibleAgents: ['*'],
  order: -1
}

/** Pure derivation: the Workspace project pinned first, then real projects by order.
 *  Components call this inside useMemo (NOT as a zustand selector — a selector that
 *  returns a fresh array every call causes an infinite render loop). */
export function buildAllProjects(projects: Project[]): Project[] {
  const ordered = [...projects].sort((a, b) => a.order - b.order)
  return [WORKSPACE_PROJECT, ...ordered]
}

/** T-103 — projects flattened in the EXACT order they appear in the
 *  Projects panel, with the Workspace project pinned first. `buildAllProjects` sorts by the
 *  flat `Project.order`, which is WRONG once groups exist (`order` is scoped per-group), so
 *  the cross-project picker needs this instead: a pre-order DFS mirroring the Projects panel render
 *  (ProjectsPanel.tsx) — walk `topLevelTokens` (top-level groups interleaved with the Ungrouped
 *  pseudo-group at its stored position); for a group, emit its member projects (by `order`)
 *  then recurse its child groups; for the Ungrouped token, emit the ungrouped projects. Groups
 *  are not shown as picker headers — only their order shapes the project sequence. Pure (no
 *  store, no React) so callers memoize it; used only where display order matters. */
export function buildProjectsPanelOrderedProjects(
  groups: Group[],
  projects: Project[],
  ungroupedOrder: number | undefined
): Project[] {
  const byGroup = new Map<string, Project[]>()
  for (const p of [...projects].sort((a, b) => a.order - b.order)) {
    const key = p.groupId ?? ''
    const list = byGroup.get(key) ?? []
    list.push(p)
    byGroup.set(key, list)
  }
  const out: Project[] = [WORKSPACE_PROJECT]
  const walkGroup = (groupId: string): void => {
    out.push(...(byGroup.get(groupId) ?? []))
    for (const child of childGroups(groups, groupId)) walkGroup(child.id)
  }
  for (const token of topLevelTokens(groups, ungroupedOrder)) {
    if (token === UNGROUPED_ID) out.push(...(byGroup.get('') ?? []))
    else walkGroup(token)
  }
  return out
}

interface WorkspaceState {
  root: string | null
  groups: Group[]
  projects: Project[]
  // T-019 — file tree ignored-items settings.
  fileTree: FileTreeSettings
  // E-010 (round-3) — optional workspace identity icon (emoji or image). undefined = unset.
  identity: WorkspaceIdentity | undefined
  // E-015 — the Ungrouped pseudo-group's position in the top-level ordering (shares the
  // top-level groups' integer order space). undefined = sorts last (pre-E-015 behavior).
  ungroupedOrder: number | undefined
  activeProjectId: Id
  hydrated: boolean

  // lifecycle
  hydrate: () => Promise<void>
  // E-006 (T-027) — pick a new workspace folder, flush + tear down current state, reload.
  changeWorkspace: () => Promise<void>

  // actions
  addGroup: (group: Group) => void
  updateGroup: (id: Id, patch: Partial<Group>) => void
  deleteGroup: (id: Id) => void
  addProject: (project: Project) => void
  updateProject: (id: Id, patch: Partial<Project>) => void
  deleteProject: (id: Id) => void
  // E-015 — persist a reordered/re-nested group tree (+ optional new Ungrouped top-level
  // position). `ungroupedOrder` omitted keeps the current value; callers pass a number only
  // when a top-level move actually repositioned Ungrouped.
  reorder: (groups: Group[], projects: Project[], ungroupedOrder?: number) => void
  setActiveProject: (id: Id) => void
  // E-010 (round-3) — set (or clear, with undefined) the workspace identity icon; persists
  // via the normal workspace.saveConfig like any other config mutation.
  setWorkspaceIdentity: (identity: WorkspaceIdentity | undefined) => void
  // T-019 — merge-patch file-tree settings (currently just `ignore`), persisted the same way.
  updateFileTree: (patch: Partial<FileTreeSettings>) => void

  // selectors
  allProjects: () => Project[]
  projectById: (id: Id) => Project | undefined
}

function persist(state: WorkspaceState): void {
  if (!state.hydrated || !state.root) return
  const config: WorkspaceConfig = {
    groups: state.groups,
    projects: state.projects,
    fileTree: state.fileTree,
    identity: state.identity,
    ungroupedOrder: state.ungroupedOrder
  }
  // Persist immediately (no renderer-side debounce): config mutations are low-frequency,
  // and a renderer debounce would drop the last change if the app quit within its window.
  // Main still debounces the actual disk write and flushes it on quit.
  void window.pomade.workspace.saveConfig(config)
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => {
  const commit = (partial: Partial<WorkspaceState>): void => {
    set(partial)
    persist(get())
  }

  return {
    root: null,
    groups: [],
    projects: [],
    fileTree: DEFAULT_FILETREE_SETTINGS,
    identity: undefined,
    ungroupedOrder: undefined,
    activeProjectId: WORKSPACE_PROJECT_ID,
    hydrated: false,

    hydrate: async () => {
      const { root, config } = await window.pomade.workspace.get()
      // E-015 — migrate/normalize the group tree on load (repair dangling parentId, cycles,
      // over-deep chains). A pre-E-015 flat config is already valid → no change. When a repair
      // WAS made, write the corrected shape back through the normal saveConfig (via commit).
      const { groups, changed } = normalizeGroupTree(config.groups)
      // T-140 / T-141 — load the workspace-scoped Projects panel UI state (collapsed groups + last-active
      // project). Only meaningful once a real workspace root is known; without one there is no
      // .pomade to read. Awaited so the boot-time last-active restore below is atomic with the
      // config set (no flash of the Workspace project → real project) and so the Projects panel's first paint already
      // reflects the collapsed groups.
      let bootActive: Id = WORKSPACE_PROJECT_ID
      if (root !== null) {
        const ui = await useWorkspaceUiStore.getState().hydrate()
        const last = ui.lastActiveProjectId
        // T-141 graceful fallback — restore only a project that still exists. The Workspace
        // project is always valid; a stale/removed id falls back to the Workspace project.
        if (last && (last === WORKSPACE_PROJECT_ID || config.projects.some((p) => p.id === last))) {
          bootActive = last
        }
      }
      set({
        root,
        groups,
        projects: config.projects,
        fileTree: config.fileTree,
        identity: config.identity,
        ungroupedOrder: config.ungroupedOrder,
        activeProjectId: bootActive,
        hydrated: root !== null
      })
      if (changed) persist(get())
    },

    // E-006 (T-027) — Change Workspace flow. Pick a folder (unconstrained native dialog);
    // if a different one is chosen: flush the CURRENT workspace's pending tab state to its
    // .pomade, then have main commit the switch (which tears down PTYs + fs watchers and
    // persists the new root), then reset the renderer tab caches and load the new workspace.
    // The App effect re-hydrates each project's tabs once `projects` changes under `hydrated`.
    changeWorkspace: async () => {
      const picked = await window.pomade.workspace.pickRoot()
      if (!picked || picked === get().root) return
      // 1. Land the old workspace's per-project state before switching: await EVERY registered
      //    store's in-flight state.save IPCs (tabs, mounts, future registrants), so main's
      //    changeRoot flushPendingWrites writes them into the OLD root's .pomade.
      await flushAllProjectState()
      // 2. Commit the switch in main (PTYs killed, watchers closed, root persisted).
      const { root, config } = await window.pomade.workspace.change(picked)
      // 3. Reset every registered per-project store (T-157 registry — no more reaching into
      //    foreign stores' internals field-by-field, which had already gone stale: it missed
      //    previewTabByProject/propertiesPanelExpandedByProject and all of mounts-store). Each
      //    store clears ALL its per-project fields + hydration flags in ONE atomic set, which
      //    keeps the T-116 snapshot-forgetter's contract: the tab caches, reopen stacks and
      //    hydratedProjects vanish together, so a wholesale drop forgets nothing.
      resetAllProjectStateForWorkspaceSwitch()
      // T-140 / T-141 — reload the new workspace's Projects panel UI state (collapsed groups are
      // workspace-scoped; the old set must not leak). Landing on the Workspace project after
      // a deliberate workspace switch is the pre-existing behavior and is left unchanged.
      await useWorkspaceUiStore.getState().hydrate()
      // App settings live in the workspace (T-313): the new one's settings, or the defaults.
      await useAppSettingsStore.getState().hydrate()
      // 4. Load the new workspace. `hydrated` stays true so the App hydrate-tabs effect fires
      //    on the new `projects` array and repopulates each project's tabs from its .pomade.
      const migrated = normalizeGroupTree(config.groups)
      set({
        root,
        groups: migrated.groups,
        projects: config.projects,
        fileTree: config.fileTree,
        identity: config.identity,
        ungroupedOrder: config.ungroupedOrder,
        activeProjectId: WORKSPACE_PROJECT_ID,
        hydrated: root !== null
      })
      if (migrated.changed) persist(get())
    },

    addGroup: (group) => commit({ groups: [...get().groups, group] }),
    updateGroup: (id, patch) =>
      commit({ groups: get().groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) }),
    deleteGroup: (id) => {
      const removed = get().groups.find((g) => g.id === id)
      commit({
        groups: get()
          .groups.filter((g) => g.id !== id)
          // E-015 — a deleted group's CHILD groups are re-parented up to the deleted group's
          // own parent (they survive, one level shallower) rather than orphaned/lost.
          .map((g) => (g.parentId === id ? { ...g, parentId: removed?.parentId } : g)),
        // orphan the group's projects to Ungrouped rather than deleting them
        projects: get().projects.map((p) =>
          p.groupId === id ? { ...p, groupId: undefined } : p
        )
      })
    },

    addProject: (project) => commit({ projects: [...get().projects, project] }),
    updateProject: (id, patch) =>
      commit({ projects: get().projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) }),
    // T-156 — a real project TEARDOWN pipeline. The old body dropped the project from `projects`
    // and repointed `activeProjectId` only, orphaning the project's live PTYs (kept alive in main
    // with no UI to reach them until quit), its `.pomade/state/<id>.json`, and every per-project
    // store entry. Deletion is now a SANCTIONED PTY-teardown path — the one besides a workspace
    // switch where killing this project's PTYs is correct. The core invariant is intact: project
    // SWITCHING never touches PTYs; this is a DELETE, not a switch.
    deleteProject: (id) => {
      const tabsStore = useTabsStore.getState()
      // 1. Silent-close every tab through the EXISTING closeTab path — no save/confirm prompt (the
      //    guards live ABOVE closeTab; this is the silent primitive, like stopAllTerminals uses).
      //    Each close fires terminals-store's PTY reaper (kills the tab's live terminal/agent) and
      //    lands the tab on the reopen stack. OTHER projects' focus is untouched — closeTab only
      //    repoints the closing project's own active tab.
      for (const tab of tabsStore.tabsFor(id)) tabsStore.closeTab(id, tab.id)
      // 2. Sweep every per-project store entry for the gone project. tabs-store clears its maps and,
      //    by clearing the reopen stack while the project is STILL hydrated, lets the T-116 snapshot-
      //    forgetter delete each per-tab scrollback file before the hydration flag is retired;
      //    mounts-store and side-panel-store clear their own. state.remove (next) cancels the
      //    closes' queued write.
      tabsStore.dropProject(id)
      useMountsStore.getState().dropProject(id)
      useSidePanelStore.getState().dropProject(id)
      // 3. Delete the persisted per-project state file (main; missing file = no-op). Its own tab
      //    ids leave the persisted world here, so a future boot gcSnapshots also stays consistent
      //    (a project deleted while never opened this run leaves no in-memory tabs to forget — its
      //    scrollback files become orphans that the next boot's GC collects).
      void window.pomade.state.remove(id)
      // 4. Drop the project from the workspace and repoint the active project if it was the one
      //    deleted; `commit` persists workspace.json.
      const nextActive = get().activeProjectId === id ? WORKSPACE_PROJECT_ID : get().activeProjectId
      commit({ projects: get().projects.filter((p) => p.id !== id), activeProjectId: nextActive })
    },

    reorder: (groups, projects, ungroupedOrder) =>
      commit({
        groups,
        projects,
        ungroupedOrder: ungroupedOrder ?? get().ungroupedOrder
      }),

    // T-151 — opening a project no longer resets any attention counter: the Projects panel count is a
    // live-derived tally of unread tabs and decrements only as those tabs are activated. Opening a
    // project therefore leaves its badge intact until the user actually reads the dotted tabs.
    // T-141 — persist the newly-active project as the last-active one (written on EVERY switch,
    // not only at quit) so the next app boot reopens it. Workspace-scoped, machine-local file.
    setActiveProject: (id) => {
      set({ activeProjectId: id })
      useWorkspaceUiStore.getState().setLastActiveProject(id)
    },

    setWorkspaceIdentity: (identity) => commit({ identity }),

    updateFileTree: (patch) => commit({ fileTree: { ...get().fileTree, ...patch } }),

    allProjects: () => buildAllProjects(get().projects),
    projectById: (id) => buildAllProjects(get().projects).find((p) => p.id === id)
  }
})
