---
doc: docs/user-guide/files.md
audience: users
holds: how to work with the file tree — roots and mounted folders, opening, creating, renaming, moving, deleting, multi-select, drag and drop, go to path, reveal in Finder, symlinks, ignored items, unwatched folders, git marks
kind: reference
---

# Files

The **Files** panel is the file tree of the project you are in. It sits in the column between the Projects panel
and your tabs (the **Files** icon on the strip). It updates by itself when files change on disk, whoever
changes them: you, a terminal or an agent. A file being written over and over (a log) does not keep the
tree from showing other changes.

## What the tree shows

The first section is the project's own folder. For the **Workspace project** it is the whole workspace folder.
Folders load as you open them. Under the header you can have more sections: **mounted folders** (below).

- Click a file to open it in a tab. With *Single click opens a preview tab* on (Settings ▸ General ▸
  Tabs) it opens an italic preview tab that the next click replaces; edit it or click into it to keep it. See the [editor guide](./editor.md).
- Click a folder to open or close it.
- A chain-link badge on a row marks a symbolic link (see Symlinks).
- A small struck bell on a folder marks it as not watched (see Unwatched folders).
- A folder with nothing in it shows `Empty folder`.

**Collapse** (`«`, or **Cmd+Shift+B**) hides the side panel, leaving only the icon strip; the tree keeps its
state.

## Mounted folders

A project can show extra folders in its tree: another folder of the workspace, or **any folder on your
computer**, outside the workspace.

1. Click **⋯** (`File tree options`) in the tree header ▸ **Mount new folder…**
2. Type the folder's path — relative to the workspace, absolute, or starting with `~` — and click **Mount**
   (or press Enter). A hint under the field says where the folder lives.
3. Tick **Add to project scope** if the folder belongs to this project (see below). It is off by default;
   the **(i)** next to it explains it.
4. The folder appears as its own section.

Each section has a small diamond in its header — click the header to fold or unfold it (the diamond is
solid when open). Its color tells where the folder is:

| Diamond | Where the folder is |
|---|---|
| blue | in the project (the project's own section also has a `home` chip), or a mounted folder in the project's scope |
| orange | in the workspace, but outside this project |
| red | outside the workspace |

Hover the header for the full path. **⋯** on a header (or right-click it) offers **Copy path**,
**Copy full path**, **Reveal in Finder** and, for mounted folders, **Add to project scope** /
**Remove from project scope**, **Rename** (a label only; the folder keeps its name) and **Unmount** (the
folder is only removed from the tree, never from disk). A mount belongs to the project you added it in, and
is remembered on this computer.

If a mounted folder disappears, its header turns grey with a red `⚠` (`Path doesn't exist`); it comes back
by itself when the folder returns, or you can **Unmount** it.

### Project scope

A file outside the project's own folder normally wears an orange (another project) or red (outside the
workspace) warning triangle on its tab. Put a mounted folder in the project's scope — **Add to project scope**
in the mount dialog, or in the folder's menu later — and its files count as the project's own: no triangle, and
the editor header shows the path as `<folder name>/…`. The folder's diamond turns blue. **Remove from project
scope** in the same menu takes it back; the triangles return at once. The setting is per project: the same
folder mounted in another project keeps its marks there.

Files in a folder outside the workspace can be created, renamed, moved, copied and deleted like any
other; two differences keep you safe: **deleting always asks first**, and you cannot paste or move between
the workspace and an outside folder (Paste is greyed out, with a tooltip). Outside folders show no git
marks and do not hide `node_modules` and similar names the way the workspace does.

## Create

- **New file** (**＋**) and **New folder** in the tree header, or right-click a row ▸ **New file** /
  **New folder**. The new item goes into the selected folder, or next to the selected file, or into the
  project's root when nothing is selected.
- Type a name and click **Create**. A name with `/` in it creates the folders in between (`notes/2026/a.md`).
  If the name exists you get an error message and nothing changes.

## Rename

Right-click ▸ **Rename**, or **double-click** the row. The name is selected up to the extension, so typing
keeps `.md`. Press Enter or click **Rename**. Open tabs of that file (or of files inside a renamed folder)
follow the new name in every project, and unsaved text is untouched.

## Move and copy

- **Drag** a row onto a folder, or onto a section header, to move it there. You cannot drop a folder into
  itself, or into the folder it is already in.
- Or right-click ▸ **Cut** (or **Copy**), then right-click the target folder ▸ **Paste**. Copying into the
  same folder makes `name copy`, then `name copy 2`.
- If a move lands on a name that exists, a dialog asks: **Move with a new name** (adds ` copy`),
  **Overwrite** (only file onto file; the old file goes to the Trash) or **Cancel**.

Open tabs follow a moved file too.

## Delete

Right-click ▸ **Move to Trash**. Items go to the macOS Trash, so Finder's **Put Back** recovers them;
Pomade never deletes permanently. Items inside the workspace go straight to the Trash; items in an outside
mounted folder ask `Delete “name”?` first.

## Select several

- **Cmd+click** adds or removes a row. **Shift+click** selects the range from the last row you clicked
  (rows you can see). **Cmd+Shift+click** adds a range. A count appears next to `Files`.
- **Esc**, or a click on the empty tree, clears the selection.
- Right-click inside the selection for the bulk menu, headed `N items selected`: **Open in editor** (every
  file as its own tab; above 10 files it asks `Open N files?`), **Compare** (exactly two files side by
  side), **Cut**, **Copy**, **Paste**, **Move to Trash**, **Copy path** / **Copy full path** (of the folder
  containing them all) and **Reveal in Finder** (one window per folder). A summary message appears when
  it is done, for example `7 items moved to Trash` or `5 moved, 2 failed`.
- Dragging works on one row at a time: dragging from a selection drags only that row.

## Go to a path

The `Go to path…` box under the header takes a path and jumps there on Enter. The clipboard button in the
box pastes from the clipboard. **Esc** clears the box.

- A path in the current project, or inside any of its mounted folders: the tree opens the folders above it
  (and unfolds the section if it was collapsed), selects the item and scrolls it into view; a folder stays
  closed, and a file opens as a tab. A mounted folder's own path scrolls to its header.
- A file in another project, or outside the workspace, that is not in a mounted folder: it opens as a tab (the
  tab shows an orange or red warning triangle for where it lives); the tree does not move. A file in a
  mounted folder outside the project shows the same triangle unless the folder is in the project's scope.
- A folder that is in neither the project nor a mounted folder: it opens in Finder.
- `Not found` appears under the box when nothing exists at that path. When the path would exist under
  your home folder — typically because the `~` was deleted from `~/Downloads/x` — a note offers `did you
  mean ~/…?`; **Apply** opens it, **×** or Esc dismisses the note.

## Reveal in Finder, copy a path

Right-click ▸ **Reveal in Finder** opens the folder (for a file, its folder) in Finder. **Copy path** copies the
path relative to the workspace; **Copy full path** copies the absolute path.

## Symbolic links

A symbolic link opens and expands like the thing it points to, and shows a chain-link badge on its row, on
its tab and in the editor header. Click the badge to see where it points:

- Inside the workspace: **Open target**, **Reveal in tree** (or **Open in project…** to pick a project that
  contains it), **Copy path**.
- Outside the workspace: the path with **Copy full path** and **Reveal in Finder**; Pomade does not open it
  from here.
- Broken: a red badge and `Target doesn't exist — the link is broken.`, with **Copy path**.

Saving a linked document writes to the target; the link stays a link. A link to a folder opens only when
you open it, so link cycles are harmless.

## Ignored items

The tree hides the ignored items: `.git`, `node_modules` and `.DS_Store` by default. Dot-files not on the
list show as usual. To change the list, **⋯** ▸ **Ignored items…** (Settings ▸ File tree): add a name with
**Add**, remove one with **×**, or **Reset to default**. To peek without changing the list, **⋯** ▸
**Show ignored items**: they appear dimmed until you quit Pomade; **Hide ignored items** turns it off.

## Unwatched folders

A folder full of files that keep changing — logs, exports, caches — can be left out of Pomade's watching.
**⋯** ▸ **Ignored items…** (Settings ▸ File tree), then under **Unwatched folders** type a path
inside the workspace (for example `logs`) and **Add**, or click **Choose…** and pick the folder. Remove
one with **×**. It applies at once; no restart.

Pomade then doesn't follow changes inside the folder, and search and indexes skip it. The tree still shows
the folder and its contents, marked with a struck bell (hover for the hint). Its listing doesn't update
by itself: collapse and expand the folder to read it again. A listed folder that no longer exists stays
in the list, dimmed.

## Git marks

Changed, new, conflicted, renamed and deleted files are marked in the tree (`M`, `U`, `C`, `R`, a dot on
folders, struck-through rows for deleted files). **⋯** ▸ **Hide git status** / **Show git status** turns
the marks off or on. What each mark means and what you can do with it: the [git guide](./git.md).

## Shortcuts

| Keys | What it does |
|---|---|
| Cmd+Shift+B | collapse or expand the side panel |
| Cmd+click, Shift+click, Cmd+Shift+click | toggle a row, select a range, add a range |
| Double-click | rename the row |
| Enter | confirm a name, a mount path or a go-to path |
| Esc | clear the selection; clear the go-to box; close a menu, dialog or popover |

## If something looks wrong

- *A file I just added does not show.* The tree refreshes within about a second, even while another file is
  written continuously. A folder named like `node_modules` or `dist` is checked every 2 seconds while it is open,
  so a change there can take that long to show; when closed, it refreshes the moment you open it.
- *A folder is missing from the tree.* Its name may be among the ignored items; try **Show ignored items**.
- *A file I dragged did not move.* You cannot drop it on its own folder, on itself or on a file, and not
  between the workspace and an outside folder.
- *Opening the badge of a link in an outside folder shows `Resolving…`.* Links under outside mounted folders
  cannot show their target; reveal the folder in Finder instead.
