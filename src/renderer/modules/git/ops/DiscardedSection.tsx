// Pomade — E-039: the repo view's Discarded section — files whose changes were discarded here in
// the last 7 days, newest first. A row opens the document (even when the file is gone) with its
// Document history showing, where the discarded content is a row to compare or restore.
// T-310: a row shows only while the file is not back (main's `discardedFiles`: it holds the kept
// copy, or it was restored from Document history and saved since); a file that is gone again
// shows again. **Forget** (asked once, inline) deletes the file's kept copies.

import { useEffect, useMemo, useState } from 'react'

import { versionTime } from '@shared/doc-history'
import { repoOfPath, type RepoState } from '@shared/git-state'
import type { DiscardedFile } from '@shared/recovery'
import type { Id } from '@shared/types'
import { Tooltip } from '../../../components/Tooltip'
import { useToast } from '../../../hooks/useToast'
import { cleanIpcError } from '../../../lib/ipc-errors'
import { FileIcon } from '../../filetree/icons'
import { openDocHistory } from '../history/doc-history-store'
import { useGitStateStore } from '../git-state-store'
import { useGitPanelStore } from '../panel/git-panel-store'
import { Chevron, ForgetGlyph } from '../icons'
import { repoKeyOf } from './CommitComposer'
import { useGitOpsStore } from './git-ops-store'
import panel from '../panel/GitPanel.module.css'

export function DiscardedSection({ repo, projectId }: { repo: RepoState; projectId: Id }): React.JSX.Element | null {
  const nonce = useGitOpsStore((s) => s.draftsNonce)
  const snapshot = useGitStateStore((s) => s.snapshot)
  const collapsed = useGitPanelStore((s) => s.toggles[repo.root]?.discardedCollapsed === true)
  const setToggle = useGitPanelStore((s) => s.setToggle)
  const toast = useToast()
  const [rows, setRows] = useState<DiscardedFile[]>([])
  const [confirming, setConfirming] = useState<string | null>(null)
  // Re-asked whenever the repo's files change (a save, a delete, a restore) or drafts were kept.
  const key = repoKeyOf(repo)

  useEffect(() => {
    let cancelled = false
    window.pomade.recovery.discardedFiles().then(
      (list) => {
        if (!cancelled) setRows(list)
      },
      () => {
        if (!cancelled) setRows([])
      }
    )
    return () => {
      cancelled = true
    }
  }, [nonce, key])

  const files = useMemo(() => rows.filter((r) => repoOfPath(snapshot, r.path)?.root === repo.root), [rows, snapshot, repo.root])

  const forget = (path: string): void => {
    setConfirming(null)
    window.pomade.recovery.forgetDiscarded(path).then(
      () => useGitOpsStore.setState((s) => ({ draftsNonce: s.draftsNonce + 1 })),
      (err: unknown) => toast(`Could not forget the kept copy: ${cleanIpcError(err)}`, 'error')
    )
  }

  if (files.length === 0) return null
  const now = Date.now()
  return (
    <section className={panel.section} data-testid="git-discarded">
      <div className={panel.sectionHead}>
        <button
          type="button"
          className={panel.sectionToggle}
          aria-expanded={!collapsed}
          data-testid="git-discarded-toggle"
          onClick={() => setToggle(repo.root, { discardedCollapsed: !collapsed })}
        >
          <span className={`${panel.chevron} ${collapsed ? '' : panel.chevronOpen}`}>
            <Chevron />
          </span>
          <span className={panel.sectionTitle}>Discarded</span>
          <span className={panel.sectionCount}>{files.length}</span>
        </button>
      </div>
      {!collapsed &&
        files.map((f) => {
          const inRepo = repo.root ? f.path.slice(repo.root.length + 1) : f.path
          const slash = inRepo.lastIndexOf('/')
          const name = slash < 0 ? inRepo : inRepo.slice(slash + 1)
          const dir = slash < 0 ? '' : inRepo.slice(0, slash)
          if (confirming === f.path) {
            return (
              <div
                key={f.path}
                className={`${panel.fileRow} ${panel.forgetRow}`}
                data-testid={`git-discarded-${f.path}`}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setConfirming(null)
                }}
              >
                <span className={panel.forgetText}>
                  Forget the kept {f.count === 1 ? 'copy' : 'copies'} of {name}?
                </span>
                <button type="button" className={panel.forgetBtn} data-variant="danger" autoFocus data-testid="git-discarded-forget-confirm" onClick={() => forget(f.path)}>
                  Forget
                </button>
                <button type="button" className={panel.forgetBtn} data-testid="git-discarded-forget-cancel" onClick={() => setConfirming(null)}>
                  Keep
                </button>
              </div>
            )
          }
          return (
            <div
              key={f.path}
              role="button"
              tabIndex={0}
              className={panel.fileRow}
              data-testid={`git-discarded-${f.path}`}
              title={`Discarded ${versionTime(f.at, now)} — kept 7 days. Open its Document history to compare or restore.`}
              onClick={() => openDocHistory(projectId, f.path)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') openDocHistory(projectId, f.path)
              }}
            >
              <span className={panel.fileIcon}>
                <FileIcon name={name} />
              </span>
              <span className={panel.fileName}>{name}</span>
              {dir && <span className={panel.fileDir}>{dir}</span>}
              <span className={panel.fileWhen}>{versionTime(f.at, now)}</span>
              <Tooltip lines={['Forget…', 'Delete the kept copy — it leaves Document history too.']}>
                <button
                  type="button"
                  className={`${panel.rowAction} ${panel.rowActionEnd}`}
                  aria-label={`Forget the kept copy of ${name}`}
                  data-testid={`git-discarded-forget-${f.path}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirming(f.path)
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <ForgetGlyph />
                </button>
              </Tooltip>
            </div>
          )
        })}
    </section>
  )
}
