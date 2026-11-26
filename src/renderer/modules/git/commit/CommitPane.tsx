// Pomade — E-037: the commit-details tab. The full message (subject as the title, the rest rendered
// as markdown), author, date, a copyable hash, and the files changed against the first parent with
// their letters and +/- counts; a file opens the comparison tab parent ↔ commit through the preview
// slot, and its right-click menu opens that comparison in a tab that stays (T-228) or the file as it
// is in this commit in its own tab (T-226; a deleted file has no such version, so its menu is the
// comparison alone). Read once when the
// pane mounts (a commit never changes); a commit that is gone renders a notice, never a crash.

import { useEffect, useRef, useState } from 'react'

import {
  commitTimestamp,
  isMerge,
  relativeTime,
  type CommitDetails,
  type CommitFile,
  type CommitFileStatus
} from '@shared/git-history'
import type { CommitTab, Tab } from '@shared/types'
import { joinRel } from '@shared/git-state'
import { ContextMenu } from '../../../components/ContextMenu'
import { Tooltip } from '../../../components/Tooltip'
import { useToast } from '../../../hooks/useToast'
import { cleanIpcError } from '../../../lib/ipc-errors'
import { useTabsStore } from '../../../stores/tabs-store'
import { useGitStateStore, useGitStateSubscription } from '../git-state-store'
import { FileIcon } from '../../filetree/icons'
import { CopyGlyph } from '../icons'
import { openCommitFile } from '../open-compare'
import { openVersionTab } from '../history/open-version'
import { OPEN_DELETION_LABEL, openInNewTabItem } from '../row-menu'
import { CommitMessage } from './CommitMessage'
import styles from './CommitPane.module.css'

const LETTER: Record<CommitFileStatus, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }
const HINT: Record<CommitFileStatus, string> = {
  added: 'A — Added in this commit',
  modified: 'M — Modified in this commit',
  deleted: 'D — Deleted in this commit',
  renamed: 'R — Renamed in this commit'
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** The message minus its subject line (the pane's title already shows the subject). */
function bodyOf(message: string): string {
  const nl = message.indexOf('\n')
  return nl < 0 ? '' : message.slice(nl + 1).replace(/^\s*\n/, '')
}

function FileRow({
  file,
  onOpen,
  onMenu
}: {
  file: CommitFile
  onOpen: (preview: boolean) => void
  onMenu: (x: number, y: number) => void
}): React.JSX.Element {
  const slash = file.path.lastIndexOf('/')
  const name = slash < 0 ? file.path : file.path.slice(slash + 1)
  const dir = slash < 0 ? '' : file.path.slice(0, slash)
  const hint = file.status === 'renamed' && file.from ? `R — Renamed from ${file.from}` : HINT[file.status]
  return (
    <div
      role="button"
      tabIndex={0}
      className={styles.fileRow}
      data-testid={`commit-file-${file.path}`}
      data-status={LETTER[file.status]}
      onClick={() => onOpen(true)}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(false)
      }}
    >
      <Tooltip lines={[hint]}>
        <span className={`${styles.letter} ${styles[`tint_${file.status}`]}`}>{LETTER[file.status]}</span>
      </Tooltip>
      <span className={styles.fileIcon}>
        <FileIcon name={name} />
      </span>
      <span className={`${styles.fileName} ${styles[`tint_${file.status}`]}`}>{name}</span>
      {dir && <span className={styles.fileDir}>{dir}</span>}
      <span className={styles.stat} data-testid={`commit-file-stat-${file.path}`}>
        {file.added === null ? (
          <span className={styles.binary}>binary</span>
        ) : file.status === 'renamed' && file.added === 0 && file.removed === 0 ? (
          <span className={styles.binary}>moved, unchanged</span>
        ) : (
          <>
            <span className={styles.added}>+{file.added}</span>
            <span className={styles.removed}>−{file.removed}</span>
          </>
        )}
      </span>
    </div>
  )
}

export function CommitPane({ tab }: { tab: Tab }): React.JSX.Element | null {
  const t = tab as CommitTab
  useGitStateSubscription()
  const repoName = useGitStateStore((s) => s.snapshot.repos.find((r) => r.root === t.repo)?.name)
  const commitPreview = useTabsStore((s) => s.commitPreview)
  const toast = useToast()
  const [details, setDetails] = useState<CommitDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; file: CommitFile } | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    setDetails(null)
    setError(null)
    window.pomade.git.commit(t.repo, t.hash).then(
      (d) => {
        if (!cancelled) setDetails(d)
      },
      (err: unknown) => {
        if (!cancelled) setError(cleanIpcError(err))
      }
    )
    return () => {
      cancelled = true
    }
  }, [t.repo, t.hash])

  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  const copyHash = (): void => {
    void window.pomade.app.clipboardWrite(t.hash).then(() => {
      setCopied(true)
      clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 1500)
    })
  }

  const short = t.hash.slice(0, 7)
  const openFile = (d: CommitDetails, f: CommitFile, preview: boolean): void => {
    openCommitFile(t.projectId, t.repo, d, f, { preview }).catch((err: unknown) =>
      toast(`Could not open the comparison: ${cleanIpcError(err)}`, 'error')
    )
  }
  const openVersion = (d: CommitDetails, f: CommitFile): void => {
    const path = joinRel(t.repo, f.path)
    openVersionTab(t.projectId, path, { kind: 'rev', repo: t.repo, rev: d.hash, path }).catch((err: unknown) =>
      toast(`Could not open this version: ${cleanIpcError(err)}`, 'error')
    )
  }

  let body: React.ReactNode
  if (error) {
    body = (
      <div className={styles.notice} data-testid="commit-error">
        <div className={styles.noticeTitle}>Commit {short} cannot be shown</div>
        <p>{error}</p>
        <p className={styles.noticeHint}>
          {repoName ? `Repository: ${repoName}` : 'Its repository is no longer in this workspace.'}
        </p>
      </div>
    )
  } else if (!details) {
    body = (
      <div className={styles.loading} data-testid="commit-loading">
        Loading commit…
      </div>
    )
  } else {
    const added = details.files.reduce((n, f) => n + (f.added ?? 0), 0)
    const removed = details.files.reduce((n, f) => n + (f.removed ?? 0), 0)
    const total = details.totalFiles ?? details.files.length
    const merge = isMerge(details)
    body = (
      <article className={styles.article}>
        <header className={styles.head}>
          {merge && (
            <Tooltip lines={[`A merge: the files below are what it brought in (against ${details.parents[0].slice(0, 7)})`]}>
              <span className={styles.mergeTag} data-testid="commit-merge-tag">
                Merge
              </span>
            </Tooltip>
          )}
          <h1 className={styles.subject} data-testid="commit-subject">
            {details.subject}
          </h1>
          <div className={styles.meta}>
            <Tooltip lines={[details.authorEmail || details.author]}>
              <span className={styles.author} data-testid="commit-author">
                {details.author}
              </span>
            </Tooltip>
            <span className={styles.sep} aria-hidden="true">
              ·
            </span>
            <Tooltip lines={[relativeTime(details.date, Date.now())]}>
              <span data-testid="commit-date">{commitTimestamp(details.date)}</span>
            </Tooltip>
            {repoName && (
              <>
                <span className={styles.sep} aria-hidden="true">
                  ·
                </span>
                <span className={styles.repo}>{repoName}</span>
              </>
            )}
            <Tooltip lines={[copied ? 'Copied' : `Copy the full hash ${details.hash}`]}>
              <button
                type="button"
                className={styles.hash}
                data-testid="commit-hash-copy"
                data-copied={copied || undefined}
                aria-label={`Copy commit hash ${details.hash}`}
                onClick={copyHash}
              >
                <span className={styles.hashText} data-testid="commit-hash">
                  {copied ? 'Copied' : short}
                </span>
                <CopyGlyph />
              </button>
            </Tooltip>
          </div>
        </header>

        <CommitMessage text={bodyOf(details.message)} />

        <section className={styles.files} data-testid="commit-files">
          <div className={styles.filesHead}>
            <span className={styles.filesTitle}>Files changed</span>
            <span className={styles.filesCount} data-testid="commit-files-count">
              {total}
            </span>
            <span className={styles.filesStat}>
              <span className={styles.added}>+{added}</span>
              <span className={styles.removed}>−{removed}</span>
            </span>
          </div>
          {details.files.length === 0 ? (
            <div className={styles.loading}>No file changes.</div>
          ) : (
            details.files.map((f) => (
              <FileRow
                key={f.path}
                file={f}
                onOpen={(preview) => openFile(details, f, preview)}
                onMenu={(x, y) => setMenu({ x, y, file: f })}
              />
            ))
          )}
          {menu && (
            <ContextMenu
              x={menu.x}
              y={menu.y}
              onClose={() => setMenu(null)}
              testId="commit-file-menu"
              data={{ 'data-path': menu.file.path }}
              items={
                menu.file.status === 'deleted'
                  ? [openInNewTabItem(() => openFile(details, menu.file, false), OPEN_DELETION_LABEL)]
                  : [
                      openInNewTabItem(() => openFile(details, menu.file, false)),
                      {
                        label: 'Open this version in a tab',
                        testId: 'commit-file-menu-open-tab',
                        onSelect: () => openVersion(details, menu.file)
                      }
                    ]
              }
            />
          )}
          {details.totalFiles !== undefined && (
            <div className={styles.loading}>
              Only the first {plural(details.files.length, 'file', 'files')} of {details.totalFiles} are listed.
            </div>
          )}
        </section>
      </article>
    )
  }

  return (
    <div
      className={styles.pane}
      data-testid="commit-pane"
      data-hash={t.hash}
      onMouseDown={() => commitPreview(t.projectId, t.id)}
    >
      {body}
    </div>
  )
}
