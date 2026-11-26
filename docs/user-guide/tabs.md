---
doc: docs/user-guide/tabs.md
audience: users
holds: how to work with tabs in Pomade — opening them, preview tabs, reordering, moving to another project, renaming and coloring, closing and reopening, the dots and marks on a tab, tab details, what comes back after a restart, shortcuts
kind: reference
---

# Tabs

Everything you open in Pomade is a tab: a document, a terminal, a coding agent, an app, a commit, a comparison.
Each project has its own tab strip, so switching projects swaps the whole set. Switching tabs or projects
never restarts anything: a terminal you are not looking at keeps running.

## Open a tab

A new tab opens **right of the tab you are on** and becomes the active one.

| To open | Do this |
|---|---|
| A document | Click a file in the file tree. **+** ▸ **New doc** opens an empty `Untitled` document. Cmd+click a file path in terminal output opens that file. |
| A terminal | **+** ▸ **New terminal**, or Cmd+T. |
| A coding agent | **+** ▸ the agent's name. Typing an agent's command (`claude`, `codex`, …) into a terminal also turns that terminal tab into an agent tab. |
| An app | **+** ▸ the app's name, or its icon in the icon strip when it has a tab view. An app has one tab per project (per icon): opening it again goes to the open tab, which stays on the view it is on. |
| A commit, a comparison, a branch | Click a row in the Git panel (History, Changes, In progress). A conflict tab opens when a pull, rebase or merge hits conflicts. See [git.md](./git.md). |

An app can also open tabs on its own — an attached terminal for one of its running services, or extra tabs of its own for the things it shows (Runner's output of a run). Such an app tab has the title and icon the app gives it, and you can rename it like any other ([apps.md](./apps.md) "Open an app").

A tab you open from another project's context (**Copy to another project**, **Move to another project**)
lands at the **end** of that project's strip instead; see below.

## Preview tabs and tabs that stay

With **Single click opens a preview tab** on (Settings ▸ General ▸ Tabs, on by default), a single click on a
file in the tree, or on a row in the Git panel or in a commit or branch tab, opens it in the project's one
**preview tab**. Its title is in *italics*. The next single click replaces it, so skimming ten files leaves
one tab, not ten.

A preview tab **stays** — the title turns upright and the next click opens a new preview — as soon as you:

- edit the document,
- click into the tab's content (a right-click too),
- switch to another tab, or
- open any other tab: a terminal, an agent, **Open in a new tab**.

To open a tab that stays at once: right-click a Git row ▸ **Open in a new tab**, focus a Git, commit-tab or
branch-tab row and press Enter, or right-click a file in the tree ▸ **Open in editor**. A double click is not
a way to keep a tab (in the tree it renames the file). A file that is already open in the project jumps to its
existing tab instead of replacing the preview. With the setting off, every click opens its own tab.

Preview is only for the current session: after a restart every tab is a tab that stays.

## Reorder and move tabs

- **Reorder:** drag a tab to another place in the strip. A line shows where it will land. Drop on the empty
  space right of the last tab to move it to the end. Near either edge of a long strip, the strip scrolls by
  itself while you drag. A terminal keeps running through a reorder.
- **Move to another project:** right-click the tab ▸ **Move to another project** ▸ the project, or drag the tab
  onto a project row in the Projects panel. The tab goes to the end of that project's strip, a terminal keeps its
  shell and output, and you stay where you are. Moving from the menu shows a `Moved to <project>` notice. The
  tab arrives with a red dot, so the project's number in the Projects panel goes up.
- **Copy to another project:** documents only. Right-click ▸ **Copy to another project** ▸ the project opens
  a second tab on the same file there (`Copied to <project>`). The original stays. A document that is not
  saved yet cannot be copied (`Save the document first.`).

If the target project already shows that file, you get no second tab: moving or copying jumps to the tab that
is there. If you move a tab with unsaved edits onto a clean copy, the edited tab replaces it; if both copies have
unsaved edits, both tabs are kept.

The Workspace project counts too, and every project is offered in the menu, in Projects panel order.

## Rename and color a tab

- **Rename:** double-click the tab, or right-click ▸ **Rename tab** (**Rename document** on a document). Enter
  saves, Esc cancels. A terminal or agent keeps the name you give it: the automatic title Pomade gives when an
  agent starts or exits never replaces it.
- **A document's rename renames the file on disk**, in the project folder, and every tab on that file, in every
  project, follows it. If the name is taken, the field stays open with your text so you can pick another. A
  document that is not saved yet cannot be renamed here; save it first.
- **A tab opened as an earlier version cannot be renamed.** Double-clicking it does nothing, and **Rename
  document** in its menu is greyed out (`A version can't be renamed — rename the document from its own tab.`).
  Rename the document from its own tab.
- **An app's title:** when an app sets a tab's title, the tab keeps that title even if the app's own name for the
  tab changes later. Your own rename always wins.
- **Color:** right-click ▸ **Change color** ▸ **Red**, **Amber**, **Green**, **Teal**, **Blue** or **Purple**
  tints the tab; **None** removes the tint. It works on every kind of tab and is remembered.
- **Long names:** hover a tab whose name is cut off to see the full name.

## Close a tab

Click the **×** on a tab (tooltip `Close tab (Cmd+W)`), press Cmd+W, or right-click ▸ **Close**. Pomade asks
first only when closing would lose something:

| Tab | What happens |
|---|---|
| A document with unsaved changes | **Unsaved changes**: `Cancel`, `Discard`, `Save`. Discard keeps your text for 7 days as a discarded draft in the document's Document history. |
| A running agent | **Close agent tab?**: `Cancel` or `Close`. Closing ends the session. |
| A terminal with a command running | **Close running terminal?**: `Cancel` or `Close`. Closing stops the process. |
| A terminal with an idle prompt, a finished tab, a clean document, a commit, comparison, branch, app tab | Closes at once. |

Closing an attached terminal only disconnects; nothing stops.

Closing the tab you are on takes you back to **the tab you were on before it**. When there is none (just after
a restart, say), you land on the tab to its right, or on the left one if it was last. (**Close saved docs**, and moving a tab to another project, pick
the tab to the right instead.) Closing a tab you are not on never moves you.

Right-click a tab for the group closes:

- **Close others**, **Close to the right**: go through the tabs one at a time, and each tab that needs an answer
  is brought to the front and asked. `Cancel` stops the rest.
- **Close all docs** (the **⋯** menu, or right-click the empty space in the strip): the same, for every
  document. **Close saved docs** closes every document without unsaved changes, with no questions.
- **Stop all terminals** closes every plain terminal's tab. **Exit all agents** types `/exit` into every running
  agent and closes each tab when its agent ends. Neither asks tab by tab: when a terminal has a command running
  (or an agent is in the middle of a turn, or waiting for your answer) you get **one** question for the lot —
  **Close running terminal?** / **Close running terminals?**, **Close working agent?** / **Close working
  agents?** — with `Cancel` (nothing closes) or `Close`. Idle terminals and agents waiting at their prompt
  close without a question. `Close` then closes every terminal or agent of the project, not only the busy ones.

Cmd+Shift+W closes the window, not a tab.

## Reopen a closed tab

Closed a tab by mistake? Press **Cmd+Shift+T**, or choose **Reopen closed tab** (the first item of **⋯**, or of
the menu on the empty space in the strip; it is greyed out when there is nothing to reopen). Each press brings
back the next most recent one, in the place it had in the strip. Pomade remembers the last 10 closed tabs of each
project, also across restarts.

- A document comes back from disk, in the same view and scrolled to where you were.
- A terminal comes back as a new shell in its old folder, with its earlier output above a restore line and the
  last command typed but not run.
- An agent resumes its conversation; if the session cannot be found, the tab opens as an ended agent.
- A document outside the workspace whose file is gone is skipped.

Moving a tab to another project, and a preview being replaced, are not closes, and are not remembered.

## Dots and marks on a tab

| Mark | Meaning |
|---|---|
| Blue dot | The document has **unsaved** changes. |
| Red dot | The tab is **unread**: an agent or terminal finished something while you were elsewhere, a tab arrived from another project, or you chose **Mark unread**. |
| Hollow dot and italic title | An agent session that an app marked as unnamed. |
| ⚠ orange triangle | The document is **outside this project**: not in its folder and not in a folder in its scope. Tooltip: `Outside this project`. |
| ⚠ red triangle | The document is **outside the workspace**, and not in a folder in the project's scope. Tooltip: `Outside the workspace`. |
| ⚠ triangle with `2+ copies open across projects` | The same file is open in two or more projects. Shown on every copy. |
| ⚠ triangle on an agent tab | `Session not identified — click to fix`: the agent works, but will not resume by itself after a restart. Click it to fix; see [terminals-and-agents.md](./terminals-and-agents.md). |
| Chain glyph | The document is a symbolic link. Click it to see the target. |

A mounted folder put in the project's scope makes its files the project's own: no triangle on their tabs, and
the editor header shows their path as `<folder name>/…`. See [files.md](./files.md) "Project scope".

A document with both unsaved changes and a red dot shows only the red dot; the blue one returns when the red
one clears. A triangle can sit next to a dot. Hover or focus a triangle to read its reasons.

The red dot clears when you switch to the tab, or type or paste into it (editing does it on a document).
Opening the project, clicking or scrolling inside the tab does not clear it. A terminal or agent you are looking
at never raises a dot. **Mark unread** (right-click) puts the dot on any tab by hand, even the active one.
Right-clicking a tab does not switch to it, so you can mark a tab you are not on.

The project's row in the Projects panel shows the number of its tabs that carry a red dot; it counts down as you read
them.

A tab opened as an earlier version of a document is titled `notes.md @ 0b8e744`. It is a separate tab: it never
counts as a second copy of the document for the triangle. See [git.md](./git.md).

## Tab details

Right-click ▸ **Show tab details** (last item, every kind of tab) opens **Tab details**: the raw saved record of
the tab as JSON — its session id, last command, folder, colors, and so on. You can edit it and press **Save**.
Saving only changes what Pomade has stored; it does not relaunch or rebind anything. Deleting a line clears that
field. An unknown field, a wrong type, invalid JSON or a changed `id` or `kind` is refused and the dialog stays
open with an error. `Cancel` or Esc closes it. This is mainly for repairing a wrong session id on an agent tab.

## Other items in the tab menu

- **Reveal in Finder** (documents, terminals, agents): shows the file, or the terminal's folder, in Finder.
- **Copy path** and **Copy full path** (documents): the workspace-relative and the absolute path.

## What comes back after a restart

Each project's tabs, their order, the active tab, colors, names and red dots come back as you left them.
Documents reopen scrolled to where you were; unsaved edits come back from the recovery copy under a banner.
Terminals and agents come back when you open the project; see [terminals-and-agents.md](./terminals-and-agents.md).
The preview tab does not: every restored tab is a tab that stays. The tab strip is a separate set for each
project, the Workspace project included.

## Shortcuts

| Keys | Action |
|---|---|
| Cmd+T | new terminal tab, right of the active tab |
| Cmd+W | close the active tab (asks first when it would lose work) |
| Cmd+Shift+T | reopen the most recently closed tab |
| Cmd+Shift+W | close the window (asks to quit) |
| Enter on a Git, commit-tab or branch-tab row | open it in a tab that stays |
| Enter / Esc in a tab's name field | save / cancel the rename |

There are no shortcuts for switching between tabs; click the tab.
