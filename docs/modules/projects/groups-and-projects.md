---
doc: docs/modules/projects/groups-and-projects.md
audience: engineers, product
holds: the Projects panel — the Workspace row, nested groups, Ungrouped, create/edit/delete, highlight and colors, reorder and drop targets, collapsing groups and the rail, counters; how it is built
kind: reference
---

# Groups & projects — the Projects panel

**Module:** `projects` · **UI:** the Projects panel (`Projects`) · **Code:**
`src/renderer/modules/projects-panel/` (`ProjectsPanel.tsx` orchestrator, `GroupSection.tsx`, `ProjectRow.tsx`,
`UngroupedSection.tsx`, `ProjectsPanelRail.tsx`, `useProjectsPanelDnd.ts`, `reorder.ts`, `GroupModal.tsx`,
`ProjectModal.tsx`, `WorkspaceIconModal.tsx`, `projects-panel-parts.tsx`), `src/renderer/stores/{workspace-store,workspace-ui-store,new-project-store,marks-store}.ts`
· **e2e:** `projects-panel-tree.spec.ts`, `projects-panel-nesting.spec.ts`, `projects-panel-actions.spec.ts`,
`projects-panel-highlight.spec.ts`, `projects-panel-row-colors.spec.ts`, `projects-panel-footer-pinned.spec.ts`,
`group-attention-aggregate.spec.ts`, `project-creation.spec.ts`, `project-teardown.spec.ts`,
`project-visible-agents.spec.ts`, `start-project-from-folder.spec.ts`, `git-ops-new-project.spec.ts`,
`tab-drag-to-projects-panel.spec.ts`

## What it does

The Projects panel organizes the workspace into **projects** (each a folder in the workspace, with its own
tabs, file tree and visible agents) held in a **tree of groups** up to 4 levels deep. Clicking a
project makes it the active project; the whole middle and right area (tree, tabs, panes) flips to
it with nothing torn down (see [pane host](../tabs/pane-host.md)).

Top to bottom: the header (`Projects`, **Collapse Projects panel** `«`, **New group** `⊞`, **New project**
`+`), the pinned **Workspace** row, the top-level groups interleaved with **Ungrouped** at its stored
position, a drop zone filling the remaining space, and the footer (**Settings**, tooltip
`Settings (Cmd+,)`, and the app version). Only the project list scrolls.

## Data model

Groups and projects are stored in `.pomade/workspace.json` (`groups`, `projects`, `ungroupedOrder`,
`identity`); `workspace-store` persists on every mutation. A `Group` carries `name`, `description`,
`icon` / `image`, `parentId`, `order`, `highlighted`, `color`. A `Project` carries `name`, `groupId`,
`rootPath` (workspace-relative; `''` = the workspace root), `area`, `description`, `icon` /
`image`, `visibleAgents` (`['*']` = all, `[]` = none), `order`, `highlighted`, `color`. `order`
is scoped to a sibling list; every drag renumbers the affected lists densely, so repeated drags never
drift. The group tree is normalized on load (`normalizeGroupTree`): a dangling parent, a cycle or a
chain deeper than 4 is repaired non-destructively and written back.

Machine-local Projects panel state lives apart, in `.pomade/state/workspace-ui.json` (gitignored):
`collapsedGroups`, `lastActiveProjectId`, and app overlay positions.

## The Workspace project

The first row is always **Workspace**: a built-in project rooted at the workspace root, not stored in
`workspace.json`. It is pinned, cannot be deleted, renamed, moved or grouped (only its icon is editable), and is how you reach
files that belong to no project. The whole row opens it (click, or Enter / Space with the row
focused); its icon (48 px, default 💠) is a separate button, tooltip `Change workspace icon`, that
opens the `Workspace icon` dialog; right-click on the row offers `Change icon…`. The row shows the
git badge and the unread counter like any project, and is a valid target for a dragged tab. See
[icons](./icons.md).

## The Ungrouped pseudo-group

Projects without a group live under **Ungrouped**. It takes part in top-level ordering (drag the
header; its position is `ungroupedOrder`) but cannot be nested, renamed or deleted, and it is not
drawn while empty. A project can still be un-grouped while the section is hidden: dropping it on the
zone below everything moves it out of its group.

## Groups

A group's header shows its icon, name (tooltip: its description) and, on hover, a `+` button
(`Add to group`) and a kebab `⋮` (`More actions`).

- **Collapse.** A plain click anywhere on the header folds or unfolds the group; hovering the icon
  cross-fades it to a rotating chevron (the same toggle). A collapsed group hides its projects and
  sub-groups and shows the summed unread count of every project in its subtree (see Unread
  counters). Sub-groups keep their own collapse state, restored when the parent unfolds. The set of
  collapsed groups is persisted per workspace (`workspace-ui.json`) and shared with the rail. An
  expanded group with no projects and no sub-groups shows `No projects`, which accepts a dropped
  project.
- **`+` menu**: `New project` (the New project dialog with this group preselected) and
  `New sub-group` (hidden at depth 4).
- **Kebab menu**: `Move up`, `Move down` (among siblings; disabled at the ends), `Edit`, `Highlight` /
  `Remove highlight`, `Change color ▸` (`None`, `Red`, `Amber`, `Green`, `Teal`, `Blue`, `Purple`),
  `Delete`.
- **Dialogs**: `New group` / `New sub-group` / `Edit group` with Name, Description, Icon; the
  buttons are `Create group` / `Save`.
- **Delete** asks `Delete group?`: its projects move to Ungrouped and its sub-groups move up one
  level; nothing on disk changes.

## Projects

A project row shows its icon (16 px), name, optional **area** label, the git badge and the unread
counter; a click activates it. The kebab (`More actions`): `Move up`, `Move down`, `Edit`,
`Highlight` / `Remove highlight`, `Change color ▸`, `Delete`.

**New project** (header `+`, a group's `+` ▸ `New project`, or the tree's **Start new project from
here**) opens `New project`. The **Project source** is an explicit choice:

- **From existing folder** — `Root folder`, a workspace-relative folder (path picker or typed). A
  folder that does not exist yet is created on Create.
- **New from template** — `Template folder` (a workspace folder to copy), `Parent folder` (default
  `Projects` when it exists); the copy `<parent>/<name>` becomes the root. Create is refused with
  `Target already exists: …` when the target exists.

**Track with git** (both sources): a template copy or a folder that does not exist yet starts as a
repository with a first commit (`Start <name>`) unless unchecked; an existing folder without git is
offered unchecked; a folder that already is a repository shows its remote (or `Local only`); one
inside another repository names it. When the first commit cannot be made (git does not know the
user's name and email), the project is still created and the dialog says what to run — see
[operations and safety rails](../git/operations-and-safety-rails.md).

Further fields: **Name** (required), **Group**, **Area** (free text with suggestions from the other
projects' areas), **Description**, **Icon**, **Visible agents**. Hand-typed roots are normalized
(leading and trailing slashes stripped) so they cannot break the tree. **Edit project** shows the
same fields with an editable `Root folder` instead of the source choice; it never copies or creates
anything. A newly created project becomes the active one.

**Visible agents** (`All agents` by default, or a per-agent checklist; unchecking every agent saves
*no agents*, a real choice) decides which agents the project offers: the **+** menu of the tab strip,
the editor's agent actions, and Session history for the project. Hosted apps read and change the
same list through the Host API ([workspace data API](../core/workspace-data-api.md)); the Workspace
project always offers every agent.

**Delete** asks `Delete project?` — the project is removed from the workspace config and **its files
on disk are untouched**. It is also a teardown of the project's app state: every tab of the project
is closed without a save prompt (so its terminals and agents are killed and dirty documents are
not saved), its per-project state file and mounts are removed, and, if it was the active project, the
Workspace project becomes active.

## Highlight and row colors

**Highlight** (kebab) renders a row's name bold in the expanded list. It is an emphasis marker, not a
favorites system: nothing reorders. The menu label always names the action the click performs.

**Change color** gives a row one of 6 hues or `None`. Color interacts with the other states
automatically:

- *Colored, resting* → a soft tint fills the row.
- *Highlighted* → the fill deepens to the medium tone (and the name is bold).
- *Active project* → the fill stays and the row gains a 2 px border two tones darker than the fill.
  Groups are never active, so they show only the fill.
- *Active with no color* → a near-white fill and a neutral gray 2 px border (`--row-active-bg`,
  `--row-active-border`); this is the resting look of the open project, the Workspace row included.

The tone ladder per hue is `--row-tint-<hue>-{soft,medium,strong}` in `tokens.css`. `highlighted` and
`color` live on the project or group in `workspace.json`. The red unread badge keeps its own red
inside any tint. The collapsed rail mirrors this with a full-background chip per launcher and a ring
on the active one.

## Reordering and nesting (drag and drop)

Two HTML5 drag systems share one hook (`useProjectsPanelDnd`); the pure planners live in `reorder.ts`.

- **Project rows** — drop on another project's top or bottom half to insert before or after (also
  across groups); drop on a group header to move into that group (the header's bottom band makes it
  the first member, elsewhere on the header appends); drop on Ungrouped, the below-everything zone or
  `No projects` places it there.
- **Group headers** are the single group-drop target. When nesting is legal the header has three
  bands: the top edge inserts above, the center nests *into* the group, the bottom band nests as the
  first child (band height 30 % of the row, clamped to 6–14 px). When nesting is not legal (into
  itself, a descendant, or past depth 4) the header reduces to before / after halves. The **gap**
  strip before each section drops "here, at this level"; the zone below everything means "last in
  the top-level order".
- Every illegal move is refused whole — never a partial mutation. The kebab's **Move up** / **Move
  down** remain as the keyboard path.

## Dropping a tab on a project row = Move

A tab dragged off the tab strip and dropped on a **project row** moves it into that project, for any
tab kind (a terminal or agent keeps its live PTY). It goes through the shared
`tabs-store.moveTabToProject` (see [tab strip](../tabs/tab-strip.md)): the tab lands at the end of
the target's strip, unread so the target's counter rises, the source strip focuses the
moved tab's right neighbour, and a doc the target already shows is not duplicated. Drag is always
Move; the tab menu still offers Copy for docs.

- **Valid targets:** every project row except the active one, plus the Workspace row. Group headers
  are not targets.
- **Affordance:** the hovered valid row shows a solid accent outline; the active project's row never
  lights up. The two gestures are told apart by the `application/x-pomade-tab` drag marker, which
  Projects panel reorder drags do not carry, so a tab drag shows no reorder lines and a reorder drag shows no
  tab outline.

## Collapsed rail

**Cmd+B** (menu item `Toggle Projects Panel`) or `«` collapses the Projects panel to a rail (`ProjectsPanelRail`): the
Workspace project's launcher, then each top-level section's subtree flattened depth-first — a group **marker**
(its icon at its tier size; clicking it expands the Projects panel) followed by its projects' launchers —
with separators between top-level sections. A group whose subtree holds no project is not drawn; a
collapsed group shows only its marker. Per-project unread counters and git dots ride the launchers;
the sum across every project rides the expand button (`Expand Projects panel (Cmd+B)`). Settings stays as
a gear at the bottom.

## Unread counters

A red badge (capped `9+`) on a project row is the live count of that project's **unread tabs**: tabs
carrying the red dot (a terminal or agent whose turn ended or long command finished, or any tab marked
unread), all kinds counted. It is derived from the tabs (`marks-store.useProjectRowCounts`), so it
always equals the dots, combined with any marks other sources set on the project row
(`row:project:<id>`). Opening a project does not reset it; the count ticks down as each unread tab is
activated. Because the unread flag is persisted, counts survive a restart. A collapsed group shows
the sum of its subtree. Details: [agent providers](../agents/agent-providers.md).

## Git badge

Before the counter a project row shows `● 5 ↑2` — uncommitted files and unpushed commits over the
project's repositories — and nothing when clean and pushed; the Workspace row sums every repository,
and a rail launcher gets a corner dot with the same lines in its tooltip. Details:
[git in the tree](../git/git-in-the-tree.md).

## Following the active project

When the active project changes by anything but the user's own pick — a notice, an app or an agent opening
something in another project, a symlink into one — the panel reveals the project
(`useRevealActiveProject`): it unfolds the collapsed groups around the row (the change is saved, like a
click on the header), scrolls the row into view inside the list (never the shell around it) and flashes it
with an accent ring twice. The collapsed rail does the same with the launcher. The user's own picks go
through `pickProject` — a row or launcher click, a project created from the panel, the toast's Back — and
only scroll into view; so does the workspace's first active project at startup.

While the experimental app setting `projectSwitchToast` is on (default; Settings ▸ General ▸ Experimental),
the same switch shows a toast *Switched to B* with **Back to A**. A newer switch replaces it; there is none
when A no longer exists.

## Startup and workspace switches

On launch the active project is the one saved in `lastActiveProjectId` (written on every switch);
a removed project falls back to the Workspace project. A workspace switch lands on the Workspace project and reloads that
workspace's collapsed groups.

## Boundaries worth knowing

- Group depth is capped at **4**, matching the four icon tiers (40 / 32 / 24 / 16 px).
- Ordering is per sibling list; the Ungrouped section's position is shared with the top-level
  groups' order space.

Tickets: E-010, E-015, E-026, T-104, T-140, T-182, T-183, T-186, T-190.
