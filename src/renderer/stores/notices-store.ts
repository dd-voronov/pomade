// Pomade — E-032 notices-store (renderer). Every notice posted this run — by an app frame
// or a backend (`notices.post`), or through the closed-Pomade queue — newest last, and the notice toasts on
// screen. Runtime-only: the list starts empty each launch (queued notices arrive at launch).

import { create } from 'zustand'
import { nanoid } from 'nanoid'

import type { NoticeAction, QueuedNotice } from 'pomade-kit/protocol'

import { WORKSPACE_PROJECT_ID } from '@shared/types'
import {
  admitToast,
  appendNotice,
  NOTICES_PANEL_KEY,
  unreadCounts,
  withoutNotices,
  withPostingProject,
  noticeProject,
  type Notice,
  type NoticeToast
} from '../modules/notices/notice-model'
import { useAppSettingsStore } from './app-settings-store'
import { stripTarget, useMarksStore } from './marks-store'

export interface NoticeInput {
  source: string
  title: string
  body?: string
  action?: NoticeAction
  /** The project the notice was posted from: it belongs there unless its action names another, and an action without a `projectId` opens there. */
  postingProject: string
  /** Epoch ms; default now. */
  postedAt?: number
}

interface NoticesState {
  notices: Notice[]
  toasts: NoticeToast[]
  post: (input: NoticeInput) => Notice
  dismissToast: (toastId: string) => void
  /** Mute a source: its toasts go at once; its notices stay listed. */
  mute: (source: string) => void
  markRead: (noticeId: string) => void
  markAllRead: () => void
  /** Delete these notices (and a toast showing one of them). */
  remove: (noticeIds: readonly string[]) => void
  clear: () => void
}

export const useNoticesStore = create<NoticesState>((set) => ({
  notices: [],
  toasts: [],
  post: (input) => {
    const action = withPostingProject(input.action, input.postingProject)
    const notice: Notice = {
      id: nanoid(),
      source: input.source,
      title: input.title,
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(action !== undefined ? { action } : {}),
      projectId: noticeProject(input.action, input.postingProject),
      postedAt: input.postedAt ?? Date.now(),
      read: false
    }
    const muted = useAppSettingsStore.getState().mutedNoticeSources
    set((s) => ({ notices: appendNotice(s.notices, notice), toasts: admitToast(s.toasts, notice, nanoid(), muted) }))
    return notice
  },
  dismissToast: (toastId) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== toastId) })),
  mute: (source) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.source !== source) }))
    void useAppSettingsStore.getState().setNoticeSourceMuted(source, true)
  },
  markRead: (noticeId) =>
    set((s) => ({ notices: s.notices.map((n) => (n.id === noticeId && !n.read ? { ...n, read: true } : n)) })),
  markAllRead: () => set((s) => ({ notices: s.notices.map((n) => (n.read ? n : { ...n, read: true })) })),
  remove: (noticeIds) => set((s) => withoutNotices(s.notices, s.toasts, noticeIds)),
  clear: () => set({ notices: [], toasts: [] })
}))

// The Notices icon's badge: every unread notice — those of unmuted sources a mark from the source
// `notices`, those of muted sources a quiet mark from `notices-muted`, so the badge counts them all
// and is grey only when every unread notice is muted.
function markUnread(): void {
  const counts = unreadCounts(useNoticesStore.getState().notices, useAppSettingsStore.getState().mutedNoticeSources)
  const target = stripTarget(NOTICES_PANEL_KEY)
  useMarksStore.getState().setMark(target, 'notices', { count: counts.unmuted, urgent: false })
  useMarksStore.getState().setMark(target, 'notices-muted', { count: counts.muted, urgent: false, quiet: true })
}
useNoticesStore.subscribe((s, prev) => {
  if (s.notices !== prev.notices) markUnread()
})
useAppSettingsStore.subscribe((s, prev) => {
  if (s.mutedNoticeSources !== prev.mutedNoticeSources) markUnread()
})

/** E-032 — serve the closed-Pomade queue: what was queued while Pomade was closed shows now, and
 *  anything posted while it runs as it lands. Mounted once, in `App`. */
export function startNoticeQueue(): () => void {
  const show = (queued: QueuedNotice[]): void => {
    for (const q of queued) {
      useNoticesStore.getState().post({
        source: q.source,
        title: q.title,
        ...(q.body !== undefined ? { body: q.body } : {}),
        ...(q.action !== undefined ? { action: q.action } : {}),
        // A backend or a command has no project of its own: the notice belongs to the Workspace project.
        postingProject: WORKSPACE_PROJECT_ID,
        postedAt: Date.parse(q.postedAt)
      })
    }
  }
  const off = window.pomade.notices.onQueued(show)
  void window.pomade.notices.attach().then(show)
  return off
}
