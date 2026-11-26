// Pomade — T-224: a version chip's list. The compared document's History rows, in their groups, one
// line each, on the shared Popover under the chip: ✓ on the side's own version, a `left` / `right`
// mark on the other side's. A pick puts that version on the side (or swaps the sides when it is the
// other side's) and closes the list; the row the editor holds is right-only, so it is disabled in
// the left list with the reason as its tooltip. Esc (a window listener while the list is up), a click
// outside or the chip again close it.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'

import type { CompareSource } from '@shared/compare'
import {
  currentRow,
  GROUP_TITLE,
  groupRows,
  NO_REPO_LINE,
  EMPTY_LINE,
  pickForSide,
  rowOnSide,
  type CompareSide,
  type HistoryRow
} from '@shared/doc-history'
import { isDocTabOf } from '@shared/doc-version'
import type { Id } from '@shared/types'
import { Popover } from '../../../components/Popover'
import { Tooltip } from '../../../components/Tooltip'
import { useToast } from '../../../hooks/useToast'
import { cleanIpcError } from '../../../lib/ipc-errors'
import { useTabsStore } from '../../../stores/tabs-store'
import { rowTestId, rowTexts } from '../history/DocHistoryPanel'
import { useDocHistory } from '../history/use-doc-history'
import { useGitOpsStore } from '../ops/git-ops-store'
import { setComparisonSides } from '../open-compare'
import historyStyles from '../history/DocHistoryPanel.module.css'
import styles from './VersionList.module.css'

const WIDTH = 400
const MAX_HEIGHT = 440
const MARGIN = 8

function Check(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.2 6.3l2.5 2.5 5.1-5.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function VersionList({
  projectId,
  tabId,
  side,
  path,
  pair,
  anchor,
  onClose
}: {
  projectId: Id
  tabId: Id
  side: CompareSide
  /** The compared document. */
  path: string
  pair: { left: CompareSource; right: CompareSource }
  /** The chip the list hangs under. */
  anchor: HTMLElement
  onClose: () => void
}): React.JSX.Element {
  const toast = useToast()
  const dirty = useTabsStore((s) => (s.tabsByProject[projectId] ?? []).some((x) => isDocTabOf(x, path) && x.kind === 'doc' && !!x.dirty))
  const draftsNonce = useGitOpsStore((s) => s.draftsNonce)
  const history = useDocHistory({ path, dirty, all: false, draftsNonce })
  const { rows, repo } = history
  const ctx = useMemo(() => ({ path, repo }), [path, repo])
  const panelRef = useRef<HTMLDivElement | null>(null)
  // Placed from the chip as it mounts (the chip is on screen while its list is open).
  const [place] = useState<CSSProperties>(() => {
    const r = anchor.getBoundingClientRect()
    const width = Math.min(WIDTH, window.innerWidth - 2 * MARGIN)
    const top = r.bottom + 4
    return {
      left: Math.min(Math.max(r.left, MARGIN), window.innerWidth - width - MARGIN),
      top,
      width,
      maxHeight: Math.min(MAX_HEIGHT, window.innerHeight - top - MARGIN)
    }
  })
  const other: CompareSide = side === 'left' ? 'right' : 'left'
  const now = Date.now()

  useEffect(() => {
    panelRef.current?.focus()
  }, [])
  // Esc closes the list wherever focus is (it lives only while its tab is on screen).
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const pick = (row: HistoryRow): void => {
    const p = pickForSide(row, side, pair, rows, ctx)
    if (p.kind === 'blocked') return
    onClose()
    if (p.kind === 'same') return
    if (p.kind === 'swap') toast('Sides swapped.', 'info')
    setComparisonSides(projectId, tabId, p.left, p.right).catch((err: unknown) =>
      toast(`Could not show this version: ${cleanIpcError(err)}`, 'error')
    )
  }

  const current = currentRow(rows)
  const shown = side === 'left' ? pair.left : pair.right
  const otherShown = side === 'left' ? pair.right : pair.left

  const moveFocus = (from: HTMLElement, step: 1 | -1): void => {
    const all = [...(panelRef.current?.querySelectorAll<HTMLElement>('[data-row]') ?? [])]
    all[all.indexOf(from) + step]?.focus()
  }

  const renderRow = (row: HistoryRow): React.JSX.Element => {
    const id = rowTestId(row)
    const { title, meta } = rowTexts(row, now, path)
    const on = rowOnSide(row, side, shown, rows, ctx)
    const onOther = rowOnSide(row, other, otherShown, rows, ctx)
    const p = pickForSide(row, side, pair, rows, ctx)
    const blocked = p.kind === 'blocked' ? p.reason : null
    const el = (
      <div
        key={row.id}
        className={`${styles.row} ${on ? styles.rowOn : ''} ${blocked ? styles.rowOff : ''}`}
        role="option"
        aria-selected={on}
        aria-disabled={blocked ? true : undefined}
        tabIndex={0}
        data-row=""
        data-testid={`compare-version-${id}`}
        data-kind={row.kind}
        data-on={on || undefined}
        data-disabled={blocked ? true : undefined}
        onClick={() => pick(row)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            pick(row)
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            moveFocus(e.currentTarget, e.key === 'ArrowDown' ? 1 : -1)
          }
        }}
      >
        <span
          className={historyStyles.glyph}
          data-kind={row.kind}
          data-git={row.kind === 'saved' ? row.git.state : undefined}
          aria-hidden="true"
        />
        <span className={styles.title}>{title}</span>
        {current?.id === row.id && <span className={historyStyles.currentMark}>current</span>}
        {onOther && (
          <span className={historyStyles.currentMark} data-testid={`compare-version-mark-${id}`}>
            {other}
          </span>
        )}
        <span className={styles.meta}>{meta}</span>
        <span className={styles.check}>{on && <Check />}</span>
      </div>
    )
    if (blocked) return <Tooltip key={row.id} lines={[blocked]}>{el}</Tooltip>
    return el
  }

  return (
    <Popover
      onDismiss={onClose}
      style={place}
      ariaLabel={side === 'left' ? 'Version on the left' : 'Version on the right'}
      testId="compare-versions"
      scrimTestId="compare-versions-scrim"
      panelClassName={styles.panel}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={styles.inner}
        data-side={side}
      >
        <div className={styles.head}>
          <span className={historyStyles.headerTitle}>{side === 'left' ? 'Left side' : 'Right side'}</span>
        </div>
        <div className={styles.list} role="listbox" aria-label="Versions">
          {groupRows(rows).map(({ group, rows: inGroup }) => (
            <section key={group} className={styles.group}>
              <div className={styles.groupHead}>
                <span className={historyStyles.groupTitle}>{GROUP_TITLE[group]}</span>
                <span className={historyStyles.groupCount}>
                  {inGroup.length}
                  {group === 'commits' && history.more ? '+' : ''}
                </span>
              </div>
              {inGroup.map(renderRow)}
              {group === 'commits' && history.more && !history.loading && (
                <button type="button" className={historyStyles.more} onClick={history.loadMore}>
                  Show older
                </button>
              )}
            </section>
          ))}
          {history.loading && <div className={historyStyles.note}>Loading…</div>}
          {history.error && <div className={historyStyles.note}>Could not read the history: {history.error}</div>}
          {!history.loading && !history.error && rows.length === 0 && repo !== null && (
            <div className={historyStyles.note}>{EMPTY_LINE}</div>
          )}
          {repo === null && <div className={historyStyles.note}>{NO_REPO_LINE}</div>}
        </div>
      </div>
    </Popover>
  )
}
