---
doc: docs/contracts/documents.md
audience: engineers
holds: the document-version surface — the open-doc watcher (rule 8), recovery copies and discarded drafts, local history, comparison sources, the Document history model, version tabs, doc channels and the EditorController
kind: reference
---

# Documents: watcher, recovery, local history, versions

**Rule 8 — the file on disk is the truth.** Pomade never holds a document's text anywhere a writer
can miss it: every open doc's path is watched, every write (Pomade's, an agent's, an app's) is
reported, and an unsaved buffer is copied to user data. None of this writes into the workspace.

## Open-doc watcher

```ts
fs.watchDocs(paths: string[]): Promise<void>      // replace the watched set; ws-relative or absolute; '' ignored
fs.onDocChanged(cb: (path: string) => void): () => void   // EV 'fs:doc-changed', path as declared
```

- Main `doc-watch.ts`, separate from the tree watchers: one **non-recursive** `fs.watch` per distinct
  parent folder, debounced per doc (120 ms). Stopped on workspace teardown.
- It reports every writer, Pomade included. The renderer filters Pomade's own writes by the doc's
  sync point: `writeTo` sets the sync hash to the bytes it is about to write **before** the write
  (restored on failure).
- Renderer: `modules/editor/open-doc-watch.ts` (`startOpenDocWatch`, mounted once) declares every
  doc tab's path in every project plus every comparison's `file`/`disk` path, and fans the event out
  through one listener.
- Diagnostic: `globalThis.__pomadeDocWatch.dirs` — descriptors held.

## Recovery copies and discarded drafts (`shared/recovery.ts`, main `recovery-store.ts`)

```ts
recovery.put(rec: RecoveryPut): Promise<void>           // store (replace) the doc's copy
recovery.get(path: string, tabId: string): Promise<RecoveryRecord | null>
recovery.remove(path: string, tabId: string): Promise<void>
recovery.keepDraft(draft: DraftPut): Promise<void>      // keep a draft, then drop the copy
recovery.drafts(path?: string): Promise<DiscardedDraft[]>   // current workspace, newest first
recovery.discardedFiles(): Promise<DiscardedFile[]>      // the Git panel's Discarded rows: files not back
recovery.markRestored(path: string): Promise<void>       // a restore from Document history: stamps restoredAt
recovery.forgetDiscarded(path: string): Promise<void>    // Forget: delete the path's git-discard drafts

interface SyncPoint { mtimeMs: number; hash: string }
interface RecoveryRecord { workspace; path /* '' = Untitled */; tabId; title; content; savedAt; base: SyncPoint | null; stretchId }
interface DiscardedDraft { id /* = stretch id */; workspace; path; tabId; title; content; discardedAt; reason: DraftReason; restoredAt?: number }
interface DiscardedFile { path; at /* newest discard */; count }
type DraftReason = 'close' | 'quit' | 'recovery-discard' | 'load-disk' | 'git-discard' | 'git-discard-staged' | 'replaced'
type RecoveryPut = Omit<RecoveryRecord, 'workspace'>
interface DraftPut { id; path; tabId; title; content; reason; recoveryPath?: string }
```

- A doc is keyed by the current workspace plus `path:<path>`, or `untitled:<tabId>` for an Untitled
  doc (`docKeyOf`, `recoveryKey`, `recoveryFileName`).
- Files: `<userData>/recovery/buffers/<key>.json` (one copy per dirty doc) and
  `<userData>/recovery/drafts/<key>.json` (one per editing stretch — discarding the same stretch
  twice overwrites). Atomic writes, one FIFO queue per file. `keepDraft` writes the draft, then
  removes the copy under `recoveryPath ?? path`. `pruneDrafts()` runs once per launch (TTL
  `DRAFT_TTL_MS` = 7 days, every workspace). `measureDrafts(before)` / `purgeDrafts(before)` (T-234):
  the current workspace's drafts discarded before `before` (`draftsBefore`), sized by their files.
- `RECOVERY_DEBOUNCE_MS` = 2000: the copy is taken that long after the last edit while dirty,
  removed on clean, moved on a path retarget. `flushAllRecovery()` runs inside the quit flush.
- Pure verdicts: `contentHash` (cyrb53, hex); `syncVerdict(sync, disk)` → `in-sync` | `needs-hash` |
  `changed` | `missing` (same mtime ⇒ in sync; a differing mtime is decided by the bytes' hash);
  `recoveryVerdict(base, diskHash)` → `recovered` | `changed`; `isGitDiscard(reason)`.

## Local history (`shared/local-history.ts`, main `local-history*.ts`)

```ts
localHistory.list(path: string): Promise<SnapshotRef[]>     // current workspace, newest first
localHistory.read(path: string, id: string): Promise<string | null>   // null = no longer kept
localHistory.keep(path: string): Promise<boolean>
localHistory.previewPurge(group: PurgeGroup, olderThanDays: number): Promise<PurgePreview>
localHistory.purge(group: PurgeGroup, before: number): Promise<RemovalSize>
localHistory.previewCap(capMb: number): Promise<RemovalSize>
localHistory.onChanged(cb: (path: string) => void): () => void       // EV 'localHistory:changed'

type SnapshotOrigin = 'disk' | 'saved' | 'renamed'
interface SnapshotEntry { at; hash; size; origin; from?: string /* a rename's old path */ }
interface SnapshotRef extends SnapshotEntry { id: string /* `${at}-${hash}` */ }
type PurgeGroup = 'local' | 'discarded'          // Document history's group ids
interface RemovalSize { versions: number; bytes: number }
interface PurgePreview extends RemovalSize { group: PurgeGroup; before: number /* epoch ms */ }
```

- Paths are workspace-relative. `keep(path)` snapshots the current content now, no quiet window:
  true when that content is the path's newest snapshot afterwards; false when local history does
  not keep the file (absolute path, not trackable, ignored by git, empty, missing).
- Limits: `SNAPSHOT_TTL_MS` 7 days, `SNAPSHOT_MAX_FILE_BYTES` 2 MB, `SNAPSHOT_CAP_BYTES` 256 MB
  (tunable in tests). `isTrackablePath(rel)` excludes `node_modules`, `.git`, `.pomade`,
  binary/generated extensions, backup and temp names; `looksBinary` = a NUL in the first 8000 bytes.
- Recording: `startLocalHistory()` holds one app-style watch on the workspace root
  (`holdAppWatch('')`) and taps its raw changes; per path (debounced by `PathScheduler`: quiet window
  1500 ms, max wait 20 s, bounded pool, excess paths dropped): cheap filters → version rule → stat
  → (streaming file: stop, unread) → read → UTF-8/NUL check → newest-hash check → burst count →
  `git check-ignore` → `record` (`'disk'`).
- Version rule (`versionRule(rel, lists, openInEditor)`, in this order): a document open in the
  Editor (`doc-watch.isDocOpen` — the `fs.watchDocs` set) or an extension in
  `AppSettings.localHistoryAlways` → `'every'` change kept; an extension in `localHistoryNever` →
  `'none'` (a **streaming file**; its events are dropped before the quiet window); otherwise
  `'bursts'`: each quiet window that finds changed content (new text; for binary or invalid UTF-8,
  which have no baseline, a changed stat) counts one burst (`StreamingFiles`), and
  more than `STREAMING_BURSTS` (12) within `STREAMING_WINDOW_MS` (1 h) make it a streaming file — no
  versions until a full hour passes with no burst; its versions stay. Pomade's own save, move and
  `keep` skip the rule. Extensions match the end of the file name, case-insensitive
  (`hasListedExtension`).
  `fs.write` calls `noteSaved` (records `'saved'` at once); `fs.rename` / `fs.move` call
  `noteMoved(from, to)` (carries a file's or folder's snapshots to the new path and keeps a
  `'renamed'` snapshot). A new path whose content is exactly the newest snapshot of a path that no
  longer exists (a terminal `mv`) is `'renamed'` too. Prune 30 s after start, then hourly
  (`planPrune`: expired first, then oldest until the distinct content fits; shared content counts once).
- Limits (T-234): the cap is `AppSettings.localHistoryCapMb` (`capBytesOf`; the test hook
  `POMADE_TEST_LOCAL_HISTORY_CAP_BYTES` overrides it). A lower cap saved by the user prunes at once;
  `previewCap(mb)` is what that prune would remove now (`planPrune` + `removalSize`: content shared with
  a version that stays frees nothing). `previewPurge(group, days)` counts the current workspace's
  versions of the group kept before `now − days` (0 = all; `planPurge` for `'local'`, `measureDrafts`
  for `'discarded'`) and returns that `before`; `purge(group, before)` deletes exactly those. Every
  prune and purge emits `localHistory:changed` for each path that lost versions; a Discarded purge
  emits nothing (the renderer bumps `git-ops-store.draftsNonce`).
- Store: one per workspace, in the workspace — `localHistoryStoreDir(flavor)`:
  `Apps/Pomade/local-history/` for the stable Pomade, `Apps/Pomade/dev/local-history/` for a dev
  build (`buildFlavor`; `POMADE_TEST_BUILD_FLAVOR` under test). Layout `blobs/<hash>.txt` +
  `paths/<key>.json` (`{ path, entries }`, key = `recoveryFileName(path)` — the workspace-relative
  path alone, so a workspace copied to another path or Mac keeps its versions) + `.gitignore` (`*`).
  Atomic writes; one FIFO queue for every mutation. `isTrackablePath` excludes both flavors' store
  folders (`isLocalHistoryStorePath`); the platform watcher, the name and frontmatter indexes and the
  tree skip them by the same path test, which also covers the unwatched folders (`isSkippedPath`) ([ipc-workspace-and-files](ipc-workspace-and-files.md)). `LocalHistoryStore` API (all paths workspace-relative):
  `record`, `newestHash`, `list`, `read`, `move`, `known`, `prune` (resolves the paths that lost
  versions), `ensureDirs()`,
  `setCap(bytes)`, `measurePrune(capBytes)`, `measurePurge(before)`, `purge(before)` (resolves
  `{ removed, paths }`). Opened at boot and on workspace
  ready, dropped on teardown; the store follows a workspace switch. The workspace bootstrap
  (config-store, before `workspace:ready` and before any tree or watcher) creates the active flavor's
  store folder with `createStoreDirs`, so a first snapshot never creates `Apps/` or `Apps/Pomade/`
  mid-session.

## Comparison sources (`shared/compare.ts`)

```ts
type CompareSource =
  | { kind: 'rev'; repo: string; rev: string /* hash or 'HEAD' */; path: string /* ws-relative at that rev */ }
  | { kind: 'file'; path: string }       // the live document (shares the doc tab's buffer)
  | { kind: 'disk'; path: string }       // read-only disk
  | { kind: 'draft'; path: string; id: string; at: number }
  | { kind: 'snapshot'; path; id; at; origin: SnapshotOrigin; from?; pathThen? }
  | { kind: 'none' }
type CompareMode = 'version-current' | 'version-version' | 'file-file' | 'disk-mine'
type RevisionFile = { kind: 'text'; content; commit: RevisionInfo } | { kind: 'absent'; commit }
  | { kind: 'binary'; size; commit } | { kind: 'too-big'; size; commit } | { kind: 'no-revision' }
const COMPARE_MAX_BYTES = 2 * 1024 * 1024
```

`compareMode`, `rightIsLive`, `sourcePath`, `compareKey` (opening the same pair again focuses its tab),
`compareTitle`, `sameSource(a, b)` (the same version: kind plus identity — a rev's repo, rev and path, a
draft's or snapshot's id, a file's or disk's path — whatever optional fields either carries).

A comparison tab's sources change in place (T-224, its version chips): `setComparisonSides(projectId, tabId,
left, right)` in `modules/git/open-compare.ts` writes `left`, `right` and the recomputed `title` through
`updateTab` and keeps the tab (a preview tab is committed). The pane is keyed by `compareKey`, so a new pair
re-reads both sides and rebuilds the merge view in its mode. No dedup on this path: two tabs may hold the same
pair. `pathThen` = the path the document had when a snapshot was kept, set only when it
differs. A `rev` side is read through `git.fileAt` ([git-state-and-history](./git-state-and-history.md));
a draft or snapshot that was pruned renders "no longer kept". `shared/text-change.ts#minimalChange(from, to)`
is the one prefix/suffix-trimmed replacement the CodeMirror editors apply outside changes with.

## Document history model (`shared/doc-history.ts`)

```ts
type HistoryRow = { kind: 'unsaved' } | { kind: 'draft'; draftId; at; reason }
  | { kind: 'discarded'; draftId; at; staged }
  | { kind: 'saved'; at; size; git: SavedGit; snapshot?: { snapshotId; origin } }
  | { kind: 'commit'; commit: FileCommit }
  | { kind: 'snapshot'; snapshotId; at; origin; size; from?; sameText?; pathThen? }
type SavedGit = { state: 'changed'; isNew; from? } | { state: 'committed'; hash } | { state: 'none' }
// savedMeta(row), the Saved row's second line: `not committed` | `new file · not committed` |
// `renamed from <name> · not committed` | `same as <short hash>` | `local version · <size>`
interface DiskFile { mtime; size; hash: string | null }   // HistorySources.disk; null = not on disk
const HISTORY_GROUPS = ['current', 'discarded', 'local', 'commits']   // ROW_GROUP maps kinds to groups
```

`buildHistoryRows`, `groupRows`, `currentRow` (Unsaved edits while dirty, else the saved row),
`rowSource(row, ctx)` (the row's version as a `CompareSource`), `rowVsCurrent`, `earlierPath`,
`orderPair`, `rowTime`. For a comparison's version chips (T-224): `sideSource(row, side, rows, ctx)` (on the
right, `currentRow` is the live document `{ kind: 'file' }`; otherwise `rowSource`), `rowOnSide`, and
`pickForSide(row, side, { left, right }, rows, ctx)` → `SidePick` = `{ kind: 'set' | 'swap'; left; right }`
(swap: the row is the other side's version) | `{ kind: 'same' }` | `{ kind: 'blocked'; reason }` (the live
document on the left — `LIVE_RIGHT_ONLY` — or a swap that would put it there — `LIVE_SWAP_BLOCKED`). The saved row is the file on disk, whenever it exists; it absorbs the newest
snapshot when that snapshot's `hash` equals `disk.hash` (`blobHash` of the disk text, from
`shared/local-history.ts`) and the snapshot is not a rename's. A new row source adds a kind, a group
and a `rowSource` case. Folded groups persist in `AppSettings.docHistoryFolded`; `foldedGroups` reads
a saved `changes` as `current`, `withGroupFolded` writes a fold.

## Version tabs (`shared/doc-version.ts`)

```ts
type VersionSource = Extract<CompareSource, { kind: 'rev' | 'draft' | 'snapshot' }>
interface DocVersion { source: VersionSource; label: string }   // DocTab.version
```

A version tab is a `DocTab` whose `path` is the document and whose `version` names where its text
came from. It is **not** the document's tab: every "the doc tab for a path" lookup uses
`isDocTabOf(tab, path)` / `sameDocTab(a, b)`. One tab per version (`sameVersion`); title
`versionTabTitle(versionPath(source, docPath), label)` (`notes.md @ 0b8e744`); `retargetVersion`
follows a document move. Its Save replaces the document after a confirm, keeping the replaced text
first (`localHistory.keep`, else a `'replaced'` draft). It runs no rule-8 checks, keeps its recovery
copy under `''` + its tab id, and registers no doc channel.

## Doc channels and the editor controller (renderer)

- **`DocChannel`** (`modules/editor/doc-buffers.ts`): each mounted `EditorPane` of a document
  registers `{ tabId, projectId, path(), read(), state(): { loaded, dirty, changedOutside, missing,
  refused }, write(next), save(), reload(), dismissChange(), keepMine(), loadDisk(), subscribe(fn) }`.
  `findDocChannel(projectId, path)`, `findDocChannelsFor(path)`, `onDocChannels(fn)`,
  `readDocBuffer(tabId)`. The quick peek and the comparison tab read and edit a live buffer only
  through it.
- **`EditorController`** (`modules/editor/editor-controller.ts`): each engine (raw, live, rendered,
  table) registers one with `EditorPane`. Common: `kind`, `getSelection()`,
  `replaceRange(from, to, text)`, `focus()`. Optional: `replaceDocument(text): boolean` (one
  undoable edit; rendered returns false when it cannot parse), `flushPendingEdits()` (emits an edit
  not yet reported — rendered reports through a 200 ms debounce; every save path, draft keeping and
  buffer read flush first), `openFind` / `closeFind`, `gotoLine(n)`, `find`, caret and viewport
  anchors (`getCaretAnchor` / `setCaretAnchor` / `getViewportAnchor`).

Tickets: E-035, E-037, E-038, E-044, T-142, T-219, T-223, T-224, T-226.
