// Pomade — E-032: notice toasts, drawn inside the shared toast host (`hooks/useToast.tsx`) with the
// toast's look. A toast shows the source, the title and the body; clicking it runs the notice's
// action and dismisses it. It leaves after NOTICE_TOAST_MS — not while the pointer is on it — and
// the notice stays in the Notices panel either way. The source line names the project the notice
// belongs to ("Hello · gamma"), since a click opens it there. A burst from one source is one toast
// showing the newest notice, with "N more from <source>" (opens the Notices panel — in the burst's
// project when they all belong to one, switching to it); the bell-slash mutes the source.

import { useEffect, useState } from 'react'

import { Tooltip } from '../../components/Tooltip'
import { useAppSettingsStore } from '../../stores/app-settings-store'
import { useSidePanelStore } from '../../stores/side-panel-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { WORKSPACE_PROJECT_ID } from '@shared/types'

import { cleanIpcError } from '../../lib/ipc-errors'
import { useAppsStore } from '../../stores/apps-store'
import { useNoticesStore } from '../../stores/notices-store'
import { useToastStore } from '../../hooks/useToast'
import { moreTarget, NOTICE_TOAST_MS, NOTICES_PANEL_KEY, projectLabel, type Notice, type NoticeToast } from './notice-model'
import { runNoticeAction } from './notice-actions'
import { CloseGlyph, MuteGlyph } from './notice-glyphs'
import { sourceName } from './source-name'
import styles from '../../hooks/useToast.module.css'

/** Show the Notices panel (the column expanded). */
function showNoticesPanel(): void {
  useSidePanelStore.getState().select(useWorkspaceStore.getState().activeProjectId, NOTICES_PANEL_KEY)
  void useAppSettingsStore.getState().setFileTreeCollapsed(false)
}

/** Switch to `projectId` (when it still exists) and show its Notices panel there. */
export async function showNoticesPanelIn(projectId: string | null): Promise<void> {
  const ws = useWorkspaceStore.getState()
  if (projectId !== null && projectId !== ws.activeProjectId && (projectId === WORKSPACE_PROJECT_ID || ws.projects.some((p) => p.id === projectId))) {
    await useSidePanelStore.getState().hydrateProject(projectId)
    ws.setActiveProject(projectId)
  }
  showNoticesPanel()
}

/** Run a notice's action (it is read now); a click that cannot run says why. */
export async function openNotice(notice: Notice): Promise<void> {
  useNoticesStore.getState().markRead(notice.id)
  try {
    const res = await runNoticeAction(notice)
    if (!res.ok) useToastStore.getState().push(res.error.message, 'error')
  } catch (err) {
    useToastStore.getState().push(cleanIpcError(err), 'error')
  }
}

function NoticeToastView({ toast }: { toast: NoticeToast }): React.JSX.Element | null {
  const notice = useNoticesStore((s) => s.notices.find((n) => n.id === toast.noticeId))
  const apps = useAppsStore((s) => s.apps)
  const projects = useWorkspaceStore((s) => s.projects)
  const dismiss = useNoticesStore((s) => s.dismissToast)
  const mute = useNoticesStore((s) => s.mute)
  const [hovered, setHovered] = useState(false)

  useEffect(() => {
    if (hovered) return
    const timer = setTimeout(() => dismiss(toast.id), NOTICE_TOAST_MS)
    return () => clearTimeout(timer)
  }, [hovered, toast.id, toast.seq, dismiss])

  if (!notice) return null
  const name = sourceName(notice.source, apps)
  const project = projectLabel(notice.projectId, projects)
  return (
    <div
      className={`${styles.toast} ${styles.notice}`}
      data-testid="notice-toast"
      data-source={notice.source}
      data-actionable={notice.action ? true : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className={styles.noticeMain}
        data-testid="notice-toast-open"
        onClick={() => {
          dismiss(toast.id)
          void openNotice(notice)
        }}
      >
        <span className={styles.noticeHead}>
          <span className={styles.noticeSource} data-testid="notice-toast-source">
            {name}
          </span>
          {project !== null && (
            <span className={styles.noticeProject} data-testid="notice-toast-project">
              {project}
            </span>
          )}
        </span>
        <span className={styles.noticeTitle} data-testid="notice-toast-title">
          {notice.title}
        </span>
        {notice.body && (
          <span className={styles.noticeBody} data-testid="notice-toast-body">
            {notice.body}
          </span>
        )}
      </button>
      {toast.more > 0 && (
        <button
          type="button"
          className={styles.noticeMore}
          data-testid="notice-toast-more"
          onClick={() => {
            dismiss(toast.id)
            void showNoticesPanelIn(moreTarget(toast))
          }}
        >
          {toast.more} more from {name}
        </button>
      )}
      <span className={styles.noticeActions}>
        <Tooltip lines={[`Mute notices from ${name}`, 'They still go to the Notices panel']}>
          <button
            type="button"
            className={styles.noticeIconBtn}
            aria-label={`Mute notices from ${name}`}
            data-testid="notice-toast-mute"
            onClick={() => mute(notice.source)}
          >
            <MuteGlyph />
          </button>
        </Tooltip>
        <button
          type="button"
          className={styles.noticeIconBtn}
          aria-label="Dismiss"
          data-testid="notice-toast-dismiss"
          onClick={() => dismiss(toast.id)}
        >
          <CloseGlyph />
        </button>
      </span>
    </div>
  )
}

export function NoticeToasts(): React.JSX.Element {
  const toasts = useNoticesStore((s) => s.toasts)
  return (
    <>
      {toasts.map((t) => (
        <NoticeToastView key={t.id} toast={t} />
      ))}
    </>
  )
}
