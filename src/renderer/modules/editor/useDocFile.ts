// Pomade — the editor pane's document buffer + disk lifecycle: load-once (restoring an unsaved
// recovery copy when one exists — E-035), size/binary refusal, missing-on-open, detection of
// writes by any other writer (rule 8), re-check on becoming visible, reload, and the amber
// banner's Keep mine. Owns the in-memory buffer (`content` + the saved/normalized/sync refs) and
// dirty tracking; the save pipeline (useSavePipeline) and recovery (useRecovery) read and update
// the same refs.

import { useEffect, useRef, useState, type MutableRefObject } from 'react'

import type { VersionSource } from '@shared/doc-version'
import { contentHash, recoveryVerdict, type SyncPoint } from '@shared/recovery'
import { readVersion } from '../git/history/version-text'
import {
  MAX_BYTES,
  normalize,
  probeDisk,
  readPath,
  statPath,
  type Normalized,
  type Refusal
} from './doc-io'
import { onOpenDocChanged } from './open-doc-watch'

export interface DocFile {
  content: string
  /** Set the buffer; `contentRef` reflects it immediately (before the re-render). */
  setContent: (s: string) => void
  /** The live buffer, readable from callbacks without a re-render. */
  contentRef: MutableRefObject<string>
  loaded: boolean
  refusal: Refusal
  missing: boolean
  setMissing: (b: boolean) => void
  /** Another writer changed the file since the buffer's sync point (rule 8). With unsaved edits
   *  this raises the amber banner; without, the plain "changed on disk" notice. */
  changedOutside: boolean
  setChangedOutside: (b: boolean) => void
  /** Set when the buffer was restored from a recovery copy at load (banner time), else null. */
  recoveredAt: number | null
  setRecoveredAt: (t: number | null) => void
  reloadNonce: number
  /** Remount the rendered / CSV editor so it re-reads the buffer (they read their content once). */
  remountRich: () => void
  isSymlink: boolean
  // Shared buffer refs — the save pipeline updates these on write.
  savedRef: MutableRefObject<string>
  normRef: MutableRefObject<Normalized>
  /** The disk state the buffer last agreed with (mtime + hash of the bytes). Pomade's own load,
   *  save, reload and Keep mine move it; every other writer moves the disk away from it. */
  syncRef: MutableRefObject<SyncPoint>
  /** The current editing stretch (dirty → clean); restored from a recovery copy. */
  stretchRef: MutableRefObject<string | null>
  lastDirtyRef: MutableRefObject<boolean>
  /** Edge-triggered dirty-flag propagation to the tab store. */
  applyDirty: (next: string) => void
  /** setContent + applyDirty — the raw editor / CSV table onChange. */
  handleContentChange: (next: string) => void
  /** Reload from disk, discarding the in-memory copy (changed notice, save conflict, Load disk
   *  version, recovery Discard). An Untitled doc reverts to empty. */
  reloadFromDiskRef: MutableRefObject<() => void>
  /** Keep mine: adopt the CURRENT disk as the sync point and keep the buffer as unsaved edits on
   *  top of it — the next save writes the buffer without a conflict prompt. */
  keepMine: () => Promise<void>
  /** Compare the disk with the sync point now (writes detected → changedOutside / missing). */
  checkDiskRef: MutableRefObject<() => Promise<void>>
}

export function useDocFile(
  projectId: string,
  tabId: string,
  pathRef: MutableRefObject<string>,
  visible: boolean,
  markDirty: (projectId: string, tabId: string, dirty: boolean) => void,
  /** T-226 — a version tab: the buffer starts from this version, not from the file; the file's
   *  disk state is not this buffer's (no rule-8 checks), and its recovery copy is keyed by the tab. */
  version?: VersionSource
): DocFile {
  const [content, setContentState] = useState('')
  const contentRef = useRef('')
  const setContent = (s: string): void => {
    contentRef.current = s
    setContentState(s)
  }
  const [loaded, setLoaded] = useState(false)
  const loadedRef = useRef(false)
  const [refusal, setRefusal] = useState<Refusal>(null)
  const [missing, setMissing] = useState(false)
  const [changedOutside, setChangedOutside] = useState(false)
  const [recoveredAt, setRecoveredAt] = useState<number | null>(null)
  // E-016 — bumped on every disk reload. Used to REMOUNT the rendered (Milkdown) / CSV editor,
  // which capture their `initial`/content once and ignore later prop changes — so a reload
  // updates the raw editor (controlled by `value`) but was silently a no-op in rendered mode.
  // Keying those editors on this nonce forces them to re-read the reloaded content.
  const [reloadNonce, setReloadNonce] = useState(0)
  // E-012 (round-3) — whether this doc's file is a symbolic link (from the load-time lstat).
  // Drives the accent chain-link chip in the pane header.
  const [isSymlink, setIsSymlink] = useState(false)

  const savedRef = useRef('')
  const normRef = useRef<Normalized>({ text: '', hadCRLF: false, hadTrailingNewline: false })
  const lastDirtyRef = useRef(false)
  const syncRef = useRef<SyncPoint>({ mtimeMs: 0, hash: '' })
  const stretchRef = useRef<string | null>(null)
  const refusalRef = useRef<Refusal>(null)
  refusalRef.current = refusal

  const setDirtyFlag = (d: boolean): void => {
    lastDirtyRef.current = d
    markDirty(projectId, tabId, d)
  }

  // ── Load once on mount (+ E-035 recovery restore) ───────────────────────────
  useEffect(() => {
    let cancelled = false
    const initialPath = pathRef.current
    const finish = (): void => {
      loadedRef.current = true
      setLoaded(true)
    }
    void (async () => {
      let diskHash: string | null = null
      if (version) {
        try {
          const raw = await readVersion(version)
          if (cancelled) return
          const n = normalize(raw)
          normRef.current = n
          savedRef.current = n.text
        } catch (err) {
          if (cancelled) return
          setRefusal({ reason: 'version', message: err instanceof Error ? err.message : String(err) })
          return
        }
      } else if (initialPath) {
        try {
          // Byte-accurate size guard BEFORE reading — refuse huge files by real size.
          const st = await statPath(initialPath)
          if (cancelled) return
          setIsSymlink(st.isSymbolicLink)
          if (st.size > MAX_BYTES) {
            syncRef.current = { mtimeMs: st.mtimeMs, hash: '' }
            setRefusal({ reason: 'too-big' })
            return
          }
          const raw = await readPath(initialPath)
          if (cancelled) return
          if (raw.includes('\u0000')) {
            syncRef.current = { mtimeMs: st.mtimeMs, hash: '' }
            setRefusal({ reason: 'binary' })
            return
          }
          diskHash = contentHash(raw)
          syncRef.current = { mtimeMs: st.mtimeMs, hash: diskHash }
          const n = normalize(raw)
          normRef.current = n
          savedRef.current = n.text
        } catch {
          if (cancelled) return
          // File not present at open — non-fatal; start empty and let a save recreate it.
          setMissing(true)
          savedRef.current = ''
        }
      }
      // E-035 — a recovery copy means this tab held unsaved edits when Pomade last stopped
      // (crash, force quit, reload, kernel panic): put them back in place, marked dirty.
      let restored = savedRef.current
      try {
        const rec = await window.pomade.recovery.get(version ? '' : initialPath, tabId)
        if (cancelled) return
        if (rec && rec.content !== savedRef.current) {
          restored = rec.content
          stretchRef.current = rec.stretchId
          if (!version && recoveryVerdict(rec.base, diskHash) === 'changed' && rec.base) {
            // Edits taken against an older disk state: keep that state as the sync point so
            // the save-conflict guard holds until the Owner chooses, and raise the amber banner.
            syncRef.current = rec.base
            setChangedOutside(true)
          } else {
            setRecoveredAt(rec.savedAt)
          }
        } else if (rec) {
          // The copy equals the disk (saved right before the stop): nothing to recover.
          void window.pomade.recovery.remove(version ? '' : initialPath, tabId)
        }
      } catch {
        /* recovery is best-effort — the doc still opens from disk */
      }
      setContent(restored)
      if (restored !== savedRef.current) setDirtyFlag(true)
      finish()
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loads once per pane (PaneHost keys it by tab id); the path is read through pathRef and a version tab's source never changes
  }, [])

  // ── Rule 8: compare the disk with the sync point ────────────────────────────
  // Bytes decide, not the clock: a differing mtime over identical bytes (a touch, Pomade's own
  // write observed before its post-write stat landed, a checkout to the same content) is not a
  // change. Neither the disk nor the buffer is ever changed here — only the flags.
  const checkDiskRef = useRef<() => Promise<void>>(async () => {})
  checkDiskRef.current = async (): Promise<void> => {
    const p = pathRef.current
    if (version || !p || !loadedRef.current) return
    const sync = syncRef.current
    const { verdict, mtimeMs } = await probeDisk(p, sync, !refusalRef.current)
    if (pathRef.current !== p) return // retargeted (in-app rename/move) while probing
    if (verdict === 'missing') {
      setMissing(true)
      return
    }
    setMissing(false)
    // Same bytes under a new mtime: the sync point follows the clock.
    if (verdict === 'in-sync' && syncRef.current === sync && mtimeMs !== sync.mtimeMs) {
      syncRef.current = { mtimeMs, hash: sync.hash }
    }
    // A reload or save that moved the sync point while probing decided already.
    if (verdict === 'changed' && syncRef.current === sync) setChangedOutside(true)
  }

  // Writes anywhere in the active project's tree (the file tree's watcher) …
  useEffect(() => {
    return window.pomade.fs.onChanged(() => void checkDiskRef.current())
  }, [])
  // … and writes to THIS doc in any project, the moment they land (the open-doc watcher).
  useEffect(() => {
    return onOpenDocChanged((p) => {
      if (p === pathRef.current) void checkDiskRef.current()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one subscription per pane; pathRef and checkDiskRef are refs read at event time
  }, [])

  // E-016 — re-check the file when this pane comes back into view: a backstop for anything the
  // watchers can miss (a parent folder renamed away, a watcher torn down by the OS). Runs once
  // per hidden→visible transition, after load.
  const wasVisibleRef = useRef(false)
  useEffect(() => {
    if (!visible) {
      wasVisibleRef.current = false
      return
    }
    if (!loaded || wasVisibleRef.current) return
    wasVisibleRef.current = true
    void checkDiskRef.current()
  }, [visible, loaded])

  // Reload the file from disk, discarding the in-memory copy.
  const reloadFromDiskRef = useRef<() => void>(() => {})
  reloadFromDiskRef.current = (): void => {
    const p = pathRef.current
    const settle = (): void => {
      setDirtyFlag(false)
      setRefusal(null)
      setChangedOutside(false)
      setRecoveredAt(null)
      stretchRef.current = null
      // Remount the rendered/CSV editor so it re-reads the reloaded content (they don't
      // reconcile `initial`/content on prop change the way the raw CodeMirror editor does).
      setReloadNonce((k) => k + 1)
    }
    if (version) {
      // A version tab reloads its version.
      void readVersion(version).then(
        (raw) => {
          const n = normalize(raw)
          normRef.current = n
          savedRef.current = n.text
          setContent(n.text)
          settle()
        },
        (err: unknown) => setRefusal({ reason: 'version', message: err instanceof Error ? err.message : String(err) })
      )
      return
    }
    if (!p) {
      // Untitled: the "disk" is the empty document.
      savedRef.current = ''
      setContent('')
      settle()
      return
    }
    void (async () => {
      try {
        const st = await statPath(p)
        if (st.size > MAX_BYTES) {
          syncRef.current = { mtimeMs: st.mtimeMs, hash: '' }
          setRefusal({ reason: 'too-big' })
          return
        }
        const raw = await readPath(p)
        if (raw.includes('\u0000')) {
          syncRef.current = { mtimeMs: st.mtimeMs, hash: '' }
          setRefusal({ reason: 'binary' })
          return
        }
        syncRef.current = { mtimeMs: st.mtimeMs, hash: contentHash(raw) }
        const n = normalize(raw)
        normRef.current = n
        savedRef.current = n.text
        setContent(n.text)
        setMissing(false)
        settle()
      } catch {
        setMissing(true)
      }
    })()
  }

  const keepMine = async (): Promise<void> => {
    const p = pathRef.current
    if (p) {
      try {
        const st = await statPath(p)
        const raw = await readPath(p)
        syncRef.current = { mtimeMs: st.mtimeMs, hash: contentHash(raw) }
        const n = normalize(raw)
        normRef.current = n
        savedRef.current = n.text
      } catch {
        setMissing(true) // gone meanwhile: the missing notice takes over; Save recreates it
      }
    }
    setChangedOutside(false)
    const d = contentRef.current !== savedRef.current
    if (d !== lastDirtyRef.current) setDirtyFlag(d)
  }

  const applyDirty = (next: string): void => {
    const d = next !== savedRef.current
    if (d !== lastDirtyRef.current) setDirtyFlag(d)
  }

  const handleContentChange = (next: string): void => {
    setContent(next)
    applyDirty(next)
  }

  return {
    content,
    setContent,
    contentRef,
    loaded,
    refusal,
    missing,
    setMissing,
    changedOutside,
    setChangedOutside,
    recoveredAt,
    setRecoveredAt,
    reloadNonce,
    remountRich: () => setReloadNonce((k) => k + 1),
    isSymlink,
    savedRef,
    normRef,
    syncRef,
    stretchRef,
    lastDirtyRef,
    applyDirty,
    handleContentChange,
    reloadFromDiskRef,
    keepMine,
    checkDiskRef
  }
}
