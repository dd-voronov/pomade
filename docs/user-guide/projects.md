---
doc: docs/user-guide/projects.md
audience: users
holds: how to organize work in the Projects panel — the Workspace row, groups and projects, creating (also from a folder), editing, colors and icons, reordering, collapsing, deleting, unread counters
kind: reference
---

# Projects and groups

A **project** is a folder of your workspace with its own tabs, its own file tree and its own choice of
agents. The Projects panel on the left lists your projects, optionally sorted into **groups**. Click a project
and everything to its right — file tree, tabs, terminals — switches to it. Nothing is closed when you
switch: terminals keep running in the projects you left.

## The Projects panel at a glance

From top to bottom: the header (`Projects` with the buttons **Collapse Projects panel** `«`, **New group**
`⊞` and **New project** `+`), the **Workspace** row, your groups and the **Ungrouped** section, and at
the bottom **Settings** with the app version.

- **Workspace** is always first: the Workspace project, the whole workspace folder as one project, for
  files that belong to no project ([the workspace and the Workspace project](./getting-started.md#the-workspace-and-the-workspace-project)).
  It cannot be deleted or moved. Click the row to open it; click its icon (or right-click
  the row ▸ **Change icon…**) to change the icon.
- **Ungrouped** holds projects that are in no group. It appears only when it has projects.

## Create a project

1. Click **+** in the Projects panel header (or a group's **+** ▸ **New project**, which preselects that group).
2. In **New project**, type a **Name** and choose the **Project source**:
   - **From existing folder** — pick or type the **Root folder**, a folder inside your workspace. A folder
     that does not exist yet is created for you.
   - **New from template** — pick a **Template folder** to copy and a **Parent folder**; the copy
     `<parent>/<name>` becomes the project's folder. Pomade refuses if that folder already exists.
3. Optional: **Group**, **Area** (a free-text label shown next to the name, with suggestions from your other
   projects), **Description**, **Icon**, **Visible agents**.
4. Click **Create project**. The new project opens at once.

**Track with git** (shown for both sources) starts a git repository in the project with a first commit
named `Start <name>`. It is on for a template copy and for a folder that does not exist yet, off for an
existing folder without git. A folder that already is a repository shows its remote, or `Local only`.
If git does not know your name and email, the project is still created and the dialog tells you what to
run; see the [git guide](./git.md).

### Create a project from a folder you already see

In the file tree, right-click a folder ▸ **Start new project from here**. The **New project** dialog opens
with that folder as the **Root folder**. The item is greyed out for folders outside the workspace.

## Change a project

Hover a project row and click **⋮** ▸ **Edit**. The **Edit project** dialog has the same fields; you can
also change the **Root folder** there. Click **Save**.

**Visible agents** controls which agents the project offers: the **+** menu in the tab strip, the editor's
agent actions and the session history. `All agents` is the default; untick agents to hide them. Unticking
every agent leaves the project with none.

## Make a row stand out

The **⋮** menu on a project or group also has:

- **Highlight** / **Remove highlight** — the name turns bold. Nothing moves.
- **Change color ▸** — **None**, **Red**, **Amber**, **Green**, **Teal**, **Blue**, **Purple**. The row gets
  a soft tint (deeper when highlighted); the project that is open also gets a 2 px border.

Icons: in **Edit**, the **Icon** field has three sources — **Icons** (a searchable library of use-case
symbols and brand marks), **Emoji** (searchable, by category) and **Image** (any image file; Pomade keeps a
copy in the workspace, so it survives if you move the original). **Clear icon** goes back to the default.
Groups scale their icon with depth: 40, 32, 24 and 16 pixels.

## Groups

- **New group**: click **⊞** in the header. Give it a **Name**, an optional **Description** (shown as a
  tooltip on the name) and an **Icon**, then **Create group**.
- **Sub-groups**: a group's **+** ▸ **New sub-group**. Groups nest up to 4 levels; at the fourth level
  the item is not offered.
- **Edit**, **Highlight**, **Change color**: the group's **⋮** menu.
- **Collapse**: click the group's header (or hover its icon and click the chevron). A collapsed group
  hides its projects and sub-groups, and shows the total unread count of everything inside. Pomade
  remembers which groups are collapsed.

## Reorder and move

- Drag a project onto another project to place it before or after it, even in another group.
- Drag a project onto a group's header to move it into that group; drop on the lower edge of the header to
  make it the group's first project.
- Drag a project onto **Ungrouped**, or onto the empty space below the list, to take it out of its group.
- Drag a group the same way: the top edge of another group's header puts it above, the middle nests it
  inside, the lower edge nests it as the first child. The strip between two sections puts it at that level.
  Moves that are not allowed (into itself, deeper than 4 levels) do nothing.
- **Ungrouped** can be dragged too, to change where it sits among the top-level groups.
- Without a mouse: **⋮** ▸ **Move up** / **Move down** moves a row within its siblings.

Dropping a **tab** from the tab strip onto a project row moves that tab into that project (a terminal keeps
running). Groups are not drop targets for tabs.

## Delete

**⋮** ▸ **Delete** asks `Delete project?` or `Delete group?`.

- Deleting a **project** removes it from the Projects panel. **Your files are not touched.** Its tabs are closed
  without asking — terminals and agents running in it stop, and unsaved changes in its open documents are not saved —
  so save what you need first. If it was open, Pomade shows the Workspace project.
- Deleting a **group** moves its projects to **Ungrouped** and its sub-groups up one level. Nothing else
  changes.

## Unread counters

A red number on a project row (`9+` above nine) counts that project's tabs with a red dot: a terminal or
agent whose turn ended or whose long command finished, or a tab you marked unread. Opening the project does
not clear it; the number drops as you open each unread tab. A collapsed group shows the sum for everything
inside it. The counters survive a restart. A project row also shows a git badge such as `● 5 ↑2`
(uncommitted files, unpushed commits) when there is something to commit or push.

## Collapse the Projects panel

**Cmd+B**, or **«**, shrinks the Projects panel to a narrow strip of icons: the Workspace project, then each group's
icon followed by its projects. Click a project icon to open it; click a group icon, or **»** (tooltip
`Expand Projects panel (Cmd+B)`), to expand the Projects panel. The strip keeps the unread numbers and a small dot for
git changes; **»** shows the total. The gear at the bottom opens Settings.

## Shortcuts

| Keys | What it does |
|---|---|
| Cmd+B | collapse or expand the Projects panel |
| Cmd+, | open Settings |
| Enter, Space | open the Workspace row when it has focus |

## If something looks wrong

- *The Ungrouped section is missing.* It appears only when a project is in no group.
- *The **New sub-group** item is missing.* The group is already at the fourth level.
- *A project's tabs disappeared.* If the project was deleted, they were closed with it. Re-create the
  project from its folder; its files are intact.
- *The project opened empty after a restart.* Tab state is kept per machine, not in the repository, so a
  workspace opened on another computer starts with no tabs.
