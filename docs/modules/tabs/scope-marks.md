---
doc: docs/modules/tabs/scope-marks.md
audience: engineers, product
holds: scope marks — the exclamation triangle on doc tabs and the editor header showing a document outside the project's scope or the workspace, or open in several projects; project scope, the tiers, the header's short path, tooltips and rules
kind: reference
---

# Scope marks — the exclamation-triangle location indicator

**Module:** `tabs` + `editor` · **UI:** doc tabs (testid `tab-scope-<id>`) and the editor header
(testid `editor-scope`) · **Code:** `src/renderer/components/ScopeMark.tsx`,
`src/shared/paths.ts` (`classifyScope`, `scopeRelativePath`), `src/renderer/stores/project-scope.ts`,
`src/renderer/layout/TabStrip.tsx`, `src/renderer/modules/editor/EditorPane.tsx`, `EditorHeader.tsx` ·
**e2e:** `scope-marks.spec.ts`, `scope-header.spec.ts`, `classify-scope.spec.ts`, `project-scope.spec.ts`

## What it does

A tiered, self-explaining indicator for **where a doc lives** relative to the **scope** of the
project it is being viewed in. It is an exclamation-warning triangle in its **own slot**, independent of the blue
(unsaved) and red (unread) dots: a tab may show a dot **and** a triangle at once, and the
active-tab underline stays accent-blue in every case. Only **one** scope triangle ever shows per
surface (orange XOR red). It is a passive indicator (role `img`, focusable for its tooltip); the
agent tab's clickable Unbound mark reuses the same component and is a different thing
([tab strip](./tab-strip.md)).

## Project scope

A project's scope is its **root folder plus its in-scope folders**: the mounted folders put in
scope (mount dialog box **Add to project scope**, or the mount header menu's **Add to project
scope** / **Remove from project scope**; the flag is `Mount.inScope`, persisted with the mount —
[mounts](../filetree/mounts.md)). Files in an in-scope folder count as the project's own, whether
the folder is inside the workspace or outside it. The scope folders are derived from the mounts
store (`useProjectScopeFolders`), never stored on a tab, so a mark follows a scope change at once —
including for tabs already open. Every project's mounts are hydrated at startup, so the marks of a
background project's tabs are right when it is first shown.

## The tiers

Colour is location severity, from `classifyScope(path, projectRoot, scopeFolders)`
(`src/shared/paths.ts`). Paths are stored workspace-relative; an **absolute** path (leading `/`)
means outside the workspace.

| Scope | Meaning | Triangle |
| --- | --- | --- |
| `in-project` | under the project root, or under an in-scope folder | none |
| `outside-project` | workspace-relative, outside the project's scope | **orange** (`--warning`) |
| `outside-workspace` | an absolute path, outside the workspace, in no in-scope folder | **red** (`--danger`) |

The **Workspace project** (rootPath `''`) treats every workspace-relative doc as
in-project — its root *is* the workspace root — but an absolute path there is still
outside-workspace unless an in-scope folder covers it. Red never shows for an in-workspace file.
Everything is computed at render, never stored, so the same file is orange in one project and
unmarked in another (an in-scope folder belongs to one project's mounts only).

An outside-workspace doc opens from a terminal link, a path typed into the file tree's go-to box,
or an app; it is stored with its absolute path, and is dropped at restore when the file no longer
exists. A file under an **outside mount** opened from a terminal link or the go-to box takes the
mount's tree path (the mount's stored path plus the file's relative part), the same path a click in
the tree opens, so both entry points land on one tab; the tab carries the mount's scope: unmarked
when the mount is in scope, red when not ([the tree](../filetree/the-tree.md) "Go-to-path row").

## Duplicate-open indicator

When the same file path is open as doc tabs in **≥2 different projects** (the Workspace
project counts as a project), **every** copy shows a triangle. Duplication only **adds a
tooltip line** — it never changes the colour and can force the triangle even for an in-project
doc (whose location alone would show nothing). When the other copies close, the duplicate line —
and the triangle, if location was the only other reason — disappears on the survivor. A
[version tab](../git/document-history.md#a-version-in-its-own-tab) does not count: it is not the
document's own tab, so neither it nor a version of the same path ever raises the duplicate line.

## Tooltips (stacking)

The shared tooltip box (`TooltipBubble`, themed from tokens, portalled so the tab strip's overflow
never clips it), one line per active reason. Short lines stay on one line, longer ones wrap inside
320px, and the box is clamped inside the window (flipping above the icon near the bottom). It opens
on hover and on keyboard focus:

- outside-project: `Outside this project`
- outside-workspace: `Outside the workspace`
- duplicate (appended): `2+ copies open across projects`

A tab an app opens (`tabs.openFile`) is an ordinary doc tab: it opens in the project the app names
(default the active one), so a file outside that project shows the orange mark like any other. The
app avoids it by naming the project that holds the file (`projectId`), or `"__workspace__"` for a
file outside every project.

## In the editor header

The same `ScopeMark` sits in the doc header, to the **right** of the name/path and **before** the
file-type chip, with the same stacking tooltip. It also drives the header's expanded path format
(`scopeRelativePath`):

- a doc under the project root shows its path **from the root** (workspace-relative for the
  Workspace project);
- a doc under an in-scope folder shows `<folder name>/…`: the folder's last path segment, then the
  path inside it, from the deepest in-scope folder that holds the file;
- a doc outside the scope shows the `~`-relative full path (the absolute path when outside the home
  folder).

See [editor-header](../editor/editor-header.md).

Tickets: T-101, T-102, T-290.
