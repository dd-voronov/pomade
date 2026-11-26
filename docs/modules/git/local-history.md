---
doc: docs/modules/git/local-history.md
audience: engineers, product
holds: local history — 7-day on-disk snapshots of project text files, which changes are kept (open documents, the always / never lists, streaming files), renames, triggering, the in-workspace store, the space cap and Delete versions now
kind: reference
---

# Local history — 7 days of on-disk versions between commits

**Module:** `git` (editor) · **UI:** snapshot rows in [Document history](./document-history.md) · **Code:**
`src/main/local-history.ts` (service), `local-history-scheduler.ts`, `local-history-store.ts`,
`src/shared/local-history.ts` (pure rules), `isDocOpen` in
`src/main/doc-watch.ts`, the **Local history** group in `src/renderer/modules/settings/GeneralSection.tsx` with
`LocalHistoryLimits.tsx` (space and delete), `src/renderer/modules/git/history/` (rows) · **e2e:**
`local-history.spec.ts`, `local-history-streaming.spec.ts`, `local-history-in-workspace.spec.ts`,
`local-history-limits.spec.ts`, `doc-history-rename.spec.ts`, `smoke:scale` [J] · **Contract:** [contracts/documents](../../contracts/documents.md) "Local history"

## What it does

An agent rewrote a ticket at 15:00 and the 11:00 wording was better: Document history lists
`Nov 11 11:00 · changed on disk` and the paragraph comes back. Every time the content of a project text file
changes — written by another process (an agent, git, an app, Obsidian, Finder) or saved in Pomade — Pomade
keeps that content as a **snapshot** (unless the file is a [streaming file](#which-changes-keep-a-version)), for **7 days**, in the workspace's own store (see [Storage](#storage)). A snapshot row shows
`Nov 11 11:42 · saved in Pomade` or `… · changed on disk` and `local version · 1.2 KB`.

Snapshots are one more kind of History row, in their own **Local versions** group, newest first, between the
discarded versions and the commits; the newest one, while it holds exactly the disk text, is shown as the
**Saved** row of the Current group instead ([Document history](./document-history.md#the-saved-row)). Click a snapshot → the comparison tab (version ↔ current document, with per-chunk **→ take old**);
tick two rows → version ↔ version; **Restore** → the whole version as one unsaved edit (Cmd+Z undoes it). The
list refreshes the moment a new snapshot is kept. A file that is not in a repository has the same rows (the
panel's *Git history appears when this file is in a repository.* line stays).

A file that did not change while Pomade ran has no snapshot: nothing walks the workspace, and Pomade only
sees what happens while it is open.

## Limits

| Limit | Value |
|---|---|
| How long a version is kept | 7 days |
| Which files | text files under the workspace, not empty, at most 2 MB, not gitignored, not binary (see "Which files") |
| Which changes | every change of an open document or an always-listed extension; any other file until it streams (see "Which changes keep a version") |
| Store size | 256 MB per workspace by default, a setting (64 MB – 2 GB); above it the oldest versions go first (see "Space and Delete versions now") |
| Seen changes | only while Pomade runs |

The 7 days, the 2 MB per file and the streaming threshold are fixed. Settings ▸ General ▸ **Local history** controls the
extensions that keep every change and those that keep none (below), the **Space for local versions**, and **Delete versions now**
([Space and Delete versions now](#space-and-delete-versions-now)).

## Renames and moves

A file's local history follows it to a new name. Renaming or moving it in Pomade (the tree's Rename, the tab's
rename, Cut/Paste, drag and drop — a file or a whole folder) carries its snapshots to the new path and keeps one
more snapshot there: `Nov 17 12:49 · renamed from T-2.md` (`moved from docs/old/` to another folder, `moved from
docs/old/T-2.md` when both changed). It holds the text the file arrived with — the first version under the new
name when the file had none yet; when it is the text of the version below it, its second line reads *same text —
only the name changed*. The watcher's own events for the rename add nothing more. The rename's row and the
versions below it are the document under its earlier name: Document history labels them with that name, and their
Restore renames the document back ([Document history](./document-history.md) §"Versions under an earlier
name").

A rename outside Pomade (a terminal `mv`, `git mv`, Finder) is recognized when the file that appears holds
exactly the newest snapshot of a path that no longer exists: that path's snapshots follow, with the same
`renamed from` row. A file that had no snapshot before an outside rename cannot be recognized: under its new
name it starts with a plain `changed on disk` version.

## Which files

A snapshot is kept when the file is a regular text file in the workspace and **all** of these hold:

- the path is not under `node_modules`, `.git`, `.pomade` or a local-history store (`Apps/Pomade/local-history`, `Apps/Pomade/dev/local-history`), not a `.DS_Store`, an editor backup (`name~`) or a
  temp file, and its extension is not a binary / generated one (images, audio, video, archives, office files,
  fonts, executables, databases, `.lock`, …; `.log` is not on this list — it is a default of the never-list) — decided by name, before anything is read;
- the file is not empty and is at most **2 MB**;
- its bytes are valid UTF-8 with no NUL byte in the first 8 KB;
- the content differs from the path's newest snapshot (same content again is no new version and no
  [burst](#which-changes-keep-a-version), even after a `touch` or a rewrite);
- git does not ignore it (`git check-ignore`; a file outside any repository is never ignored). A path git
  ignores is not asked again for a minute, so an ignored file written all the time costs one check a minute.

Files outside the workspace (an outside mount, an absolute-path doc) have no snapshots.

## Which changes keep a version

For a trackable file (below) the version rule (`versionRule` in `shared/local-history.ts`) decides how a change
by **another writer** is treated, in this order:

1. **Every change** — the document is open in the Editor of any project (`isDocOpen`: the doc-watch open set,
   the paths the renderer declared), or the file name ends in an extension of the setting **Always keep every
   change for** (default `.md`, `.txt`). A version per quiet window, however often it changes.
2. **None** — the file name ends in an extension of **Never keep versions of** (default `.log`, `.jsonl`,
   `.ndjson`). A streaming file by name: its events are dropped before the quiet window, nothing is read.
3. **Bursts** — any other file. Each quiet window that finds a **change of content** is one *burst*: the
   file is read and its hash differs from the path's newest snapshot. A touch or a rewrite of the same text
   (new mtime, same content) counts nothing. Content with no snapshot baseline to compare (binary or invalid
   UTF-8) counts at every new stat. More than **12 bursts within an hour** makes it a **streaming file**: no
   versions until it has been quiet for an hour (`StreamingFiles` in `local-history-scheduler.ts`; the versions
   it already has stay). A file already streaming is **not read**: a new stat alone (mtime + size) is
   counted against it, so it stays streaming until an hour passes with no new stat. The count is kept in memory
   (cleared on a workspace switch) and for at most as many paths as the stat cache holds, least recently
   changed forgotten first.

**Pomade's own saves, moves and `keep` requests skip the rule**: a save or move marks the path `forced` and its next job
always keeps the content; `keep` runs the job with `force` at once. Extensions are matched at the end of the file name, case-insensitive (`.tar.gz` works too);
Settings ▸ General ▸ **Local history** edits both lists (entries normalize to `.ext`) and main applies an edit
at once (`onAppSettingsChanged`), without a restart. The burst threshold is not a setting. A file in the never-list
that is open in the Editor still gets every change (the order is the rule).

## How it is triggered

The platform watcher (a tap on `fs-watch.ts`, as git state and apps use) — Pomade holds one recursive descriptor on the
workspace root, so **every project** is covered, not only the active one. An event for a path under the *none* rule is dropped; any other only touches the path's quiet
window: nothing is read until the path has been quiet for **1.5 s** (a file written without pause is
snapshotted 20 s after its first event anyway), then the path's job runs on a pool of **2 workers**. At most
**2000** distinct paths wait at once; a burst beyond that (a checkout rewriting thousands of files — git already
holds those) drops the extra paths. A stat identical to the last one looked at (mtime + size) is skipped without
a read.

**Pomade's own save** skips the quiet window and the version rule: right after the write succeeds the editor's save door tells the
service, which snapshots that content at once and marks it *saved in Pomade*. A snapshot whose content is
exactly what Pomade last saved at that path is *saved in Pomade*; every other one is *changed on disk*. The
watcher's own event for the save finds the same content and adds nothing.

**Before a version tab replaces a document** ([Document history](./document-history.md#a-version-in-its-own-tab)),
`localHistory.keep(path)` snapshots the file's current content at once, so the text being replaced is always a
local version; it answers whether local history keeps that file at all (if not, the editor keeps a discarded
draft instead).

## Storage

Each workspace keeps its own store inside it: `<workspace>/Apps/Pomade/local-history/` for the installed Pomade,
`<workspace>/Apps/Pomade/dev/local-history/` for a dev build (`localHistoryStoreDir` in `shared/local-history.ts`), so
the two never write one store at once. The store travels with the workspace folder (the Owner's folder sync) and is
never committed: it carries its own `.gitignore` (`*`). Activating a workspace creates the folders and the
`.gitignore` (`createStoreDirs`), before any watcher runs; the store is opened with the workspace.

- `blobs/<hash>.txt` — one file per distinct content; equal content is stored once, even across paths.
- `paths/<key>.json` — per workspace-relative path: its snapshots `{ at, hash, size, origin, from? }`, oldest first. The key
  hashes the relative path alone (never the absolute root), so a workspace opened at another path or on another Mac
  still reads its versions.

The store's own paths are skipped by name (`isLocalHistoryStorePath`) by the snapshot rule, the watchers and the name
and content indexes, and the tree shows the folder only with ignored items; writing a snapshot raises no tree,
index or git-state event. Recovery copies and discarded drafts stay in the machine's user data
([Document history](./document-history.md)).

Writes are atomic and all mutations run on one FIFO queue, so a prune never removes a blob a write in flight is
about to use. **Retention:** snapshots older than 7 days are removed; then, while the distinct content kept
exceeds the cap, the oldest snapshots go first (content shared by several snapshots counts once and
is freed with the last of them); then every blob no snapshot references. The prune runs 30 s after launch, then
hourly — never in the startup path.

### Space and Delete versions now

Settings ▸ General ▸ **Local history** (`LocalHistoryLimits.tsx`), after the two extension lists:

- **Space for local versions** — the store's cap: 64 MB, 128 MB, 256 MB (default), 512 MB, 1 GB or 2 GB
  (`LOCAL_HISTORY_CAP_CHOICES_MB`; setting `localHistoryCapMb`, a preference in `.pomade/settings.json`). The hint
  reads `When local versions take more, the oldest go first. Now: <size>.` Raising it applies at once. Lowering it
  to a size the store exceeds first asks `Lower the space to <cap>?` with what would go (`3 versions, 1.2 MB`,
  `previewCap`); **Lower and delete** applies it and prunes at once instead of waiting for the hourly prune; cancel
  keeps both the cap and the versions. A value outside the list (a hand edit) is shown as an extra choice.
- **Delete versions now** — **Group** (`Local versions` or `Discarded`), **Older than** (`Any age`, `1 day` …
  `6 days`) and a live count: `3 versions, 1.2 MB`, or `Nothing to delete` (the **Delete…** button is then
  disabled). The line under it names the scope and says it applies *in this workspace*. **Delete…** confirms with the same
  count (`Delete local versions?` / `Delete discarded versions?`, *This can’t be undone.*). The count refreshes when a
  version is kept or removed or a draft is discarded (at most every 300 ms). Preview and delete take the same
  `before` moment, so the delete removes exactly what was counted. Local versions are removed whatever the cap
  (`purge` in the store: every snapshot observed before the moment, plus those with an unreadable time);
  Discarded removes the current workspace's discarded drafts older than the age (`purgeDrafts` in `recovery-store.ts`).
  The bytes counted are only what no remaining snapshot shares (`removalSize`). A toast reports `Deleted 3 versions,
  1.2 MB.`

Main: `localHistory.previewPurge`, `purge` and `previewCap` ([contracts/documents](../../contracts/documents.md) "Local history").

## Test hooks

`POMADE_TEST_LOCAL_HISTORY_DEBOUNCE_MS`, `…_MAX_WAIT_MS`, `…_PRUNE_DELAY_MS` (tuned intervals, the usual
`tunedMs` contract) and `POMADE_TEST_LOCAL_HISTORY_CAP_BYTES` (the size cap, over the setting). The store takes its clock, retention
and cap by constructor (`LocalHistoryStore`), so unit tests pin all three.

Tickets: E-044, T-274, T-297, T-234, T-314.
