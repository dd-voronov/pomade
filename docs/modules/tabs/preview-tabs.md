---
doc: docs/modules/tabs/preview-tabs.md
audience: engineers, product
holds: preview tabs — the one-preview-tab rule on the file tree and the Git panel, what keeps a preview, what never goes through the preview slot, the stray second press
kind: reference
---

# Preview tabs — single clicks reuse one tab

**Module:** `tabs` · **UI:** Settings ▸ General ▸ Tabs ▸ `Single click opens a preview tab` (testid
`setting-preview-tab-mode`, default **on**) · **Code:** `stores/tabs-store.ts` (`previewTabByProject`,
`openDocByPath` with `usePreviewMode`, `replacePreviewTab`, `commitPreview`),
`modules/filetree/filetree-ops.ts` (`openDoc`),
`modules/git/open-git-tabs.ts` (`openThroughPreview`), `modules/git/row-menu.tsx`,
`layout/TabStrip.tsx` (the italic title), `stores/stray-press-guard.ts` · **e2e:**
`preview-tabs.spec.ts`, `preview-tab-rule.spec.ts`

## The rule

One rule on every surface that opens tabs from a list — the file tree, the Git panel (Changes, In
progress, History), a commit tab's files, a branch tab's commits and files:

- A **single click** opens the item in the project's one **preview tab**, replacing the preview
  that is there. Skimming ten files leaves one tab, not ten (VS Code behavior). What a click can
  replace depends on the surface: a Git-panel click replaces a preview that is a clean doc, a commit,
  a branch or a comparison; a file-tree click replaces only a preview that is a clean doc — over a
  commit, branch or comparison preview it opens the file as the new preview and the old tab stays as
  a tab that stays.
- The preview tab's **title is in italics**. Nothing else marks it.
- **Using the tab keeps it**: the title turns upright and the next single click opens a new
  preview.
- A **double click is not a gesture** for keeping a tab. In the tree it renames
  ([file management](../filetree/file-management.md)); elsewhere it is just two single clicks.
- To open a tab that stays straight away: right-click the row ▸ **Open in a new tab** (the Git
  panel rows, commit- and branch-tab rows; the tree's menu has **Open in editor**), or focus a Git
  panel, commit-tab or branch-tab row and press **Enter**. The file tree has no Enter-to-open.

## What counts as using it

- you **edit** the document (a dirty doc is never replaced);
- you **click into the pane** (editor, terminal, a commit, branch or comparison pane — a right-click
  there too);
- you **activate another tab**;
- you **open any tab outside the preview slot** (a terminal, an agent, Open in a new tab, a bulk
  open).

## The stray second press

A double click on a row opens its tab with the first click, and the new pane can appear right under
the pointer — a commit tab's file row opens a comparison over the list; a Document history row opens
a comparison whose editable "Now" side sits where the panel was. The second press then lands in that
pane. Pomade drops it: a press with click count 2 or more whose first press activated a tab, landing
on something other than what the first press hit, never reaches the page — no caret, no selection,
no focus, and the preview stays a preview. A double click whose two presses hit the same thing (the
tree's Rename, a tab's rename, the same Git panel row) is untouched.

## What never goes through the preview slot

- **Modified clicks** in the tree (Cmd / Shift / Cmd+Shift) are selection-only — they never open
  a doc at all, so they can never replace the preview.
- **Open in editor** (tree context menu, single or bulk) always opens tabs that stay — a bulk
  open must leave every file open, not chain them through one slot.
- **Document history** rows, the conflict tab and files opened from **terminal links**
  (Cmd+click) open tabs that stay.
- A thing **already open** in the project jumps to its existing tab instead (Enter or Open in a new
  tab on it keeps it if it was the preview).

## Boundaries worth knowing

- The preview slot is **runtime-only** — it is never persisted. After a restart every restored
  tab is a tab that stays.
- Replacement swaps in a **fresh tab** (new id) at the same strip position, so the pane remounts
  and loads the new content cleanly; the old preview pane (guaranteed non-dirty) unmounts.
- Unnamed agent tabs also show an italic, muted title with a hollow dot; an agent tab is never a
  preview, so the two never meet.
- A closed or moved-away preview vacates the slot; a conflict tab, a version tab and every tab an app
  opens are never the preview.
- The tab element carries `data-preview="true"` while it is the preview.
- Turning the setting **off** makes every single click open its own tab.

Tickets: T-063, T-228.
