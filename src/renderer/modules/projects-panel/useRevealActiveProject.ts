// Pomade — T-311: the Projects panel follows the active project. Pomade switches projects on its own
// (a notice, an app opening a tab, an agent tab call, a symlink into another project); when the active
// project changes by anything but the user's own pick (a row, a launcher, a created project, the
// toast's Back), the panel reveals the row — unfolds the collapsed groups around it, scrolls it into
// view and flashes it once — and, while the experimental setting is on, a toast names the switch with
// a "Back to <previous>" action. A pick only scrolls into view; so does the workspace's first active
// project at startup.
//
// Rows and launchers carry `data-project-row="<id>"`; their scroll box carries `data-reveal-scroll`.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { WORKSPACE_PROJECT_ID, type Id } from '@shared/types'
import { useToastStore } from '../../hooks/useToast'
import { useAppSettingsStore } from '../../stores/app-settings-store'
import { WORKSPACE_PROJECT, useWorkspaceStore } from '../../stores/workspace-store'
import { useWorkspaceUiStore } from '../../stores/workspace-ui-store'
import { groupAncestry } from './reorder'

/** How long a revealed row carries its flash — the CSS animation's length. */
const FLASH_MS = 1200

/** The project the user last picked, until the switch to it is seen. */
let userPick: Id | null = null

/** Switch to `id` as the user's own pick: the panel scrolls to it but doesn't flash or toast. */
export function pickProject(id: Id): void {
  userPick = id
  useWorkspaceStore.getState().setActiveProject(id)
}

function projectName(id: Id): string {
  if (id === WORKSPACE_PROJECT_ID) return WORKSPACE_PROJECT.name
  return useWorkspaceStore.getState().projects.find((p) => p.id === id)?.name ?? id
}

/** Scroll `el` into its scroll box, as little as needed. Only that box moves — never the shell
 *  around it, which `scrollIntoView` would also scroll. */
function scrollIntoBox(el: HTMLElement): void {
  const box = el.closest<HTMLElement>('[data-reveal-scroll]')
  if (!box) return
  // The visible box is the client area: a scrollbar along the bottom would cover a row the
  // bounding rect counts as shown.
  const top = box.getBoundingClientRect().top + box.clientTop
  const bottom = top + box.clientHeight
  const r = el.getBoundingClientRect()
  if (r.top < top) box.scrollTop -= top - r.top
  else if (r.bottom > bottom) box.scrollTop += r.bottom - bottom
}

/** Scroll the pending row into view once it is rendered. */
function scrollPending(pending: { current: Id | null }): void {
  const id = pending.current
  if (!id) return
  const el = document.querySelector<HTMLElement>(`[data-project-row="${CSS.escape(id)}"]`)
  if (!el) return
  pending.current = null
  scrollIntoBox(el)
}

/** Follows the active project; returns the project whose row is flashing, or null. */
export function useRevealActiveProject(activeProjectId: Id): Id | null {
  const hydrated = useWorkspaceStore((s) => s.hydrated)
  const seenFirstRef = useRef(false)
  const prevRef = useRef<Id>(activeProjectId)
  // The row still to scroll into view; it may only render after its groups unfold.
  const scrollPendingRef = useRef<Id | null>(null)
  const [flashProjectId, setFlashProjectId] = useState<Id | null>(null)

  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = activeProjectId
    const picked = userPick === activeProjectId
    userPick = null
    // Until the workspace has loaded and shown its first active project, nothing is a switch.
    const startup = !seenFirstRef.current
    seenFirstRef.current = hydrated
    scrollPendingRef.current = activeProjectId
    if (picked || startup || prev === activeProjectId) {
      setFlashProjectId(null)
      scrollPending(scrollPendingRef)
      return
    }
    const { projects, groups } = useWorkspaceStore.getState()
    const ui = useWorkspaceUiStore.getState()
    const groupId = projects.find((p) => p.id === activeProjectId)?.groupId
    for (const g of groupAncestry(groups, groupId)) {
      if (ui.collapsedGroups.includes(g)) ui.toggleGroupCollapsed(g)
    }
    setFlashProjectId(activeProjectId)
    scrollPending(scrollPendingRef)
    // No toast when the previous project is gone (deleted, or another workspace was opened).
    const prevExists = prev === WORKSPACE_PROJECT_ID || projects.some((p) => p.id === prev)
    if (prevExists && useAppSettingsStore.getState().projectSwitchToast) {
      useToastStore.getState().push(`Switched to ${projectName(activeProjectId)}`, 'info', {
        tag: 'project-switch',
        testId: 'project-switch-toast',
        action: {
          label: `Back to ${projectName(prev)}`,
          testId: 'project-switch-back',
          run: () => pickProject(prev)
        }
      })
    }
    const t = window.setTimeout(() => setFlashProjectId(null), FLASH_MS)
    return () => window.clearTimeout(t)
  }, [activeProjectId, hydrated])

  // Runs after every render until the pending row exists (an unfold renders it a commit later).
  useLayoutEffect(() => scrollPending(scrollPendingRef))

  return flashProjectId
}
