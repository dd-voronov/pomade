// Pomade — the editor pane's save pipeline: writeTo (the single write door), handleSave (Cmd+S /
// Save button, with the T-142 save-conflict guard), Save-As + overwrite, and the two promise-gated
// confirms (T-102 outside-workspace, T-142 conflict). It reads and updates the shared doc buffer
// owned by useDocFile.

import { useRef, useState, type MutableRefObject } from 'react'

import type { DocTab } from '@shared/types'
import { basename } from './doc-kind'
import { contentHash } from '@shared/recovery'
import { isOutsidePath, probeDisk, readPath, reconstruct, statPath, writePath } from './doc-io'
import { findDocChannelsFor } from './doc-buffers'
import type { DocFile } from './useDocFile'
import { cleanIpcError } from '../../lib/ipc-errors'

type DocMetaPatch = Partial<Pick<DocTab, 'path' | 'title' | 'mode' | 'symlink' | 'richView'>>

// 'exists' is only ever returned for an exclusive write (Save-As collision detection).
type WriteResult = 'ok' | 'exists' | 'error'

export interface SavePipeline {
  saveAs: { open: boolean; name: string }
  setSaveAs: React.Dispatch<React.SetStateAction<{ open: boolean; name: string }>>
  overwrite: { rel: string } | null
  setOverwrite: (v: { rel: string } | null) => void
  outsideSavePrompt: boolean
  resolveOutsideSave: (ok: boolean) => void
  saveConflict: boolean
  resolveSaveConflict: (choice: 'overwrite' | 'reload' | 'cancel') => void
  writeTo: (rel: string, assign: boolean, exclusive?: boolean) => Promise<WriteResult>
  handleSave: () => Promise<boolean>
  handleSaveRef: MutableRefObject<() => Promise<boolean>>
  confirmSaveAs: () => Promise<void>
  confirmOverwrite: () => Promise<void>
  // T-187 — the non-interactive save used by quit's "Save all docs" (registered with the tabs-store
  // save-guard registry). 'ok' = the dirty buffer was written through the normal door; 'blocked' =
  // it can't be saved unattended (see saveForQuit). Held in a ref so the registry always runs the
  // current closure.
  saveForQuit: () => Promise<'ok' | 'blocked'>
  saveForQuitRef: MutableRefObject<() => Promise<'ok' | 'blocked'>>
  /** T-226 — a version tab's Save confirm (null = closed); `docDirty`: the document has unsaved
   *  edits in its own tab. */
  replacePrompt: { docDirty: boolean } | null
  resolveReplace: (ok: boolean) => void
  /** T-226 — a version tab replaced its document at least once (the buffer then is clean against
   *  what it wrote). */
  replaced: boolean
}

export function useSavePipeline(params: {
  projectId: string
  tabId: string
  pathRef: MutableRefObject<string>
  rootPath: string
  doc: DocFile
  markDirty: (projectId: string, tabId: string, dirty: boolean) => void
  setDocMeta: (projectId: string, tabId: string, patch: DocMetaPatch) => void
  toast: (message: string, tone?: 'info' | 'error') => void
  /** Emit the mounted editor's not-yet-reported edits (EditorController.flushPendingEdits). */
  flushEdits: () => void
  /** T-226 — a version tab: Save replaces the document at `path` after a confirm. */
  versionTab: boolean
}): SavePipeline {
  const { projectId, tabId, pathRef, rootPath, doc, markDirty, setDocMeta, toast, flushEdits, versionTab } = params
  const { savedRef, normRef, syncRef, lastDirtyRef, refusal, setMissing, setChangedOutside, setRecoveredAt } =
    doc

  const [saveAs, setSaveAs] = useState<{ open: boolean; name: string }>({ open: false, name: '' })
  const [overwrite, setOverwrite] = useState<{ rel: string } | null>(null)
  // T-102 (E-021) — the FIRST save of an outside-workspace doc in a given tab SESSION shows a
  // confirm; later saves in the same open tab are silent. `outsideSaveConfirmedRef` is per-mount,
  // so closing + reopening the tab (a fresh EditorPane) re-arms it. The prompt is a promise gate
  // inside `writeTo`, so EVERY save path (Cmd+S, Save button, save-then-close) inherits it.
  const [outsideSavePrompt, setOutsideSavePrompt] = useState(false)
  const outsideSaveConfirmedRef = useRef(false)
  const outsideConfirmResolveRef = useRef<((ok: boolean) => void) | null>(null)
  // T-142 — save-conflict guard (data-loss). A single confirm shown at the Save click when the
  // file diverged on disk since our last load/save. Promise-gated exactly like the outside-save
  // confirm above, so it's a straight-line await inside handleSave.
  const [saveConflict, setSaveConflict] = useState(false)
  const saveConflictResolveRef = useRef<
    ((choice: 'overwrite' | 'reload' | 'cancel') => void) | null
  >(null)

  // T-102 (E-021) — resolve the outside-workspace save confirm. The buttons call this; the
  // gate inside `writeTo` awaits the returned promise.
  const confirmOutsideSave = (): Promise<boolean> =>
    new Promise((resolve) => {
      outsideConfirmResolveRef.current = resolve
      setOutsideSavePrompt(true)
    })
  const resolveOutsideSave = (ok: boolean): void => {
    setOutsideSavePrompt(false)
    const r = outsideConfirmResolveRef.current
    outsideConfirmResolveRef.current = null
    r?.(ok)
  }

  // T-142 — open the save-conflict confirm and await the user's choice.
  const confirmSaveConflict = (): Promise<'overwrite' | 'reload' | 'cancel'> =>
    new Promise((resolve) => {
      saveConflictResolveRef.current = resolve
      setSaveConflict(true)
    })
  const resolveSaveConflict = (choice: 'overwrite' | 'reload' | 'cancel'): void => {
    setSaveConflict(false)
    const r = saveConflictResolveRef.current
    saveConflictResolveRef.current = null
    r?.(choice)
  }

  const writeTo = async (rel: string, assign: boolean, exclusive = false): Promise<WriteResult> => {
    // T-095 — a refused file (binary / too-big) was never read: `content` is '' here, so any
    // write would TRUNCATE the real file on disk. Refusal makes the whole save surface inert
    // (Save, Cmd+S, Save As all route through writeTo).
    if (refusal) {
      toast(`${basename(rel)} was not loaded — saving now would erase it`, 'error')
      return 'error'
    }
    // T-102 — an outside-workspace doc confirms once per tab session before its first write.
    // Cancel aborts THIS save silently (no toast, tab stays dirty).
    if (isOutsidePath(rel) && !outsideSaveConfirmedRef.current) {
      const ok = await confirmOutsideSave()
      if (!ok) return 'error'
      outsideSaveConfirmedRef.current = true
    }
    flushEdits()
    const content = doc.contentRef.current
    const out = reconstruct(content, normRef.current)
    // E-035 — Pomade's own write never trips rule 8: the sync point takes the bytes about to land
    // BEFORE the write, so a watcher event that races the post-write stat below sees identical
    // bytes (in sync). A failed write restores the previous sync point.
    const prevSync = syncRef.current
    const outHash = contentHash(out)
    syncRef.current = { mtimeMs: prevSync.mtimeMs, hash: outHash }
    try {
      const res = await writePath(rel, out, exclusive ? { exclusive: true } : undefined)
      // The exclusive-write collision (Save-As) is a STRUCTURED result, not a message to grep —
      // `res.code === 'EEXIST'` is the only shape it can take when `res.ok` is false.
      if (!res.ok) {
        syncRef.current = prevSync
        return 'exists'
      }
      savedRef.current = content
      normRef.current = { ...normRef.current, hadTrailingNewline: content.endsWith('\n') }
      lastDirtyRef.current = false
      markDirty(projectId, tabId, false)
      setMissing(false)
      setChangedOutside(false)
      setRecoveredAt(null)
      if (assign) {
        pathRef.current = rel
        setDocMeta(projectId, tabId, { path: rel, title: basename(rel) })
      }
      // Record our own write's mtime: the sync point is now exactly what we wrote.
      try {
        syncRef.current = { mtimeMs: (await statPath(rel)).mtimeMs, hash: outHash }
      } catch {
        /* ignore — the hash already marks these bytes as ours */
      }
      return 'ok'
    } catch (err) {
      syncRef.current = prevSync
      toast(`Could not save ${basename(rel)}: ${cleanIpcError(err)}`, 'error')
      return 'error'
    }
  }

  // T-226 — a version tab's Save: confirm, keep what the document holds now in History, write the
  // tab's text into the document, then bring the document's open tabs to it (a dirty one keeps its
  // edits as a discarded draft first). The tab's own buffer is then clean against what it wrote.
  const [replacePrompt, setReplacePrompt] = useState<{ docDirty: boolean } | null>(null)
  const replaceResolveRef = useRef<((ok: boolean) => void) | null>(null)
  const [replaced, setReplaced] = useState(false)
  const resolveReplace = (ok: boolean): void => {
    setReplacePrompt(null)
    const r = replaceResolveRef.current
    replaceResolveRef.current = null
    r?.(ok)
  }
  const confirmReplace = (docDirty: boolean): Promise<boolean> =>
    new Promise((resolve) => {
      replaceResolveRef.current = resolve
      setReplacePrompt({ docDirty })
    })
  /** The document's current text goes to local history; a file local history does not keep goes
   *  to the discarded drafts instead. A missing or empty file has nothing to keep. */
  const keepReplaced = async (p: string): Promise<void> => {
    let raw: string
    try {
      raw = await readPath(p)
    } catch {
      return
    }
    if (raw === '' || (await window.pomade.localHistory.keep(p))) return
    const id = crypto.randomUUID()
    await window.pomade.recovery.keepDraft({
      id,
      path: p,
      tabId: `replaced:${id}`,
      title: basename(p),
      content: raw,
      reason: 'replaced',
      recoveryPath: ''
    })
  }
  const replaceDocument = async (): Promise<boolean> => {
    const p = pathRef.current
    if (refusal) return false
    flushEdits()
    const docTabs = () => findDocChannelsFor(p)
    if (!(await confirmReplace(docTabs().some((ch) => ch.state().dirty)))) return false
    try {
      await keepReplaced(p)
    } catch (err) {
      toast(`Could not keep the current ${basename(p)} in History, so nothing was replaced: ${cleanIpcError(err)}`, 'error')
      return false
    }
    if ((await writeTo(p, false)) !== 'ok') return false
    for (const ch of docTabs()) {
      if (ch.state().dirty) ch.loadDisk()
      else ch.reload()
    }
    setReplaced(true)
    toast(`${basename(p)} now holds this version. The text it replaced is in History.`, 'info')
    return true
  }
  const handleSave = async (): Promise<boolean> => {
    if (versionTab) return replaceDocument()
    const p = pathRef.current
    if (!p) {
      setSaveAs({ open: true, name: '' })
      return false
    }
    // T-142 — save-conflict guard (data-loss, T-095 class). BEFORE overwriting, probe the disk
    // through the SAME fs door the doc uses (in-workspace vs outside) against the doc's sync point
    // (mtime, then bytes). If another writer changed the file since our last load/save/Keep mine,
    // a blind write would silently discard that change — so gate on a single confirm.
    // `changedOutside` is only a passive hint; the authority is THIS write-time probe, which also
    // catches a divergence the watchers missed. A refused file never reaches a real write
    // (writeTo refuses it) so the probe is skipped. A file that VANISHED is not a conflict — Save
    // recreates it (the user wants it to exist); no prompt, no crash.
    if (!refusal) {
      const diverged = (await probeDisk(p, syncRef.current)).verdict === 'changed'
      if (diverged) {
        const choice = await confirmSaveConflict()
        if (choice === 'cancel') return false
        if (choice === 'reload') {
          doc.reloadFromDiskRef.current()
          return false
        }
        // 'overwrite' → fall through; writeTo moves the sync point to the bytes it writes.
      }
    }
    return (await writeTo(p, false)) === 'ok'
  }
  const handleSaveRef = useRef(handleSave)
  handleSaveRef.current = handleSave

  // T-187 — the non-interactive save behind quit's "Save all docs". Same write door as Cmd+S
  // (T-142 conflict guard, T-095 refusal guard) but it NEVER raises a dialog: anything that would
  // need a user decision returns 'blocked' so the quit flow names the doc and ABORTS the quit — the
  // app never silently discards unsaved work, nor writes outside the workspace / over an on-disk
  // conflict without consent.
  const saveForQuit = async (): Promise<'ok' | 'blocked'> => {
    const p = pathRef.current
    if (!p) return 'blocked' // untitled — a name (Save-As) is required first
    // T-226 — replacing a document with a version always asks first.
    if (versionTab) return savedRef.current === doc.contentRef.current ? 'ok' : 'blocked'
    if (refusal) return 'blocked' // T-095 — a refused file was never read; a write would truncate it
    flushEdits()
    if (savedRef.current === doc.contentRef.current) return 'ok' // already clean (defensive; sweep skips clean)
    // T-102 — a first outside-workspace write needs a per-session confirm we won't raise here.
    if (isOutsidePath(p) && !outsideSaveConfirmedRef.current) return 'blocked'
    // T-142 — never blind-overwrite a file another writer changed since our sync point. A file
    // that VANISHED is not a conflict (Save recreates it — matches handleSave), so only a real
    // byte divergence blocks.
    if ((await probeDisk(p, syncRef.current)).verdict === 'changed') return 'blocked'
    return (await writeTo(p, false)) === 'ok' ? 'ok' : 'blocked'
  }
  const saveForQuitRef = useRef(saveForQuit)
  saveForQuitRef.current = saveForQuit

  const confirmSaveAs = async (): Promise<void> => {
    const name = saveAs.name.trim()
    if (!name) return
    const rel = rootPath ? `${rootPath}/${name}` : name
    // Exclusive write so an existing sibling isn't silently clobbered; on collision, ask.
    const res = await writeTo(rel, true, true)
    if (res === 'ok') setSaveAs({ open: false, name: '' })
    else if (res === 'exists') setOverwrite({ rel })
  }

  const confirmOverwrite = async (): Promise<void> => {
    if (!overwrite) return
    const res = await writeTo(overwrite.rel, true, false)
    setOverwrite(null)
    if (res === 'ok') setSaveAs({ open: false, name: '' })
  }

  return {
    saveAs,
    setSaveAs,
    overwrite,
    setOverwrite,
    outsideSavePrompt,
    resolveOutsideSave,
    saveConflict,
    resolveSaveConflict,
    writeTo,
    handleSave,
    handleSaveRef,
    confirmSaveAs,
    confirmOverwrite,
    saveForQuit,
    saveForQuitRef,
    replacePrompt,
    resolveReplace,
    replaced
  }
}
