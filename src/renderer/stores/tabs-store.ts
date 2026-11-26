// Pomade — tabs-store (renderer). Per-project open tabs + active tab.
// Persists per project via state.save — immediately on each mutation; main's config-store
// debounces the disk write (see stores/project-state-persistence.ts, T-157). Terminal-specific
// actions live in terminals-store (Wave 2b) which CALLS into this store — do not reorder
// existing exports.

import { isDocTabOf, retargetVersion, sameDocTab, versionPath, versionTabTitle } from '@shared/doc-version'
import { create } from 'zustand'
import { nanoid } from 'nanoid'

import { createProjectStatePersistence } from './project-state-persistence'
// T-185 — capture the visible pane's reading position at the save points (tab switch / close).
import { captureViewport } from './viewport-capture'

// WAVE2C (editor) added DocTab — additive import for the setDocMeta action appended below.
import type { ClosedTabEntry, DocTab, Id, ProjectState, Tab } from '@shared/types'
import { REOPEN_STACK_CAP } from '@shared/types'
// T-170 — openDocByPath's shared "open default"/jump machinery. `open-mode` is a small pure
// module (no tabs-store import), so this is not a cycle.
import { initialDocMode } from '../modules/editor/open-mode'
import { useJumpStore } from './jump-store'
import { basename } from '../lib/path-display'

// T-044 — a close guard's resolution: 'proceed' (closed, or the user chose to keep working
// but let the batch continue) advances a batch; 'cancel' aborts the remaining sequence.
export type CloseOutcome = 'proceed' | 'cancel'

interface TabsState {
  tabsByProject: Record<Id, Tab[]>
  activeTabByProject: Record<Id, Id | undefined>
  // T-063 — the per-project "preview" tab (VS Code-style). RUNTIME-only (session state, NOT
  // persisted to ProjectState): a doc opened by a single tree click while preview mode is on
  // occupies this slot; the next tree click REPLACES it in place. Committed (slot cleared) by any
  // other interaction — an edit (markDirty true), a click into a pane, or activating another tab.
  previewTabByProject: Record<Id, Id | undefined>
  // E-013 (T-053 round-3) — per-project properties-panel expand state. Absent = expanded
  // (default true). Subscribing here is what makes a toggle in one pane apply live to every
  // other open pane OF THE SAME PROJECT; persisted in ProjectState via the normal state.save.
  propertiesPanelExpandedByProject: Record<Id, boolean | undefined>
  // T-149 — the per-project undo-close (reopen) stack, LIFO, cap REOPEN_STACK_CAP. Every explicit
  // close (closeTab, closeAllDocs/closeSavedDocs) pushes; `restoreClosedTab` pops. Persisted in
  // ProjectState.reopenStack via the normal state.save, so reopen survives an app restart.
  reopenStackByProject: Record<Id, ClosedTabEntry[]>
  // T-189 — per-project MRU (most-recently-used) activation stack, session-local (RUNTIME-only,
  // NOT persisted: no history survives a restart, adopted from the ticket's planning note). Each
  // id appears at most once; the LAST element is the most-recently-active tab (the invariant
  // "top === active tab" is maintained by recordActivation on every active-change). Closing the
  // ACTIVE tab focuses the most-recent SURVIVING entry here; only when none survives does the
  // right-neighbour (T-107) fallback fire. Entries are pruned when a tab is closed or moved to
  // another project. Bounded at MRU_CAP so it can never grow unbounded.
  activationHistoryByProject: Record<Id, Id[]>
  hydratedProjects: Record<Id, boolean>

  // lifecycle
  hydrateProject: (projectId: Id) => Promise<void>

  // actions (pinned in docs/contracts/stores.md "tabs-store")
  // T-036 append — optional `opts.afterTabId`: insert the tab immediately AFTER that tab
  // (Cmd+T inserts right of the active tab) instead of appending at the end. Unknown or
  // omitted id ⇒ append, as before.
  // T-063 append — `opts.preview: true` opens the tab as this project's PREVIEW tab (records it
  // in `previewTabByProject`). Any OTHER open (preview omitted) COMMITS an outstanding preview.
  // E-037 — `background`: insert without activating (the active tab, the preview slot and the MRU
  // stack are untouched) — a comparison tab opening the doc whose buffer it shares.
  openTab: (tab: Tab, opts?: { afterTabId?: Id; preview?: boolean; background?: boolean }) => void
  closeTab: (projectId: Id, tabId: Id) => void

  // T-170 — the ONE "open (or jump to) a doc tab by path" action. Replaces four hand-rolled
  // copies (FileTree.openDoc, EditorPane.openDocTab, term-link-open.openDocFromLink,
  // TerminalActions.newDoc) that each rebuilt the Tab literal and drifted — most visibly, the
  // terminal-link path never set the symlink flag, so a doc opened via a Cmd+click on a symlinked
  // path silently lost the tab-strip glyph the other three paths set. Owns:
  //   • dedupe-or-activate — an already-open tab for `path` is activated instead of duplicated.
  //     Guarded on a NON-EMPTY path: `path: ''` (TerminalActions' "New Document") never dedupes,
  //     so repeated untitled-doc creates keep landing as distinct tabs (today's behavior).
  //   • `initialDocMode(path)` (E-024), overridable via `opts.mode` — "New Document" starts at the
  //     rich-formatting default regardless of extension (goes rich once saved as .md), which
  //     `initialDocMode` alone can't express for an empty path.
  //   • the symlink flag: `opts.symlink` is authoritative when the caller already knows it (the
  //     file-tree node carries its own fresh symlink bit) — no stat. Left undefined (and `path`
  //     non-empty), the action stats it itself (outside-workspace-aware: an absolute `path` goes
  //     through `fs.statOutside`, matching EditorPane's own load/save dispatch) and patches the
  //     new tab via `setDocMeta` once the result lands — this is what closes the terminal-link gap.
  //   • T-063 preview-tab semantics, opt-in via `opts.usePreviewMode` (FileTree.openDoc is the only
  //     caller that ever sets it — the other three sites always open a REAL tab, unconditionally,
  //     exactly as before): replaces a non-dirty preview tab in place, else opens a fresh preview.
  //   • new tabs land right of the active tab (openTab's default anchor — unchanged).
  //   • the `:line` jump handoff (`opts.line`): fires `jumpStore.jumpTo` against whichever tab id
  //     the call resolves to (existing or new), same as term-link-open.openDocFromLink did inline.
  // Returns the id of the tab the caller ends up looking at (existing or newly created). Reveal-
  // in-tree stays the CALLER's job (only term-link-open needs it, and only conditionally) — it is
  // not part of this action's surface.
  openDocByPath: (
    projectId: Id,
    path: string,
    opts?: {
      title?: string
      mode?: 'raw' | 'rendered' | 'live'
      symlink?: boolean
      usePreviewMode?: boolean
      line?: number
      /** E-037 — open (or find) the doc without activating it, right of `afterTabId`. */
      background?: boolean
      afterTabId?: Id
    }
  ) => Id
  // T-056/T-061 — activating a DIFFERENT tab clears its red unread/attention dot on the activation
  // EDGE (marking the already-active tab keeps its dot until the user leaves AND returns). Also
  // COMMITS the project's preview tab when the newly-active tab isn't it (T-063).
  setActive: (projectId: Id, tabId: Id) => void
  markDirty: (projectId: Id, tabId: Id, dirty: boolean) => void
  // T-061 — flag ANY tab kind "unread" (the red dot). Set unconditionally (even on the active
  // tab); the edge-clear in setActive removes it when the tab is next (re)activated.
  markUnread: (projectId: Id, tabId: Id) => void
  // T-111 — clear ONE tab's attention dot directly (no activation edge). Called when the user
  // ACTS in an already-active unread tab whose activation-edge clear never fired: a terminal/
  // agent keystroke (TerminalPane.onData) or an editor edit (markDirty true). No-op — no set(),
  // no persist — when the tab is absent or already unmarked, so it is safe to call on every
  // keystroke. Distinct from the setActive edge-clear (which is tied to a tab SWITCH).
  clearTabAttention: (projectId: Id, tabId: Id) => void
  // T-063 — COMMIT the preview tab (clear the slot). With `tabId`, only commits when that tab IS
  // the current preview (so a pane commits only its own preview); without it, commits regardless.
  commitPreview: (projectId: Id, tabId?: Id) => void
  // T-063 — REPLACE the preview tab `oldTabId` with `newTab` in place (same array index), activate
  // it, and make it the new preview. A fresh tab id (not a retarget) so its EditorPane remounts and
  // loads the new file's content — the old preview pane unmounts (it is guaranteed non-dirty).
  replacePreviewTab: (projectId: Id, oldTabId: Id, newTab: Tab) => void
  closeAllDocs: (projectId: Id) => void
  closeSavedDocs: (projectId: Id) => void

  // T-149 — reopen-stack primitives. The orchestrator (`terminals-store.reopenClosedTab`) needs
  // the revive machinery, so it lives there and drives these low-level ops:
  //   • `reopenStackFor` — read the project's stack (UI enables/disables the menu item on its
  //     emptiness; the orchestrator peeks the top from it).
  //   • `restoreClosedTab` — re-insert `entry.tab` at its ORIGINAL index (clamped to the current
  //     strip length), make it active, and REMOVE that entry from the stack. §6's deliberate
  //     exception to "new tabs open right of active". The tab keeps its original id.
  //   • `dropReopenEntry` — remove `entry` from the stack WITHOUT re-inserting it (a vanished
  //     outside-workspace doc the orchestrator is skipping, matching hydration's prune).
  reopenStackFor: (projectId: Id) => ClosedTabEntry[]
  restoreClosedTab: (projectId: Id, entry: ClosedTabEntry) => void
  dropReopenEntry: (projectId: Id, entry: ClosedTabEntry) => void

  // T-156 — project TEARDOWN: drop EVERY per-project entry this store owns for a DELETED project
  // (tabs / active / preview / properties-panel / reopen stack / hydration flag). The teardown's
  // own closeTab saves ride the ordered IPC pipe AHEAD of `state.remove`, which cancels/awaits
  // them in main — nothing re-creates the file main is about to remove.
  // Deletion (workspace-store.deleteProject) routes each tab through `closeTab` FIRST, so the
  // PTY reaper has already killed the project's live terminals and the closed tabs sit on the
  // reopen stack; this then clears that stack while the project is STILL hydrated — the T-116
  // snapshot-forgetter's close signal for every per-tab scrollback — before retiring the
  // hydration flag (which the forgetter treats as "cache dropped, forget nothing").
  dropProject: (projectId: Id) => void

  // Wave 2b append: generic tab-metadata patch (used by terminals-store to sync
  // TerminalTab status/termId/lastCommand/resumeSessionId into persisted state).
  updateTab: (projectId: Id, tabId: Id, patch: Partial<Tab>) => void

  // E-013 (T-053 round-3) — toggle the per-project properties-panel expand state (persists).
  togglePropertiesPanelExpanded: (projectId: Id) => void

  // selectors
  tabsFor: (projectId: Id) => Tab[]
  activeTabFor: (projectId: Id) => Id | undefined
  // Absent = expanded (default true).
  propertiesPanelExpandedFor: (projectId: Id) => boolean

  // WAVE2C (editor) — additive action: patch a doc tab's path/title/mode
  // (used by mode toggle persistence and saving an untitled doc).
  // T-185 appended `viewport` — the persisted reading position, written by the visible pane's
  // capturer at the save points below.
  setDocMeta: (projectId: Id, tabId: Id, patch: Partial<Pick<DocTab, 'path' | 'title' | 'mode' | 'symlink' | 'richView' | 'viewport'>>) => void

  // E-016 — retarget every open DocTab whose path was affected by an in-app file operation
  // (move / rename), in EVERY project. `oldPrefix` is the moved item's old path, `newPrefix`
  // its new path: an EXACT match retargets that doc; a folder move retargets every descendant
  // by prefix-rewrite. `path` is updated (so the pane saves to the NEW path afterwards) and
  // `title` is refreshed from the new basename. The buffer is untouched — dirty state and the
  // in-memory content (the user's work) are preserved; no reload. Persists each affected project.
  retargetPaths: (oldPrefix: string, newPrefix: string) => void

  // T-097 / T-103 — cross-project tab actions (tab context menu).
  //
  // `moveTabToProject` MOVES a tab out of `fromProjectId` into `toProjectId`, landing at the
  // END of the target's strip. T-103 makes it available on EVERY kind: terminals/agents ("Move
  // to another project", live PTY rides along) AND docs ("Move to another project", the tab
  // leaves the source — distinct from `openDocInProject`, which COPIES). The tab's id and — for
  // a terminal/agent — its `termId` are UNCHANGED: the PTY lives in the main process and is
  // never touched (core invariant), so the shell keeps streaming and its process state (cwd,
  // exported vars, running command) rides along. Two things make that hold:
  //   • ONE atomic set() for both projects. A remove-then-add pair would publish an
  //     intermediate state where NO tab references the termId, and terminals-store's
  //     tab-lifecycle reaper (it diffs the termId SET on every tabs-store change) would kill
  //     the live PTY between the two updates.
  //   • the target project is HYDRATED first (see below).
  // T-103 arrival semantics: the landed tab does NOT steal focus in the target — it lands
  // ATTENTION-MARKED (red dot) so the user gets an arrival signal and clears it by opening it
  // (the setActive edge). When the target had no active tab (empty) the arrival becomes its active
  // tab and carries NO dot (an active tab never does) — that suppresses the DOT ONLY: the target
  // project's E-011 Projects panel attention counter is bumped for EVERY genuinely-new arrival, the
  // empty-target one included (the Owner re-confirmed 2026-08-18 that this is wanted). Moving the
  // source's ACTIVE tab focuses its RIGHT neighbour (fallback left) — T-103's focus-to-right
  // fix, replacing T-097's jump-to-last.
  // T-117 — a DOC move DEDUPES by path, so a project can never end up with two tabs of the same
  // file: when the target already shows that path, (a) a CLEAN moved tab is dropped and the
  // target's existing tab is re-used (marked + counter-bumped only when it was unmarked and
  // non-active — T-110's guarded-arrival rule); (b) a DIRTY moved tab REPLACES a clean existing
  // copy in its slot (the unsaved buffer is the user's work and must not be discarded); (c) both
  // dirty ⇒ both tabs are kept (buffers cannot be merged — known limit). Terminals/agents and
  // untitled docs never dedupe.
  moveTabToProject: (fromProjectId: Id, tabId: Id, toProjectId: Id) => Promise<void>
  // T-097 / T-103 — open a COPY of a doc tab in another project (docs: "Copy to another
  // project"); the original tab is untouched, since a workspace-relative `path` is readable from
  // any project. Dedupes by path: when the target already shows that path, that tab is re-used
  // instead of opening a second copy — same rule as a terminal-link open. The copy is a fresh
  // view of the file ON DISK: new tab id, `dirty: false` (the source's unsaved buffer stays with
  // the source); `mode`/`color`/`symlink` ride along. T-103 arrival semantics match
  // `moveTabToProject`: the copy (or the re-used tab on a repeat) lands ATTENTION-MARKED and does
  // NOT steal focus. When it becomes the target's active tab (empty target) it carries no dot —
  // that suppresses the DOT ONLY, never the counter: the target's E-011 counter is bumped for
  // every genuinely-new arrival, the empty-target one included (T-110 withholds the bump only for
  // a dedupe hit that adds no new mark). An untitled doc (no path) has nothing to copy
  // elsewhere ⇒ resolves to undefined. Resolves with the target project's tab id.
  openDocInProject: (fromProjectId: Id, tabId: Id, toProjectId: Id) => Promise<Id | undefined>

  // E-004 (T-048) — drag-and-drop reorder. Move `sourceId` to sit before/after `targetId`
  // (`after` true ⇒ drop on the target's right half). Pure array reorder: tab identities and
  // termIds are unchanged, so PaneHost (keyed by tab id) never remounts a pane and the PTY
  // reaper (which diffs the termId SET) never fires — a live terminal keeps its PTY. Persists.
  reorderTab: (projectId: Id, sourceId: Id, targetId: Id, after: boolean) => void

  // WAVE3 — close-guard registry. A pane (EditorPane / TerminalPane) registers a guard for
  // its tab; TabStrip's × routes through requestClose so a dirty doc / running process gets a
  // confirm instead of being force-closed. No guard ⇒ requestClose closes immediately.
  // T-044: the guard receives an optional `done` callback it MUST invoke once its turn is
  // resolved. `done()` (or `done('proceed')`) advances a batch to the next tab; `done('cancel')`
  // signals the user cancelled — the batch ABORTS (nothing else closes after a Cancel). The
  // guard focuses its tab before prompting so the user sees what they're deciding about.
  registerCloseGuard: (tabId: Id, guard: (done?: (outcome?: CloseOutcome) => void) => void) => void
  unregisterCloseGuard: (tabId: Id) => void
  requestClose: (projectId: Id, tabId: Id) => void

  // T-044 — batch close variants. Each routes every target through its close guard
  // sequentially, FOCUSING each tab before its prompt. Clean docs / idle-or-dead terminals
  // close silently; a dirty doc or running terminal/agent prompts. A Cancel keeps that tab
  // AND aborts the remaining sequence (nothing closes silently after a Cancel). `onComplete`
  // runs only when the batch finishes without a cancel.
  requestCloseMany: (projectId: Id, tabIds: Id[], onComplete?: () => void) => void
  requestCloseOthers: (projectId: Id, keepTabId: Id) => void
  requestCloseToRight: (projectId: Id, fromTabId: Id) => void
  // T-044 — "Close all docs" routed through the guard flow (was closeAllDocs, which discarded
  // dirty docs silently). Every doc tab goes through its guard: clean docs close silently,
  // dirty docs prompt (Save / Discard / Cancel); a Cancel aborts the rest.
  requestCloseAllDocs: (projectId: Id) => void

  // T-187 — save-guard registry (quit's "Save all docs"). A doc pane registers a NON-INTERACTIVE
  // save for its tab: it returns 'ok' when the dirty buffer was written through the normal pipeline
  // (T-142 conflict guard + T-095 refusal guard applied), or 'blocked' when it can't be saved
  // unattended (untitled/no-path, refused file, unconfirmed outside-workspace write, on-disk
  // conflict, or a write error). `saveAllDirtyDocs` sweeps EVERY project's dirty docs (hidden panes
  // included — panes are never unmounted) and returns the ones that came back 'blocked', so the
  // quit flow can name them and ABORT rather than silently discard.
  registerSaveGuard: (tabId: Id, guard: () => Promise<'ok' | 'blocked'>) => void
  unregisterSaveGuard: (tabId: Id) => void
  dirtyDocs: () => { projectId: Id; tabId: Id; title: string }[]
  saveAllDirtyDocs: () => Promise<{ title: string }[]>
  // E-035 — discard-guard registry (quit's "Discard all changes"). A doc pane registers a callback
  // that keeps its unsaved state as a discarded draft (user data, 7 days). `discardAllDirtyDocs`
  // runs it for EVERY project's dirty docs and resolves once every draft is on disk, so the quit
  // continues only after nothing unsaved is lost for good.
  registerDiscardGuard: (tabId: Id, guard: () => Promise<void>) => void
  unregisterDiscardGuard: (tabId: Id) => void
  discardAllDirtyDocs: () => Promise<void>

  // WAVE4 — flush-on-quit handshake (T-157: routed through the shared persistence helper, and
  // App awaits EVERY per-project store's flush via flushAllProjectState, not just this one).
  // Saves fire immediately on mutation, so flush only awaits the in-flight state.save IPCs —
  // by the time it resolves, main's write queue holds the final state for its own quit flush.
  flush: () => Promise<void>
}

// T-103 — the tab to focus after `removedId` leaves `tabs`: its RIGHT neighbour (the tab that
// slides into its slot), falling back to the LEFT neighbour when it was the last tab. Returns
// undefined when nothing remains. This is the "focus-to-right" rule the cross-project move
// paths use for the source strip, replacing T-097's jump-to-last.
function rightNeighborId(tabs: Tab[], removedId: Id): Id | undefined {
  const idx = tabs.findIndex((t) => t.id === removedId)
  if (idx < 0) return undefined
  const remaining = tabs.filter((t) => t.id !== removedId)
  if (remaining.length === 0) return undefined
  return remaining[Math.min(idx, remaining.length - 1)]?.id
}

// T-107 — the tab to focus after a BULK close (closeAllDocs / closeSavedDocs / restore-prune)
// when the current active tab was among those removed: the first SURVIVOR at or right of the
// removed active's ORIGINAL slot, falling back to the LAST survivor (its left neighbour) when it
// was the rightmost. The multi-removal analogue of rightNeighborId. If the active survived it is
// returned unchanged; undefined when nothing remains.
function nextActiveAfterBulk(original: Tab[], survivors: Tab[], activeId: Id | undefined): Id | undefined {
  const last = survivors[survivors.length - 1]?.id
  if (survivors.length === 0) return undefined
  if (activeId !== undefined && survivors.some((t) => t.id === activeId)) return activeId
  const origIdx = original.findIndex((t) => t.id === activeId)
  if (origIdx < 0) return last
  const survivorIds = new Set(survivors.map((t) => t.id))
  const right = original.slice(origIdx + 1).find((t) => survivorIds.has(t.id))
  return right?.id ?? last
}

// T-189 — the MRU activation stack cap. Bounds `activationHistoryByProject` so a long session of
// tab-switching can never grow it without limit; the oldest activations fall off the bottom.
const MRU_CAP = 50

// T-189 — move `tabId` to the TOP (most-recent) of an MRU stack, de-duplicating and capping to the
// most recent MRU_CAP ids. `undefined` (no active tab) leaves the stack unchanged. Pure.
function touchMru(stack: Id[], tabId: Id | undefined, cap = MRU_CAP): Id[] {
  if (tabId === undefined) return stack
  const without = stack.filter((id) => id !== tabId)
  without.push(tabId)
  return without.length > cap ? without.slice(-cap) : without
}

// T-189 — record an active-change from `prevActive` to `newActive`: the tab being LEFT is pushed
// first (so it becomes the return target), then the newly-active tab on top. Recording the leaving
// tab is what lets a tab that was active but never yet in the session stack (e.g. a hydrated tab
// after restart) still be returned to when the tab opened on top of it is closed. Pure.
function recordActivation(stack: Id[], prevActive: Id | undefined, newActive: Id | undefined): Id[] {
  return touchMru(touchMru(stack, prevActive), newActive)
}

// T-189 — remove `removed` (one id or a set) from an MRU stack: a closed or moved-away tab leaves
// no MRU trace. Pure.
function pruneMru(stack: Id[], removed: Id | Set<Id>): Id[] {
  const rm = removed instanceof Set ? removed : new Set([removed])
  return stack.filter((id) => !rm.has(id))
}

// T-189 — the most-recently-active SURVIVING tab in `stack`, other than `excludeId` (the tab being
// closed), restricted to `survivorIds` (the tabs that remain). Walks the stack from the top (most
// recent) down. `undefined` when the stack holds no surviving candidate — the caller then falls
// back to the T-107 right-neighbour rule.
function mruPrevious(stack: Id[], survivorIds: Set<Id>, excludeId: Id): Id | undefined {
  for (let i = stack.length - 1; i >= 0; i--) {
    const id = stack[i]
    if (id !== excludeId && survivorIds.has(id)) return id
  }
  return undefined
}

// Runtime-only (not persisted, not reactive): tabId → close-guard callback.
const closeGuards = new Map<Id, (done?: (outcome?: CloseOutcome) => void) => void>()

// T-187 — runtime-only (not persisted, not reactive): tabId → non-interactive save-for-quit
// callback. A doc pane registers one; quit's "Save all docs" resolves them (see registerSaveGuard).
const saveGuards = new Map<Id, () => Promise<'ok' | 'blocked'>>()

// E-035 — runtime-only: tabId → keep-as-discarded-draft callback (see registerDiscardGuard).
const discardGuards = new Map<Id, () => Promise<void>>()

function projectStateOf(get: () => TabsState, projectId: Id): ProjectState {
  return {
    openTabs: get().tabsByProject[projectId] ?? [],
    activeTabId: get().activeTabByProject[projectId],
    propertiesPanelExpanded: get().propertiesPanelExpandedByProject[projectId],
    // T-149 — the reopen stack is one of tabs-store's owned fields (saveState MERGES by owner, so
    // sending it here never clobbers mounts-store's mounts/collapsedRoots).
    reopenStack: get().reopenStackByProject[projectId] ?? []
  }
}

// T-149 — push a just-closed tab onto its project's reopen stack, LIFO, cap REOPEN_STACK_CAP.
// The 11th entry evicts the OLDEST (front); the evicted tab's snapshot is forgotten by
// terminals-store's forgetter the moment its id leaves both openTabs and every stack. Pure —
// returns the next stack; the caller folds it into its single set().
function pushReopen(stack: ClosedTabEntry[], entry: ClosedTabEntry): ClosedTabEntry[] {
  return [...stack, entry].slice(-REOPEN_STACK_CAP)
}

// T-149 — push every tab in `original` that is NOT in `survivors` onto the stack, in strip order
// (each with the index it held in `original`). Used by the bulk closes that bypass closeTab.
function pushBulk(stack: ClosedTabEntry[], original: Tab[], survivors: Tab[]): ClosedTabEntry[] {
  const survivorIds = new Set(survivors.map((t) => t.id))
  let next = stack
  original.forEach((tab, index) => {
    if (!survivorIds.has(tab.id)) next = pushReopen(next, { tab, index })
  })
  return next
}

export const useTabsStore = create<TabsState>((set, get) => {
  // T-157 — the shared per-project persistence plumbing (immediate partial state.save with
  // in-flight tracking, hydrate-sharing, quit flush, workspace-switch reset). Self-registers
  // with the flush/reset registries; see stores/project-state-persistence.ts.
  const persistence = createProjectStatePersistence({
    isHydrated: (projectId) => get().hydratedProjects[projectId] === true,
    payload: (projectId) => projectStateOf(get, projectId),

    hydrate: async (projectId, isCurrent) => {
      const loaded = await window.pomade.state.load(projectId)
      let openTabs = loaded?.openTabs ?? []
      let activeTabId = loaded?.activeTabId
      // T-102 (E-021) — an outside-workspace doc tab stores an ABSOLUTE path (the distinct
      // object class). On restore, drop it silently when the path no longer resolves (moved /
      // deleted, or `.pomade` git-synced from another machine where that path is meaningless) —
      // the same graceful-skip other unresolved restore targets get. In-workspace doc tabs are
      // untouched (a missing one still shows the editor's "no longer exists" notice, since it
      // can be recreated in the same workspace). Only outside tabs pay the stat cost.
      const outsideDocs = openTabs.filter(
        (t): t is DocTab =>
          t.kind === 'doc' && typeof t.path === 'string' && t.path.startsWith('/')
      )
      if (outsideDocs.length > 0) {
        const resolved = await Promise.all(
          outsideDocs.map((t) => window.pomade.fs.statOutside(t.path).then(() => true, () => false))
        )
        const dead = new Set(outsideDocs.filter((_, i) => !resolved[i]).map((t) => t.id))
        if (dead.size > 0) {
          const before = openTabs
          openTabs = before.filter((t) => !dead.has(t.id))
          if (activeTabId && dead.has(activeTabId)) {
            // T-107 — the active-tab pointer falls back to the right neighbour (fallback left),
            // consistent with closeTab, instead of jumping to the last tab.
            activeTabId = nextActiveAfterBulk(before, openTabs, activeTabId)
          }
        }
      }
      // T-157 — a workspace switch reset the store while this load was in flight: applying the
      // stale data would resurrect the old workspace's tabs (and re-arm the forgetter's guard).
      if (!isCurrent()) return
      set((s) => ({
        tabsByProject: { ...s.tabsByProject, [projectId]: openTabs },
        activeTabByProject: { ...s.activeTabByProject, [projectId]: activeTabId },
        propertiesPanelExpandedByProject: {
          ...s.propertiesPanelExpandedByProject,
          [projectId]: loaded?.propertiesPanelExpanded
        },
        // T-149 — rehydrate the persisted reopen stack (absent on pre-T-149 state files ⇒ []).
        // A tab id sitting here (but not in openTabs) still owns its scrollback snapshot: main's
        // boot GC and the renderer forgetter both treat the stack as an owner (see terminals-store
        // forgetter + pty-manager gcSnapshots), so replay works after a restart.
        reopenStackByProject: {
          ...s.reopenStackByProject,
          [projectId]: loaded?.reopenStack ?? []
        },
        hydratedProjects: { ...s.hydratedProjects, [projectId]: true }
      }))
    },

    // Workspace switch — ONE atomic set clearing ALL six per-project maps (the T-116 snapshot-
    // forgetter reads a wholesale drop — tab caches, reopen stacks and hydration flags vanishing
    // together — as "cache dropped, forget nothing"). previewTabByProject and
    // propertiesPanelExpandedByProject are cleared too: the old workspace-store field list
    // missed them, leaking stale entries across a switch.
    reset: () =>
      set({
        tabsByProject: {},
        activeTabByProject: {},
        previewTabByProject: {},
        propertiesPanelExpandedByProject: {},
        reopenStackByProject: {},
        // T-189 — the MRU stacks are session-local; a workspace switch drops them with everything
        // else (the old workspace's tab ids are meaningless in the new one).
        activationHistoryByProject: {},
        hydratedProjects: {}
      })
  })

  const afterMutation = (projectId: Id): void => persistence.persist(projectId)

  return {
    tabsByProject: {},
    activeTabByProject: {},
    previewTabByProject: {},
    propertiesPanelExpandedByProject: {},
    reopenStackByProject: {},
    activationHistoryByProject: {},
    hydratedProjects: {},

    // T-097 — concurrent calls for one project share ONE in-flight load (see the helper).
    hydrateProject: (projectId) => persistence.hydrateProject(projectId),

    openTab: (tab, opts) => {
      const pid = tab.projectId
      set((s) => {
        const existing = s.tabsByProject[pid] ?? []
        // T-036: new tabs open right of the active tab by default (Chrome-like);
        // opts.afterTabId overrides the anchor; no anchor found ⇒ append.
        const anchorId = opts?.afterTabId ?? s.activeTabByProject[pid]
        const anchor = anchorId ? existing.findIndex((t) => t.id === anchorId) : -1
        const next =
          anchor >= 0
            ? [...existing.slice(0, anchor + 1), tab, ...existing.slice(anchor + 1)]
            : [...existing, tab]
        if (opts?.background) return { tabsByProject: { ...s.tabsByProject, [pid]: next } }
        // T-063 — a preview open records the slot; ANY other open commits an outstanding preview.
        const nextPreview = opts?.preview ? tab.id : undefined
        // T-189 — a new tab becomes active: record the tab it displaced as the return target, then
        // the new tab on top of the MRU stack.
        const nextHistory = recordActivation(
          s.activationHistoryByProject[pid] ?? [],
          s.activeTabByProject[pid],
          tab.id
        )
        return {
          tabsByProject: { ...s.tabsByProject, [pid]: next },
          activeTabByProject: { ...s.activeTabByProject, [pid]: tab.id },
          previewTabByProject: { ...s.previewTabByProject, [pid]: nextPreview },
          activationHistoryByProject: { ...s.activationHistoryByProject, [pid]: nextHistory }
        }
      })
      afterMutation(pid)
    },

    // T-170 — see the interface note for the full contract.
    openDocByPath: (projectId, path, opts) => {
      // Read fresh so a rapid back-to-back call (preview chaining, a doubled key handler) never
      // acts on a stale snapshot — the same reason FileTree's old copy re-read the store directly.
      const existing =
        path !== ''
          ? (get().tabsByProject[projectId] ?? []).find((t) => isDocTabOf(t, path))
          : undefined
      let tabId: Id
      if (existing) {
        if (!opts?.background) get().setActive(projectId, existing.id)
        tabId = existing.id
      } else {
        const tab: Tab = {
          id: nanoid(),
          projectId,
          kind: 'doc',
          title: opts?.title ?? basename(path),
          path,
          mode: opts?.mode ?? initialDocMode(path),
          dirty: false,
          ...(opts?.symlink ? { symlink: true } : {})
        }
        tabId = tab.id
        if (opts?.usePreviewMode) {
          const previewId = get().previewTabByProject[projectId]
          const previewTab = previewId
            ? (get().tabsByProject[projectId] ?? []).find((t) => t.id === previewId)
            : undefined
          if (previewTab && previewTab.kind === 'doc' && !previewTab.dirty) {
            get().replacePreviewTab(projectId, previewTab.id, tab)
          } else {
            get().openTab(tab, { preview: true })
          }
        } else if (opts?.background) {
          get().openTab(tab, { background: true, afterTabId: opts.afterTabId })
        } else {
          get().openTab(tab)
        }
        // The symlink flag: authoritative when the caller already knows it (folded into the tab
        // literal above, no stat). Otherwise resolve it ourselves — outside-workspace-aware, so an
        // absolute `path` (T-102/T-106's distinct object class) stats through the sanctioned
        // outside door instead of the workspace-guarded one. Skipped for an empty (untitled) path.
        if (opts?.symlink === undefined && path !== '') {
          const stat = path.startsWith('/') ? window.pomade.fs.statOutside : window.pomade.fs.stat
          void stat(path)
            .then((st) => {
              if (st.isSymbolicLink) get().setDocMeta(projectId, tabId, { symlink: true })
            })
            .catch(() => {})
        }
      }
      if (opts?.line !== undefined) useJumpStore.getState().jumpTo(tabId, opts.line)
      return tabId
    },

    // T-149 — `closeTab` is THE capture point for the reopen stack: every explicit close routes
    // through here (× button, Cmd+W, context-menu Close / Close others / Close to the right, the
    // guarded batch closes via requestCloseMany, the pane-side direct closes, and the bulk Stop all
    // terminals / Exit all agents → handlePtyExit). The paths that DELIBERATELY bypass closeTab —
    // moveTabToProject, replacePreviewTab, reorderTab, the hydration prune — filter the array
    // directly and so create NO entry, which is exactly the locked decision. (closeAllDocs /
    // closeSavedDocs also bypass closeTab and push their own victims below.)
    closeTab: (projectId, tabId) => {
      // T-185 — capture the closing tab's reading position first, so the reopen-stack entry (T-149)
      // it is about to be pushed onto carries the up-to-date `viewport` (no-op for a background tab
      // with no visible pane — its tab already holds the position from when it was last visible).
      captureViewport(tabId)
      set((s) => {
        const current = s.tabsByProject[projectId] ?? []
        const closingIdx = current.findIndex((t) => t.id === tabId)
        const closing = closingIdx >= 0 ? current[closingIdx] : undefined
        const remaining = current.filter((t) => t.id !== tabId)
        const wasActive = s.activeTabByProject[projectId] === tabId
        // T-189 — closing the ACTIVE tab returns to the previously-active tab via the per-project
        // MRU stack: the most-recently-active SURVIVING tab. Only when the stack holds no survivor
        // (e.g. a fresh project whose session history is still empty after a restart, or the return
        // target was closed/moved away) does the T-107 right-neighbour rule (fallback left when it
        // was the last tab) fire. Closing an INACTIVE tab leaves the active tab untouched (T-118).
        const history = s.activationHistoryByProject[projectId] ?? []
        const survivorIds = new Set(remaining.map((t) => t.id))
        const nextActive = wasActive
          ? mruPrevious(history, survivorIds, tabId) ?? rightNeighborId(current, tabId)
          : s.activeTabByProject[projectId]
        // Prune the closed tab from the MRU stack; keep the new active on top (a no-op reorder when
        // an inactive close left the active where it already sat).
        const nextHistory = touchMru(pruneMru(history, tabId), nextActive)
        // T-063 — a closed preview tab vacates the slot.
        const preview = s.previewTabByProject[projectId]
        // T-149 — push the closed tab (with the index it held) onto the reopen stack.
        const stack = s.reopenStackByProject[projectId] ?? []
        const nextStack = closing
          ? pushReopen(stack, { tab: closing, index: closingIdx })
          : stack
        return {
          tabsByProject: { ...s.tabsByProject, [projectId]: remaining },
          activeTabByProject: { ...s.activeTabByProject, [projectId]: nextActive },
          previewTabByProject: {
            ...s.previewTabByProject,
            [projectId]: preview === tabId ? undefined : preview
          },
          reopenStackByProject: { ...s.reopenStackByProject, [projectId]: nextStack },
          activationHistoryByProject: {
            ...s.activationHistoryByProject,
            [projectId]: nextHistory
          }
        }
      })
      afterMutation(projectId)
    },

    setActive: (projectId, tabId) => {
      // T-185 — the OUTGOING tab is still visible here (the switch hasn't re-rendered the pane yet),
      // so capture its reading position before it hides. A no-op unless it is the registered visible
      // pane and actually changing (its capturer's setDocMeta writes `viewport` onto the tab).
      const prev = get().activeTabByProject[projectId]
      if (prev && prev !== tabId) captureViewport(prev)
      set((s) => {
        const prevActive = s.activeTabByProject[projectId]
        const tabs = s.tabsByProject[projectId] ?? []
        // T-056/T-061 — edge-triggered clear: activating a DIFFERENT tab wipes its red dot.
        // Marking the already-active tab leaves the dot (no edge) — it clears only on return.
        const isEdge = prevActive !== tabId
        const nextTabs =
          isEdge && tabs.some((t) => t.id === tabId && t.attention)
            ? tabs.map((t) => (t.id === tabId && t.attention ? ({ ...t, attention: undefined } as Tab) : t))
            : tabs
        // T-063 — navigating to another tab commits the preview.
        const preview = s.previewTabByProject[projectId]
        const nextPreview = preview && preview !== tabId ? undefined : preview
        // T-189 — record the switch on the MRU stack: the tab being left becomes the return
        // target, the newly-active tab goes on top.
        const nextHistory = recordActivation(
          s.activationHistoryByProject[projectId] ?? [],
          prevActive,
          tabId
        )
        return {
          tabsByProject: nextTabs === tabs ? s.tabsByProject : { ...s.tabsByProject, [projectId]: nextTabs },
          activeTabByProject: { ...s.activeTabByProject, [projectId]: tabId },
          previewTabByProject: { ...s.previewTabByProject, [projectId]: nextPreview },
          activationHistoryByProject: { ...s.activationHistoryByProject, [projectId]: nextHistory }
        }
      })
      afterMutation(projectId)
    },

    markDirty: (projectId, tabId, dirty) => {
      set((s) => {
        // T-063 — an edit COMMITS the preview (a dirty doc is never replaced).
        const preview = s.previewTabByProject[projectId]
        const nextPreview = dirty && preview === tabId ? undefined : preview
        return {
          tabsByProject: {
            ...s.tabsByProject,
            [projectId]: (s.tabsByProject[projectId] ?? []).map((t) =>
              t.id === tabId && t.kind === 'doc'
                ? // T-111 — an editor edit is a meaningful INTERACTION: it clears a stuck
                  // attention dot on the already-active doc tab (the case the activation edge
                  // misses). Only on dirty→true; a save (dirty=false) leaves any mark alone.
                  { ...t, dirty, attention: dirty ? undefined : t.attention }
                : t
            )
          },
          previewTabByProject: { ...s.previewTabByProject, [projectId]: nextPreview }
        }
      })
      afterMutation(projectId)
    },

    // T-061 — flag any tab kind unread (the red dot). Persists like dirty/color.
    markUnread: (projectId, tabId) => {
      set((s) => ({
        tabsByProject: {
          ...s.tabsByProject,
          [projectId]: (s.tabsByProject[projectId] ?? []).map((t) =>
            t.id === tabId ? ({ ...t, attention: true } as Tab) : t
          )
        }
      }))
      afterMutation(projectId)
    },

    // T-111 — clear one tab's attention dot on a user INTERACTION (not an activation edge).
    // Guarded so the common case (keystrokes into an already-clean tab) does no work at all.
    clearTabAttention: (projectId, tabId) => {
      const tabs = get().tabsByProject[projectId] ?? []
      if (!tabs.some((t) => t.id === tabId && t.attention)) return
      set((s) => ({
        tabsByProject: {
          ...s.tabsByProject,
          [projectId]: (s.tabsByProject[projectId] ?? []).map((t) =>
            t.id === tabId && t.attention ? ({ ...t, attention: undefined } as Tab) : t
          )
        }
      }))
      afterMutation(projectId)
    },

    // T-063 — commit (clear) the project's preview slot. Session-only, so no persist.
    commitPreview: (projectId, tabId) => {
      const cur = get().previewTabByProject[projectId]
      if (!cur || (tabId !== undefined && cur !== tabId)) return
      set((s) => ({
        previewTabByProject: { ...s.previewTabByProject, [projectId]: undefined }
      }))
    },

    // T-063 — replace the preview tab in place with a fresh tab and make it the new preview.
    replacePreviewTab: (projectId, oldTabId, newTab) => {
      set((s) => {
        const tabs = s.tabsByProject[projectId] ?? []
        const idx = tabs.findIndex((t) => t.id === oldTabId)
        if (idx < 0) return s
        const next = [...tabs.slice(0, idx), newTab, ...tabs.slice(idx + 1)]
        // T-189 — the replaced preview tab is gone (prune it); the fresh tab becomes the active
        // top of the MRU stack.
        const nextHistory = touchMru(
          pruneMru(s.activationHistoryByProject[projectId] ?? [], oldTabId),
          newTab.id
        )
        return {
          tabsByProject: { ...s.tabsByProject, [projectId]: next },
          activeTabByProject: { ...s.activeTabByProject, [projectId]: newTab.id },
          previewTabByProject: { ...s.previewTabByProject, [projectId]: newTab.id },
          activationHistoryByProject: { ...s.activationHistoryByProject, [projectId]: nextHistory }
        }
      })
      afterMutation(projectId)
    },

    closeAllDocs: (projectId) => {
      set((s) => {
        const current = s.tabsByProject[projectId] ?? []
        const remaining = current.filter((t) => t.kind !== 'doc')
        const active = s.activeTabByProject[projectId]
        // T-189 — a bulk close keeps T-107's geometric focus rule (nextActiveAfterBulk) rather than
        // walking the MRU stack, but still prunes the closed tabs from the stack and keeps the new
        // active on top so a later single close reads a consistent history.
        const nextActive = nextActiveAfterBulk(current, remaining, active)
        const survivorIds = new Set(remaining.map((t) => t.id))
        const removed = new Set(current.filter((t) => !survivorIds.has(t.id)).map((t) => t.id))
        const nextHistory = touchMru(
          pruneMru(s.activationHistoryByProject[projectId] ?? [], removed),
          nextActive
        )
        return {
          tabsByProject: { ...s.tabsByProject, [projectId]: remaining },
          activeTabByProject: {
            // T-107 — when the active tab was among those closed, focus its right neighbour
            // (fallback left), consistent with closeTab; otherwise the active tab is kept.
            ...s.activeTabByProject,
            [projectId]: nextActive
          },
          activationHistoryByProject: { ...s.activationHistoryByProject, [projectId]: nextHistory },
          // T-149 — this bulk close bypasses closeTab, so it pushes its victims itself. Order:
          // strip order (left→right), so the RIGHTMOST closed doc ends up on top of the stack and
          // is the first one reopen resurrects — the same most-recent-first order the guarded
          // requestCloseAllDocs path yields (it closes left→right through closeTab).
          reopenStackByProject: {
            ...s.reopenStackByProject,
            [projectId]: pushBulk(s.reopenStackByProject[projectId] ?? [], current, remaining)
          }
        }
      })
      afterMutation(projectId)
    },

    closeSavedDocs: (projectId) => {
      set((s) => {
        const current = s.tabsByProject[projectId] ?? []
        const remaining = current.filter((t) => !(t.kind === 'doc' && !t.dirty))
        const active = s.activeTabByProject[projectId]
        // T-189 — see closeAllDocs: geometric focus (T-107), MRU stack pruned + re-topped.
        const nextActive = nextActiveAfterBulk(current, remaining, active)
        const survivorIds = new Set(remaining.map((t) => t.id))
        const removed = new Set(current.filter((t) => !survivorIds.has(t.id)).map((t) => t.id))
        const nextHistory = touchMru(
          pruneMru(s.activationHistoryByProject[projectId] ?? [], removed),
          nextActive
        )
        return {
          tabsByProject: { ...s.tabsByProject, [projectId]: remaining },
          activeTabByProject: {
            // T-107 — right-neighbour fallback when the active tab was closed (see closeAllDocs).
            ...s.activeTabByProject,
            [projectId]: nextActive
          },
          activationHistoryByProject: { ...s.activationHistoryByProject, [projectId]: nextHistory },
          // T-149 — push the closed (saved) docs, strip order (see closeAllDocs).
          reopenStackByProject: {
            ...s.reopenStackByProject,
            [projectId]: pushBulk(s.reopenStackByProject[projectId] ?? [], current, remaining)
          }
        }
      })
      afterMutation(projectId)
    },

    // T-149 — reopen-stack primitives (see the interface note). The orchestrator lives in
    // terminals-store (it needs the revive machinery); these are the store-owned array ops.
    reopenStackFor: (projectId) => get().reopenStackByProject[projectId] ?? [],

    restoreClosedTab: (projectId, entry) => {
      set((s) => {
        const tabs = s.tabsByProject[projectId] ?? []
        // §6 — original index, CLAMPED to the current strip length (tabs may have closed/opened
        // since). A deliberate exception to T-036's "new tabs open right of active".
        const idx = Math.min(Math.max(entry.index, 0), tabs.length)
        const next = [...tabs.slice(0, idx), entry.tab, ...tabs.slice(idx)]
        // Remove THIS entry by identity (robust to a concurrent close landing on top during the
        // orchestrator's async doc-existence check).
        const stack = (s.reopenStackByProject[projectId] ?? []).filter((e) => e !== entry)
        // T-189 — the restored tab becomes active: record the displaced tab as the return target,
        // the restored tab on top.
        const nextHistory = recordActivation(
          s.activationHistoryByProject[projectId] ?? [],
          s.activeTabByProject[projectId],
          entry.tab.id
        )
        return {
          tabsByProject: { ...s.tabsByProject, [projectId]: next },
          activeTabByProject: { ...s.activeTabByProject, [projectId]: entry.tab.id },
          reopenStackByProject: { ...s.reopenStackByProject, [projectId]: stack },
          activationHistoryByProject: { ...s.activationHistoryByProject, [projectId]: nextHistory }
        }
      })
      afterMutation(projectId)
    },

    dropReopenEntry: (projectId, entry) => {
      set((s) => {
        const stack = s.reopenStackByProject[projectId] ?? []
        if (!stack.includes(entry)) return s
        return {
          reopenStackByProject: {
            ...s.reopenStackByProject,
            [projectId]: stack.filter((e) => e !== entry)
          }
        }
      })
      afterMutation(projectId)
    },

    // T-156 — project teardown (see the interface note). Two sets, in this order deliberately.
    dropProject: (projectId) => {
      const drop = <T>(m: Record<Id, T>): Record<Id, T> => {
        if (!(projectId in m)) return m
        const next = { ...m }
        delete next[projectId]
        return next
      }
      // Phase 1 — clear the tab arrays + the reopen stack while KEEPING hydratedProjects, so the
      // T-116 snapshot-forgetter (it forgets only for a still-hydrated project) fires for every
      // terminal/agent id leaving the openTabs ∪ reopen-stack union → deletes its scrollback file.
      set((s) => ({
        tabsByProject: drop(s.tabsByProject),
        activeTabByProject: drop(s.activeTabByProject),
        previewTabByProject: drop(s.previewTabByProject),
        propertiesPanelExpandedByProject: drop(s.propertiesPanelExpandedByProject),
        reopenStackByProject: drop(s.reopenStackByProject),
        // T-189 — drop the deleted project's session MRU stack with its other per-project state.
        activationHistoryByProject: drop(s.activationHistoryByProject)
      }))
      // Phase 2 — retire the hydration flag (a SEPARATE set so the forgetter above saw it true).
      set((s) => ({ hydratedProjects: drop(s.hydratedProjects) }))
      // Drop the project's hydration bookkeeping. The teardown's own closeTab saves were already
      // sent (immediate saves) and ride the ordered IPC pipe AHEAD of the caller's `state.remove`,
      // which cancels the queued write and awaits the in-flight chain in main — so nothing
      // re-creates `.pomade/state/<projectId>.json` after main removes it. No persist here, and
      // the retired hydration flag blocks any later stray save for this project.
      persistence.dropProject(projectId)
    },

    // E-013 (T-053 round-3) — per-project properties-panel collapse. The set() makes every
    // mounted EditorPane of THIS project (all subscribe to the same record) re-render live;
    // afterMutation persists it into ProjectState so it survives restart. Absent = true.
    togglePropertiesPanelExpanded: (projectId) => {
      set((s) => ({
        propertiesPanelExpandedByProject: {
          ...s.propertiesPanelExpandedByProject,
          [projectId]: !(s.propertiesPanelExpandedByProject[projectId] ?? true)
        }
      }))
      afterMutation(projectId)
    },

    tabsFor: (projectId) => get().tabsByProject[projectId] ?? [],
    activeTabFor: (projectId) => get().activeTabByProject[projectId],
    propertiesPanelExpandedFor: (projectId) =>
      get().propertiesPanelExpandedByProject[projectId] ?? true,

    // Wave 2b append.
    updateTab: (projectId, tabId, patch) => {
      set((s) => ({
        tabsByProject: {
          ...s.tabsByProject,
          [projectId]: (s.tabsByProject[projectId] ?? []).map((t) =>
            t.id === tabId ? ({ ...t, ...patch } as Tab) : t
          )
        }
      }))
      afterMutation(projectId)
    },

    // WAVE2C (editor) — additive.
    setDocMeta: (projectId, tabId, patch) => {
      set((s) => ({
        tabsByProject: {
          ...s.tabsByProject,
          [projectId]: (s.tabsByProject[projectId] ?? []).map((t) =>
            t.id === tabId && t.kind === 'doc' ? { ...t, ...patch } : t
          )
        }
      }))
      afterMutation(projectId)
    },

    // E-016 — retarget open doc tabs after an in-app move/rename (see interface note).
    retargetPaths: (oldPrefix, newPrefix) => {
      const affected: Id[] = []
      set((s) => {
        const patched: Record<Id, Tab[]> = {}
        for (const [pid, tabs] of Object.entries(s.tabsByProject)) {
          let projChanged = false
          const next = tabs.map((t) => {
            if (t.kind !== 'doc') return t
            const p = t.path
            let np: string | null = null
            if (p === oldPrefix) np = newPrefix
            else if (p.startsWith(oldPrefix + '/')) np = newPrefix + p.slice(oldPrefix.length)
            if (np === null) return t
            projChanged = true
            if (!t.version) return { ...t, path: np, title: basename(np) }
            const version = { ...t.version, source: retargetVersion(t.version.source, np) }
            return { ...t, path: np, version, title: versionTabTitle(versionPath(version.source, np), version.label) }
          })
          if (projChanged) {
            affected.push(pid)
            patched[pid] = next
          }
        }
        if (affected.length === 0) return s
        return { tabsByProject: { ...s.tabsByProject, ...patched } }
      })
      for (const pid of affected) afterMutation(pid)
    },

    // E-004 (T-048) — reorder within a project's tab array (drag-and-drop).
    reorderTab: (projectId, sourceId, targetId, after) => {
      set((s) => {
        const tabs = s.tabsByProject[projectId] ?? []
        const moved = tabs.find((t) => t.id === sourceId)
        if (!moved || sourceId === targetId) return s
        const without = tabs.filter((t) => t.id !== sourceId)
        const targetIdx = without.findIndex((t) => t.id === targetId)
        if (targetIdx < 0) return s
        const insertAt = after ? targetIdx + 1 : targetIdx
        const next = [...without.slice(0, insertAt), moved, ...without.slice(insertAt)]
        return { tabsByProject: { ...s.tabsByProject, [projectId]: next } }
      })
      afterMutation(projectId)
    },

    // T-097 — move a tab to another project (see the interface note for the invariants).
    // T-117 — doc moves DEDUPE by path (see the three branches below), mirroring
    // `openDocInProject`'s dedupe + T-110's guarded-arrival bump.
    moveTabToProject: async (fromProjectId, tabId, toProjectId) => {
      if (fromProjectId === toProjectId) return
      if (!(get().tabsByProject[fromProjectId] ?? []).some((t) => t.id === tabId)) return
      // The target must be in memory before we mutate it: writing into an unhydrated project
      // would be dropped by the persist guard AND then clobbered by its eventual hydration.
      await get().hydrateProject(toProjectId)
      // T-151 — the Projects panel counter is a live-derived tally of unread (dotted) tabs, so a
      // cross-project arrival raises the target's count simply by landing its tab `attention`-
      // marked (below); there is no separate counter to bump. A background arrival lands dotted; an
      // empty-target arrival lands active (no dot, correctly no count); a dedupe hit re-uses the
      // existing tab and marks it only when it was unmarked and non-active — an already-dotted twin
      // stays a single unread (the derivation can't double-count).
      set((s) => {
        const from = s.tabsByProject[fromProjectId] ?? []
        const moving = from.find((t) => t.id === tabId)
        if (!moving) return s
        const remaining = from.filter((t) => t.id !== tabId)
        const targetExisting = s.tabsByProject[toProjectId] ?? []
        const priorActive = s.activeTabByProject[toProjectId]
        const targetHasActive = !!priorActive && targetExisting.some((t) => t.id === priorActive)
        const wasActive = s.activeTabByProject[fromProjectId] === tabId
        const fromPreview = s.previewTabByProject[fromProjectId]
        // The SOURCE-side outcome is identical in every branch: the tab leaves, a vacated ACTIVE
        // slot focuses the right neighbour (T-103 focus-to-right, not the last tab), and a vacated
        // preview slot is cleared.
        const sourceActive = wasActive
          ? rightNeighborId(from, tabId)
          : s.activeTabByProject[fromProjectId]
        const sourcePreview = fromPreview === tabId ? undefined : fromPreview
        // T-117 — dedupe by PATH for doc moves: one project must never show two tabs of the same
        // file. Copy (`openDocInProject`) has always deduped; move blindly appended, so a
        // copy-then-move of the same doc produced TWO tabs and a double-bumped counter (the Owner's
        // repro). Untitled docs (no path) and terminals/agents (unique termId — a live PTY can't
        // be merged with anything) have nothing to dedupe against, so they keep the plain path.
        const twin =
          moving.kind === 'doc' && moving.path
            ? targetExisting.find((t) => sameDocTab(t, moving))
            : undefined
        const movingDirty = moving.kind === 'doc' && moving.dirty
        const twinDirty = twin !== undefined && twin.kind === 'doc' && twin.dirty

        if (twin && !movingDirty) {
          // (1) CLEAN source onto an existing copy — the moved tab is a plain view of the file on
          // disk, so it is simply dropped and the target's EXISTING tab is re-used (the target's
          // copy may itself be dirty; re-using it never loses work). T-151 arrival mark: dot it
          // only when it was UNMARKED and is not the target's active tab; a hit on an already-dotted
          // tab stays a single unread (the Owner's repro: no second tab, no double-count). Target
          // focus and preview are untouched, exactly as copy's dedupe branch leaves them.
          const markable = twin.id !== priorActive && !twin.attention
          const target = markable
            ? targetExisting.map((t) =>
                t.id === twin.id ? ({ ...t, attention: true } as Tab) : t
              )
            : targetExisting
          return {
            tabsByProject: {
              ...s.tabsByProject,
              [fromProjectId]: remaining,
              [toProjectId]: target
            },
            activeTabByProject: { ...s.activeTabByProject, [fromProjectId]: sourceActive },
            previewTabByProject: { ...s.previewTabByProject, [fromProjectId]: sourcePreview }
          }
        }

        if (twin && movingDirty && !twinDirty) {
          // (2) DIRTY source onto a CLEAN copy — the moved tab carries the unsaved buffer (the
          // user's work), so IT wins: it REPLACES the target's copy, taking its SLOT (the position
          // the user already knows), and the replaced clean tab just closes. Dropping the moved tab
          // instead would silently destroy unsaved work.
          const idx = targetExisting.findIndex((t) => t.id === twin.id)
          // Normal landed-tab rules, with one addition: replacing the target's ACTIVE tab makes the
          // arrival active (it inherits the slot the user is looking at, and an active tab never
          // carries a dot); otherwise it lands attention-marked like any background arrival.
          const landsActive = !targetHasActive || priorActive === twin.id
          // T-151 — the replacement lands active (no dot ⇒ not counted) or dotted (counted); the
          // derived counter follows the tab's `attention` either way, so no explicit signal needed.
          const landed = {
            ...moving,
            projectId: toProjectId,
            attention: landsActive ? undefined : true
          } as Tab
          const target = [
            ...targetExisting.slice(0, idx),
            landed,
            ...targetExisting.slice(idx + 1)
          ]
          const toPreview = s.previewTabByProject[toProjectId]
          return {
            tabsByProject: {
              ...s.tabsByProject,
              [fromProjectId]: remaining,
              [toProjectId]: target
            },
            activeTabByProject: {
              ...s.activeTabByProject,
              [fromProjectId]: sourceActive,
              [toProjectId]: landsActive ? tabId : priorActive
            },
            previewTabByProject: {
              ...s.previewTabByProject,
              [fromProjectId]: sourcePreview,
              // The replaced tab vacates the target's preview slot (like any close does).
              [toProjectId]: toPreview === twin.id ? undefined : toPreview
            }
          }
        }

        // (3) No twin — the plain T-103 path. Also the BOTH-DIRTY case: two unsaved buffers of one
        // file cannot be merged, so both tabs are kept (known limit, noted in docs/contracts/stores.md "tabs-store") rather than
        // silently dropping one user's edits.
        // T-103 — the arrival becomes active ONLY when the target has no valid active tab
        // (empty); otherwise it lands attention-marked as a background tab (see interface note).
        const landsActive = !targetHasActive
        // END of the target strip (locked decision) — the tab object is reused, only its
        // projectId changes, so its id/termId (and thus its pane and PTY) are preserved.
        const landed = {
          ...moving,
          projectId: toProjectId,
          attention: landsActive ? undefined : true
        } as Tab
        const target = [...targetExisting, landed]
        return {
          tabsByProject: { ...s.tabsByProject, [fromProjectId]: remaining, [toProjectId]: target },
          activeTabByProject: {
            ...s.activeTabByProject,
            // T-103 focus-to-right for the vacated ACTIVE slot (not the last tab).
            [fromProjectId]: sourceActive,
            // T-103 — an arrival does NOT steal focus in the target unless it was empty.
            [toProjectId]: landsActive ? tabId : priorActive
          },
          previewTabByProject: {
            ...s.previewTabByProject,
            // A moved-away preview tab vacates the source slot; the target's preview is left
            // untouched (a background arrival never disturbs the user's current preview there).
            [fromProjectId]: sourcePreview
          }
        }
      })
      // T-189 — reconcile the two projects' MRU stacks off the post-move state (a SEPARATE set:
      // the atomic move above is what the PTY reaper watches; the session-only history is not, so
      // splitting it out cannot disturb that invariant). The moved tab leaves the source stack
      // (requirement 2 prune) and each project's post-move active is re-topped so a later single
      // close in either reads a consistent history. Kind-agnostic and dedupe-branch-agnostic — it
      // only reads the resulting active ids, so it stays correct across all three move branches.
      set((s) => ({
        activationHistoryByProject: {
          ...s.activationHistoryByProject,
          [fromProjectId]: touchMru(
            pruneMru(s.activationHistoryByProject[fromProjectId] ?? [], tabId),
            s.activeTabByProject[fromProjectId]
          ),
          [toProjectId]: touchMru(
            s.activationHistoryByProject[toProjectId] ?? [],
            s.activeTabByProject[toProjectId]
          )
        }
      }))
      // T-151 — no counter bump: the target's derived attention count already reflects the tab that
      // just landed dotted (or, if it landed active, correctly does not).
      afterMutation(fromProjectId)
      afterMutation(toProjectId)
    },

    // T-097 / T-103 — open a COPY of a doc tab in another project (see the interface note).
    openDocInProject: async (fromProjectId, tabId, toProjectId) => {
      if (fromProjectId === toProjectId) return undefined
      const src = (get().tabsByProject[fromProjectId] ?? []).find((t) => t.id === tabId)
      if (!src || src.kind !== 'doc' || !src.path) return undefined
      await get().hydrateProject(toProjectId)
      const existing = (get().tabsByProject[toProjectId] ?? []).find(
        (t) => sameDocTab(t, src)
      )
      let landedId: Id
      // T-151 — the target's derived attention count rises simply because the arriving copy lands
      // dotted; there is no counter to bump. A dedupe hit that re-uses an ALREADY-dotted tab (or the
      // target's active tab) changes no `attention`, so the count is unchanged — the derivation
      // cannot double-count (this was the old event-tally's double-bump bug, now structurally gone).
      if (existing) {
        // Dedupe by path — re-use what is already there. T-103: it does NOT steal focus; instead
        // it lands ATTENTION-MARKED like a fresh arrival (unless it is already the target's active
        // tab, which never carries a dot) so the user gets the same arrival signal.
        landedId = existing.id
        set((s) => {
          if (existing.id === s.activeTabByProject[toProjectId]) return s
          const cur = (s.tabsByProject[toProjectId] ?? []).find((t) => t.id === existing.id)
          if (cur && cur.attention) return s // already dotted ⇒ count unchanged, nothing to do.
          return {
            tabsByProject: {
              ...s.tabsByProject,
              [toProjectId]: (s.tabsByProject[toProjectId] ?? []).map((t) =>
                t.id === existing.id ? ({ ...t, attention: true } as Tab) : t
              )
            }
          }
        })
      } else {
        const copyId = nanoid()
        landedId = copyId
        set((s) => {
          const targetExisting = s.tabsByProject[toProjectId] ?? []
          const priorActive = s.activeTabByProject[toProjectId]
          const landsActive = !priorActive || !targetExisting.some((t) => t.id === priorActive)
          const copy: DocTab = {
            ...(src as DocTab),
            id: copyId,
            projectId: toProjectId,
            dirty: false,
            // Attention-marked as an arrival unless it becomes the (empty) target's active tab.
            attention: landsActive ? undefined : true
          }
          // END of the target strip (locked decision); the arrival does NOT steal focus unless
          // the target had no active tab.
          return {
            tabsByProject: { ...s.tabsByProject, [toProjectId]: [...targetExisting, copy] },
            activeTabByProject: {
              ...s.activeTabByProject,
              [toProjectId]: landsActive ? copyId : priorActive
            }
          }
        })
      }
      // T-151 — no counter bump: the copy landed dotted (or active, correctly uncounted); the
      // derived Projects panel count follows the tab's `attention`.
      afterMutation(toProjectId)
      return landedId
    },

    // WAVE3 — close-guard registry.
    registerCloseGuard: (tabId, guard) => {
      closeGuards.set(tabId, guard)
    },
    unregisterCloseGuard: (tabId) => {
      closeGuards.delete(tabId)
    },
    requestClose: (projectId, tabId) => {
      const guard = closeGuards.get(tabId)
      if (guard) guard()
      else get().closeTab(projectId, tabId)
    },

    // T-187 — save-guard registry (see the interface note).
    registerSaveGuard: (tabId, guard) => {
      saveGuards.set(tabId, guard)
    },
    unregisterSaveGuard: (tabId) => {
      saveGuards.delete(tabId)
    },
    dirtyDocs: () => {
      const out: { projectId: Id; tabId: Id; title: string }[] = []
      for (const [projectId, tabs] of Object.entries(get().tabsByProject)) {
        for (const t of tabs) {
          if (t.kind === 'doc' && t.dirty) out.push({ projectId, tabId: t.id, title: t.title })
        }
      }
      return out
    },
    // Snapshot the dirty set ONCE (each successful save flips its own tab clean, which would
    // otherwise shrink a live re-read mid-sweep), then save each through its registered guard. A
    // dirty doc with no registered guard (should never happen — every doc tab has a mounted pane)
    // counts as blocked, so an un-savable doc can never be silently dropped.
    saveAllDirtyDocs: async () => {
      const blocked: { title: string }[] = []
      for (const d of get().dirtyDocs()) {
        const guard = saveGuards.get(d.tabId)
        const res = guard ? await guard() : 'blocked'
        if (res !== 'ok') blocked.push({ title: d.title })
      }
      return blocked
    },
    registerDiscardGuard: (tabId, guard) => {
      discardGuards.set(tabId, guard)
    },
    unregisterDiscardGuard: (tabId) => {
      discardGuards.delete(tabId)
    },
    discardAllDirtyDocs: async () => {
      await Promise.all(
        get()
          .dirtyDocs()
          .map((d) => discardGuards.get(d.tabId)?.().catch(() => {}))
      )
    },

    // T-044 — sequential batch close. Process targets left-to-right; a guarded tab (dirty
    // doc, running terminal/agent) is asked to close and we wait for its `done` before the
    // next, so prompts appear one at a time and the tab is focused while its dialog shows.
    // Unguarded tabs (no pane registered) close immediately. A `done('cancel')` ABORTS the
    // remainder — nothing else closes silently after the user bails.
    requestCloseMany: (projectId, tabIds, onComplete) => {
      const run = (i: number): void => {
        if (i >= tabIds.length) {
          onComplete?.()
          return
        }
        const tabId = tabIds[i]
        const guard = closeGuards.get(tabId)
        if (guard) {
          guard((outcome) => {
            if (outcome === 'cancel') return // abort: keep the cancelled tab focused, stop
            run(i + 1)
          })
        } else {
          get().closeTab(projectId, tabId)
          run(i + 1)
        }
      }
      run(0)
    },

    requestCloseOthers: (projectId, keepTabId) => {
      const targets = (get().tabsByProject[projectId] ?? [])
        .filter((t) => t.id !== keepTabId)
        .map((t) => t.id)
      get().setActive(projectId, keepTabId)
      get().requestCloseMany(projectId, targets, () => get().setActive(projectId, keepTabId))
    },

    requestCloseToRight: (projectId, fromTabId) => {
      const tabs = get().tabsByProject[projectId] ?? []
      const from = tabs.findIndex((t) => t.id === fromTabId)
      const targets = from < 0 ? [] : tabs.slice(from + 1).map((t) => t.id)
      get().requestCloseMany(projectId, targets, () => get().setActive(projectId, fromTabId))
    },

    // T-044 — route every doc tab through its guard (clean → silent, dirty → prompt), so
    // "Close all docs" never discards unsaved work silently the way closeAllDocs did.
    requestCloseAllDocs: (projectId) => {
      const targets = (get().tabsByProject[projectId] ?? [])
        .filter((t) => t.kind === 'doc')
        .map((t) => t.id)
      get().requestCloseMany(projectId, targets)
    },

    // WAVE4 — quit-flush handshake (see the interface note): await the in-flight state.save IPCs.
    flush: () => persistence.flush()
  }
})
