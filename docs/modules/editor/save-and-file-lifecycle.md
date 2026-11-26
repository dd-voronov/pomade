---
doc: docs/modules/editor/save-and-file-lifecycle.md
audience: engineers, product
holds: saving, dirty state, the close and quit guards, Untitled docs, refused files, outside-workspace files, version tabs
kind: reference
---

# Save, dirty state & file lifecycle — explicit saves, close guards, refusals

**Module:** `editor` · **UI:** the header `Save` button, dirty dots, the "Unsaved changes" dialog, the Save As
and overwrite dialogs, the "File changed on disk" confirm, the refusal panel, the outside-workspace save
confirm · **Code:** `src/renderer/modules/editor/EditorPane.tsx` (wiring), `useSavePipeline.ts` (every write),
`useDocFile.ts` (load, buffer, dirty flag), `doc-io.ts` (fs doors, CRLF, size limit), `EditorDialogs.tsx`
(dialogs), `stores/tabs-store.ts` (close, save-all and discard-all guards) · **e2e:** `editor.spec.ts`,
`editor-roundtrip.spec.ts`, `editor-save-state.spec.ts`, `editor-refusal-save.spec.ts`,
`editor-refusal-save-tooltip.spec.ts`, `terminal-outside-workspace.spec.ts`,
`outside-unsupported-in-tab.spec.ts`, `refusal-reveal-button.spec.ts`, `outside-doc-restore.spec.ts`,
`quit-dirty-docs.spec.ts`, `editor-untitled-markdown.spec.ts`

## What it does

Pomade never writes a doc behind your back: **there is no autosave**. Every disk write is an explicit
**Cmd+S**, the header **Save** button, a **Save** in the close guard, a **Save all docs** at quit, or Save As.
A doc is dirty when its buffer differs from the last saved bytes; dirty shows as an accent dot in the pane
header and on the tab. Closing a dirty doc always prompts. Files changed on disk by any other writer raise a
notice or banner, never an automatic reload ([external-changes.md](./external-changes.md)); unsaved edits
survive a crash and a discard is recoverable for 7 days ([unsaved-recovery.md](./unsaved-recovery.md)).

## Saving

- **Cmd+S** is captured at the editor pane root (`onKeyDownCapture` in `EditorPane.tsx`, so it works while
  CodeMirror, Milkdown, the CSV table or the Properties panel holds focus) and also bound inside the
  CodeMirror editors. It is not a global app-menu accelerator: focus must be inside the pane.
- A save writes every keystroke, even one pressed right after typing in Rendered (whose edits reach the
  buffer through a 200 ms debounce; the save flushes it first).
- Writes keep file fidelity: CRLF line endings and the trailing-newline state are recorded on load and
  reconstructed on save (`normalize` / `reconstruct` in `doc-io.ts`). A failed write shows an error toast
  `Could not save <name>: …` and keeps the doc dirty.
- Before overwriting, the save probes the disk against the doc's sync point. If another writer changed the
  file, a confirm **"File changed on disk"** asks: `“<name>” was modified on disk since you opened it.
  Overwrite it with this version, reload the disk copy (discarding your edits), or cancel?` with **Cancel**,
  **Reload instead** (discards the buffer, no write) and **Overwrite**. A file that vanished is not a
  conflict: Save recreates it.
- The header button reads `Saved` (disabled) only when the buffer is clean and the disk agrees; see
  [editor-header.md](./editor-header.md).
- **Untitled docs** open the Save As modal (**"Save new document"**, field "File name (relative to
  <project root>)", placeholder `notes.md`, Enter confirms, Esc cancels). Save As writes **exclusively**:
  an existing file is never clobbered silently; a collision raises **"File already exists"**
  (`“<name>” already exists. Overwrite it with this document?`) with **Cancel** / **Overwrite**. Parent
  directories are created as needed. After the write the tab takes the new path and title.
- **First save resolves an Untitled doc's kind.** While unsaved, an Untitled doc is markdown by policy
  ([editing-modes.md](./editing-modes.md)). The name given at Save As assigns the real extension: a markdown
  extension keeps the markdown treatment; any other reclassifies the tab to that kind (`.txt` plain text,
  `.csv` gains the table view, `.js` code).

## Closing: the guard

Closing a dirty doc (tab ×, header ×, Cmd+W, batch closes) shows **"Unsaved changes"**:
`“<title>” has unsaved changes. Save before closing?` with three buttons:

- **Cancel**: keeps the doc and, in a batch close, **aborts the rest of the batch**.
- **Discard**: closes without saving; the unsaved state is kept as a discarded draft.
- **Save**: writes, then closes; a failed write keeps the prompt open. An Untitled doc routes to Save As
  instead (closing is cancelled, so the batch stops too).

Batches prompt sequentially, one doc at a time. The ⋯ menu offers **Close saved docs** (clean tabs only, no
prompts) and **Close all docs** (every doc through its guard).

## Quit

A dirty buffer is never written on quit. When any doc tab is dirty (any project), the quit flow raises a
third confirm, **"Unsaved documents"** (`N documents have unsaved changes.`), after the "Quit Pomade?" and
running-sessions stages: **Save all docs**, **Discard all changes**, **Cancel** ([contracts/ipc-app](../../contracts/ipc-app.md) "Quit pipeline"). **Save all** runs every dirty doc through its pane's non-interactive save (`saveForQuit`): the normal
write door with the conflict probe, which never raises a dialog. A doc that cannot be saved unattended
(refused, changed on disk, an outside-workspace file not yet confirmed, Untitled, or a version tab) is named
and the quit is aborted, never discarded. **Discard all** is the deliberate drop (each buffer kept as a
discarded draft); **Cancel** keeps everything dirty. A dirty buffer also survives project switches within a
session.

## What opens in the editor

Any text file opens. Markdown and CSV additionally get their rich views ([editing-modes.md](./editing-modes.md),
[csv-editing.md](./csv-editing.md)); everything else is Raw-only with a language badge and no mode button.
Refusals, checked on load and on reload:

- **Over 2 MB** (checked by `stat` before reading): panel **"File too large"**, "This file is larger than
  2 MB and won’t be opened in the editor."
- **Contains a NUL byte**: panel **"Binary file"**, "Pomade’s editor only opens text files. This looks like a
  binary file." Images are classified here (their bytes trip the sniff).

Both panels carry a **Reveal in Finder** button (testid `refusal-reveal`, `app.showItemInFolder` on the doc's
absolute path: the workspace root prepended for in-workspace docs). While a refusal panel shows, the header
Save button is a real `disabled` control (dimmed, no hover affordance) with the tooltip **"File is not
supported: editing is not available"**; Cmd+S is inert, and every write path (Save, Save As) refuses with
`<name> was not loaded — saving now would erase it`, because the buffer is empty and a write would truncate
the real file. The refusal check precedes the outside-workspace confirm, so a refused outside file never
raises that prompt either.

A missing file at open starts empty with the notice "This file no longer exists on disk (moved or deleted).
Saving will recreate it."

## Outside-workspace files

A file resolving outside the workspace (a terminal Cmd+click, an editor link, go-to-path, or a restored tab)
is a distinct object class: its `DocTab.path` is the **absolute** path (a workspace-relative path never
begins with `/`, `isOutsidePath` in `doc-io.ts`). The editor reads, writes and stats it through a narrow door
(`fs.readOutside` / `writeOutside` / `statOutside`, absolute paths only) instead of the workspace-guarded
channels. The open-doc watcher covers it like any other doc.

- **Full read/write**, but the **first save in a tab session** asks **"Save outside your workspace?"**
  (`“<title>” is outside your workspace. Save anyway?`, **Save anyway** / **Cancel**). Later saves in the same
  open tab are silent; closing and reopening the tab re-arms the confirm. Cancel aborts that one save (tab
  stays dirty, no toast). An in-workspace doc outside the project is freely editable with no confirm; the
  confirm keys on the path being absolute.
- **Unsupported outside files** (image, binary, oversize) open in a tab on the same refusal panel (with
  Reveal in Finder); only an outside *folder* reveals in Finder.
- **Restore:** an outside tab persists like any tab; if its absolute path no longer resolves on restore (moved
  or deleted, or `.pomade` synced from another machine) the tab is dropped silently.

## Version tabs

A version tab is a doc tab whose buffer starts from an earlier version of a file (opened from Document
History) instead of from the file ([Document history](../git/document-history.md)). It never has rule-8 checks
(the file's disk state is not its buffer's), its recovery copy is keyed by the tab, and a version that cannot
be read shows the panel **"Version not available"** with the reason. Its **Save** replaces the document: a
confirm **"Replace with this version"** (`Replace <doc> with this version? The current text stays in
History.`, plus a line when the document has unsaved edits in its own tab: they are kept as a discarded draft
and that tab shows this version), **Cancel** / **Replace**; the current text goes to local history, or to the
discarded drafts when local history does not keep the file; open tabs of the document then reload. Toast
`<doc> now holds this version. The text it replaced is in History.` Save all at quit never writes a dirty
version tab.

## Boundaries worth knowing

- The image/binary **extension** gate (`opensInEditor` in `doc-kind.ts`: images including `.svg`, archives,
  office containers, databases, fonts, media, compiled artifacts) applies only to terminal and editor links, and
  go-to-path to a path outside the active project, that resolve to a file **inside the workspace**: those reveal
  in Finder. A file opened from the file tree, or by go-to-path inside the active project, always opens a tab
  (a `.png` or `.zip` lands on the refusal panel; a `.svg`, being text, opens as an editable buffer), as does
  an **outside-workspace** file of any type.
- Line endings are one flag per file: a mixed-endings file is rewritten uniformly (to CRLF if any CRLF was
  present) on save.
- Two dirty tabs on the same file (one per project; buffers are never merged) share one recovery copy: the
  last one typed in wins.

Tickets: T-044, T-095, T-096, T-102, T-106, T-109, T-139, T-142, T-187, T-192, T-226, E-021, E-035.
