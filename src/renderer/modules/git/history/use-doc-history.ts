// Pomade — E-038: loads one document's History rows. Commits come from main (paged, first-parent
// or every commit); where the saved file stands against git from the git snapshot; the file on
// disk (its modified time, size and content hash) from a stat and a read; discarded drafts from the
// recovery store; local-history snapshots from main; unsaved from the caller. Reloads when HEAD
// moves, the path changes, a draft is kept or a snapshot of the path is kept; the disk file also on
// a save and on a git status change.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { buildHistoryRows, type DiskFile, type DraftRef, type HistoryRow } from '@shared/doc-history'
import type { FileCommit } from '@shared/git-history'
import { blobHash, SNAPSHOT_MAX_FILE_BYTES, type SnapshotRef } from '@shared/local-history'
import { repoOfPath, type GitFileChange } from '@shared/git-state'
import { cleanIpcError } from '../../../lib/ipc-errors'
import { readPath, statPath } from '../../editor/doc-io'
import { useGitStateStore, useGitStateSubscription } from '../git-state-store'

export interface DocHistory {
  rows: HistoryRow[]
  /** The owning repo's ws-relative root; null outside any repo. */
  repo: string | null
  loading: boolean
  error: string | null
  /** Older commits exist past what is listed. */
  more: boolean
  loadMore: () => void
}

const SAVED_STATUSES = new Set<GitFileChange['status']>(['modified', 'new', 'renamed', 'conflict'])

export function useDocHistory(params: {
  path: string
  dirty: boolean
  /** Every commit, not only the branch's first-parent line. */
  all: boolean
  /** Bumped when a discarded draft was just kept. */
  draftsNonce: number
}): DocHistory {
  const { path, dirty, all, draftsNonce } = params
  useGitStateSubscription()
  const snapshot = useGitStateStore((s) => s.snapshot)
  const index = useGitStateStore((s) => s.index)
  const repoState = useMemo(() => repoOfPath(snapshot, path), [snapshot, path])
  const repo = repoState?.root ?? null
  const head = repoState?.head ?? null
  const change = repoState ? index.statusOf(path) : null
  // Where the file was moved from, when it was moved: git's own answer for a staged rename, else
  // (an untracked file) the files deleted from the working tree, one of which the first page picks.
  const status = change?.status
  const renamedFrom = change?.from
  const deletedKey =
    status === 'new' && repoState
      ? repoState.changes
          .filter((c) => c.status === 'deleted' && !c.dir)
          .map((c) => c.path)
          .join('\0')
      : ''
  const deleted = useMemo(() => (deletedKey ? deletedKey.split('\0') : []), [deletedKey])

  const [commits, setCommits] = useState<FileCommit[]>([])
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<DraftRef[]>([])
  const [snapshots, setSnapshots] = useState<SnapshotRef[]>([])
  const [movedFrom, setMovedFrom] = useState<string | undefined>(undefined)
  const [disk, setDisk] = useState<DiskFile | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    if (!path) {
      setDrafts([])
      return
    }
    let cancelled = false
    void window.pomade.recovery.drafts(path).then(
      (list) => {
        if (!cancelled) setDrafts(list.map((d) => ({ id: d.id, discardedAt: d.discardedAt, reason: d.reason })))
      },
      () => {
        if (!cancelled) setDrafts([])
      }
    )
    return () => {
      cancelled = true
    }
  }, [path, draftsNonce, dirty])

  // Local-history snapshots: read when the path changes and each time one of this path is kept.
  useEffect(() => {
    if (!path) {
      setSnapshots([])
      return
    }
    let cancelled = false
    const load = (): void => {
      void window.pomade.localHistory.list(path).then(
        (list) => {
          if (!cancelled) setSnapshots(list)
        },
        () => {
          if (!cancelled) setSnapshots([])
        }
      )
    }
    load()
    const off = window.pomade.localHistory.onChanged((changed) => {
      if (changed === path) load()
    })
    return () => {
      cancelled = true
      off()
    }
  }, [path])

  // The file on disk: read again after a save (dirty clears), a kept snapshot (another writer) or
  // a git status change. Its hash is the local-history one, so the newest snapshot can be told.
  useEffect(() => {
    if (!path) {
      setDisk(null)
      return
    }
    let cancelled = false
    void (async (): Promise<DiskFile | null> => {
      const st = await statPath(path)
      if (!st.isFile) return null
      if (st.size > SNAPSHOT_MAX_FILE_BYTES) return { mtime: st.mtimeMs, size: st.size, hash: null }
      const text = await readPath(path)
      return { mtime: st.mtimeMs, size: st.size, hash: text.includes('\u0000') ? null : blobHash(text) }
    })().then(
      (d) => {
        if (!cancelled) setDisk(d)
      },
      () => {
        if (!cancelled) setDisk(null)
      }
    )
    return () => {
      cancelled = true
    }
  }, [path, dirty, snapshots, status, head])

  useEffect(() => {
    const gen = ++generation.current
    setCommits([])
    setMore(false)
    setError(null)
    setMovedFrom(undefined)
    if (repo === null || !path) {
      setLoading(false)
      return
    }
    setLoading(true)
    void window.pomade.git.fileLog(repo, path, { all, skip: 0, via: renamedFrom, candidates: deleted }).then(
      (page) => {
        if (generation.current !== gen) return
        setCommits(page.commits)
        setMore(page.more)
        setMovedFrom(page.renamedFrom)
        setLoading(false)
      },
      (err: unknown) => {
        if (generation.current !== gen) return
        setError(cleanIpcError(err))
        setLoading(false)
      }
    )
  }, [repo, path, all, head, renamedFrom, deleted])

  const loadMore = useCallback((): void => {
    if (repo === null || loading) return
    const gen = generation.current
    setLoading(true)
    void window.pomade.git.fileLog(repo, path, { all, skip: commits.length, via: movedFrom }).then(
      (page) => {
        if (generation.current !== gen) return
        setCommits((prev) => [...prev, ...page.commits])
        setMore(page.more)
        setLoading(false)
      },
      (err: unknown) => {
        if (generation.current !== gen) return
        setError(cleanIpcError(err))
        setLoading(false)
      }
    )
  }, [repo, path, all, commits.length, loading, movedFrom])

  const savedFrom = renamedFrom ?? movedFrom
  const saved = useMemo(
    () => (status && SAVED_STATUSES.has(status) ? { isNew: status === 'new' && !savedFrom, from: savedFrom } : null),
    [status, savedFrom]
  )
  const rows = useMemo(
    () => buildHistoryRows({ dirty, disk, inRepo: repo !== null, saved, drafts, commits, snapshots }),
    [dirty, disk, repo, saved, drafts, commits, snapshots]
  )
  return { rows, repo, loading, error, more, loadMore }
}
