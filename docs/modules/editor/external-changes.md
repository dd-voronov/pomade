---
doc: docs/modules/editor/external-changes.md
audience: engineers, product
holds: rule 8 in the editor — how a write by any other writer is detected, the notices and amber banner, Compare / Keep mine / Use disk version, the save-time conflict guard
kind: reference
---

# External changes — the file on disk is the truth

**Module:** `editor` · **UI:** the notices under the header ("This file changed on disk outside Pomade.", the
amber "File changed since your edits.", "This file no longer exists on disk …"), the comparison tab's
resolution bar, the "File changed on disk" confirm · **Code:** `src/renderer/modules/editor/useDocFile.ts`
(sync point, `checkDiskRef`, reload, Keep mine), `doc-io.ts` (`probeDisk`), `DocNotices.tsx`,
`open-doc-watch.ts` (renderer fan-out), `doc-buffers.ts` (the doc channel), `useSavePipeline.ts` (conflict
guard), `src/main/doc-watch.ts` (the watcher), `src/shared/recovery.ts` (`SyncPoint`, `syncVerdict`),
`src/renderer/modules/git/compare/ComparePane.tsx` (resolution bar) · **e2e:** `rule8-recovery.spec.ts`,
`editor-save-state.spec.ts`

## What it does

[PLATFORM](../../PLATFORM.md) rule 8: the file on disk is the truth. Any writer — an agent, git, an app,
Obsidian, Finder — may change a file that is open in Pomade, and Pomade never overwrites either version
silently and never reloads on its own. A doc without unsaved edits gets a notice with **Reload** / **Dismiss**;
a doc with unsaved edits gets an amber banner whose **Compare** opens a side-by-side where the two
versions are reconciled; a file that disappeared says so.

## Detection

**The open-doc watcher** (`src/main/doc-watch.ts`). The renderer declares the set of every open doc path in
every project (outside-workspace docs and the disk and live sides of comparison tabs included) through
`fs.watchDocs` (`startOpenDocWatch`, replace semantics). Main keeps **one non-recursive `fs.watch` per distinct
parent directory** of those docs, bounded by the number of open docs and never a recursive walk. Watching the
directory rather than the inode survives writers that replace a file by rename (atomic saves, `git checkout`,
most editors). A change to a doc's entry broadcasts `fs:doc-changed` after a 120 ms debounce, so a write is
caught when it lands, also in a background project. One IPC listener fans the events out to the panes.
Pomade's own saves trip it too; telling them apart is the renderer's job.

**Backstops.** The file tree's per-root watcher (`fs.onChanged`) triggers the same check, and a pane re-checks
once each time it becomes visible after being hidden (a parent folder renamed away, a watcher the OS tore
down).

**The sync point.** Each doc keeps the disk state its buffer last agreed with: the file's mtime plus a hash of
its bytes, set by Pomade's own load, save, reload and Keep mine. `probeDisk` stats the file; the same mtime
means in sync, a different mtime means read and hash the bytes. **Bytes decide, never the clock**: a touch, a
checkout to identical content, or Pomade's own save racing its watcher event is in sync (the sync point
follows the new mtime). A refused file, never read, treats any mtime change as a change. A missing file is
reported as missing. Pomade's own save, an in-app rename or move, and retargeting never show a banner: a save
moves the sync point to the bytes it is about to write before the write, and in-app renames and moves retarget
open tabs across all projects with buffer and dirty state intact. App writes through the platform file layer
count as external.

## What the user sees

**Doc without unsaved edits.** The notice **"This file changed on disk outside Pomade."** with **Reload**
(re-reads the disk; the Rendered and CSV views remount) and **Dismiss** (a later change raises it again). The
header Save button reads `Save`, not `Saved`, while the disk differs.

**Doc with unsaved edits.** The amber banner **"File changed since your edits."** with **Compare**; neither
the disk nor the buffer changes on its own. Compare opens a [comparison tab](../git/comparison-tab.md)
**disk ↔ my edits**: the file on disk now on the left, the doc's own buffer (editable) on the right, and a bar
("The file changed on disk since your edits. Take what you need from the left, then save — your version
replaces the disk one.") with the two resolutions:

- **Keep mine**: the buffer stays dirty and the bar closes. The current disk becomes the sync point, so the next
  save writes the buffer without a conflict prompt (an explicit choice), and the recovery copy is rewritten
  against the new sync point.
- **Use disk version**: the buffer becomes the disk content and the edits are kept as a discarded draft
  ([unsaved-recovery.md](./unsaved-recovery.md)).

Taking chunks from the left and pressing Cmd+S in the comparison tab is the same choice as Keep mine, then
save. The comparison tab of a doc shows the doc's notices too: a doc and its comparison share one buffer, one
dirty flag and one save path through the **doc channel** (`doc-buffers.ts`), which also feeds the Cmd+Shift+G
quick peek. An edit made there replaces the buffer here as an unsaved edit, and the Rendered or CSV view
remounts the next time the pane is shown.

**File missing.** **"This file no longer exists on disk (moved or deleted). Saving will recreate it."**

**Save-time guard.** The watchers only raise a passive hint; the authority is the probe a save runs before
writing (`handleSave` in `useSavePipeline.ts`), which also catches a divergence the watchers missed. If the disk
changed since the sync point the **"File changed on disk"** confirm appears (**Cancel** / **Reload instead** /
**Overwrite**, see [save-and-file-lifecycle.md](./save-and-file-lifecycle.md)). Quit's Save all docs treats a
diverged file as blocked instead of asking.

## Boundaries worth knowing

- Dirty tabs on the same file in two projects are never merged; each compares against the disk on its own.
- Version tabs have no rule-8 checks.
- Test hook: `globalThis.__pomadeDocWatch.dirs` (main process) is the number of directory watches held.

Tickets: E-016, E-030, E-035, E-037, T-142.
