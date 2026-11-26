// Pomade — tab strip for the ACTIVE project. Shows that project's tabs, the active one
// highlighted, a close affordance per tab, and (WAVE2B) the TerminalActions cluster:
// the "+" launcher (new terminal + visible agents), bulk actions, and Session history.
//
// WAVE2B replaced the Wave-1 placeholder "+" menu with <TerminalActions/> (which lives in
// modules/terminal so Wave 2c can append its close-all-docs bulk items there).
//
// E-004 adds tab power features: a right-click context menu (close variants / copy path /
// rename), inline rename (double-click a terminal/agent title), soft per-tab colors, and a
// kind/extension icon left of the title.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import type { AttachedTab, Id, Tab, TabColor } from '@shared/types'
import { classifyScope } from '@shared/paths'
import { ScopeMark } from '../components/ScopeMark'
import { useProjectScopeFolders } from '../stores/project-scope'
import { Tooltip } from '../components/Tooltip'
import { useTabsStore } from '../stores/tabs-store'
import {
  buildAllProjects,
  buildProjectsPanelOrderedProjects,
  useWorkspaceStore
} from '../stores/workspace-store'
import { useToast } from '../hooks/useToast'
import { cleanIpcError } from '../lib/ipc-errors'
import { TAB_DRAG_MIME } from '../dnd'
import { TerminalActions } from '../modules/terminal/TerminalActions'
import { UnboundPopover } from '../modules/terminal/UnboundPopover'
import { useUnboundStore } from '../stores/unbound-store'
import { FileIcon, TerminalIcon, AgentIcon, SymlinkGlyph } from '../modules/filetree/icons'
import { SymlinkPopover } from '../modules/filetree/SymlinkPopover'
import { AppIcon } from '../modules/apps/AppIcon'
import { useOwnerName } from '../modules/terminal/owner-name'
import { BranchTabIcon, CommitIcon, CompareIcon, ConflictIcon } from '../modules/git/icons'
import { InlineRenameInput } from '../components/InlineRenameInput'
import { basename, parentOf } from '../lib/path-display'
import { TabContextMenu } from './TabContextMenu'
import { StripContextMenu } from './StripContextMenu'
import { TabDetails } from './TabDetails'
import { bumpRenderCount } from '../dev/render-counts'
import styles from './TabStrip.module.css'

// T-181 — a STABLE empty-array reference for the "no tabs yet" fallback below. `shallow` (what
// `useShallow` uses) compares a selector's return value only ONE level deep: for a tuple, each
// slot is compared by Object.is, not recursively. A fresh `[]` literal on every call would make
// slot 0 "different" on every single invocation (two distinct empty arrays are never Object.is-
// equal), which never stabilizes — an infinite render loop (React error #185). Reusing this one
// module-level array for every "no tabs for this project (yet)" case keeps slot 0 reference-equal
// across calls whenever the project genuinely still has no tabs.
const EMPTY_TABS: Tab[] = []

/** E-034 — an attached tab's title with its owner ("Coda web · Runner"); its own component so an
 *  app-list change re-renders only these titles. */
function AttachedTabTitle({ tab, className, ownerClassName }: { tab: AttachedTab; className: string; ownerClassName: string }): React.JSX.Element {
  const owner = useOwnerName(tab.session.app)
  return (
    <Tooltip lines={[`${tab.title} · ${owner}`]} showIf={(el) => el.scrollWidth > el.clientWidth} testId={`tab-title-tooltip-${tab.id}`}>
      <span className={className} data-testid={`tab-title-${tab.id}`}>
        {tab.title}
        <span className={ownerClassName}> · {owner}</span>
      </span>
    </Tooltip>
  )
}

function TabIcon({ tab }: { tab: Tab }): React.JSX.Element {
  if (tab.kind === 'doc') return <FileIcon name={basename(tab.path) || tab.title} />
  if (tab.kind === 'agent') return <AgentIcon />
  if (tab.kind === 'app') return <AppIcon appId={tab.appId} icon={tab.icon} tabKind={tab.tabKind} />
  if (tab.kind === 'commit') return <CommitIcon />
  if (tab.kind === 'compare') return <CompareIcon />
  if (tab.kind === 'conflict') return <ConflictIcon />
  if (tab.kind === 'branch') return <BranchTabIcon />
  return <TerminalIcon />
}

interface MenuState {
  x: number
  y: number
  tabId: string
}
interface RenameState {
  tabId: string
  value: string
}
interface DragOverState {
  tabId: string
  side: 'before' | 'after'
}

export function TabStrip(): React.JSX.Element {
  // T-181 — render-count probe (see dev/render-counts.ts): bumped unconditionally in the body so
  // an e2e spec can prove a background project's tab mutation no longer re-renders this component.
  bumpRenderCount('TabStrip')
  const projects = useWorkspaceStore((s) => s.projects)
  const groups = useWorkspaceStore((s) => s.groups)
  const ungroupedOrder = useWorkspaceStore((s) => s.ungroupedOrder)
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId)
  const wsRoot = useWorkspaceStore((s) => s.root)
  const allProjects = useMemo(() => buildAllProjects(projects), [projects])
  const project = allProjects.find((p) => p.id === activeProjectId)
  const projectRoot = project?.rootPath ?? ''
  const scopeFolders = useProjectScopeFolders(activeProjectId)
  // T-103 — the cross-project picker list: Workspace project first, then EXACT Projects panel
  // order (a pre-order tree walk — group order shapes project order), CURRENT project excluded.
  // buildAllProjects sorts by the flat per-group `order`, which is wrong once groups nest.
  const otherProjects = useMemo(
    () =>
      buildProjectsPanelOrderedProjects(groups, projects, ungroupedOrder).filter(
        (p) => p.id !== activeProjectId
      ),
    [groups, projects, ungroupedOrder, activeProjectId]
  )
  // T-181 — narrowed to the ACTIVE project's own tab array + active id (useShallow on the tuple):
  // a `cd`/`exec` in a BACKGROUND project's terminal never touches this project's tabsByProject
  // entry (updateTab only replaces the mutated project's array), so the tuple compares equal and
  // TabStrip does not re-render for it. A mutation in THIS project's own tabs still re-renders, as
  // it must (a title, dirty flag, or color changed on a tab this strip shows).
  const [tabs, activeTabId] = useTabsStore(
    useShallow(
      (s) => [s.tabsByProject[activeProjectId] ?? EMPTY_TABS, s.activeTabByProject[activeProjectId]] as const
    )
  )
  // T-228 — the project's preview tab shows its title in italics until it is used.
  const previewTabId = useTabsStore((s) => s.previewTabByProject[activeProjectId])
  // T-101 — doc paths open as tabs in ≥2 DIFFERENT projects (the duplicate-open indicator). Built
  // across ALL projects (the Workspace project counts as one), so a copy in another project's
  // strip still marks this project's copy. This selector still has to SCAN every project's tabs on
  // every store change (that part cannot be narrowed away — a background project's doc tab
  // opening/closing is exactly what must be observed here), but a high-frequency FIELD mutation
  // (cwd, lastCommand, ...) never changes any path's project-count, so the computed Set comes out
  // equal BY CONTENT; `useShallow` (which compares Sets by membership, not by reference — see
  // zustand's `shallow`) is what lets TabStrip recognise that and skip the re-render, even though
  // the selector body constructs a brand-new Set on every invocation.
  const duplicatePaths = useTabsStore(
    useShallow((s) => {
      const projectsByPath = new Map<string, Set<Id>>()
      for (const ptabs of Object.values(s.tabsByProject)) {
        for (const t of ptabs) {
          if (t.kind !== 'doc' || !t.path || t.version) continue
          let set = projectsByPath.get(t.path)
          if (!set) projectsByPath.set(t.path, (set = new Set()))
          set.add(t.projectId)
        }
      }
      const dup = new Set<string>()
      for (const [p, set] of projectsByPath) if (set.size >= 2) dup.add(p)
      return dup
    })
  )
  const requestClose = useTabsStore((s) => s.requestClose)
  const requestCloseOthers = useTabsStore((s) => s.requestCloseOthers)
  const requestCloseToRight = useTabsStore((s) => s.requestCloseToRight)
  const setActive = useTabsStore((s) => s.setActive)
  const updateTab = useTabsStore((s) => s.updateTab)
  const markUnread = useTabsStore((s) => s.markUnread)
  const retargetPaths = useTabsStore((s) => s.retargetPaths)
  const reorderTab = useTabsStore((s) => s.reorderTab)
  const moveTabToProject = useTabsStore((s) => s.moveTabToProject)
  const openDocInProject = useTabsStore((s) => s.openDocInProject)
  const toast = useToast()

  const [menu, setMenu] = useState<MenuState | null>(null)
  // T-149 — the empty-space (end-zone) context menu. Independent of the per-tab `menu`.
  const [stripMenu, setStripMenu] = useState<{ x: number; y: number } | null>(null)
  // T-150 — the "Show tab details" popup (raw persisted JSON, editable). Holds the target tab id.
  const [detailsTabId, setDetailsTabId] = useState<string | null>(null)
  const [rename, setRename] = useState<RenameState | null>(null)
  const [dragTabId, setDragTabId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<DragOverState | null>(null)
  // T-087 — the pointer is over the free strip area right of the last tab ("move to END").
  const [dragOverEnd, setDragOverEnd] = useState(false)
  // E-012 (final) — the open symlink popover for a doc tab's link glyph (path + anchor rect).
  const [symlinkPop, setSymlinkPop] = useState<{ rel: string; rect: DOMRect } | null>(null)
  // E-025 — the open Unbound-session recovery popover (agent-tab ⚠️ mark). `silencedUnbound`
  // is the runtime-only "Ignore" set: a silenced tab's mark is hidden for THIS unbound session.
  const [unboundPop, setUnboundPop] = useState<{ tabId: Id; rect: DOMRect } | null>(null)
  const silencedUnbound = useUnboundStore((s) => s.silenced)

  // T-062 — scroll the ACTIVE tab into view whenever it changes (a tab opened OR activated by
  // any path: tree click, context menu, agent/terminal launch, hotkeys, preview reuse). Keyed on
  // the active id (and tab count, so a freshly-inserted active tab is measured after its render);
  // `inline: 'nearest'` is a no-op when the tab is already visible — no jump.
  const tabElsRef = useRef<Map<string, HTMLDivElement>>(new Map())
  useEffect(() => {
    if (!activeTabId) return
    const el = tabElsRef.current.get(activeTabId)
    if (!el) return
    const raf = requestAnimationFrame(() => {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
    return () => cancelAnimationFrame(raf)
  }, [activeTabId, tabs.length])

  // Close the context menu on Esc (both the per-tab and the T-149 empty-space menus).
  useEffect(() => {
    if (!menu && !stripMenu) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setMenu(null)
        setStripMenu(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu, stripMenu])

  const menuTab = menu ? tabs.find((t) => t.id === menu.tabId) : undefined

  const startRename = (tab: Tab): void => {
    // A version tab is an old text of its document at the document's path — it has no name of
    // its own, and renaming it would rename the file.
    if (tab.kind === 'doc' && tab.version) return
    const seed = tab.kind === 'doc' ? basename(tab.path) || tab.title : tab.title
    setRename({ tabId: tab.id, value: seed })
  }

  const cancelRename = (): void => setRename(null)

  // T-179 — the single-shot Enter/blur guard (committing closes the input, which fires onBlur
  // right after Enter/Escape already handled it) now lives in InlineRenameInput; this is just the
  // per-kind commit logic it invokes once per rename session.
  const commitRename = (): void | 'retry' | Promise<void | 'retry'> => {
    const r = rename
    if (!r) {
      setRename(null)
      return
    }
    const value = r.value.trim()
    const tab = tabs.find((t) => t.id === r.tabId)
    if (!tab || !value) {
      setRename(null)
      return
    }
    if (tab.kind === 'doc') {
      // Rename the file ON DISK (collision-refusing), then update the tab; the fs watcher
      // refreshes the tree. Untitled docs have no path yet — nothing to rename.
      const oldPath = tab.path
      if (!oldPath) {
        toast('Save the document first.', 'error')
        setRename(null)
        return
      }
      if (value === basename(oldPath)) {
        setRename(null)
        return
      }
      const dir = parentOf(oldPath)
      const dest = oldPath.includes('/') ? `${dir}/${value}` : value
      // T-055: keep the SAME rename input mounted while the async rename is in flight, and close
      // it ONLY on success. On a collision (or any failure) the input never unmounts — no
      // close/reopen flicker, no focus flash — it stays focused holding the attempted text so the
      // user can correct it. The loop ends only on a valid commit or Esc (which restores the
      // original — nothing on disk changed here). Returning 'retry' re-arms InlineRenameInput's
      // single-shot guard.
      return (async (): Promise<void | 'retry'> => {
        try {
          const rel = await window.pomade.fs.rename(oldPath, dest)
          // E-016 — retarget THIS tab and any other project's tab pointing at the same file
          // (dual-open) so every open doc follows the rename and saves to the new path.
          retargetPaths(oldPath, rel)
          toast(`Renamed to ${basename(rel)}`)
          setRename(null)
        } catch (err) {
          toast(cleanIpcError(err), 'error')
          return 'retry'
        }
      })()
    }
    // T-244 — an app tab the user names stops following its manifest's title.
    if (tab.kind === 'app') {
      updateTab(activeProjectId, tab.id, { title: value, renamed: true })
      setRename(null)
      return
    }
    // Commit and comparison tabs: a title of the user's choosing (nothing auto-titles them).
    if (tab.kind === 'commit' || tab.kind === 'compare' || tab.kind === 'conflict' || tab.kind === 'branch') {
      updateTab(activeProjectId, tab.id, { title: value })
      setRename(null)
      return
    }
    // Terminal/agent: rename in place, marking `renamed` so auto-titles (agent exit/start)
    // never overwrite the user's choice (E-005 T-024 flag). E-033 — the user's name replaces an
    // app's and ends the "unnamed" mark; the agents app hears it (`agentTab.changed`).
    updateTab(activeProjectId, tab.id, { title: value, renamed: true, appTitled: undefined, unnamed: undefined })
    setRename(null)
  }

  const setColor = (tab: Tab, color: TabColor | undefined): void => {
    // T-046: colors apply to every tab kind (docs included). updateTab persists via state.save.
    updateTab(activeProjectId, tab.id, { color })
  }

  // T-048/T-087 — one place to end a drag session (source + both indicator kinds).
  const endDrag = useCallback((): void => {
    setDragTabId(null)
    setDragOver(null)
    setDragOverEnd(false)
  }, [])

  // T-119 — a tab drag can end with NO strip handler firing at all: dropped on a Projects panel project
  // row (the T-104 move gesture), the source tab UNMOUNTS, so its own onDragEnd never runs and the
  // 2px insertion line stayed painted between the surviving tabs until the next drag (the Owner's
  // screenshot). Window-level listeners close every exit for BOTH indicators:
  //   • `drop` — fires on the outside target and bubbles here BEFORE that unmount;
  //   • `dragend` — cancelled drags (Esc, release on a non-target) and every ordinary drop;
  //   • `dragover` — the pointer is elsewhere while the drag is still live (on its way to the
  //     Projects panel), so the line must not hang over the strip. `dragover` is used instead of a
  //     `dragleave` handler on purpose: Chromium gives dragleave no reliable relatedTarget, and an
  //     intra-strip leave (tab → tab) would blink the line off for a frame; dragover fires
  //     continuously on whatever element is under the pointer and bubbles here, making "target
  //     outside the strip" an unambiguous, flicker-free exit test. It only ever CLEARS — inside the
  //     strip it is a no-op, so a legitimate reorder drag looks exactly as it did before.
  // All three are bubble-phase, so the strip's own React handlers (reorder, end-drop) still run
  // first and keep their behaviour.
  const stripRef = useRef<HTMLDivElement | null>(null)
  // T-062 (edge autoscroll) — a ref to the overflow-x scroller (the `.tabs` element) so a tab drag
  // near either strip edge can pan the overflowing strip. This used to be Chromium's own drag
  // autoscroll (no code): drag a tab to the scroller's edge and the browser scrolled it. That
  // native behaviour degraded on the Electron 33→44 Chromium jump and, crucially, only ever
  // covered the SCROLLER's own edges — with tabs overflowing, the strip's visual right edge is the
  // TerminalActions cluster (a sibling, `margin-left:auto`), NOT part of `.tabs`, so the pointer
  // there was never over the scrollable element and the right edge never scrolled at all (the left
  // edge, still over a tab, scrolled only barely). We now drive it explicitly off the drag-lifetime
  // window `dragover` below, measured against the WHOLE strip's width, so both edges — including the
  // actions region on the right — pan deterministically and identically across Chromium versions.
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const autoScrollDirRef = useRef(0)
  useEffect(() => {
    if (!dragTabId) return
    // The edge band (px from each side) that arms autoscroll, and the pan step per animation frame.
    const EDGE = 56
    const STEP = 16
    let raf: number | null = null
    const tick = (): void => {
      const scroller = scrollerRef.current
      const dir = autoScrollDirRef.current
      if (scroller && dir !== 0) scroller.scrollLeft += dir * STEP
      raf = requestAnimationFrame(tick)
    }
    const onWindowDragOver = (e: DragEvent): void => {
      const target = e.target
      if (!(target instanceof Node && stripRef.current?.contains(target))) {
        setDragOver(null)
        setDragOverEnd(false)
      }
      // Edge autoscroll direction. Zones are measured against the SCROLLER's own left edge (the
      // strip's left) and the STRIP's right edge (which extends past the scroller across the
      // TerminalActions cluster), so a drag to the visual right edge — over the actions — still
      // pans. Only arms while the pointer is within the strip row; leaving it (e.g. dragging toward
      // the Projects panel) stops the pan. `right - clientX < EDGE` stays true past the scroller edge, so
      // dragging over the actions keeps scrolling right.
      const scroller = scrollerRef.current
      const strip = stripRef.current
      if (!scroller || !strip) return
      const sr = scroller.getBoundingClientRect()
      const pr = strip.getBoundingClientRect()
      const inRow =
        e.clientY >= pr.top && e.clientY <= pr.bottom && e.clientX >= pr.left && e.clientX <= pr.right
      if (!inRow) autoScrollDirRef.current = 0
      else if (e.clientX - sr.left < EDGE) autoScrollDirRef.current = -1
      else if (pr.right - e.clientX < EDGE) autoScrollDirRef.current = 1
      else autoScrollDirRef.current = 0
    }
    window.addEventListener('dragover', onWindowDragOver)
    window.addEventListener('drop', endDrag)
    window.addEventListener('dragend', endDrag)
    raf = requestAnimationFrame(tick)
    return () => {
      window.removeEventListener('dragover', onWindowDragOver)
      window.removeEventListener('drop', endDrag)
      window.removeEventListener('dragend', endDrag)
      if (raf !== null) cancelAnimationFrame(raf)
      autoScrollDirRef.current = 0
    }
  }, [dragTabId, endDrag])

  const copyPath = (tab: Tab): void => {
    if (tab.kind !== 'doc' || !tab.path) return
    void window.pomade.app.clipboardWrite(tab.path)
    toast('Copied path')
  }
  const copyFullPath = (tab: Tab): void => {
    if (tab.kind !== 'doc' || !tab.path) return
    const full = wsRoot ? `${wsRoot}/${tab.path}` : tab.path
    void window.pomade.app.clipboardWrite(full)
    toast('Copied full path')
  }

  // T-103 — explicit Copy (docs only) vs Move (all kinds). Neither switches the active project:
  // the tab lands in the target ATTENTION-MARKED and bumps the target's counter (the arrival
  // signal), and the target's name is echoed back in a toast as the receipt.
  const copyToProject = (tab: Tab, toProjectId: Id): void => {
    const target = allProjects.find((p) => p.id === toProjectId)
    if (!target || tab.kind !== 'doc') return
    if (!tab.path) {
      toast('Save the document first.', 'error')
      return
    }
    void openDocInProject(activeProjectId, tab.id, toProjectId).then(() => {
      toast(`Copied to ${target.name}`)
    })
  }
  const moveToProject = (tab: Tab, toProjectId: Id): void => {
    const target = allProjects.find((p) => p.id === toProjectId)
    if (!target) return
    // A doc can be moved too (its tab leaves the source strip); an untitled doc has no path but
    // moving it is still meaningful — the whole tab relocates. moveTabToProject is kind-agnostic.
    void moveTabToProject(activeProjectId, tab.id, toProjectId).then(() => {
      toast(`Moved to ${target.name}`)
    })
  }

  // T-103 — reveal a tab's path in the OS file manager (Finder). A doc reveals its file; a
  // terminal/agent reveals its cwd. Both `path` and `cwd` are workspace-relative (or already
  // absolute for out-of-workspace files), so resolve to an absolute path for showItemInFolder,
  // which reveals in- and out-of-workspace targets alike.
  const revealInFinder = (tab: Tab): void => {
    if (tab.kind === 'doc') {
      if (!tab.path) {
        toast('Nothing to reveal — save the document first.', 'error')
        return
      }
      const abs = tab.path.startsWith('/')
        ? tab.path
        : wsRoot
          ? `${wsRoot}/${tab.path}`
          : tab.path
      void window.pomade.app.showItemInFolder(abs)
      return
    }
    if (tab.kind === 'app' || tab.kind === 'commit' || tab.kind === 'compare' || tab.kind === 'attached' || tab.kind === 'conflict' || tab.kind === 'branch') return // no reveal for these
    // Terminal/agent: an empty cwd means the workspace root itself — still revealable.
    const cwd = tab.cwd
    const abs = cwd.startsWith('/') ? cwd : wsRoot ? (cwd ? `${wsRoot}/${cwd}` : wsRoot) : cwd
    if (!abs) return
    void window.pomade.app.showItemInFolder(abs)
  }

  // T-087 — "drop at the END" geometry: the target is always the current last tab, inserted
  // after. The indicator is suppressed when the dragged tab is already last (nothing would move).
  const lastTab = tabs.length > 0 ? tabs[tabs.length - 1] : undefined
  const dropAtEnd = dragOverEnd && !!dragTabId && !!lastTab && dragTabId !== lastTab.id

  return (
    <div ref={stripRef} className={styles.strip} role="tablist" data-testid="tabstrip">
      <div ref={scrollerRef} className={styles.tabs} data-testid="tabstrip-scroll">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          // T-056/T-061 — the red "unread / wants attention" dot, now on EVERY tab kind (terminal
          // attention events + the manual "Mark unread" action). On a doc tab it REPLACES the blue
          // dirty dot while set; the blue dot reappears when the red one clears (dirty untouched).
          const attention = !!tab.attention
          const dirty = tab.kind === 'doc' && tab.dirty && !attention
          // T-101 — the scope mark (exclamation triangle) in its OWN slot: orange when the doc
          // lives outside the active project's scope (root + in-scope folders, E-047), red when
          // outside the workspace (absolute path) and the scope;
          // duplicate-open across projects adds a tooltip line (colour unchanged) and can force
          // the triangle even for an in-project doc. COMPUTED from the paths, never stored — it
          // follows the project the tab is viewed in. The Workspace project (rootPath '')
          // contains everything workspace-relative.
          const scope = tab.kind === 'doc' ? classifyScope(tab.path, projectRoot, scopeFolders) : 'in-project'
          const duplicate = tab.kind === 'doc' && !!tab.path && duplicatePaths.has(tab.path)
          const showScopeMark = scope !== 'in-project' || duplicate
          // E-025 — the Unbound ⚠️ mark: a LIVE agent tab whose bind window closed with no
          // uniquely-attributable session id (it keeps working; it just won't auto-resume after
          // a restart until it becomes Bound). Reuses the scope mark's exclamation vocabulary,
          // but CLICKABLE — the popover offers manual id entry / Ignore / Cancel. Hidden while
          // the user has silenced THIS unbound session (runtime-only; a rebind re-arms it).
          const unbound =
            tab.kind === 'agent' &&
            tab.status === 'live' &&
            tab.bindState === 'unbound' &&
            !silencedUnbound[tab.id]
          const scopeLines: string[] = []
          if (scope === 'outside-project') scopeLines.push('Outside this project')
          else if (scope === 'outside-workspace') scopeLines.push('Outside the workspace')
          if (duplicate) scopeLines.push('2+ copies open across projects')
          // E-033 — an app marked this agent tab's session unnamed: the default title in italics,
          // with a hollow "unnamed" dot.
          const unnamed = tab.kind === 'agent' && !!tab.unnamed
          const preview = tab.id === previewTabId
          const color = tab.color
          const renaming = rename?.tabId === tab.id
          const dropSide = dragOver?.tabId === tab.id ? dragOver.side : undefined
          return (
            <div
              key={tab.id}
              ref={(el) => {
                // T-062 — track each tab's element so the autoscroll effect can reach the active one.
                if (el) tabElsRef.current.set(tab.id, el)
                else tabElsRef.current.delete(tab.id)
              }}
              role="tab"
              aria-selected={active}
              className={`${styles.tab} ${active ? styles.active : ''} ${
                dropSide === 'before' ? styles.dropBefore : ''
              } ${dropSide === 'after' ? styles.dropAfter : ''}`}
              data-testid={`tab-${tab.id}`}
              data-active={active}
              data-preview={preview || undefined}
              data-color={color ?? undefined}
              data-drop={dropSide}
              // T-048: HTML5 drag-and-drop reorder. The tab is draggable except while its
              // rename input is open (the input keeps its own drag/selection behavior).
              draggable={!renaming}
              onClick={() => setActive(activeProjectId, tab.id)}
              onDoubleClick={() => {
                // Double-click renames any tab: terminal/agent in place (T-021), doc tab via
                // the same on-disk rename flow as the context menu (T-047; collision → T-045).
                // A version tab offers none (startRename).
                startRename(tab)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                // T-061 — do NOT activate the tab on right-click. Activating would clear its dot on
                // the edge, so "Mark unread" could never mark an INACTIVE tab (it would become the
                // active tab first). Every menu action targets `menuTab` by id, so activation isn't
                // needed; guarded close paths focus their own tab.
                setMenu({ x: e.clientX, y: e.clientY, tabId: tab.id })
              }}
              onDragStart={(e) => {
                if (renaming) {
                  e.preventDefault()
                  return
                }
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', tab.id)
                // T-104 — a custom marker so a drop target OUTSIDE the strip (the Projects panel's
                // project rows) can recognise a tab drag during dragover, when getData is blocked
                // and only dataTransfer.types is readable. Drop there = Move to that project.
                e.dataTransfer.setData(TAB_DRAG_MIME, tab.id)
                setDragTabId(tab.id)
              }}
              onDragOver={(e) => {
                if (!dragTabId || dragTabId === tab.id) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                const rect = e.currentTarget.getBoundingClientRect()
                const side = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
                setDragOverEnd(false)
                setDragOver((prev) =>
                  prev?.tabId === tab.id && prev.side === side ? prev : { tabId: tab.id, side }
                )
              }}
              onDrop={(e) => {
                e.preventDefault()
                const source = dragTabId ?? e.dataTransfer.getData('text/plain')
                if (source && source !== tab.id) {
                  const rect = e.currentTarget.getBoundingClientRect()
                  const after = e.clientX >= rect.left + rect.width / 2
                  reorderTab(activeProjectId, source, tab.id, after)
                }
                endDrag()
              }}
              onDragEnd={endDrag}
            >
              <span className={styles.tabIcon} aria-hidden="true">
                <TabIcon tab={tab} />
              </span>
              {renaming ? (
                <InlineRenameInput
                  className={styles.renameInput}
                  testId={`tab-rename-input-${tab.id}`}
                  value={rename.value}
                  onChange={(value) => setRename({ tabId: tab.id, value })}
                  onCommit={commitRename}
                  onCancel={cancelRename}
                />
              ) : tab.kind === 'attached' ? (
                <AttachedTabTitle tab={tab} className={styles.tabTitle} ownerClassName={styles.tabOwner} />
              ) : (
                // T-148 — full-name tooltip, shown ONLY when the title span is truncated
                // (`scrollWidth > clientWidth`, measured live at hover). Same string that is
                // rendered (`tab.title`) for every kind.
                // Lives in the `!renaming` branch, so the rename input never carries it.
                <Tooltip
                  lines={[tab.title]}
                  showIf={(el) => el.scrollWidth > el.clientWidth}
                  testId={`tab-title-tooltip-${tab.id}`}
                >
                  <span
                    className={`${styles.tabTitle} ${unnamed ? styles.unnamedTitle : ''} ${preview ? styles.previewTitle : ''}`}
                    data-testid={`tab-title-${tab.id}`}
                    data-unnamed={unnamed || undefined}
                  >
                    {tab.title}
                  </span>
                </Tooltip>
              )}
              {unnamed && !renaming && (
                <Tooltip lines={['Unnamed session']}>
                  <span className={styles.unnamed} data-testid={`tab-unnamed-${tab.id}`} aria-label="unnamed session" />
                </Tooltip>
              )}
              {dirty && <span className={styles.dirty} aria-label="unsaved" />}
              {attention && (
                <span
                  className={styles.attention}
                  data-testid={`tab-attention-${tab.id}`}
                  aria-label="wants attention"
                />
              )}
              {showScopeMark && (
                <ScopeMark
                  tone={scope === 'outside-workspace' ? 'danger' : 'warning'}
                  lines={scopeLines}
                  testId={`tab-scope-${tab.id}`}
                />
              )}
              {unbound && (
                <ScopeMark
                  tone="warning"
                  lines={['Session not identified — click to fix']}
                  testId={`tab-unbound-${tab.id}`}
                  onClick={(rect) => setUnboundPop({ tabId: tab.id, rect })}
                />
              )}
              {tab.kind === 'doc' && tab.symlink && (
                <Tooltip lines={['Symbolic link — click to see target']}>
                  <button
                    type="button"
                    className={styles.symlink}
                    data-testid="tab-symlink"
                    aria-label="Symbolic link — click to see target"
                    onClick={(e) => {
                      e.stopPropagation()
                      setSymlinkPop({ rel: tab.path, rect: e.currentTarget.getBoundingClientRect() })
                    }}
                  >
                    <SymlinkGlyph />
                  </button>
                </Tooltip>
              )}
              <Tooltip lines={['Close tab (Cmd+W)']}>
                <button
                  type="button"
                  className={styles.close}
                  aria-label={`Close ${tab.title}`}
                  data-testid={`close-${tab.id}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    requestClose(activeProjectId, tab.id)
                  }}
                >
                  ×
                </button>
              </Tooltip>
            </div>
          )
        })}
      </div>

      {/* T-087 — the free strip area right of the last tab is a LIVE drop target meaning "move to
          END". It used to be dead space belonging to no target (the exact T-073 failure mode: the
          only route to the last slot was the right half of the last tab, so a drop on the obvious
          empty area was declined and the tab snapped back). This zone GROWS to fill everything
          between the last tab and the actions cluster — the whole visually-plausible remainder,
          not a thin band — and shows the same 2px insertion line the between-tab indicators use,
          on its left edge (flush with the last tab's right edge). It carries drag handlers only,
          so it never swallows a click, and it stays inert unless a tab drag is in flight. */}
      <div
        className={`${styles.endZone} ${dropAtEnd ? styles.endZoneActive : ''}`}
        data-testid="tabstrip-end-zone"
        data-drop-end={dropAtEnd ? 'true' : undefined}
        onContextMenu={(e) => {
          // T-149 — right-click the empty strip area opens the strip context menu (bulk actions +
          // Reopen closed tab). Right-clicking a TAB still opens the per-tab menu (handled on the
          // tab element above) — this handler is on the end zone only, so there is no regression.
          e.preventDefault()
          setMenu(null)
          setStripMenu({ x: e.clientX, y: e.clientY })
        }}
        onDragOver={(e) => {
          if (!dragTabId || !lastTab) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setDragOver(null)
          setDragOverEnd(true)
        }}
        onDragLeave={() => setDragOverEnd(false)}
        onDrop={(e) => {
          if (!lastTab) return
          e.preventDefault()
          const source = dragTabId ?? e.dataTransfer.getData('text/plain')
          // Insert AFTER the current last tab — a no-op when the dragged tab is already last.
          if (source && source !== lastTab.id) reorderTab(activeProjectId, source, lastTab.id, true)
          endDrag()
        }}
      />

      {project && <TerminalActions project={project} />}

      {menu && menuTab && (
        <TabContextMenu
          x={menu.x}
          y={menu.y}
          tab={menuTab}
          onClose={() => setMenu(null)}
          onCloseTab={() => requestClose(activeProjectId, menuTab.id)}
          onCloseOthers={() => requestCloseOthers(activeProjectId, menuTab.id)}
          onCloseRight={() => requestCloseToRight(activeProjectId, menuTab.id)}
          onMarkUnread={() => markUnread(activeProjectId, menuTab.id)}
          onCopyPath={() => copyPath(menuTab)}
          onCopyFullPath={() => copyFullPath(menuTab)}
          onRenameDoc={() => startRename(menuTab)}
          onRenameTab={() => startRename(menuTab)}
          onSetColor={(c) => setColor(menuTab, c)}
          otherProjects={otherProjects}
          onMoveToProject={(pid) => moveToProject(menuTab, pid)}
          onCopyToProject={(pid) => copyToProject(menuTab, pid)}
          onRevealInFinder={() => revealInFinder(menuTab)}
          onShowDetails={() => setDetailsTabId(menuTab.id)}
        />
      )}

      {detailsTabId && (
        <TabDetails
          projectId={activeProjectId}
          tabId={detailsTabId}
          onClose={() => setDetailsTabId(null)}
        />
      )}

      {stripMenu && project && (
        <StripContextMenu
          x={stripMenu.x}
          y={stripMenu.y}
          project={project}
          onClose={() => setStripMenu(null)}
        />
      )}

      {symlinkPop && (
        <SymlinkPopover
          rel={symlinkPop.rel}
          isDir={false}
          anchorRect={symlinkPop.rect}
          onClose={() => setSymlinkPop(null)}
        />
      )}

      {unboundPop && (
        <UnboundPopover
          projectId={activeProjectId}
          tabId={unboundPop.tabId}
          anchorRect={unboundPop.rect}
          onClose={() => setUnboundPop(null)}
        />
      )}
    </div>
  )
}
