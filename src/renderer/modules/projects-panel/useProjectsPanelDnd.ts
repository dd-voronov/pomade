// Pomade — the Projects panel's two interleaved HTML5 drag-and-drop systems, in one hook.
//
//  1. REORDER DnD (E-010/E-015/T-073): the Projects panel's own project/group/Ungrouped drag. The active
//     source is tracked in a REF (`dragRef`, read synchronously by dragover/drop routing so it
//     never lags a not-yet-flushed setState); `dropInd` state drives only the visual before/after
//     + "drop into" indicators. Every ordering / nesting / guard decision lives in the pure
//     planners in reorder.ts (`moveProject`, `moveProjectIntoGroup`, `planGroupDrop`) — the DOM
//     handlers here only translate an event's geometry into a target and defer to them.
//  2. TAB-DROP DnD (T-104): a tab dragged off the tab strip drops on a project row = MOVE it to
//     that project (Finder-style). A separate gesture, recognised via the `TAB_DRAG_MIME` marker
//     so the two systems never trigger each other's indicators.
//
// The hook exposes state (`dropInd`, `tabDropTargetId`) + class helpers for the indicators, plus
// one handler-bundle factory per drop-target shape. A factory returns the exact
// {draggable,onDragStart,onDragOver,onDrop,onDragEnd} props to spread onto its element.

import { useEffect, useRef, useState } from 'react'

import type { Group, Id, Project } from '@shared/types'
import { isTabDrag, TAB_DRAG_MIME } from '../../dnd'
import {
  canNestUnder,
  descendantIds,
  groupHeaderZone,
  moveProject,
  moveProjectIntoGroup,
  planGroupDrop,
  UNGROUPED_ID,
  type GroupDropTarget,
  type HeaderZone
} from './reorder'
import styles from './ProjectsPanel.module.css'

// E-015 — what is being dragged. `ungrouped` is the draggable Ungrouped pseudo-group.
export type DragItem = { kind: 'project' | 'group' | 'ungrouped'; id: string } | null

// E-015 / T-073 — where a drop would land. A group header shows an insertion line (top band =
// above), a "nest into" highlight (center) or a "nest as first child" highlight (bottom band); a
// project row shows a before/after line; `gap` is the strip preceding a section ("place here at
// that level"); `end` is the below-all zone (last in the top-level order / out to Ungrouped).
export type DropInd =
  | { kind: 'project'; id: string; side: 'before' | 'after' }
  | { kind: 'group'; id: string; zone: HeaderZone }
  | { kind: 'ungrouped'; zone: HeaderZone }
  | { kind: 'gap'; id: string }
  | { kind: 'end' }
  | null

/**
 * E-015 / T-073 — the drop BAND for a group header, read fresh from the drop event's geometry
 * (never from async indicator state) so the outcome is deterministic regardless of render
 * timing — a key part of the round-4 flakiness rebuild. The band → meaning mapping itself lives
 * in `groupHeaderZone` (pure, in reorder.ts).
 */
function headerZoneAt(clientY: number, el: HTMLElement, canNest: boolean): HeaderZone {
  const r = el.getBoundingClientRect()
  return groupHeaderZone(clientY - r.top, r.height, canNest)
}

/** The reorder-source drag props (dragstart/dragend) shared by every draggable Projects panel element. */
type DragSourceProps = {
  draggable: true
  onDragStart: (e: React.DragEvent<HTMLElement>) => void
  onDragEnd: () => void
}
type OverDrop = {
  onDragOver: (e: React.DragEvent<HTMLElement>) => void
  onDrop: (e: React.DragEvent<HTMLElement>) => void
}

export interface ProjectsPanelDnd {
  dropInd: DropInd
  tabDropTargetId: string | null
  /** Cleanup shared by every draggable source's `onDragEnd`. */
  clearDrag: () => void
  /** Visual class for a project row's before/after insertion line. */
  rowDropClass: (id: string) => string
  /** Visual class for a group / Ungrouped header's live drop band. */
  headerDropClass: (zone: HeaderZone | undefined) => string
  /** Tab-drop (T-104) branches, called BEFORE reorder logic on rows that accept tab moves. Each
   *  returns true when it handled a tab drag, so the caller skips its reorder handling. Exposed
   *  raw for the Workspace project row (which has no reorder DnD of its own). */
  tabDragOverRow: (e: React.DragEvent<HTMLElement>, projectId: string) => boolean
  tabDropOnRow: (e: React.DragEvent<HTMLElement>, projectId: string) => boolean
  /** Handler bundles, one per drop-target shape — spread onto the element. */
  projectRowHandlers: (project: Project) => DragSourceProps & OverDrop
  groupHeaderHandlers: (group: Group) => DragSourceProps & OverDrop
  groupEmptyHandlers: (group: Group) => OverDrop
  gapHandlers: (target: GroupDropTarget) => OverDrop
  ungroupedSectionHandlers: () => OverDrop
  ungroupedHeaderHandlers: () => DragSourceProps & OverDrop
  belowAllHandlers: () => OverDrop
  /** Whether a gap strip is the live drop target (drives its `.gapActive` class). */
  isGapActive: (key: string) => boolean
}

export function useProjectsPanelDnd(args: {
  groups: Group[]
  projects: Project[]
  ungroupedOrder: number | undefined
  activeProjectId: Id
  reorder: (groups: Group[], projects: Project[], ungroupedOrder?: number) => void
  moveTabToProject: (fromProjectId: Id, tabId: Id, toProjectId: Id) => Promise<void>
}): ProjectsPanelDnd {
  const { groups, projects, ungroupedOrder, activeProjectId, reorder, moveTabToProject } = args

  // E-010 (T-003) — the active reorder drag source, in a REF (read synchronously by dragover/drop
  // routing, so it never lags a not-yet-flushed setState). `dropInd` drives only the indicators.
  const dragRef = useRef<DragItem>(null)
  const [dropInd, setDropInd] = useState<DropInd>(null)
  const beginDrag = (item: DragItem): void => {
    dragRef.current = item
  }
  const clearDrag = (): void => {
    dragRef.current = null
    setDropInd(null)
  }

  // T-104 — the project row currently highlighted as a tab MOVE target (only ever a VALID target —
  // never the current/active project, whose strip the tab already lives in). The tab strip only
  // ever shows the ACTIVE project's tabs, so the source project is always `activeProjectId`.
  const [tabDropTargetId, setTabDropTargetId] = useState<string | null>(null)
  // A tab drag can end (drop elsewhere, or Esc/outside) without a `drop` on any row; `dragend`
  // bubbles to the window from the strip source, so clear the highlight there unconditionally.
  useEffect(() => {
    const onDragEnd = (): void => setTabDropTargetId(null)
    window.addEventListener('dragend', onDragEnd)
    return () => window.removeEventListener('dragend', onDragEnd)
  }, [])

  // dragover on a project row while a TAB is in flight: highlight + accept a MOVE, unless the row
  // is the current project (its strip already holds the tab — a no-op). Returns true when it
  // handled a tab drag, so the caller skips its reorder logic.
  const tabDragOverRow = (e: React.DragEvent<HTMLElement>, projectId: string): boolean => {
    if (!isTabDrag(e.dataTransfer)) return false
    if (projectId === activeProjectId) {
      // Own/current project — not a valid target: no highlight, don't accept the drop.
      setTabDropTargetId((prev) => (prev === null ? prev : null))
      return true
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setTabDropTargetId((prev) => (prev === projectId ? prev : projectId))
    return true
  }
  // drop on a project row while a TAB is in flight: MOVE it there. Returns true when handled.
  const tabDropOnRow = (e: React.DragEvent<HTMLElement>, projectId: string): boolean => {
    if (!isTabDrag(e.dataTransfer)) return false
    e.preventDefault()
    const tabId = e.dataTransfer.getData(TAB_DRAG_MIME) || e.dataTransfer.getData('text/plain')
    setTabDropTargetId(null)
    if (tabId && projectId !== activeProjectId) {
      void moveTabToProject(activeProjectId, tabId, projectId)
    }
    return true
  }

  // ── DnD drops (project source) ─────────────────────────────────────────────────
  const dropOnProject = (target: Project, side: 'before' | 'after'): void => {
    const drag = dragRef.current
    if (drag?.kind !== 'project' || drag.id === target.id) return
    reorder(groups, moveProject(projects, drag.id, target.groupId, target.id, side === 'after'))
    clearDrag()
  }
  // T-073 — a project dropped ON a group tier: `first` (the band directly below the header)
  // makes it the tier's first member, otherwise it is appended.
  const dropProjectIntoGroup = (groupId: string | undefined, first: boolean): void => {
    const drag = dragRef.current
    if (drag?.kind !== 'project') return
    reorder(groups, moveProjectIntoGroup(projects, drag.id, groupId, first))
    clearDrag()
  }
  // ── DnD drops (group / ungrouped source) — ALL routed through the one pure planner ───
  // The DOM handlers only translate an event into a `GroupDropTarget`; every ordering /
  // nesting / guard decision lives in `planGroupDrop` (reorder.ts).
  const applyGroupDrop = (target: GroupDropTarget): void => {
    const drag = dragRef.current
    if (drag?.kind !== 'group' && drag?.kind !== 'ungrouped') return
    const r = planGroupDrop(groups, ungroupedOrder, drag.id, target)
    reorder(r.groups, projects, r.ungroupedOrder)
    clearDrag()
  }

  const rowDropClass = (id: string): string => {
    if (dropInd?.kind === 'project' && dropInd.id === id) {
      return dropInd.side === 'before' ? styles.dropBefore : styles.dropAfter
    }
    return ''
  }

  /** T-073 — the class for a group/Ungrouped header's live drop band. */
  const headerDropClass = (zone: HeaderZone | undefined): string =>
    zone === 'into'
      ? styles.dropInto
      : zone === 'into-first'
        ? styles.dropIntoFirst
        : zone === 'before'
          ? styles.dropBefore
          : zone === 'after'
            ? styles.dropAfter
            : ''

  const isGapActive = (key: string): boolean => dropInd?.kind === 'gap' && dropInd.id === key

  // ── Handler bundles ────────────────────────────────────────────────────────────
  const projectRowHandlers = (project: Project): DragSourceProps & OverDrop => ({
    draggable: true,
    onDragStart: (e) => {
      beginDrag({ kind: 'project', id: project.id })
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', project.id)
    },
    onDragOver: (e) => {
      if (tabDragOverRow(e, project.id)) return
      if (dragRef.current?.kind !== 'project' || dragRef.current.id === project.id) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const rect = e.currentTarget.getBoundingClientRect()
      const side = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
      setDropInd((prev) =>
        prev?.kind === 'project' && prev.id === project.id && prev.side === side
          ? prev
          : { kind: 'project', id: project.id, side }
      )
    },
    onDrop: (e) => {
      if (tabDropOnRow(e, project.id)) return
      if (dragRef.current?.kind !== 'project') return
      e.preventDefault()
      const rect = e.currentTarget.getBoundingClientRect()
      const side = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
      dropOnProject(project, side)
    },
    onDragEnd: clearDrag
  })

  const groupHeaderHandlers = (group: Group): DragSourceProps & OverDrop => ({
    draggable: true,
    onDragStart: (e) => {
      beginDrag({ kind: 'group', id: group.id })
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', group.id)
    },
    onDragOver: (e) => {
      const drag = dragRef.current
      if (!drag) return
      if (drag.kind === 'project') {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        // A project can only ever go INTO a tier: the bottom band makes it the first
        // member, the rest of the header appends it.
        const zone = headerZoneAt(e.clientY, e.currentTarget, true)
        setDropInd({
          kind: 'group',
          id: group.id,
          zone: zone === 'into-first' ? 'into-first' : 'into'
        })
        return
      }
      if (drag.kind === 'group') {
        if (drag.id === group.id || descendantIds(groups, drag.id).has(group.id)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const zone = headerZoneAt(e.clientY, e.currentTarget, canNestUnder(groups, drag.id, group.id))
        setDropInd({ kind: 'group', id: group.id, zone })
        return
      }
      // ungrouped source: only a top-level sibling reorder
      if (group.parentId !== undefined) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropInd({ kind: 'group', id: group.id, zone: headerZoneAt(e.clientY, e.currentTarget, false) })
    },
    onDrop: (e) => {
      const drag = dragRef.current
      if (!drag) return
      e.preventDefault()
      if (drag.kind === 'project') {
        dropProjectIntoGroup(
          group.id,
          headerZoneAt(e.clientY, e.currentTarget, true) === 'into-first'
        )
        return
      }
      const canNest = drag.kind === 'group' && canNestUnder(groups, drag.id, group.id)
      applyGroupDrop({
        kind: 'header',
        groupId: group.id,
        zone: headerZoneAt(e.clientY, e.currentTarget, canNest)
      })
    },
    onDragEnd: clearDrag
  })

  const groupEmptyHandlers = (group: Group): OverDrop => ({
    onDragOver: (e) => {
      if (dragRef.current?.kind !== 'project') return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropInd({ kind: 'group', id: group.id, zone: 'into' })
    },
    onDrop: (e) => {
      if (dragRef.current?.kind !== 'project') return
      e.preventDefault()
      dropProjectIntoGroup(group.id, false)
    }
  })

  const gapHandlers = (target: GroupDropTarget): OverDrop => ({
    onDragOver: (e) => {
      const drag = dragRef.current
      if (drag?.kind !== 'group' && drag?.kind !== 'ungrouped') return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      // The gap's live-indicator identity is its own key. `before-section` carries the group id;
      // `ungrouped-before` is the single Ungrouped gap.
      const key = target.kind === 'before-section' ? `gap-${target.groupId}` : 'gap-ungrouped'
      setDropInd((prev) => (prev?.kind === 'gap' && prev.id === key ? prev : { kind: 'gap', id: key }))
    },
    onDrop: (e) => {
      const drag = dragRef.current
      if (drag?.kind !== 'group' && drag?.kind !== 'ungrouped') return
      e.preventDefault()
      applyGroupDrop(target)
    }
  })

  const ungroupedSectionHandlers = (): OverDrop => ({
    onDragOver: (e) => {
      if (dragRef.current?.kind !== 'project') return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropInd({ kind: 'ungrouped', zone: 'into' })
    },
    onDrop: (e) => {
      if (dragRef.current?.kind !== 'project') return
      e.preventDefault()
      dropProjectIntoGroup(undefined, false)
    }
  })

  const ungroupedHeaderHandlers = (): DragSourceProps & OverDrop => ({
    draggable: true,
    onDragStart: (e) => {
      beginDrag({ kind: 'ungrouped', id: UNGROUPED_ID })
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', UNGROUPED_ID)
    },
    onDragOver: (e) => {
      const drag = dragRef.current
      if (drag?.kind === 'project') {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropInd({ kind: 'ungrouped', zone: 'into' })
      } else if (drag?.kind === 'group') {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropInd({ kind: 'ungrouped', zone: headerZoneAt(e.clientY, e.currentTarget, false) })
      }
    },
    onDrop: (e) => {
      const drag = dragRef.current
      if (drag?.kind === 'project') {
        e.preventDefault()
        dropProjectIntoGroup(undefined, false)
      } else if (drag?.kind === 'group') {
        e.preventDefault()
        applyGroupDrop({
          kind: 'ungrouped-header',
          zone: headerZoneAt(e.clientY, e.currentTarget, false)
        })
      }
    },
    onDragEnd: clearDrag
  })

  const belowAllHandlers = (): OverDrop => ({
    onDragOver: (e) => {
      if (!dragRef.current) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropInd((prev) => (prev?.kind === 'end' ? prev : { kind: 'end' }))
    },
    onDrop: (e) => {
      const drag = dragRef.current
      if (!drag) return
      e.preventDefault()
      if (drag.kind === 'project') dropProjectIntoGroup(undefined, false)
      else applyGroupDrop({ kind: 'end' })
    }
  })

  return {
    dropInd,
    tabDropTargetId,
    clearDrag,
    rowDropClass,
    headerDropClass,
    tabDragOverRow,
    tabDropOnRow,
    projectRowHandlers,
    groupHeaderHandlers,
    groupEmptyHandlers,
    gapHandlers,
    ungroupedSectionHandlers,
    ungroupedHeaderHandlers,
    belowAllHandlers,
    isGapActive
  }
}
