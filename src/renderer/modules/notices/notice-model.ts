// Pomade — E-032: the notices model, pure. A notice is kept in the list (newest last, capped) and
// shown as a toast — unless its source is muted. A notice keeps the project it belongs to (the one
// it was posted from, else the one it names), and so does its action. A burst from one source is ONE
// toast: while a source's toast is up, each new notice from it takes the toast over (the newest
// shows) and counts the rest ("4 more from Runner"), so a storm never stacks toasts; the toast keeps
// the projects of the burst. The toast list is what the toast host draws.

import type { NoticeAction } from 'pomade-kit/protocol'

import { WORKSPACE_PROJECT_ID, type Project } from '@shared/types'

/** One notice as Pomade keeps it. */
export interface Notice {
  id: string
  /** The poster: an app id, or a platform command's name (`pomade-git`). */
  source: string
  title: string
  body?: string
  action?: NoticeAction
  /** The project the notice belongs to: the one its action names, else the one it was posted from. */
  projectId: string
  /** Epoch ms. */
  postedAt: number
  read: boolean
}

/** A toast on screen: the notice it shows. */
export interface NoticeToast {
  /** Stable while the toast is up. */
  id: string
  source: string
  /** The newest notice of the burst — the one it shows and opens. */
  noticeId: string
  /** How many earlier notices of the same burst it stands for. */
  more: number
  /** The distinct projects of every notice the burst holds (the shown one and the `more`). */
  projects: string[]
  /** Bumped whenever the toast's content changes (its timer restarts). */
  seq: number
}

/** The Notices panel's strip key (its icon carries the unread count). */
export const NOTICES_PANEL_KEY = 'notices'

/** The most notices the list keeps; older ones fall off. */
export const NOTICES_MAX = 200
/** How long a notice toast stays (ms), unless hovered. */
export const NOTICE_TOAST_MS = 6000

/** The action as the notice keeps it: one without a `projectId` belongs to `postingProject` — the
 *  project the notice was posted from — so its click opens there whichever project is in front. */
export function withPostingProject(action: NoticeAction | undefined, postingProject: string): NoticeAction | undefined {
  if (!action || action.projectId !== undefined) return action
  return { ...action, projectId: postingProject }
}

/** The project a notice belongs to: the one its action names, else the one it was posted from. */
export function noticeProject(action: NoticeAction | undefined, postingProject: string): string {
  return action?.projectId ?? postingProject
}

/** The project's name as a notice shows it; null when no project is known by that id (a notice
 *  from a project since removed shows no name). */
export function projectLabel(projectId: string | undefined, projects: readonly Project[]): string | null {
  if (projectId === undefined) return null
  if (projectId === WORKSPACE_PROJECT_ID) return 'Workspace'
  return projects.find((p) => p.id === projectId)?.name ?? null
}

/** Where "N more from <source>" goes: the one project every notice of the burst belongs to, to
 *  switch to it before the Notices panel opens; null when they span several (the panel opens where
 *  the user is, each row naming its project). */
export function moreTarget(toast: Pick<NoticeToast, 'projects'>): string | null {
  return toast.projects.length === 1 ? toast.projects[0]! : null
}

/** The list after `notice` arrives: appended, the oldest dropped beyond `NOTICES_MAX`. */
export function appendNotice(notices: readonly Notice[], notice: Notice): Notice[] {
  const next = [...notices, notice]
  return next.length > NOTICES_MAX ? next.slice(next.length - NOTICES_MAX) : next
}

/** The toasts after `notice` arrives: none for a muted source; the source's toast taken over
 *  when one is up (coalescing); else a new toast. */
export function admitToast(
  toasts: readonly NoticeToast[],
  notice: Notice,
  toastId: string,
  muted: readonly string[] = []
): NoticeToast[] {
  if (muted.includes(notice.source)) return [...toasts]
  const open = toasts.find((t) => t.source === notice.source)
  if (!open) return [...toasts, { id: toastId, source: notice.source, noticeId: notice.id, more: 0, projects: [notice.projectId], seq: 0 }]
  return toasts.map((t) =>
    t === open
      ? {
          ...t,
          noticeId: notice.id,
          more: t.more + 1,
          projects: t.projects.includes(notice.projectId) ? t.projects : [...t.projects, notice.projectId],
          seq: t.seq + 1
        }
      : t
  )
}

/** How many notices are unread, from unmuted and from muted sources (the Notices icon's badge:
 *  the total, grey when all of them are muted). */
export function unreadCounts(notices: readonly Notice[], muted: readonly string[] = []): { unmuted: number; muted: number } {
  const out = { unmuted: 0, muted: 0 }
  for (const x of notices) if (!x.read) out[muted.includes(x.source) ? 'muted' : 'unmuted']++
  return out
}

/** The list and the toasts without the notices `ids`; a toast showing one of them goes too. */
export function withoutNotices(
  notices: readonly Notice[],
  toasts: readonly NoticeToast[],
  ids: readonly string[]
): { notices: Notice[]; toasts: NoticeToast[] } {
  const gone = new Set(ids)
  return { notices: notices.filter((n) => !gone.has(n.id)), toasts: toasts.filter((t) => !gone.has(t.noticeId)) }
}

/** The Notices panel's selection: the selected notice ids and the anchor a Shift-click ranges from. */
export interface NoticeSelection {
  ids: string[]
  anchor: string | null
}

/** The selection after a modified click on `id` — Cmd toggles it; Shift selects the range from the
 *  anchor to it (Cmd+Shift adds the range); `order` is the rows as listed. A plain click is not a
 *  selection click: null (the caller runs the notice and clears the selection). */
export function selectOnClick(
  sel: NoticeSelection,
  id: string,
  order: readonly string[],
  mods: { cmd: boolean; shift: boolean }
): NoticeSelection | null {
  if (mods.shift) {
    const a = sel.anchor === null ? -1 : order.indexOf(sel.anchor)
    const b = order.indexOf(id)
    if (b < 0) return sel
    const range = a < 0 ? [id] : order.slice(Math.min(a, b), Math.max(a, b) + 1)
    const ids = mods.cmd ? [...sel.ids, ...range.filter((x) => !sel.ids.includes(x))] : range
    return { ids, anchor: a < 0 ? id : sel.anchor }
  }
  if (mods.cmd) {
    const ids = sel.ids.includes(id) ? sel.ids.filter((x) => x !== id) : [...sel.ids, id]
    return { ids, anchor: id }
  }
  return null
}
