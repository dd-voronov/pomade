---
doc: docs/modules/filetree/file-management.md
audience: engineers, product
holds: creating, renaming, moving, copying and trashing from the tree — context menu, double-click rename, drag and drop, collisions, tabs following moves; how it is built
kind: reference
---

# File management — create, move, copy, rename, trash from the tree

**Module:** `filetree` · **UI:** the tree context menu, the header buttons, row drag and drop ·
**Code:** `src/renderer/modules/filetree/{filetree-ops.ts,TreeContextMenu.tsx,TreeModals.tsx,NamePrompt.tsx,FileTree.tsx}`,
`src/main/{fs-service,fs-ops}.ts` (`fs.move` / `fs.copy` / `fs.trash`, the `*Outside` doors) ·
**e2e:** `filetree-manage.spec.ts`, `filetree-mounts.spec.ts`

## What it does

The tree is a file manager: a right-click menu with Cut / Copy / Paste, rename, trash and path
copying; drag-and-drop moves; a collision dialog instead of raw errors; and **open doc tabs follow
every in-app move or rename** (in every project, buffers preserved, no reload). The same operations
work under [mounted roots](./mounts.md), through the outside-workspace doors, with the boundary
rules listed there.

## The context menu

Right-click a row. Items, in order:

- **Open in editor** (files) — always a real tab, never the preview slot.
- **Show history** (files) — opens the doc with its [Document history](../git/document-history.md)
  panel showing.
- **New file** / **New folder** — created in the folder the row implies (folder → itself, file → its
  parent). The `New file` / `New folder` prompt takes a name (`name.md` / `folder-name` as
  placeholder) and **Create**; a name with `/` creates the folders in between. A name that exists
  already is refused with an error toast.
- **Start new project from here** (folders) — opens the New project dialog with the folder's path in
  *From existing folder* mode (`new-project-store.startFromFolder`; the Projects panel owns the dialog, see
  [groups and projects](../projects/groups-and-projects.md)). Disabled with the tooltip `This folder
  is outside your workspace` under an outside root; enabled under a within-workspace mount.
- **Cut** / **Copy** / **Paste** — the tree's own clipboard, not the OS one. Cut → Paste moves; Copy →
  Paste duplicates (into the same folder it yields `name copy`). Paste is disabled until something is
  on the clipboard, and lands in the target folder (a file target's parent; the root for the
  empty-area menu).
- **Rename** — the `Rename` prompt, seeded with the current name with the stem selected (the extension
  stays unless you extend the selection); **Enter** submits. **Double-clicking** a file or folder row
  opens the same prompt: the first click of the pair has already opened the file or toggled the
  folder; the second click only selects, so a folder toggles once and no second tab opens. Modified
  double-clicks (Shift / Cmd / Ctrl) are selection-only, and a ghost (deleted) row never renames. A
  rename onto an existing name is refused with an error toast and the prompt closes.
- **Move to Trash** — the OS trash, always recoverable; Pomade never `rm`s. An in-workspace item goes
  straight to the trash; an item under an outside root asks first.
- **Copy path** / **Copy full path** — workspace-relative vs absolute (an outside path is absolute
  either way); a `Copied path` toast confirms.
- **Reveal in Finder** — a file's parent folder or the folder itself, through `app.openPath`.

The root header and the empty tree area show the target-less variant (New file / New folder / Paste /
Reveal in Finder); a mount header shows its root menu instead ([mounts](./mounts.md)).

## Drag and drop

Every row is draggable; drop targets are **folder rows** and **root headers**. A drop into the item's
own current folder is a no-op, and a folder can never be dropped into itself or a descendant
(`canDrop`). The drop highlight shows the receiving folder. Dragging a row out of a multi-selection
moves only that row ([multi-select](./multi-select.md)). A drag moves; there is no drag-to-copy.

## Collisions

A move (drag or single-item Cut → Paste) landing on an existing name opens the collision dialog
(`“<name>” already exists`):

- **Move with a new name** — `fs.move` with `onCollision: 'rename'`; picks a free `name copy`,
  `name copy 2`, … name.
- **Overwrite** — offered only when **both sides are files**; the displaced file goes to the OS trash.
- **Cancel**.

Copies never need the dialog: `fs.copy` renames itself around a clash. A multi-item paste applies the
same rules item-wise with no dialog ([multi-select](./multi-select.md)).

## Open tabs follow

After every successful in-app move or rename, `tabs-store.retargetPaths(old, new)` retargets every
open doc tab whose path is the moved file or lies under a moved folder, **in every project**: the
tab's path and title change, the buffer (including unsaved edits) is untouched, and later saves go
to the new location. A genuine external delete still surfaces as the editor's "no longer exists on
disk" notice. Main records in-workspace moves for [local history](../git/local-history.md)
(`noteMoved`), so a moved document keeps its versions.

## Implementation notes

- The renderer dispatches on the path: absolute → the `*Outside` doors, relative → the escape-guarded
  in-workspace channels (`createFileD`, `moveD`, `copyD`, `trashD`, `existsD`, `statD`).
- Moves and copies share `moveEntryCore` / `copyEntryCore` in `fs-ops.ts` (collision, folder-into-self
  and trash rules) for both families.
- After an operation the tree reloads the affected directories and expands the destination.
- Errors from main reach the user as toasts through `cleanIpcError`.

## Boundaries worth knowing

- The tree clipboard is renderer-local and per-session; it does not use the OS clipboard (Copy path
  does).
- Deleting is always trash; there is no delete-permanently affordance.
- Multi-selection changes the menu and the paste rules — see [multi-select](./multi-select.md).

Tickets: E-012, E-016, T-133, T-182.
