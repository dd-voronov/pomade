// Pomade — E-035: unsaved-doc recovery copies and discarded drafts, stored ONLY in user data
// (never in the workspace or git):
//   <userData>/recovery/buffers/<key>.json  — one RecoveryRecord per dirty buffer (workspace + doc)
//   <userData>/recovery/drafts/<key>.json   — one DiscardedDraft per discarded editing stretch
// Every write is atomic (tmp + rename), and every operation on one key runs in order on a per-key
// queue, so a recovery copy still being written can never land after the remove that follows it.
// Drafts older than DRAFT_TTL_MS are pruned once at launch.
// T-310: git-discard drafts also answer the Git panel's Discarded section — which files are not
// back (`discardedFiles`), a restore from Document history (`markRestored`) and Forget.

import { app, type IpcMain } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

import { CH } from '@shared/ipc-api'
import type { RemovalSize } from '@shared/local-history'
import {
  discardedRowShown,
  draftsBefore,
  draftsToPrune,
  isGitDiscard,
  type DiscardedFile,
  recoveryFileName,
  recoveryKey,
  type DiscardedDraft,
  type DraftPut,
  type RecoveryPut,
  type RecoveryRecord
} from '@shared/recovery'

import { writeJsonAtomic } from './atomic-write'
import { defineHandler } from './ipc'
import { abs, requireRoot } from './ws-path'

function recoveryDir(): string {
  return join(app.getPath('userData'), 'recovery')
}
function buffersDir(): string {
  return join(recoveryDir(), 'buffers')
}
function draftsDir(): string {
  return join(recoveryDir(), 'drafts')
}

function bufferFile(path: string, tabId: string): string {
  return join(buffersDir(), recoveryFileName(recoveryKey(requireRoot(), path, tabId)))
}
function draftFile(id: string): string {
  return join(draftsDir(), recoveryFileName(`${requireRoot()}\n${id}`))
}

// Per-file FIFO: each operation waits for the previous one on the same file.
const queues = new Map<string, Promise<unknown>>()
function enqueue<T>(file: string, op: () => Promise<T>): Promise<T> {
  const prev = queues.get(file) ?? Promise.resolve()
  const next = prev.then(op, op)
  const settled = next.catch(() => {})
  queues.set(file, settled)
  void settled.then(() => {
    if (queues.get(file) === settled) queues.delete(file)
  })
  return next
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

async function putRecord(rec: RecoveryPut): Promise<void> {
  const workspace = requireRoot()
  const file = bufferFile(rec.path, rec.tabId)
  await enqueue(file, async () => {
    await fsp.mkdir(buffersDir(), { recursive: true })
    const record: RecoveryRecord = { ...rec, workspace }
    await writeJsonAtomic(file, record)
  })
}

async function getRecord(path: string, tabId: string): Promise<RecoveryRecord | null> {
  const workspace = requireRoot()
  const file = bufferFile(path, tabId)
  const rec = await enqueue(file, () => readJson<RecoveryRecord>(file))
  // The key already binds the workspace + doc; the check guards a hand-edited or foreign file.
  if (!rec || rec.workspace !== workspace || rec.path !== path) return null
  if (!path && rec.tabId !== tabId) return null
  return rec
}

async function removeRecord(path: string, tabId: string): Promise<void> {
  const file = bufferFile(path, tabId)
  await enqueue(file, () => fsp.rm(file, { force: true }))
}

/** Keep a discarded draft, then drop the doc's recovery copy (the draft now holds the edits). */
async function keepDraft(d: DraftPut): Promise<void> {
  const workspace = requireRoot()
  const file = draftFile(d.id)
  await enqueue(file, async () => {
    await fsp.mkdir(draftsDir(), { recursive: true })
    const { recoveryPath: _copy, ...rest } = d
    const draft: DiscardedDraft = { ...rest, workspace, discardedAt: Date.now() }
    await writeJsonAtomic(file, draft)
  })
  await removeRecord(d.recoveryPath ?? d.path, d.tabId)
}

/** E-039 — keep the content of files a git discard is about to remove, as discarded drafts.
 *  All or nothing: when one write fails, the drafts already written are removed again and the
 *  error is thrown — the caller then discards nothing. No doc's recovery copy is touched (an open
 *  doc's unsaved edits are its own). */
export async function keepDiscardedFiles(drafts: readonly DraftPut[], now = Date.now()): Promise<void> {
  const workspace = requireRoot()
  const written: string[] = []
  try {
    await fsp.mkdir(draftsDir(), { recursive: true })
    for (const d of drafts) {
      const file = draftFile(d.id)
      await enqueue(file, async () => {
        const draft: DiscardedDraft = { ...d, workspace, discardedAt: now }
        await writeJsonAtomic(file, draft)
      })
      written.push(file)
    }
  } catch (err) {
    await Promise.all(written.map((f) => enqueue(f, () => fsp.rm(f, { force: true })).catch(() => {})))
    throw err
  }
}

/** E-039 — remove drafts kept for a discard that then did not happen. */
export async function dropDiscardedFiles(ids: readonly string[]): Promise<void> {
  await Promise.all(ids.map((id) => enqueue(draftFile(id), () => fsp.rm(draftFile(id), { force: true }))))
}

async function readAllDrafts(): Promise<{ file: string; draft: DiscardedDraft | null }[]> {
  let names: string[]
  try {
    names = await fsp.readdir(draftsDir())
  } catch {
    return []
  }
  const files = names.filter((n) => n.endsWith('.json')).map((n) => join(draftsDir(), n))
  return Promise.all(files.map(async (file) => ({ file, draft: await readJson<DiscardedDraft>(file) })))
}

/** The current workspace's discarded drafts, newest first (optionally for one doc path). */
async function listDrafts(path?: string): Promise<DiscardedDraft[]> {
  const workspace = requireRoot()
  return (await readAllDrafts())
    .map((e) => e.draft)
    .filter((d): d is DiscardedDraft => !!d && d.workspace === workspace)
    .filter((d) => path === undefined || d.path === path)
    .sort((a, b) => b.discardedAt - a.discardedAt)
}

/** Launch-time housekeeping: delete drafts past their 7 days (and unreadable ones), across
 *  every workspace — retention is a property of the draft, not of the open workspace. */
export async function pruneDrafts(now = Date.now()): Promise<void> {
  const entries = await readAllDrafts()
  const unreadable = entries.filter((e) => !e.draft).map((e) => e.file)
  const readable = entries.filter((e): e is { file: string; draft: DiscardedDraft } => !!e.draft)
  const expired = draftsToPrune(
    readable.map((e) => ({ file: e.file, discardedAt: e.draft.discardedAt })),
    now
  ).map((e) => e.file)
  await Promise.all([...unreadable, ...expired].map((f) => fsp.rm(f, { force: true })))
}

/** T-234 — the current workspace's drafts (the Document history's Discarded group) discarded
 *  before `before` (epoch ms), with their files' sizes. */
async function draftFilesBefore(before: number): Promise<{ file: string; bytes: number }[]> {
  const workspace = requireRoot()
  const mine = (await readAllDrafts()).filter(
    (e): e is { file: string; draft: DiscardedDraft } => !!e.draft && e.draft.workspace === workspace
  )
  const picked = draftsBefore(
    mine.map((e) => ({ file: e.file, discardedAt: e.draft.discardedAt })),
    before
  )
  return Promise.all(
    picked.map(async (e) => ({ file: e.file, bytes: await fsp.stat(e.file).then((st) => st.size, () => 0) }))
  )
}

function sizeOf(files: readonly { bytes: number }[]): RemovalSize {
  return { versions: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) }
}

/** T-234 — what `purgeDrafts(before)` would delete. */
export async function measureDrafts(before: number): Promise<RemovalSize> {
  return sizeOf(await draftFilesBefore(before))
}

/** T-234 — Settings' Delete for the Discarded group: delete the current workspace's drafts
 *  discarded before `before`. Resolves what went. */
export async function purgeDrafts(before: number): Promise<RemovalSize> {
  const files = await draftFilesBefore(before)
  await Promise.all(files.map((f) => enqueue(f.file, () => fsp.rm(f.file, { force: true }))))
  return sizeOf(files)
}

/** A file Pomade compares with its kept copy is read only up to this size (the kept copies'
 *  own bound, E-039 "Discard changes"). */
const COMPARE_MAX_BYTES = 2 * 1024 * 1024

/** T-310 — the current workspace's git-discard drafts, by path (newest first in each). */
async function gitDiscardsByPath(): Promise<Map<string, { file: string; draft: DiscardedDraft }[]>> {
  const workspace = requireRoot()
  const by = new Map<string, { file: string; draft: DiscardedDraft }[]>()
  for (const e of await readAllDrafts()) {
    if (!e.draft || e.draft.workspace !== workspace || !isGitDiscard(e.draft.reason)) continue
    const list = by.get(e.draft.path) ?? []
    list.push({ file: e.file, draft: e.draft })
    by.set(e.draft.path, list)
  }
  for (const list of by.values()) list.sort((a, b) => b.draft.discardedAt - a.draft.discardedAt)
  return by
}

async function fileNow(path: string): Promise<{ mtimeMs: number; content: string | null } | null> {
  try {
    const st = await fsp.stat(abs(path))
    if (!st.isFile()) return null
    const content = st.size <= COMPARE_MAX_BYTES ? await fsp.readFile(abs(path), 'utf8') : null
    return { mtimeMs: st.mtimeMs, content }
  } catch {
    return null
  }
}

/** T-310 — the Discarded section's rows: files with kept copies whose content is not back, newest
 *  discard first. */
export async function discardedFiles(): Promise<DiscardedFile[]> {
  const rows: DiscardedFile[] = []
  for (const [path, list] of await gitDiscardsByPath()) {
    const latest = list.find((e) => e.draft.reason === 'git-discard')?.draft ?? list[0].draft
    const restored = list.map((e) => e.draft.restoredAt ?? 0).reduce((a, b) => Math.max(a, b), 0)
    const shown = discardedRowShown({
      latestAt: list[0].draft.discardedAt,
      kept: latest.content,
      ...(restored > 0 ? { restoredAt: restored } : {}),
      file: await fileNow(path)
    })
    if (shown) rows.push({ path, at: list[0].draft.discardedAt, count: list.length })
  }
  return rows.sort((a, b) => b.at - a.at)
}

/** T-310 — the document at `path` was restored from Document history: its kept git-discard copies
 *  note when, so the row hides once the file is saved. */
export async function markRestored(path: unknown, now = Date.now()): Promise<void> {
  if (typeof path !== 'string') return
  const list = (await gitDiscardsByPath()).get(path) ?? []
  await Promise.all(list.map((e) => enqueue(e.file, () => writeJsonAtomic(e.file, { ...e.draft, restoredAt: now }))))
}

/** T-310 — Forget: delete the kept git-discard copies of `path`. */
export async function forgetDiscarded(path: unknown): Promise<void> {
  if (typeof path !== 'string') return
  const list = (await gitDiscardsByPath()).get(path) ?? []
  await Promise.all(list.map((e) => enqueue(e.file, () => fsp.rm(e.file, { force: true }))))
}

export function registerRecoveryStore(ipc: IpcMain): void {
  defineHandler(ipc, CH.recovery.put, (_e, rec) => putRecord(rec))
  defineHandler(ipc, CH.recovery.get, (_e, path, tabId) => getRecord(path, tabId))
  defineHandler(ipc, CH.recovery.remove, (_e, path, tabId) => removeRecord(path, tabId))
  defineHandler(ipc, CH.recovery.keepDraft, (_e, draft) => keepDraft(draft))
  defineHandler(ipc, CH.recovery.drafts, (_e, path) => listDrafts(path))
  defineHandler(ipc, CH.recovery.discardedFiles, () => discardedFiles())
  defineHandler(ipc, CH.recovery.markRestored, (_e, path) => markRestored(path))
  defineHandler(ipc, CH.recovery.forgetDiscarded, (_e, path) => forgetDiscarded(path))
}
