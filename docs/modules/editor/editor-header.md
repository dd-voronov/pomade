---
doc: docs/modules/editor/editor-header.md
audience: engineers, product
holds: the doc pane header — the expandable name/path field, the badges, and the action cluster (mode, History, Save, document actions, close)
kind: reference
---

# Editor header — the expandable name↔path field and the pane's controls

**Module:** `editor` · **UI:** the header bar atop every doc pane · **Code:**
`src/renderer/modules/editor/EditorHeader.tsx` (presentational), `EditorPane.tsx` (state, `headerPath`,
scope, handlers), `EditorContextMenu.tsx` · **e2e:** `editor-header-path.spec.ts`, `scope-header.spec.ts`,
`editor-save-state.spec.ts`

## What it does

The doc header shows the file **name**; clicking it expands the field to an informative **path** — one
global toggle for every doc and pane, applied live everywhere and persisted (app-level view state,
`AppSettings.editorHeaderShowPath` in the workspace's `.pomade/state/view.json`). There is deliberately **no Settings checkbox**:
clicking the field is the toggle (`aria-pressed`, testid `editor-title`). Hovering shows the full path in
both states, so a clipped path is always readable. Right-clicking the field opens the document's context
menu. macOS Ctrl+click opens the menu without also toggling the field.

## The path tiers

The expanded text is computed at render (never stored) from the project scope — the project root plus its
in-scope folders (in-scope mounts, [project scope](../filetree/mounts.md)) — via `classifyScope(path, projectRoot,
scopeFolders)` and `scopeRelativePath` (`src/shared/paths.ts`), picking the most local truth:

1. **Short path** (the doc is in the pane's project scope): under the project root, the path from the root.
   In the Workspace project (root `''`) every workspace-relative doc is in scope and shown workspace-relative,
   which is correct since its root is the workspace root. Under an in-scope folder, `<folder name>/…` from the
   deepest such folder (the workspace root's folder name is the workspace folder's own name).
2. **`~`-relative full path**: any doc **outside the project scope** (outside this project, or outside the
   workspace): the full absolute path, home-relativised to `~` when it lives under home. An in-workspace
   out-of-scope doc's absolute path is `workspaceRoot + path`; an already-absolute (outside-workspace) path is
   used as is.

An Untitled doc reads `Untitled` in both states. The home directory comes from `window.pomade.env.home` (a
synchronous, non-IPC value the preload snapshots via `os.homedir()`). **Long paths clip on the left**: the
ellipsis eats the start and keeps the filename visible; short paths sit flush left. The language badge and
the right-side controls are never squeezed.

## The action cluster

Right side, in order: the **mode button**, **History**, **Save / Saved**, the **⋯** document actions, and **×**.

- **Mode button** (testid `mode-toggle`): `Live` / `Rendered` / `Table` / `Raw`, present only for files with
  a rich view, an Untitled doc included (markdown by policy). The label names the current view; no tooltip.
  See [editing-modes.md](./editing-modes.md).
- **History** (testid `doc-history-toggle`, tooltip "Every version of this document (Cmd+Shift+H)"): pressed
  while the panel is open; absent for an Untitled doc and for a version tab. See
  [Document history](../git/document-history.md).
- **Save / Saved** (testid `doc-save`): label `Save` and enabled when the buffer is dirty **or** the file on
  disk has diverged from the buffer's sync point; `Saved` and disabled when the buffer is clean and the disk
  agrees. A refused file keeps it disabled and dimmed. Native `title=` (it must show on a disabled
  button): `Save (Cmd+S)`, `Saved — no unsaved changes`, or `File is not supported: editing is not available`.
  A divergence with a clean buffer changes only the label; the passive notice carries the message
  ([external-changes.md](./external-changes.md)). On a version tab Save replaces the document: title
  `Replace <doc> with this version (Cmd+S)`, or `<doc> holds this version` once replaced
  ([save-and-file-lifecycle.md](./save-and-file-lifecycle.md)).
- **⋯ Document actions** (tooltip "Document actions"): **Close saved docs** (clean tabs only, no prompts);
  **Close all docs** (every doc through its close guard); the checkable **New md opens: Rich/Raw**;
  for markdown, **Rich view: Live/Rendered**; and, for a markdown doc without frontmatter in a rich view,
  **Add properties** ([frontmatter-properties.md](./frontmatter-properties.md)).
- **×** (tooltip "Close document"): close through the dirty-doc guard.

## Header right-click

Right-clicking the name field opens the same `EditorContextMenu` the body uses, in its no-selection
variant, acting on this doc: Duplicate file, Copy file to…, New agent chat with this file in context, Copy
path, Copy full path. It opens at once and never shows a spelling section. See
[editor-context-menu.md](./editor-context-menu.md).

## Everything else in the header row

- **Dirty dot** (testid `editor-dirty`): accent dot after the title while unsaved.
- **Scope mark**: an exclamation triangle right of the name/path and **before** the language badge, shown for
  a doc that lives outside the project scope (orange, line "Outside this project") or outside the workspace (red,
  "Outside the workspace"), or is open as copies across projects ("2+ copies open across projects", which
  can force the triangle even for an in-scope doc). Same stacking tooltip as the tab
  ([scope-marks](../tabs/scope-marks.md)); shared `ScopeMark` component.
- **Version chip** (testid `editor-version`): `Version <label>` on a version tab, tooltip "An earlier
  version of <doc>, in its own tab." / "Save replaces <doc> with this text."
- **Language badge** (testid `editor-lang`): `Markdown`, `CSV`, `JSON`, `JavaScript`, `JSX`, `TypeScript`,
  `TSX`, `CSS`, `HTML`, `YAML`, else the uppercased extension or `Plain text`. An Untitled doc reads
  `Markdown` until saved.
- **Symlink chip**: on symlinked files; "Symbolic link — click to see target" opens the target popover
  (open / reveal / copy path).

Notices (file changed on disk, missing file, recovered edits, CSV fallback) appear in a row directly below
the header ([external-changes.md](./external-changes.md), [unsaved-recovery.md](./unsaved-recovery.md)).

## Boundaries worth knowing

- One global flag means expanding in one pane expands every header in every project; it is a display
  preference, not per-doc state.
- The setting survives relaunch; there is no way, and no need, to set it outside the click.

Tickets: T-090, T-101, T-139, T-143, T-290, E-021, E-038.
