// Pomade — E-035: unsaved-doc recovery for one editor pane. While the buffer is dirty, a copy goes
// to user data RECOVERY_DEBOUNCE_MS after typing stops (main: recovery-store); a clean buffer
// drops it. A discard (close guard, quit's Discard all, the recovery banner's Discard, Load disk
// version) keeps the unsaved state as a discarded draft — one per editing stretch.
//
// The quit handshake flushes every pending copy (flushAllRecovery) before main tears down, so a
// crash during quit's teardown (the 2026-08-30 kernel panic) still finds the latest edits on disk.

import { useEffect, useRef, type MutableRefObject } from 'react'

import { RECOVERY_DEBOUNCE_MS, type DraftReason } from '@shared/recovery'
import type { DocFile } from './useDocFile'

const flushers = new Map<string, () => Promise<void>>()

/** Write every pane's pending recovery copy now (quit handshake). */
export async function flushAllRecovery(): Promise<void> {
  await Promise.all([...flushers.values()].map((f) => f().catch(() => {})))
}

export interface Recovery {
  /** Write the recovery copy now (e.g. after Keep mine moved the sync point). */
  putNow: () => Promise<void>
  /** Keep the current unsaved state as a discarded draft and drop the recovery copy. The caller
   *  then reverts or closes the buffer. Resolves once the draft is on disk. */
  keepDraft: (reason: DraftReason) => Promise<void>
}

export function useRecovery(params: {
  tabId: string
  path: string
  pathRef: MutableRefObject<string>
  title: string
  dirty: boolean
  doc: DocFile
  /** T-226 — a version tab: its copy is keyed by its tab id (`''` path, like an Untitled doc), so it
   *  never meets the document's own tab's copy; its drafts still go under the document's path. */
  versionTab: boolean
}): Recovery {
  const { tabId, path, pathRef, title, dirty, doc, versionTab } = params
  const { content, loaded, refusal, contentRef, syncRef, stretchRef } = doc

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The path a copy currently exists under (null = no copy), so a retarget or a clean buffer
  // removes exactly the file that was written.
  const writtenRef = useRef<string | null>(null)
  const titleRef = useRef(title)
  titleRef.current = title
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  const stretch = (): string => {
    if (!stretchRef.current) stretchRef.current = crypto.randomUUID()
    return stretchRef.current
  }

  const cancel = (): void => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
  }

  /** The path the copy is keyed under. */
  const copyPath = (): string => (versionTab ? '' : pathRef.current)

  const put = async (): Promise<void> => {
    cancel()
    const p = copyPath()
    const prev = writtenRef.current
    writtenRef.current = p
    await window.pomade.recovery.put({
      path: p,
      tabId,
      title: titleRef.current,
      content: contentRef.current,
      savedAt: Date.now(),
      base: p ? syncRef.current : null,
      stretchId: stretch()
    })
    if (prev !== null && prev !== p) await window.pomade.recovery.remove(prev, tabId)
  }
  const putRef = useRef(put)
  putRef.current = put

  // A buffer restored from a recovery copy (useDocFile set its stretch at load) owns that copy.
  useEffect(() => {
    if (loaded && stretchRef.current && writtenRef.current === null) writtenRef.current = versionTab ? '' : pathRef.current
  }, [loaded, stretchRef, pathRef, versionTab])

  // Dirty → (re)schedule the copy; clean → drop the copy and end the stretch.
  useEffect(() => {
    if (!loaded || refusal) return
    if (dirty) {
      cancel()
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        void putRef.current().catch(() => {})
      }, RECOVERY_DEBOUNCE_MS)
      return
    }
    cancel()
    stretchRef.current = null
    const written = writtenRef.current
    if (written !== null) {
      writtenRef.current = null
      void window.pomade.recovery.remove(written, tabId).catch(() => {})
    }
  }, [content, dirty, loaded, refusal, tabId, stretchRef])

  // In-app rename/move (E-016) or Save As retargets the tab: move an existing copy right away.
  useEffect(() => {
    const written = writtenRef.current
    if (versionTab || written === null || written === path || !dirtyRef.current) return
    void putRef.current().catch(() => {})
  }, [path, versionTab])

  // Quit handshake + unmount.
  useEffect(() => {
    flushers.set(tabId, async () => {
      if (timerRef.current) await putRef.current()
    })
    return () => {
      flushers.delete(tabId)
      cancel()
    }
  }, [tabId])

  const keepDraft = async (reason: DraftReason): Promise<void> => {
    cancel()
    const p = pathRef.current
    const written = writtenRef.current
    writtenRef.current = null
    const id = stretch()
    stretchRef.current = null
    const copy = copyPath()
    await window.pomade.recovery.keepDraft({
      id,
      path: p,
      tabId,
      title: titleRef.current,
      content: contentRef.current,
      reason,
      ...(copy !== p ? { recoveryPath: copy } : {})
    })
    if (written !== null && written !== copy) await window.pomade.recovery.remove(written, tabId)
  }

  return { putNow: () => putRef.current(), keepDraft }
}
