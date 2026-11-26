---
doc: docs/user-guide/settings.md
audience: users
holds: every setting in Pomade's Settings window — what it does and where it is kept — settings changed outside it, and notices (notice toasts, the bell, muting)
kind: reference
---

# Settings and notices

## Opening Settings

Open **Settings** with **Cmd+,** (File ▸ `Settings…`) or the **Settings** button at the bottom of the
Projects panel. The window has two sections in a list on the left — **General** and **File tree**. Esc or **×**
closes it. Changes apply at once; there is no Save button.

To jump straight to the File tree section, open the file tree's **File tree options** (⋯) menu and choose
`Ignored items…`.

## Where settings are kept

| Section | Kept | Meaning |
|---|---|---|
| General | on this Mac, in Pomade's own app data | applies to every workspace; not shared |
| File tree | in the workspace, in `.pomade/workspace.json` | shared with the workspace (and git, if you commit `.pomade/`) |

## General

### Editor

**New markdown opens as** — `Rich` (default) or `Raw`. How a markdown file looks when you first open
it. In `Raw` you see and edit the markdown source; in `Rich` you edit the formatted text, in the view
"Editing markdown" picks (Live or Rendered). A file the formatted editor cannot parse still opens raw. You can also switch an open
document from the editor's ⋯ menu.

**Editing markdown** — `Keep formatting` (default) or `Adjust formatting`. Decides which formatted editor
you get.

- *Keep formatting* uses **Live** view: the file changes only where you type, so the rest of the file is
  never rewritten.
- *Adjust formatting* uses **Rendered** view: when you save an edited document, Pomade rewrites its body in
  its own standard style.

Documents you already have open keep their current view; the choice applies when a document is opened or
its view is toggled.

**Editor font (raw)** — the font of the raw markdown editor. Choose from `SF Mono (default)`, `PT Mono`,
`Monaco`, `JetBrains Mono (bundled)`, `IBM Plex Mono (bundled)`, `System UI (sans-serif)`,
`Serif (Georgia)` or `Sans (Helvetica Neue)`. Code blocks, inline code, tables and the frontmatter at the top
of a file always stay monospaced, so a proportional font reads like prose while code stays aligned. Open
raw editors change at once. The bundled fonts need no installation.

**Replace -- with — while typing** — on by default. Typing `--` followed by a space, Tab or Enter turns it
into an em-dash (—) in markdown documents. It never changes anything inside code blocks, inline code or
frontmatter. Turn it off to keep `--` as typed.

### Tabs

**Single click opens a preview tab** — on by default. A single click on a file in the file tree, or on a row
in the Git panel, opens it in one shared **preview tab** (its title in *italics*). The next single click
replaces it. The tab becomes a normal tab as soon as you use it — click into it, edit it, or switch to
another tab. In the Git panel, right-click a row ▸ `Open in a new tab` to open one that stays. Off: every
click opens its own tab.

### Terminal

**Terminal font** — the font of terminals and agent panes, chosen from the monospaced fonts above
(a terminal needs a monospaced font). Running terminals change at once.

**Copy on select** — on by default. When you finish selecting text in a terminal with the mouse, it is
copied to the clipboard and a short confirmation flashes. Cmd+C and the terminal's right-click `Copy`
work either way.

### Commands

**Commands in other terminals** — Pomade's own terminals can always run the commands your apps provide
(for example `pomade-git`). To use them in terminals Pomade did not start (Terminal.app, iTerm), Pomade
adds one marked line to your `~/.zprofile`. The row shows whether it is on —
`On — ~/.zprofile puts … on PATH.` or `Off — ~/.zprofile has no Pomade line.` — and the button reads
`Add line` or `Remove line`. Removing takes out only that line and leaves the rest of the file as it was.
Pomade never edits the file without you pressing this button. The row is not shown when commands are
unavailable.

### Local history

Pomade keeps a version of a project text file each time it changes, for 7 days
([git.md](./git.md#local-versions)). Open documents and your own saves always keep every change. Two lists of
file extensions adjust the rest:

- **Always keep every change for** — files with these extensions keep a version for every change, however often
  they change. Starts with `.md` and `.txt`.
- **Never keep versions of** — files with these extensions get no versions. Starts with `.log`, `.jsonl` and
  `.ndjson`.

Any other file keeps getting versions until it changes more than 12 times within an hour; it then gets none until
it has been quiet for an hour. That limit is not a setting.

Both lists work like **Ignored items**: **×** next to an extension (`Stop keeping every change for .md`, `Keep
versions of .log again`) removes it; type an extension (`.md` or `md`) and press Enter or **Add**; **Reset to
default** restores the list's defaults. Changes apply at once.

**Space for local versions** — how much room versions may take: 64 MB, 128 MB, 256 MB (the default), 512 MB,
1 GB or 2 GB. Under the menu, `Now:` shows what they take. When they take more, the oldest go first. Picking
a smaller size than what is kept asks first, showing how much will be deleted; `Lower and delete` confirms.

**Delete versions now** — frees space by hand. Pick a **Group** — `Local versions` (files as they changed) or
`Discarded` (unsaved text you closed, changes you discarded in the Git panel) — and **Older than** an age (`Any age`, or 1 to 6 days). The
line below says how many versions and how much space that frees, for this workspace, or `Nothing to delete`.
`Delete…` asks to confirm; deleted versions cannot be brought back.

### Startup

**Confirm workspace on startup** — off by default. On, every launch shows "Continue in this workspace?"
with the workspace path and the buttons `Continue` and `Change workspace…`. Off, Pomade opens the last
workspace silently.

### Workspace

**Current workspace** — the folder Pomade is working in, with the **Change workspace…** button. Changing
the workspace closes every terminal and agent session; see [getting-started.md](./getting-started.md).

## File tree

**Ignored items** — names the file tree hides. The list starts with `.git`, `node_modules`
and `.DS_Store`.

- **×** next to a name (`Stop ignoring <name>`) removes it from the list.
- Type a folder or file name in the box and press Enter or **Add** to ignore another.
- **Reset to default** restores the three defaults.

**Unwatched folders** — folders Pomade does not follow for changes: one full of files that keep changing
(logs, exports, caches). The file tree still shows the folder and reads it again when you expand it; changes
inside it do not appear until then, and they get no local versions. An unwatched folder carries a small
"Not watched" mark in the tree.

- **×** next to a folder (`Watch <folder> again`) puts it back.
- Type a folder path inside the workspace (for example `logs`) and press Enter or **Add**, or press
  **Choose…** and pick the folder. Absolute paths and the workspace folder itself are not accepted.
- A listed folder that no longer exists is dimmed.

To look at the ignored items without changing the list, open **File tree options** (⋯) ▸ `Show ignored items`;
they appear dimmed. This list only decides what the tree shows. Pomade's file watching and the search
behind terminal file links skip some extra folders (build output, caches) on their own, whatever this list
says.

## Settings changed outside the Settings window

| What | How |
|---|---|
| Show the file name or the full path in a document's header | click the name in the editor header (applies to every document) |
| Column widths, and hiding the Projects panel or side panel | drag the dividers; Cmd+B (Projects panel); Cmd+Shift+B (side panel) |
| Git marks in the file tree | File tree options (⋯) ▸ `Hide git status` / `Show git status` |
| Which notice sources are muted | the bell-slash on a notice; `Unmute` in the Notices panel |
| Which Document history groups are folded | click the group's header in Document history |
| Show only the changed lines in a comparison tab (**Changes only**) | the **Changes only** checkbox in the comparison tab's header (one choice for every comparison tab, kept across restarts; off by default) |

## Notices

A **notice** is a short message from Pomade or from one of your apps — "Backup finished", "A scheduled push
failed". It carries a title, an optional line or two of detail, and often a click action.

### Notice toasts

A notice pops up as a **notice toast** in the bottom-right corner. It shows the **source** (the app's name,
or "Pomade") and the **project** it belongs to ("Runner · Workspace"), the **title**, and up to two lines of
detail. It disappears after six seconds, but not while the pointer is on it. Two buttons sit on the notice toast:

- the bell-slash **mutes this source** (see below);
- **×** dismisses the notice toast. The notice is still kept in the Notices panel.

**Click the notice toast** to do what the notice offers — open an app's page, open a file, or open a terminal in a
folder — in the project the notice belongs to, which Pomade switches to. A notice can also be just news,
and then clicking only dismisses it. If the project or app is gone, an error message says so.

When one source sends several notices in a row, you still get a single notice toast: it shows the newest and adds
**"N more from <source>"**. Click that line to open the Notices panel, where every notice is listed on its
own.

### The Notices panel and the bell

The bell icon on the icon strip (after Files and Git) opens the **Notices** panel. It lists every
notice since Pomade started, newest first (the latest 200), each with its source, project, how long ago it
arrived, the title and some detail. The number on the bell counts **unread** notices; opening the panel
marks them all read. The list starts empty at every launch, except for notices that arrived while Pomade
was closed (below).

- **Click a row** to run its action again.
- **Delete one:** hover the row and click **×** (it replaces the time).
- **Delete several:** Cmd-click rows to pick them one by one, Shift-click to pick a range (Cmd+Shift-click
  adds a range). A bar above the list counts the selection and has a **Delete** button; Delete or
  Backspace does the same, Esc clears the selection. Selecting never runs a notice.
- **Delete all:** the trash icon in the panel header (`Clear all notices`).

### Muting a source

Click the bell-slash on a notice toast to **mute that source**. Its notices no longer pop up, but they still
arrive in the Notices panel and still count on the bell — shown in grey while every unread notice is from a
muted source, and in the normal colour as soon as one comes from a source you listen to. At the bottom of
the panel, a **Muted** list shows every muted source with an **Unmute** button. Mutes are remembered
between launches.

### Notices while Pomade is closed

Apps' background services and Pomade's own commands can post notices even when Pomade is not running —
for example a nightly job, or a scheduled `pomade-git` push that failed. Pomade shows each one when it
next starts, oldest first, with the time it was posted. These notices belong to the **Workspace project**: they
read "<app> · Workspace", and clicking one switches to it.

Pomade does not send macOS system notifications.

### Other badges

Numbers on strip icons and project rows are separate from notices: a red number on **Git** means a git
operation failed in a repository (it clears when you open that repo); a number on a project row counts its
unread tabs. An app can put a number on its own icon.
