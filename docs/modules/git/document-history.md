---
doc: docs/modules/git/document-history.md
audience: engineers, product
holds: Document history — the per-document version list (current, discarded, local versions, commits), the Saved row and its meta line, compare, restore, version tabs, the Cmd+Shift+H shortcut
kind: reference
---

# Document history — every version of a doc, restorable whole or by paragraph

**Module:** `git` · **UI:** the **History** button in the editor header (short for Document history), **Show history** in the tree's
right-click menu, **Cmd+Shift+H** (Ctrl+Shift+H elsewhere) · **Code:**
`src/renderer/modules/git/history/` (`DocHistoryPanel.tsx`, `use-doc-history.ts`, `history-actions.ts`,
`doc-history-store.ts`, `HistoryShortcut.tsx`, `open-version.ts`, `version-text.ts`), `src/shared/doc-history.ts`,
`src/shared/doc-version.ts`, `readFileLog` in
`src/main/git-history.ts`, `restoreVersion` in `EditorPane.tsx` · **e2e:** `doc-history.spec.ts`, `doc-history-groups.spec.ts`, `doc-history-rename.spec.ts`,
`doc-history-version-tab.spec.ts` ·
**Contract:** [contracts/documents](../../contracts/documents.md) "Document history model", "Version tabs", [contracts/git-state-and-history](../../contracts/git-state-and-history.md) "History"

## What it does

One list per document, in groups, answering "why does this doc look different?" and "give me
yesterday's version back" — with or without git. The panel docks at the right of the doc pane (300 px) and
stays open per tab until closed (the ×, the History button — tooltip *Document history (Cmd+Shift+H)*, aria `Document history` —, Cmd+Shift+H, Escape inside it). An Untitled doc has no History button: nothing was saved yet. A
[version tab](#a-version-in-its-own-tab) has none either.

| Group | Row | Shown when | Click compares | Restore |
|---|---|---|---|---|
| CURRENT | **Unsaved edits** | the buffer differs from the file (dirty) | the saved file ↔ the buffer | — (it is the buffer) |
| CURRENT | **Saved · Nov 11 11:42** | the file exists on disk (not for an Untitled doc) | while `git status` lists the file as modified, new, renamed or conflicted: the last commit (`HEAD`, from the old name after a rename) ↔ the document; otherwise the saved file ↔ the document | the saved file, while the buffer differs from it |
| DISCARDED | **Discarded draft · Nov 8 14:32** | a draft of this path is in the store ([save and file lifecycle](../editor/save-and-file-lifecycle.md)); kept 7 days | the draft ↔ the document | the draft |
| DISCARDED | **◌ Discarded change · Nov 10 19:32** | its changes were discarded in the Git panel ([operations](./operations-and-safety-rails.md)); kept 7 days — a staged version kept with it says so | that content ↔ the document | that content |
| LOCAL VERSIONS | **Nov 11 11:00 · changed on disk** / **… · saved in Pomade** / **… · renamed from T-2.md** | a [local-history](./local-history.md) snapshot of this path exists; kept 7 days | that snapshot ↔ the document | that snapshot (one kept under an earlier name: [under that name](#restore-under-an-earlier-name)) |
| COMMITS | **Commits** | in a repo, the commits that touched the file | that commit's version ↔ the document | that version |

The **current** mark (a small pill after the title) sits on the row that is what the editor holds: *Unsaved edits*
while dirty, else the *Saved* row.

### The Saved row

One row for the file on disk. Its time is the newest local version's when that version holds exactly the disk text
(compared by `blobHash`; the version then leaves *Local versions*, and the row opens as a version tab like a
local version does), else the file's modified time. A rename's local version is never absorbed (it stands for
the file under its old name). A file over 2 MB or with a NUL byte has no hash and absorbs nothing. The glyph and
the meta line say where git stands (`savedMeta` in `shared/doc-history.ts`):

| Where the file stands | Glyph | Meta line |
|---|---|---|
| in a repo, differs from the last commit | filled amber dot | `not committed` |
| in a repo, new (in no commit) | filled amber dot | `new file · not committed` |
| in a repo, renamed | filled amber dot | `renamed from old.md · not committed` |
| in a repo, the same as the newest commit that touched it | hollow ring | `same as 0b8e744` |
| outside a repo, or no listed commit holds it | small faint dot | `local version · 1.2 KB` |

A discarded draft's second line says why: *closed without saving*, *quit without saving*, *recovered edits
discarded*, *replaced by the disk version*, *replaced by an earlier version*; a discarded change's: *discarded in the
Git panel* (*its staged version, discarded in the Git panel*); *Unsaved edits*: *saved ↔ unsaved*. The disk file is
read again after a save, a kept local version, a git status change and a HEAD move.

### Groups

Each group sits under a small uppercase sub-header — chevron, name, count (Commits reads `50+` while older
commits can still be shown) — the Git panel's section header. A click on the header folds or unfolds the group;
the choice holds for every document and is remembered across restarts (`docHistoryFolded` in `.pomade/state/view.json`, machine-local; the id `changes` reads as `current`). A group with no row is not
shown. Ticked rows stay ticked when their group folds, and two ticked rows in any groups compare.

The **Discarded** and **Local versions** groups can be emptied early from Settings ▸ General ▸ **Local history** ▸ **Delete versions now**
(by group and age, previewed; [local-history](./local-history.md#space-and-delete-versions-now)); the lists refresh when versions go. A lowered
**Space for local versions** also removes the oldest local versions.

A commit row reads `subject`, then `7-char hash · author · how long ago`. Commits are the branch's own
first-parent line, like the repo History, and **follow the file across renames** — each commit carries the
path the file had then, so an old version compares and restores from its old name. **Show all commits**
(header, repo files only) lists every commit that touched the file instead; **Show older** pages by 50.

### Files git does not know as renamed

A rename made in the tree or Finder is, to git, a deletion plus a new file, and `git log` has nothing under
the new name. For such an untracked file the panel passes the repo's deleted files to main, which picks the
one whose last committed text is most similar (at least half of its lines unchanged — git's own rename
threshold; up to 50 candidates, 512 KB each) and lists that file's history. The Saved row then reads
`renamed from old.md · not committed`. A `git mv` (staged) rename uses git's own answer. Nothing is guessed below the
threshold: the file then simply has no commits.

### A file that is gone

A doc whose file no longer exists (a new file whose changes were discarded) opens empty under the editor's
"no longer exists" notice; its document history lists what was kept. Restore puts it into the editor and Save recreates
the file.

### A doc outside any repo

Only the unsaved row, the Saved row (`local version · <size>`), discarded drafts and local-history snapshots exist. A line under the list says *Git history appears when this
file is in a repository.* (also for an absolute, outside-workspace path). A doc in a repo with nothing yet
shows *No earlier versions of this file yet.*

## Compare

- **Click a row** → a comparison tab ([comparison tab](./comparison-tab.md)) of that version ↔ the current
  document: the right side is the doc's own buffer, editable, with per-chunk **→ take old** — only that chunk
  changes, as an unsaved edit. The tab is always a real tab (a preview tab would replace the doc tab the
  panel lives in).
- **Two rows** → tick the boxes (shown on hover; Cmd+click on a row ticks too — Ctrl+click elsewhere; Space on a focused row) →
  **Compare** in the bar that appears (*2 versions picked* · **Compare** · **Clear**); a third tick replaces the
  older of the two. Without two picks the panel shows *Click a version to compare it with your document;
  right-click for more. Tick two to compare them with each other.* The older row goes on the left. A pair holding *Unsaved edits* has the
  live document on the right (editable); any other pair is version ↔ version, read-only. The *Saved* row in a pair is the file on disk.
- **File ↔ file**: select two files in the tree, right-click → **Compare**. The first is the left side as on
  disk; the second is the right side, **the document**, editable. Each side is labelled with its file's name.

## Right-click a row

| Item | Rows | Does |
|---|---|---|
| **Open this version in a tab** | commits, local versions (renames too), discarded drafts and changes, the Saved row when it absorbed a local version | the [version tab](#a-version-in-its-own-tab) |
| **Compare with your document** | every row (*Unsaved edits*: **Compare with the saved file**) | what a click does |
| **Restore** | where the row has Restore | as below |
| **Copy hash** | commits | copies the full hash |

A click always compares, and every item opens what it says even when the version holds the same text as the
document (the comparison then shows no change). A double click does nothing more. On macOS Ctrl+click opens the
menu.

## Versions under an earlier name

A local version kept before the document was renamed or moved belongs to the name it had then: the rename's own
row (`… · renamed from T-2.md`, the document as it was under T-2.md) and every row below it, up to the next
rename. Such a row's second line ends `· as T-2.md` (the rename's row already names it), its comparison side
reads `T-2.md · Saved in Pomade · Nov 17, 2026, 12:49` (the rename's: `Renamed from T-2.md · …`), and its
version tab is titled `T-2.md @ Nov 17 12:49`. A name in another folder reads as its workspace path. Commits
keep the path the file had at that commit; their version tab is titled with it.

## A version in its own tab

**Open this version in a tab** opens that version as an ordinary editable editor tab titled
`notes.md @ 0b8e744`, named as the document was named in that version (a local version: `notes.md @ Nov 17
12:49`; a discarded draft: `notes.md @ draft Nov 8
14:32`), in the document's view (Raw / Live / Rendered, as the document's tab shows it; the default for its kind
when the document is not open). The header names the document and carries a **Version 0b8e744** chip. Opening the
same version again focuses its tab. The same tab opens from a comparison side's **Open in tab**
([comparison tab](./comparison-tab.md)) and from a commit's file row ([commit details](./commit-details.md)).

It is not the document's tab: the tree, links and Document history open the document's own tab, and its buffer is its own.
**Save** (the button, Cmd+S, or Save in the close prompt) asks *Replace notes.md with this version? The current
text stays in History.* — Cancel changes nothing; **Replace**:

1. keeps what `notes.md` holds now as a local version (a file local history does not keep — outside the workspace,
   ignored by git — as a discarded draft *replaced by an earlier version*);
2. writes the tab's text into `notes.md` (itself then the newest local version, *saved in Pomade*);
3. brings every open tab of `notes.md` to the new text. When one has unsaved edits the prompt says so first:
   *notes.md has unsaved edits in its tab. They are kept in History as a discarded draft, and the tab shows this
   version.*

The version tab then reads **Saved** until it is edited again; each later Save replaces again, with the same
prompt. Save is enabled on a fresh, unedited version tab: replacing needs no edit.

Closing it with edits asks like any unsaved document (Discard keeps a discarded draft of the document). It
survives a restart like other tabs, unsaved edits included (its recovery copy is its own, never the document's).
Quit's **Save all** does not replace a document unasked: a version tab with edits stops the quit and is named. A
version that is no longer kept shows *Version not available* with the reason. Cmd+Shift+H on a version tab
opens the Document history of its document.

## Restore

**Restore** (shown on hover) puts the whole version into the editor as **one unsaved edit**: git and the
disk are untouched, nothing is final until saved, and **Cmd+Z undoes it** — back to exactly the previous
buffer. A toast says so.

| Mode | What happens |
|---|---|
| Raw | one CodeMirror transaction over the whole file, in its own undo step (`isolateHistory`) |
| Live | the same, over the body (the frontmatter is shown in the properties panel) |
| Rendered | the body is parsed and swapped into the ProseMirror doc in its own history step; the buffer is then what the serializer writes (the accepted canonicalization on edit) |

The restore goes **through raw** when the engine on screen cannot take it as one undoable step: a version
whose frontmatter differs from the document's (the properties panel is outside the editor's undo), a version
Milkdown cannot parse (the rendered view's parse guard is never bypassed), and the CSV table. The doc
switches to Raw first, then restores there, so Cmd+Z still returns the previous buffer whole; the mode button
takes it back.

### Restore under an earlier name

**Restore** on a local version [kept under an earlier name](#versions-under-an-earlier-name) asks *Restore
T-2b.md as it was, under its earlier name T-2.md?* — *The document is renamed back and this version's text goes
into the editor as an unsaved edit.* **Rename back and restore** renames the file through Pomade's own rename
(the folder too, for a move): its tabs, the tree and its local history follow, and the rename back is itself a
`renamed from T-2b.md` row holding what the document had. Then the version's text goes in as above (Cmd+Z undoes
the text, not the rename). Cancel changes nothing. When a file already exists at the earlier path, Restore is
refused before asking: *Can't restore under T-2.md — a file with that name is already there. Rename or move that
file first.*

## Where each row comes from

Rows are built from independent sources (`buildHistoryRows` in `shared/doc-history.ts`) and each kind maps to a
comparison source (`rowSource`) and a group (`ROW_GROUP`), so a new source adds a kind and a group without
touching the list or the comparison tab. List order is by group, then by kind: unsaved, saved;
drafts (newest first), discarded changes (newest first); the local-history snapshots, newest first; the commits,
in git's order. A picked pair is ordered by when each version was made (`rowTime`: the buffer newest, the saved
file next, every other row at its own time, a commit at its author date), so the older one is on the left even
when it sits higher in the list. A discarded change lives in the same drafts store as a discarded draft (reason
`git-discard` / `git-discard-staged`) and compares as one.

## Limits and failures

A version over 2 MB, binary, absent in that commit, or a draft or snapshot pruned meanwhile cannot be restored: a toast
names why and nothing changes. A repository with no commits has no history. The panel reloads when HEAD
moves, the path changes (rename), a draft is kept, or a local version of the path is kept.

## Shortcut

**Cmd+Shift+H** toggles the active doc's panel; on a comparison tab it opens the compared document's
Document history; elsewhere a toast says to open a saved document. Chosen next to Cmd+Shift+G (quick peek): the
physical key `H` with Shift, captured in the window's capture phase. Checked against Pomade's menu
accelerators and `POMADE_SHORTCUTS` (it joins the list, so apps cannot take it), CodeMirror's default, search,
fold, history and merge keymaps, Milkdown's commonmark / gfm / history keymaps (`Mod-Shift-b` is the only
Shift chord there), and macOS system shortcuts (none on Cmd+Shift+H outside Finder).

Tickets: E-038, T-219, T-223, T-226, T-228, T-230, T-266, T-272.
