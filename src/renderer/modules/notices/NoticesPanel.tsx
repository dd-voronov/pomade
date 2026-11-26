// Pomade — E-032: the Notices panel (built-in side panel): every notice posted this run, newest
// first — where a notice is found again after its toast fades. Showing the panel reads them all
// (the strip badge counts the unread). A click on a notice runs its action; its × (on hover) deletes
// it. Cmd-click and Shift-click select notices (the file tree's click matrix); Delete or Backspace,
// or the selection bar's Delete, deletes them; the header's trash icon deletes all. Muted sources
// are listed at the bottom, each with Unmute.

import { useEffect, useState } from 'react'

import { relativeTime } from '@shared/git-history'
import { Tooltip } from '../../components/Tooltip'
import { useAppSettingsStore } from '../../stores/app-settings-store'
import { useAppsStore } from '../../stores/apps-store'
import { useNoticesStore } from '../../stores/notices-store'
import { useSidePanelStore } from '../../stores/side-panel-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { openNotice } from './NoticeToasts'
import { CloseGlyph } from './notice-glyphs'
import { NOTICES_PANEL_KEY, projectLabel, selectOnClick, type Notice, type NoticeSelection } from './notice-model'
import { sourceName } from './source-name'
import styles from './NoticesPanel.module.css'

/** The Notices panel's strip key. */
export const NOTICES_PANEL = NOTICES_PANEL_KEY

/** Strip icon: a bell. */
export function NoticesGlyph(): React.JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round">
        <path d="M4.5 12.5v-4a4.5 4.5 0 0 1 9 0v4l1.25 1.5H3.25z" />
        <path d="M7.25 15.5a1.9 1.9 0 0 0 3.5 0" />
      </g>
    </svg>
  )
}

export function NoticesPanel(): React.JSX.Element {
  const notices = useNoticesStore((s) => s.notices)
  const markAllRead = useNoticesStore((s) => s.markAllRead)
  const clear = useNoticesStore((s) => s.clear)
  const remove = useNoticesStore((s) => s.remove)
  const apps = useAppsStore((s) => s.apps)
  const projects = useWorkspaceStore((s) => s.projects)
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId)
  const shownPanel = useSidePanelStore((s) => s.selectedByProject[activeProjectId])
  const collapsed = useAppSettingsStore((s) => s.layout.fileTreeCollapsed)
  const setCollapsed = useAppSettingsStore((s) => s.setFileTreeCollapsed)
  const visible = shownPanel === NOTICES_PANEL && !collapsed
  const muted = useAppSettingsStore((s) => s.mutedNoticeSources)
  const setMuted = useAppSettingsStore((s) => s.setNoticeSourceMuted)
  const [now, setNow] = useState(() => Date.now())
  const [selection, setSelection] = useState<NoticeSelection>({ ids: [], anchor: null })

  // Shown = read: what the panel lists while it is on screen is seen.
  useEffect(() => {
    if (visible && notices.some((n) => !n.read)) markAllRead()
  }, [visible, notices, markAllRead])

  // Relative times stay current while the panel is shown.
  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [visible, notices])

  const newestFirst = [...notices].reverse()
  // Only notices still listed count as selected (deleted or cleared ones drop out).
  const selected = selection.ids.filter((id) => notices.some((n) => n.id === id))
  const deleteSelected = (): void => {
    if (selected.length === 0) return
    remove(selected)
    setSelection({ ids: [], anchor: null })
  }
  const onRowClick = (e: React.MouseEvent, notice: Notice): void => {
    const next = selectOnClick({ ids: selected, anchor: selection.anchor }, notice.id, newestFirst.map((n) => n.id), {
      cmd: e.metaKey || e.ctrlKey,
      shift: e.shiftKey
    })
    if (next) {
      setSelection(next)
      return
    }
    setSelection({ ids: [], anchor: null })
    void openNotice(notice)
  }
  const onListKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length > 0) {
      e.preventDefault()
      deleteSelected()
    } else if (e.key === 'Escape' && selected.length > 0) {
      e.preventDefault()
      setSelection({ ids: [], anchor: null })
    }
  }
  return (
    <aside className={styles.panel} aria-label="Notices" data-testid="notices-panel">
      <div className={styles.header}>
        <span>Notices</span>
        <span className={styles.headerActions}>
          {notices.length > 0 && (
            <Tooltip lines={['Clear all notices']}>
              <button
                type="button"
                className={styles.headerBtn}
                aria-label="Clear all notices"
                data-testid="notices-clear"
                onClick={() => {
                  clear()
                  setSelection({ ids: [], anchor: null })
                }}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M3 4h8M5.5 4V2.75h3V4M4 4l.6 7.25h4.8L10 4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" />
                </svg>
              </button>
            </Tooltip>
          )}
          <Tooltip lines={['Collapse side panel (Cmd+Shift+B)']}>
            <button
              type="button"
              className={styles.headerBtn}
              aria-label="Collapse side panel"
              data-testid="notices-panel-collapse"
              onClick={() => void setCollapsed(true)}
            >
              «
            </button>
          </Tooltip>
        </span>
      </div>
      <div className={styles.body}>
        {newestFirst.length === 0 ? (
          <div className={styles.empty} data-testid="notices-empty">
            No notices yet. What apps and Pomade report shows up here.
          </div>
        ) : (
          <>
            {selected.length > 0 && (
              <div className={styles.selectionBar} data-testid="notices-selection">
                <span data-testid="notices-selection-count">{selected.length} selected</span>
                <button type="button" className={styles.smallBtn} data-testid="notices-delete-selected" onClick={deleteSelected}>
                  Delete
                </button>
              </div>
            )}
            <ul className={styles.list} data-testid="notices-list" onKeyDown={onListKeyDown}>
              {newestFirst.map((n) => (
                <li key={n.id} className={styles.item}>
                  <button
                    type="button"
                    className={styles.row}
                    data-testid="notice-row"
                    data-source={n.source}
                    data-unread={!n.read || undefined}
                    data-actionable={n.action ? true : undefined}
                    data-selected={selected.includes(n.id) || undefined}
                    onClick={(e) => onRowClick(e, n)}
                  >
                    <span className={styles.meta}>
                      <span className={styles.who}>
                        <span className={styles.source}>{sourceName(n.source, apps)}</span>
                        {projectLabel(n.projectId, projects) !== null && (
                          <span className={styles.project} data-testid="notice-row-project">
                            {projectLabel(n.projectId, projects)}
                          </span>
                        )}
                      </span>
                      <span className={styles.time}>{relativeTime(n.postedAt, now)}</span>
                    </span>
                    <span className={styles.title} data-testid="notice-row-title">
                      {n.title}
                    </span>
                    {n.body && <span className={styles.body3}>{n.body}</span>}
                  </button>
                  <Tooltip lines={['Delete this notice']}>
                    <button
                      type="button"
                      className={styles.rowDelete}
                      aria-label="Delete this notice"
                      data-testid="notice-row-delete"
                      onClick={() => remove([n.id])}
                    >
                      <CloseGlyph />
                    </button>
                  </Tooltip>
                </li>
              ))}
            </ul>
          </>
        )}
        {muted.length > 0 && (
          <section className={styles.muted} data-testid="notices-muted">
            <div className={styles.mutedTitle}>Muted</div>
            {muted.map((source) => (
              <div key={source} className={styles.mutedRow} data-testid={`notices-muted-${source}`}>
                <span className={styles.source}>{sourceName(source, apps)}</span>
                <button
                  type="button"
                  className={styles.smallBtn}
                  data-testid={`notices-unmute-${source}`}
                  onClick={() => void setMuted(source, false)}
                >
                  Unmute
                </button>
              </div>
            ))}
          </section>
        )}
      </div>
    </aside>
  )
}
