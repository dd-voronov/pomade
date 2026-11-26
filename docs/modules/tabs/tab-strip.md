---
doc: docs/modules/tabs/tab-strip.md
audience: engineers, product
holds: the tab strip — the kinds of tabs, status dots and marks, rename, colors, the context menus, cross-project copy and move, drag reorder, the tab hotkeys; how it is built
kind: reference
---

# Tab strip — the active project's tabs

**Module:** `tabs` · **UI:** the strip above the pane area (testid `tabstrip`) · **Code:**
`src/renderer/layout/TabStrip.tsx`, `TabContextMenu.tsx`, `StripContextMenu.tsx`,
`src/renderer/modules/terminal/TerminalActions.tsx` (the action cluster),
`src/renderer/stores/tabs-store.ts`, `src/renderer/stores/marks-store.ts` (project-row counts) ·
**e2e:** `tabs.spec.ts`, `tab-hotkeys.spec.ts`, `tab-cross-project.spec.ts`,
`tab-cross-project-order.spec.ts`, `tab-cross-project-v2.spec.ts`, `tab-drag-to-projects-panel.spec.ts`,
`tab-drop-indicator.spec.ts`, `tab-drag-autoscroll.spec.ts`, `move-dedupe.spec.ts`,
`scope-marks.spec.ts`, `tab-title-tooltip.spec.ts`, `tab-details.spec.ts`,
`tabs-rename-collision.spec.ts`, `tabstrip-render-scope.spec.ts`, `version-tab-rename.spec.ts`,
`app-same-title.spec.ts`, `project-scope.spec.ts`, `bulk-close-confirm.spec.ts`

## What it does

Shows the **active project's** tabs — every project keeps its own strip (see
[per-project-tab-state](../tabs/per-project-tab-state.md)) — with a kind icon, a status-dot
vocabulary, per-tab colors, inline rename, a right-click menu, and drag-and-drop reorder. Clicking
a tab activates it; the × (tooltip `Close tab (Cmd+W)`) or **Cmd+W** closes it through its close
guard (see [closing-tabs](./closing-tabs.md)).

The strip subscribes to the active project's tab array and active id only (`useShallow` on the
tuple). A background project's field mutation (a `cd`, a last command) replaces only that project's
array, so the strip does not re-render for it; a mutation on a tab this strip shows does.

## Kinds of tabs

Each kind (`TabKind`) has its own left icon:

- **doc** — a file open in the editor; icon is the file-type glyph (same as the file tree). A
  **version tab** is a doc tab whose `version` names an earlier version of the document (a commit's,
  a local version, a discarded draft); its title reads `notes.md @ 0b8e744`
  ([document history](../git/document-history.md#a-version-in-its-own-tab)). It is a separate tab
  from the document's own tab: path lookups, the duplicate-open indicator and the cross-project
  dedupe all treat the two as different things, and two version tabs match only when they hold the
  same version.
- **terminal** — a plain shell; terminal glyph.
- **agent** — a terminal running an AI agent; agent glyph. A terminal upgrades to an agent tab
  when you type a roster agent's command, and downgrades back when the agent exits (`/exit`) —
  the tab is the same, only its kind and title change.
- **app** — a hosted app ([app hosting](../core/app-hosting.md)); the app's icon. One tab per
  (app, strip icon) per project: opening it again focuses it.
- **attached** — a session an app's keeper holds ([attached terminals](../terminal/attached-terminals.md));
  the terminal glyph, titled `<title> · <owner app>`. Only apps open it; there is no menu entry.
- **commit** — a commit's details ([commit details](../git/commit-details.md)); a commit glyph.
- **compare** — two versions of a document ([comparison tab](../git/comparison-tab.md)); two
  side-by-side sheets.
- **conflict** — a rebase stopped on a conflict, combined file by file ([conflict tab](../git/conflict-tab.md));
  three sheets.
- **branch** — a branch or worktree from the Git panel's In progress ([branches and worktrees](../git/branches-and-worktrees.md));
  a branch glyph.

New tabs insert **immediately right of the active tab** (Chrome-like) on every open path: Cmd+T,
the "+" menu, docs opened from the file tree, agent launches. The exceptions: a tab **copied or
moved in from another project** lands at the end of the target's strip; a **reopened** tab returns
to its original index; a **preview** replacement takes the replaced tab's slot; a comparison that
opens its document in the background lands right of the comparison.

The right side of the strip carries the action cluster (`TerminalActions`):

- **Session history** (clock; tooltip `Session history`) — opens the agents app's Sessions view when
  that app is installed, Pomade's own session history otherwise.
- **Bulk actions** (⋯; tooltip `Bulk actions`) — `Reopen closed tab` (disabled while the project's
  reopen stack is empty), `Stop all terminals`, `Exit all agents`, `Close all docs`,
  `Close saved docs`.
  `Stop all terminals` and `Exit all agents` ask once when a tab they would close is busy
  ([closing-tabs](./closing-tabs.md) "Stop all terminals and Exit all agents").
- **New tab** (+; tooltip `New tab (Cmd+T)`) — `New doc` (an `Untitled` doc), `New terminal`, one item
  per agent visible in the project, one per hosted app (a disabled item shows the reason on hover).
  An agent whose command is not found shows a `!` badge and opens the mapping dialog.

## The dots and the scope mark

Two small dots can sit right of the title; each means one thing:

- **Blue — unsaved changes.** Doc tabs only; set while the buffer differs from disk, cleared on
  save.
- **Red — unread.** Any tab kind. Set automatically when a terminal/agent that is
  not the active tab of the active project signals attention (turn ended, permission prompt — see
  [agent providers](../agents/agent-providers.md)), when a tab is **copied or moved in from another
  project** (arrival, below), or manually via the context menu's **Mark unread**.
  On a doc tab the red dot *replaces* the blue one while set (dirty state itself is untouched —
  blue returns when red clears). Cleared two ways: (1) the **activation edge** — activating a
  *different* tab clears its dot; and (2) **interaction** with the already-active tab — the first
  meaningful user action *in* an unread tab that is already the active one clears its dot without
  any switch: a keystroke or paste into a terminal/agent pane, or an editor edit (dirty→true) on a
  doc. The terminal clear is wired to **genuine user input only** (xterm's `onKey` — keystrokes —
  plus a DOM `paste` listener) — NOT to raw pty-bound bytes, and NOT to xterm's `onUserInput` (which
  also fires for mouse-motion reports under an agent's any-motion tracking, so it would self-clear
  the focused agent tab): a terminal auto-replies to escape queries the running app prints (an agent
  TUI does this constantly), and neither those replies nor a passing mouse pointer are the user
  acting. A bare click or scroll into the active pane does not clear. The interaction clear covers
  the case the edge can't (a tab that is already active when its project opens never sees an
  activation edge, so the dot would otherwise stick until you leave and return). Merely *landing* in
  the tab is not enough — opening a project and leaving again with no action keeps the dot; so does
  marking the active tab via **Mark unread** and not touching it. Switching projects alone never
  clears tab dots.

A project row's red number is **derived** from the tabs: the count of that project's tabs carrying
the dot, combined with any marks set on the row by other sources (`marks-store.ts`,
`projectRowCounts`). Dots are persisted, so the counts come back after a restart.

A hollow **unnamed** dot (tooltip `Unnamed session`) and an italic muted title mark an agent tab
whose session an app flagged as unnamed; a user rename or the agent exiting clears it.

Independently, a doc tab can carry the **scope mark** — an exclamation triangle in its **own
slot** (orange = outside the project's scope, red = outside the workspace, plus a duplicate-open
indicator; the scope is the project's root plus its in-scope mounted folders). It never replaces a dot and a dot never replaces it; a tab may show both. The
active-tab underline stays accent-blue in every case. Full behaviour and tooltips:
[scope-marks](./scope-marks.md).

An agent tab reuses the same exclamation vocabulary for the **Unbound mark**
(`tab-unbound-<tabId>`, tooltip `Session not identified — click to fix`): shown on a live agent tab
whose bind window closed with no uniquely-attributable session id — the tab keeps working, it just
won't auto-resume after a restart. Unlike the doc scope mark this one is **clickable**: it opens
the recovery popover (manual session-id entry validated against the tab's expected store / Ignore =
silence this unbound session / Cancel = keep the mark). The silence is runtime-only. Details:
[session-attribution](../agents/session-attribution.md).

A symlinked doc additionally shows a small chain glyph between title and × (tooltip `Symbolic link —
click to see target`) — clicking it opens the symlink target popover (see
[symlinks](../filetree/symlinks.md)).

## Full-name tooltip (hover)

When a tab's name is too long to fit and gets truncated with an ellipsis, hovering the tab shows
a tooltip with the **complete name** — the exact string the tab renders (`tab.title`): the file
name for a doc, your custom rename, or the default terminal/agent title. An attached tab's tooltip
adds the owner (`<title> · <owner>`). It appears **only when the name is actually truncated**
(measured live at hover, `scrollWidth > clientWidth`, so it stays correct across window resize and
rename) — a name that fits fully shows no tooltip. It is **instant** (no hover delay, matching the
× close-button tooltip on the same tab), name-only (no path), and uses the shared
[Tooltip](../../contracts/renderer.md) (never a native `title=`), which wraps a long name inside the tip
rather than clipping it. It never shows while the inline rename input is open, and — being
pointer-transparent and portalled to `<body>` — never interferes with drag-reorder. e2e:
`tab-title-tooltip.spec.ts`.

## Rename (double-click)

Double-click a tab title to rename it inline (the same flow as the menu's **Rename document** /
**Rename tab**). Enter or leaving the field commits, Esc cancels; an empty or unchanged name cancels.
A **version tab** has no rename: double-click does nothing (`startRename` returns for a doc tab with
`version`), because the tab holds an old text of the document at the document's path and renaming it
would rename the file. What a commit does depends on the kind:

- **Terminal/agent/attached** — renames the tab in place and marks it user-named (`renamed`), so
  automatic titles (agent start/exit, a session's own title) never overwrite your choice; it also
  clears an app-given title and the unnamed mark. Survives restart.
- **App** — the title and `renamed`: the tab stops following its manifest's title. An app-given
  title (`tabs.setTitle`, or a keyed `openApp` with a `title`) marks the tab `appTitled` — it stops
  following the manifest too — even when the title equals the current one; a user rename wins over
  it.
- **Commit / comparison / conflict / branch** — the title only.
- **Doc** — renames the file **on disk** (collision-refusing: on `already exists` the input
  stays open, focused, holding your text so you can correct it; Esc restores the original).
  Every open tab pointing at that file — in any project — follows to the new path. The input is
  seeded with the file's name, not the tab's title.

## Per-tab colors

**Change color** (context menu) tints any tab kind with one of six soft colors — Red, Amber,
Green, Teal, Blue, Purple — or **None**. Stored as a palette key on the tab (re-themes with the
app), persists across restarts.

## Context menu

Right-click a tab — this does **not** activate it (so you can act on an inactive tab, e.g. mark
it unread, without clearing its dot). Items:

- **Close** / **Close others** / **Close to the right** — all guarded, see
  [closing-tabs](./closing-tabs.md).
- **Mark unread** — sets the red dot on any kind, even the active tab.
- **Rename document** (doc) / **Rename tab** (every other kind) — same inline rename as
  double-click. On a version tab **Rename document** is disabled, with the tooltip `A version can't
  be renamed — rename the document from its own tab.` (`menu-tab-rename-doc-tooltip`).
- **Change color** — the six-swatch submenu plus **None**; the current choice is checked.
- **Copy to another project** (doc) / **Move to another project** (all kinds) — the
  cross-project submenus, below. Offered only when the workspace has another project.
- **Reveal in Finder** (doc, terminal, agent) — reveals the doc's file, or a terminal/agent's cwd, in
  the OS file manager (`app.showItemInFolder`); works for in- and out-of-workspace paths. App,
  commit, comparison, attached, conflict and branch tabs have no path of their own and no item.
- **Copy path** / **Copy full path** — doc tabs only; workspace-relative vs absolute.
- **Show tab details** (all kinds) — a separated bottom section: opens the raw-persisted-JSON
  admin/debug popup for this tab (edit + Save state-only). See [tab-details](./tab-details.md).

The menu clamps to the viewport and its submenus flip left near the right edge; Esc or a
click outside closes it.

## Cross-project actions

**Copy and Move are two distinct menu items.** Docs get **both**; every other kind gets **Move
only** (a live PTY can't be in two places). Each opens the same picker: a list of every project —
the Workspace project first, then **exact Projects panel order** (a pre-order walk of the group
tree, so nested-group order shapes the project order; groups aren't shown as headers) — with the
current project excluded.

- **Move to another project** (all kinds) — the tab *leaves* this project and lands at the
  **end** of the target's strip. For a terminal/agent the tab and its **PTY are the same**: the
  shell keeps running, its scrollback, cwd, exported variables and any running command ride
  along, and the pane is never remounted (see [pane-host](./pane-host.md)). The move is one atomic
  store update for both projects, so the PTY reaper never sees a moment with no tab referencing the
  PTY. Moving the active tab focuses its **right neighbor** in the source (fallback left if it was
  last) — the one close-like path that does not use the previously-active rule of
  [closing-tabs](./closing-tabs.md).
  **Move dedupes docs by path, like Copy:** if the target already shows that file (or, for a
  version tab, that version) you never end up with two tabs of it. A **clean** moved tab simply
  leaves this project and the target's existing tab is re-used (it gets the unread dot if it didn't
  have one and isn't the target's active tab). A moved tab with **unsaved changes** *replaces* the
  target's clean copy in its slot — your buffer travels, the clean view closes. If **both** copies
  have unsaved changes, both tabs are kept: two buffers of one file can't be merged and neither may
  be thrown away (known limit). Terminals/agents and never-saved docs never dedupe.
- **Copy to another project** (doc) — a **copy** of the tab appears at the end of the target's
  strip (a doc path is workspace-relative, so it reads from any project); this tab stays as it
  is. The copy is a fresh view of the file on disk — unsaved changes and the unread dot stay
  with the original. Asking twice **re-uses** the tab already there instead of opening a second
  one. A never-saved doc can't be copied (toast `Save the document first.`). When the target
  project's root doesn't contain the path, the copy shows the orange outside-project
  [scope mark](./scope-marks.md); with the file now open in two projects, both copies also carry
  the duplicate-open triangle.

**Drag a tab onto a Projects panel project row = Move.** Besides the menu, you can drag a tab off the
strip and drop it on a **project row** in the Projects panel to move it there — any tab kind, always
**Move** (never Copy). It runs the same `moveTabToProject` as the menu (end of the target strip,
unread so the target's derived counter rises, live PTY preserved, source focus to the
right neighbour). Dropping on the current project's row is a no-op; group headers are not
targets. The drag carries a custom marker (`TAB_DRAG_MIME`) so the Projects panel recognises a tab drag
during `dragover`. Full behaviour + the drop affordance:
[groups-and-projects](../projects/groups-and-projects.md) § "Drop a tab onto a project row = Move".

**Arrival signal.** A copied or moved tab lands **unread** (red dot) in the target, so
the target project's red Projects panel counter rises to include it. The arrival does **not** steal
focus in the target (so opening it clears the dot on the activation edge); it becomes the
target's active tab only when the target had none, in which case it carries no dot (an active tab
never does) and so isn't counted. Neither action switches the active project — the tab is simply
there when you go over. The menu actions toast the receipt (`Moved to <project>` / `Copied to
<project>`); the drag gesture does not. Because the counter is *derived from the unread-tab set*,
it can't over-count: a repeat copy — or a **move** that dedupes — onto a tab already carrying the
unread dot re-uses that one tab, and the count stays equal to the number of unread tabs there.
Opening the target project does **not** reset the counter; it ticks down as you read (activate)
each unread tab.

## Drag-and-drop reorder

Drag a tab to reorder within the project: drop on another tab's left/right half inserts
before/after it, and the **free strip area right of the last tab** is a live "move to end" drop
zone (the whole remainder up to the action cluster, showing the same insertion line; suppressed
when the dragged tab is already last). Reorder is a pure array move — panes never remount, so
**a live terminal keeps its PTY through a reorder**. The new order persists. A tab is not
draggable while its rename input is open.

While a drag is in flight and the pointer is within 56 px of either edge of the strip row —
including over the action cluster on the right — the overflowing strip pans (16 px per animation
frame). The app drives this itself from the window-level `dragover`; it does not rely on Chromium's
native autoscroll.

**The insertion line never outlives its drag.** Both indicators — the between-tab line
(`data-drop="before|after"` on the tab) and the end-zone line (`data-drop-end="true"`) — clear on
every way a drag can end, not just on a drop inside the strip: the pointer leaving the strip
mid-drag, a cancelled drag (Esc / release on a non-target), and a drop on a **Projects panel project
row** (which unmounts the source tab so its own `dragend` never fires). Window-level `dragover` /
`drop` / `dragend` listeners, live only while a strip drag is in flight, own that clearing; inside
the strip they are no-ops, so a legitimate reorder drag is unchanged.

## Autoscroll

The active tab is always scrolled into view — whatever activated it (tree click, context menu,
launch, hotkeys, preview reuse). A no-op when it is already visible; no jumping.

## Empty-space context menu

Right-clicking the free area right of the last tab (the end zone, otherwise a drag target for
"move to end") opens a strip context menu (`strip-context-menu`) with the same five actions as the
Bulk actions menu: **Reopen closed tab** (disabled when the project's reopen stack is empty), Stop
all terminals, Exit all agents, Close all docs, Close saved docs. It is a deliberately
**independent copy** of that item list, not generated from shared config (the two are expected to
diverge); it reuses only the low-level menu primitives (`ContextMenu`: scrim + clamped position).
Right-clicking a **tab** still opens the per-tab menu — the empty-space handler is on the end zone
only. See [closing-tabs](./closing-tabs.md) for reopen semantics.

## Hotkeys

The tab hotkeys are application-menu accelerators (File menu), so they work with any focus,
including inside a terminal, and never reach the pty:

- **Cmd+W** (`Close Tab`) closes the active tab of the active project; a no-op with no tab open.
- **Cmd+T** (`New Terminal Tab`) opens a new terminal right of the active tab.
- **Cmd+Shift+T** (`Reopen Closed Tab`) reopens the most-recently closed tab of the active project.
- **Cmd+Shift+W** (`Close Window`) closes the window (the quit confirmation runs first, see [app shell](../core/app-shell.md) "Quit protection").

Pomade defines no tab-switching shortcut (no Cmd+1..9, no Ctrl+Tab).

## Boundaries worth knowing

- The strip scrolls horizontally when tabs overflow (`tabstrip-scroll`); there is no tab
  overflow menu.
- An untitled (never-saved) doc can't be renamed from the tab — save it first (toast
  `Save the document first.`).

Tickets: T-036, T-048, T-062, T-087, T-097, T-103, T-104, T-111, T-117, T-119, T-123, T-148, T-149,
T-150, T-151, T-181, T-226, T-244, T-290, T-295, T-298, T-299, E-004, E-025, E-034.
