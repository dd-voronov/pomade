---
doc: docs/modules/filetree/multi-select.md
audience: engineers, product
holds: multi-select in the tree — the click matrix, the bulk menu, bulk Cut/Copy/Paste/Trash/Open/Compare, summary toasts; how it is built
kind: reference
---

# Multi-select & bulk actions — Finder-style selection across folders

**Module:** `filetree` · **UI:** modified clicks in the tree + the bulk context menu · **Code:**
`src/renderer/modules/filetree/{use-tree-selection.ts,FileTree.tsx,filetree-ops.ts,TreeContextMenu.tsx}`
(selection model, `commonParent`, bulk runners) · **e2e:** `filetree-multiselect.spec.ts`,
`filetree-mounts.spec.ts`

## What it does

Select any set of rows — **across folders** — with the standard click modifiers, then apply one
action to all of them from the bulk context menu. While more than one row is selected, a
count badge shows next to `Files` in the header.

## The click matrix

- **Click** — select just this row (and do its normal action: open the file / toggle the
  folder).
- **Cmd+click** (Ctrl+click also counts) — toggle the row in/out of the selection.
- **Shift+click** — the contiguous range of **visible rows** between the anchor (the last row
  clicked without Shift) and this row, replacing the selection. A following Shift+click
  re-measures from the same anchor (Finder semantics).
- **Cmd+Shift+click** — the same range, **added** to the selection.

- **Double-click** — the second click only selects; the row's Rename dialog opens (see
  [file-management.md](file-management.md)).

Every modified click is selection-only — it never opens a doc, so it can never disturb the
preview tab. **Escape** clears the selection (menus and text fields keep their own Escape
first); clicking the empty tree body clears it too.

## The bulk menu

Right-click **inside** the selection (right-clicking anywhere else collapses to that row). The
menu is headed `N items selected`; every action applies to all items, top-to-bottom in visible
order:

- **Open in editor** — every selected *file* becomes a real tab (folders are skipped; the
  preview slot is bypassed). Above **10 files** a confirm asks first (`Open N files?`).
- **Compare** — only when exactly two files are selected (nothing else): opens a file ↔ file
  [comparison tab](../git/comparison-tab.md), the first file on the left, the second on the right.
- **Cut** / **Copy** / **Paste** — the clipboard holds the whole list. On paste, the single-item
  collision rules apply *item-wise*: a copy renames itself around a collision; a move refuses
  one (counted as a failure) — no per-item dialogs interrogating you mid-batch.
- **Move to Trash** — each item to the OS trash. If any selected item lies under an outside root, a
  `Delete N items?` confirm comes first ([mounts](./mounts.md)).
- **Copy path** / **Copy full path** — resolve to the selection's **common parent** folder
  (same folder for all → that folder; spanning folders → the first common ancestor; nothing in
  common → the workspace root, copied as `.` relative).
- **Reveal in Finder** — one Finder window per **distinct parent folder**, not one per file.

A selection that mixes rows inside and outside the workspace disables Cut, Copy, Paste and Move to
Trash (tooltip `Selection mixes inside and outside the workspace`); Open, Copy path and Reveal stay
available. Paste is also disabled when the clipboard and the target folder are on different sides.

Bulk runs **continue past failures** and end with a single summary toast (`7 items moved to
Trash`, `3 items copied`, or the error toast `5 moved, 2 failed`) — never a toast per item.

## Boundaries worth knowing

- **Multi-item drag is deliberately not implemented**: dragging a row out of a multi-selection
  collapses the selection to that row — what moves is always what the drag ghost shows.
- The selection is per-project session state: it clears on project/workspace switch, prunes
  rows that vanish (external moves, refresh), and collapsed subtrees contribute nothing to a
  Shift-range by construction (ranges are defined over *visible* rows).
- Header **New file / New folder** target the selection's anchor (folder → itself, file → its
  parent), so create-into-selected works with a multi-selection too.

Tickets: E-018, T-133.
