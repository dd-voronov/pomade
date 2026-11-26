---
doc: docs/modules/git/comparison-tab.md
audience: engineers, product
holds: the comparison tab — its four modes, the live right side, Take old, Changes only and its fold bands, disk ↔ my edits, limits and lifecycle
kind: reference
---

# Comparison tab — two versions of a document in one tab

**Module:** `git` · **UI:** a Changes row in the [Git panel](./git-panel.md), a file in
[commit details](./commit-details.md) or in a branch tab ([branches and worktrees](./branches-and-worktrees.md)), a row of [Document history](./document-history.md), two tree files →
**Compare**, or **Compare** on the amber "File changed since your edits"
banner → a tab with the two-sheets glyph · **Code:** `src/renderer/modules/git/compare/`
(`ComparePane.tsx`, `compare-sides.ts`, `fold-bands.ts`), `src/renderer/components/CheckToggle.tsx`, `open-compare.ts`, `src/shared/compare.ts`,
`src/renderer/modules/editor/doc-buffers.ts` (the doc channel), `readRevisionFile` in
`src/main/git-history.ts` · **e2e:** `compare-tab.spec.ts` (Changes only, fold bands), `rule8-recovery.spec.ts`, `doc-history.spec.ts` ·
**Contract:** [contracts/documents](../../contracts/documents.md) "Comparison sources", "Doc channels and the editor controller"; [contracts/git-state-and-history](../../contracts/git-state-and-history.md) "History"

## What it does

Shows two versions of a file side by side on `@codemirror/merge`: changed lines tinted with the
git colors (the old side red, the new side green, changed words stronger), one scroll for both
sides, line numbers, wrapping and syntax colors like the editor. A label over each side names the
version — `HEAD · c60bfe4 · Oct 17` plus the commit's subject, `Now`, `On disk now`, with
`· not in this version` for a side where the file did not exist and `· unsaved edits` when the
document is dirty. The tab title says what is compared: `BACKLOG.md · Oct 12 ↔ now`,
`links.md · Oct 11 ↔ Oct 12` (short hashes when both dates read the same),
`draft.md · disk ↔ my edits`, `a.md ↔ b.md`, `plan.md · draft Nov 8 14:32 ↔ now`, `plan.md · Nov 8 14:32 ↔ now` (a local-history snapshot), `plan.md · Oct 12 ↔ saved`.
A label over a discarded draft's side reads `Discarded draft · Nov 8, 2026, 14:32`, over a local-history snapshot `Changed on disk · Nov 8, 2026, 14:32` (or `Saved in Pomade · …`; a version kept before a rename leads with the name it had, `T-2.md · Saved in Pomade · …`, a rename's own `Renamed from T-2.md · …`); in a file ↔ file
comparison each side is labelled with its file's name. A side that is a fixed version (a commit's, a local
version, a discarded draft) has **Open in tab** at the end of its label: that version in its own editable tab
([version tab](./document-history.md#a-version-in-its-own-tab)), whose Save can make it the document.

## Modes

| Mode | Left (read-only) | Right | Opened from |
|---|---|---|---|
| version ↔ current | a commit's version (`HEAD` for Changes), a discarded draft or a local-history snapshot | **the document, editable** | a Changes row, a Document history row |
| version ↔ version | the parent's version, or the older of two Document history rows | the commit's version, or the newer Document history row, read-only | a commit's file, two Document history rows |
| disk ↔ my edits | the file on disk now | **the document, editable** | the amber banner's Compare |
| file ↔ file | another file, as on disk | **the document, editable** | two files in the tree → Compare |

## The right side is the document

When the right side is the current document it is the doc tab's **own buffer**, not a copy: an
edit here is an unsaved edit of the doc (its tab shows the dot), an edit in the doc tab shows here,
**Cmd+S** (or the header's Save — "Saved" when there is nothing to save; tooltip *Save the document (Cmd+S)*) saves through the doc's
save path, and the doc's rule-8 notices show here too. **Open in editor** focuses the doc's tab (the document itself; a version's **Open in tab** opens the version).

Looking does not open anything: until the first edit, the right side shows the file from disk. The
first edit opens the doc's tab in the background, right of the comparison, and lands in its buffer
once loaded — unless the file changed on disk in that moment, in which case the right side shows
the current version and says so. A disk change while no doc tab holds the file raises the plain
"changed on disk" notice (Reload / Dismiss). Closing the doc tab returns the right side to the disk
version.

Saving needs a decision sometimes (an on-disk conflict, a first save outside the workspace): the
doc's own tab comes forward and asks there.

## Take old

Between the sides, each change has a **→** control (*Take old — put the left version of this change into your document*): it puts the left version of that
change into the right side — one paragraph back, not the whole file — as an ordinary unsaved
edit. **Cmd+Z** in the right side undoes it. Only modes with an editable right side have it.

## Changes only

The **Changes only** switch in the tab's header (the shared `CheckToggle`, left of **Open in editor**; tooltip *Show only
the changed lines, with 3 lines around each*; `data-testid="compare-changes-only"`) folds every run of unchanged
lines on both sides, keeping 3 lines before and after each change (`@codemirror/merge`
`collapseUnchanged: { margin: 3, minSize: 4 }`, constant `CHANGES_ONLY` in `ComparePane.tsx`). It works in every
mode, editable right side or not. Off by default.

It is one app setting (`compareChangesOnly` in `.pomade/state/view.json`, machine-local), not a per-tab choice: toggling it in one tab applies at
once to every open comparison tab and to tabs opened later, and survives a restart. A toggle on a built view
reconfigures it in place (`MergeView.reconfigure`), so the live side keeps its edits, undo history and cursor.

A folded run reads `⦚ N unchanged lines ⦚` (the library's text), centred on the accent wash between two border
lines, and is **one band across the whole comparison**: the library draws a bar inside each side's content, and
`fold-bands.ts` paints the rest — a piece over the left side's gutters and a piece from the left side's edge to
the right side's content (the Take old column and the right side's gutters) — placed from the two bars'
measured positions. The pieces live in the editors' row, which scrolls with the content, and are re-placed after
an editor update that can move a bar (viewport, height, geometry, document change) and on resize. A click on
any part of the band unfolds that run on both sides (the piece clicks the side-`a` bar, whose handler unfolds the
sibling too); hovering any part lights all of it. The pieces carry `data-testid="compare-fold-band-gutter"` and
`compare-fold-band`; each side is its own stacking context so the library's gutters stay under the pieces.

## Disk ↔ my edits

The amber banner's Compare opens the file on disk now against the unsaved edits. A bar above the
sides (*The file changed on disk since your edits. Take what you need from the left, then save — your version
replaces the disk one.*) offers **Keep mine** (the disk becomes the base; the next save writes the edits) and **Use
disk version** (the buffer becomes the disk version; the edits are kept as a discarded draft).
Saving from this tab is Keep mine plus save — the disk version was in view. The left side follows
the disk while the tab is open.

## Limits and failures

Either side over 2 MB or binary shows "… is larger than 2 MB / is a binary file. Nothing to
compare." instead of the sides; main checks the size before reading a revision. Diffing is
bounded (scan limit, timeout), so a huge or wildly different pair degrades to coarser chunks
instead of freezing. Line endings are normalized on both sides like the editor's buffer.

## Lifecycle

One tab per comparison: opening the same two versions again focuses it (two quick clicks on a row
included). A single click on a Changes row, a commit's file or a branch's file opens it in the
project's [preview tab](../tabs/preview-tabs.md) (italic title); right-click ▸ Open in a new tab, or
Enter, opens one that stays, as do Document history rows. The second press of a double click that
lands in the comparison its first click opened is dropped, so it never selects text in the
editable side. The tab stores
its two sources (`CompareTab.left` / `.right`) and re-reads them when its pane mounts; it stays
mounted while hidden and survives a restart. A version that no longer resolves restores to
"Version deadbee is no longer in this repository."; a draft or local version pruned meanwhile reads "This draft is
no longer kept — discarded drafts are kept for 7 days." / "This version is no longer kept — local history keeps 7
days." The Cmd+Shift+G overlay stays the quick peek ([diff view](./diff-view.md)).

Tickets: E-037, E-038, T-226, T-228, T-267, T-278.
