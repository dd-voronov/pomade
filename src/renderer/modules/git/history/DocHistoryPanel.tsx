// Pomade — E-038: the History panel docked in a doc pane. One list of the document's versions in
// groups, each under a sub-header that folds (T-223): Current (unsaved edits, and the saved file as
// one `Saved · <time>` row that stands in for the newest local version holding its text and says
// where git stands), Discarded, Local versions (the local-history snapshots) and Commits, newest
// first within each. A `current` mark sits on the row that is what the editor holds.
// A click compares a version with the current document in a comparison tab — always, even when the
// two hold the same text; two ticked rows — in any groups — compare with each other; Restore puts
// a version into the editor as an unsaved edit. A local version kept under another path (before a
// rename) is restored under that path: after a confirm the document is renamed back through the
// workspace's own rename (tabs, tree and local history follow), then its text goes in. A
// right-click opens the row's menu (T-226): open the version in its own tab, compare, restore,
// copy a commit's hash.

import { useEffect, useMemo, useState } from 'react'

import {
  currentRow,
  draftReasonLabel,
  earlierName,
  earlierPath,
  EMPTY_LINE,
  foldedGroups,
  GROUP_TITLE,
  groupRows,
  NO_REPO_LINE,
  restoreUnderTaken,
  savedMeta,
  versionTime,
  type HistoryRow
} from '@shared/doc-history'
import { relativeTime } from '@shared/git-history'
import { formatBytes, originLabel } from '@shared/local-history'
import type { Id } from '@shared/types'
import { ContextMenu, type MenuItem } from '../../../components/ContextMenu'
import { CheckToggle } from '../../../components/CheckToggle'
import { Tooltip } from '../../../components/Tooltip'
import { useToast } from '../../../hooks/useToast'
import { cleanIpcError } from '../../../lib/ipc-errors'
import { useAppSettingsStore } from '../../../stores/app-settings-store'
import { statPath } from '../../editor/doc-io'
import { useGitOpsStore } from '../ops/git-ops-store'
import { useTabsStore } from '../../../stores/tabs-store'
import { Chevron } from '../icons'
import { openPair, openRow, readRowText, rowVersion } from './history-actions'
import { openVersionTab } from './open-version'
import { useDocHistory } from './use-doc-history'
import styles from './DocHistoryPanel.module.css'

export type RestoreOutcome = 'restored' | 'same' | 'unavailable'

/** The stable id a row's test ids carry. */
export function rowTestId(row: HistoryRow): string {
  switch (row.kind) {
    case 'commit':
      return `commit-${row.commit.hash.slice(0, 7)}`
    case 'draft':
      return `draft-${row.draftId}`
    case 'discarded':
      return `discarded-${row.draftId}`
    case 'snapshot':
      return `snapshot-${row.snapshotId}`
    default:
      return row.kind
  }
}

function rowTexts(row: HistoryRow, now: number, path: string): { title: string; meta: string } {
  switch (row.kind) {
    case 'unsaved':
      return { title: 'Unsaved edits', meta: 'saved ↔ unsaved' }
    case 'draft':
      return {
        title: `Discarded draft · ${versionTime(row.at, now)}`,
        meta: draftReasonLabel(row.reason)
      }
    case 'discarded':
      return {
        title: `Discarded change · ${versionTime(row.at, now)}`,
        meta: row.staged ? 'its staged version, discarded in the Git panel' : 'discarded in the Git panel'
      }
    case 'snapshot': {
      const meta = row.sameText ? 'same text — only the name changed' : `local version · ${formatBytes(row.size)}`
      // A version kept before a rename says under which name (the rename's own row already does).
      const then = row.pathThen && row.pathThen !== path && row.origin !== 'renamed' ? row.pathThen : null
      return {
        title: `${versionTime(row.at, now)} · ${originLabel(row.origin, row.from, path)}`,
        meta: then ? `${meta} · as ${earlierName(then, path)}` : meta
      }
    }
    case 'saved':
      return { title: `Saved · ${versionTime(row.at, now)}`, meta: savedMeta(row) }
    case 'commit': {
      const c = row.commit
      const merge = c.parents.length > 1 ? ' · merge' : ''
      return {
        title: c.subject || '(no message)',
        meta: `${c.hash.slice(0, 7)} · ${c.author} · ${relativeTime(c.date, now)}${merge}`
      }
    }
  }
}

/** T-310 — a restore into the document: its kept git-discard copies note it, so the Git panel's
 *  Discarded row hides once the file is saved. Best effort — a failure only leaves the row. */
function noteRestored(path: string): void {
  window.pomade.recovery.markRestored(path).then(
    () => useGitOpsStore.setState((s) => ({ draftsNonce: s.draftsNonce + 1 })),
    () => {}
  )
}

export function DocHistoryPanel({
  projectId,
  path,
  dirty,
  draftsNonce,
  onRestore,
  onConfirmRestoreUnder,
  onClose
}: {
  projectId: Id
  path: string
  dirty: boolean
  draftsNonce: number
  onRestore: (text: string) => Promise<RestoreOutcome>
  /** Asks whether to restore the document under `earlier`, its path in that version. */
  onConfirmRestoreUnder: (earlier: string) => Promise<boolean>
  onClose: () => void
}): React.JSX.Element {
  const toast = useToast()
  const savedFolds = useAppSettingsStore((s) => s.docHistoryFolded)
  const folded = useMemo(() => foldedGroups(savedFolds), [savedFolds])
  const setFolded = useAppSettingsStore((s) => s.setDocHistoryGroupFolded)
  const [all, setAll] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [menu, setMenu] = useState<{ x: number; y: number; row: HistoryRow } | null>(null)
  const history = useDocHistory({ path, dirty, all, draftsNonce })
  const { rows, repo } = history
  const ctx = useMemo(() => ({ path, repo }), [path, repo])
  const now = Date.now()

  // A pick that left the list (the list reloaded) is dropped.
  useEffect(() => {
    setPicked((p) => {
      const kept = p.filter((id) => rows.some((r) => r.id === id))
      return kept.length === p.length ? p : kept
    })
  }, [rows])

  const togglePick = (id: string): void =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]))

  const fail = (what: string, err: unknown): void => toast(`${what}: ${cleanIpcError(err)}`, 'error')

  const open = (row: HistoryRow): void => {
    openRow(projectId, row, ctx).catch((err: unknown) => fail('Could not open the comparison', err))
  }

  const restore = async (row: HistoryRow): Promise<void> => {
    try {
      const earlier = earlierPath(row, ctx)
      if (earlier !== null) {
        await restoreUnder(row, earlier)
        return
      }
      const text = await readRowText(row, ctx)
      const outcome = await onRestore(text)
      if (outcome === 'restored') noteRestored(path)
      const { title } = rowTexts(row, Date.now(), path)
      if (outcome === 'restored') toast(`Restored “${title}” as an unsaved edit — Cmd+Z undoes it.`, 'info')
      else if (outcome === 'same') toast('The document already has this version.', 'info')
      else toast('The document is not ready to restore into.', 'error')
    } catch (err) {
      fail('Could not restore', err)
    }
  }

  /** A version kept under another path: rename the document back, then put its text in. The text
   *  is read first — the version's store path follows the rename. */
  const restoreUnder = async (row: HistoryRow, earlier: string): Promise<void> => {
    const name = earlierName(earlier, path)
    const taken = (): Promise<boolean> => statPath(earlier).then(() => true, () => false)
    if (await taken()) {
      toast(restoreUnderTaken(path, earlier), 'error')
      return
    }
    if (!(await onConfirmRestoreUnder(earlier))) return
    const text = await readRowText(row, ctx)
    if (await taken()) {
      toast(restoreUnderTaken(path, earlier), 'error')
      return
    }
    await window.pomade.fs.rename(path, earlier)
    useTabsStore.getState().retargetPaths(path, earlier)
    const outcome = await onRestore(text)
    if (outcome === 'restored') noteRestored(earlier)
    if (outcome === 'restored') toast(`Renamed back to ${name}; its text is in as an unsaved edit — Cmd+Z undoes the text.`, 'info')
    else if (outcome === 'same') toast(`Renamed back to ${name}; the text is already this version’s.`, 'info')
    else toast(`Renamed back to ${name}, but the document is not ready to restore the text into.`, 'error')
  }

  const groups = groupRows(rows)
  const current = currentRow(rows)

  const canRestoreRow = (row: HistoryRow): boolean =>
    row.kind === 'commit' || row.kind === 'snapshot' || row.kind === 'draft' || row.kind === 'discarded' || (row.kind === 'saved' && dirty)

  const openInTab = (row: HistoryRow): void => {
    const source = rowVersion(row, ctx)
    if (!source) return
    openVersionTab(projectId, path, source).catch((err: unknown) => fail('Could not open this version', err))
  }

  const menuItems = (row: HistoryRow): MenuItem[] => {
    const items: MenuItem[] = []
    if (rowVersion(row, ctx)) {
      items.push({ label: 'Open this version in a tab', testId: 'history-menu-open-tab', onSelect: () => openInTab(row) })
    }
    items.push({
      label: row.kind === 'unsaved' ? 'Compare with the saved file' : 'Compare with your document',
      testId: 'history-menu-compare',
      onSelect: () => open(row)
    })
    if (canRestoreRow(row)) {
      items.push({ label: 'Restore', testId: 'history-menu-restore', onSelect: () => void restore(row) })
    }
    if (row.kind === 'commit') {
      const hash = row.commit.hash
      items.push(
        { separator: true },
        {
          label: 'Copy hash',
          testId: 'history-menu-copy-hash',
          onSelect: () => {
            window.pomade.app.clipboardWrite(hash).then(
              () => toast(`Copied ${hash.slice(0, 7)}`, 'info'),
              (err: unknown) => fail('Could not copy the hash', err)
            )
          }
        }
      )
    }
    return items
  }

  const renderRow = (row: HistoryRow): React.JSX.Element => {
    const id = rowTestId(row)
    const { title, meta } = rowTexts(row, now, path)
    const canRestore = canRestoreRow(row)
    const earlier = earlierPath(row, ctx)
    const isPicked = picked.includes(row.id)
    const isCurrent = current?.id === row.id
    return (
      <div
        key={row.id}
        className={`${styles.row} ${isPicked ? styles.rowPicked : ''}`}
        role="listitem"
        tabIndex={0}
        data-testid={`history-row-${id}`}
        data-kind={row.kind}
        data-origin={row.kind === 'snapshot' ? row.origin : undefined}
        data-picked={isPicked || undefined}
        data-current={isCurrent || undefined}
        title={row.kind === 'commit' ? row.commit.subject : row.kind === 'snapshot' && row.from ? `${row.from} → ${path}` : undefined}
        onClick={(e) => {
          // macOS delivers a Ctrl+click as a right-click too: the menu opens, nothing is ticked.
          if (e.ctrlKey && navigator.platform.startsWith('Mac')) return
          if (e.metaKey || e.ctrlKey) togglePick(row.id)
          else open(row)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, row })
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter') open(row)
          else if (e.key === ' ') {
            e.preventDefault()
            togglePick(row.id)
          }
        }}
      >
        <input
          type="checkbox"
          className={styles.pick}
          data-testid={`history-pick-${id}`}
          aria-label={`Pick ${title} to compare`}
          checked={isPicked}
          onClick={(e) => e.stopPropagation()}
          onChange={() => togglePick(row.id)}
        />
        <span
          className={styles.glyph}
          data-kind={row.kind}
          data-git={row.kind === 'saved' ? row.git.state : undefined}
          aria-hidden="true"
        />
        <span className={styles.text}>
          <span className={styles.titleLine}>
            <span className={styles.title} data-testid={`history-title-${id}`}>
              {title}
            </span>
            {isCurrent && (
              <span className={styles.currentMark} data-testid={`history-current-${id}`}>
                current
              </span>
            )}
          </span>
          <span className={styles.meta} data-testid={`history-meta-${id}`}>
            {meta}
          </span>
        </span>
        {canRestore && (
          <button
            type="button"
            className={styles.restore}
            data-testid={`history-restore-${id}`}
            title={
              earlier !== null
                ? `Rename the document back to ${earlierName(earlier, path)} and put this version into the editor as an unsaved edit`
                : 'Put this version into the editor as an unsaved edit (Cmd+Z undoes it)'
            }
            onClick={(e) => {
              e.stopPropagation()
              void restore(row)
            }}
          >
            Restore
          </button>
        )}
      </div>
    )
  }

  return (
    <aside
      className={styles.panel}
      data-testid="doc-history"
      data-repo={repo ?? ''}
      aria-label="Document history"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          // Escape with the row menu open closes the menu only.
          if (menu) setMenu(null)
          else onClose()
        }
      }}
    >
      <div className={styles.header}>
        <span className={styles.headerTitle}>History</span>
        <span className={styles.headerActions}>
          {repo !== null && (
            <CheckToggle
              checked={all}
              onChange={setAll}
              label="Show all commits"
              tooltip={['Every commit that touched the file, not only the branch’s own line']}
              testId="history-show-all"
            />
          )}
          <Tooltip lines={['Close history']}>
            <button type="button" className={styles.closeBtn} data-testid="history-close" aria-label="Close history" onClick={onClose}>
              ×
            </button>
          </Tooltip>
        </span>
      </div>

      {picked.length === 2 ? (
        <div className={styles.pickBar} data-testid="history-pick-bar">
          <span>2 versions picked</span>
          <button
            type="button"
            className={styles.pickBtn}
            data-testid="history-compare-picked"
            onClick={() => {
              openPair(projectId, rows, picked[0], picked[1], ctx).catch((err: unknown) =>
                fail('Could not open the comparison', err)
              )
            }}
          >
            Compare
          </button>
          <button type="button" className={styles.pickBtn} data-testid="history-clear-picks" onClick={() => setPicked([])}>
            Clear
          </button>
        </div>
      ) : (
        <div className={styles.hint} data-testid="history-hint">
          Click a version to compare it with your document; right-click for more. Tick two to compare them
          with each other.
        </div>
      )}

      <div className={styles.list} data-testid="history-list">
        {groups.map(({ group, rows: groupRowsOf }) => {
          const isFolded = folded.includes(group)
          return (
            <section key={group} className={styles.group} data-testid={`history-group-${group}`} data-folded={isFolded || undefined}>
              <button
                type="button"
                className={styles.groupHead}
                aria-expanded={!isFolded}
                data-testid={`history-group-${group}-toggle`}
                onClick={() => void setFolded(group, !isFolded)}
              >
                <span className={`${styles.chevron} ${isFolded ? '' : styles.chevronOpen}`}>
                  <Chevron />
                </span>
                <span className={styles.groupTitle}>{GROUP_TITLE[group]}</span>
                <span className={styles.groupCount} data-testid={`history-group-${group}-count`}>
                  {groupRowsOf.length}
                  {group === 'commits' && history.more ? '+' : ''}
                </span>
              </button>
              {!isFolded && (
                <div role="list">
                  {groupRowsOf.map(renderRow)}
                  {group === 'commits' && history.more && !history.loading && (
                    <button type="button" className={styles.more} data-testid="history-more" onClick={history.loadMore}>
                      Show older
                    </button>
                  )}
                </div>
              )}
            </section>
          )
        })}

        {history.loading && (
          <div className={styles.note} data-testid="history-loading">
            Loading…
          </div>
        )}
        {history.error && (
          <div className={styles.note} data-testid="history-error">
            Could not read the history: {history.error}
          </div>
        )}
        {!history.loading && !history.error && rows.length === 0 && repo !== null && (
          <div className={styles.note} data-testid="history-empty">
            {EMPTY_LINE}
          </div>
        )}
        {repo === null && (
          <div className={styles.note} data-testid="history-no-repo">
            {NO_REPO_LINE}
          </div>
        )}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.row)}
          onClose={() => setMenu(null)}
          testId="history-menu"
          data={{ 'data-row': rowTestId(menu.row) }}
          ariaLabel="Version actions"
        />
      )}
    </aside>
  )
}
