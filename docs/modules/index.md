---
doc: docs/modules/index.md
audience: engineers, product
holds: the module map — each module's scope, where it lives in code, and a summary of its feature docs
kind: reference
---

# Modules

A module is a real area of the product with a home in the code. Tickets name one in `module:`;
e2e specs declare theirs in a `// modules:` header, and
`scripts/e2e-affected.mjs` maps source paths to modules. Each module folder here holds one doc per
feature: what it does and its product rules, how it is built, invariants, tests, known limits. How to
*use* each feature is in the [user guide](../user-guide/index.md).

| Module | Covers | Where in code |
|---|---|---|
| `core` | app shell and window, persistence (`.pomade/`), IPC, settings, notices, and the platform's app side: app hosting, backends and commands, side panels, workspace data API, event bus | `src/main/{index,ipc,windows,config-store,app-*,host-*,event-bus,notice-queue*,theme}.ts`, `src/preload/`, `src/shared/`, `src/cli/`, `src/renderer/{layout,stores}/`, `src/renderer/modules/{apps,side-panels,notices,settings}/` |
| `projects` | groups and projects — the Projects panel, project and group config, create, delete, reorder, icons | `src/renderer/modules/projects-panel/`, `stores/workspace-store.ts` |
| `filetree` | the file tree: roots and mounts, live refresh, file management, multi-select, symlinks | `src/renderer/modules/filetree/`, `src/main/fs-*.ts`, `stores/mounts-store.ts` |
| `tabs` | tab strip, pane host, per-project tab state, preview tabs, closing, scope marks | `src/renderer/layout/{TabStrip,PaneHost,TabDetails}.tsx`, `stores/tabs-store.ts` |
| `editor` | the document pane: rendered, raw and live view, CSV, properties, save, recovery | `src/renderer/modules/editor/`, `src/main/{recovery-store,doc-watch,fm-index}.ts` |
| `terminal` | PTY terminals: panes, lifecycle, links, copy and paste, rendering, attached terminals | `src/renderer/modules/terminal/`, `src/main/{pty-manager,attached-terminals,name-index,path-probe}.ts` |
| `agents` | agent providers, roster, agent tabs, session history and attribution | `src/renderer/modules/agents/`, `src/main/{agent-*,agents-live,session-watcher,codex-rollout}.ts` |
| `git` | git in the tree, Git panel, history, comparison, operations, branches and worktrees, `pomade-git` | `src/git-core/`, `src/main/{git-*,local-history*}.ts`, `src/shared/git-*.ts`, `src/renderer/modules/git/` |

A new area gets its row here first; when one grows its own code folder, the row follows.

## Feature docs

### core

The window and the platform under every surface: how the app is laid out and quits, where state
persists, how it scales to a large workspace, and everything that lets apps live inside Pomade.

- [app-shell](core/app-shell.md) — layout columns, the application menu, quit protection, theme tokens.
- [workspaces-and-persistence](core/workspaces-and-persistence.md) — the workspace folder, every state file, write discipline, startup, switching workspaces.
- [settings](core/settings.md) — the Settings modal, every setting and where it is stored.
- [notices](core/notices.md) — notices, the Notices panel, muting, the closed-Pomade queue, marks and badges.
- [scale-and-reliability](core/scale-and-reliability.md) — watchers and their settle, the name index, ignore lists, `smoke:scale`.
- [app-hosting](core/app-hosting.md) — where apps come from (installed, bundled, dev-linked), app frames, routes, shortcuts, the overlay, the `pomade` command.
- [app-backends](core/app-backends.md) — the Host API socket, backends with Pomade and always on, app commands on PATH, the broker.
- [side-panels](core/side-panels.md) — the icon strip, panels, badges, collapse and width.
- [event-bus](core/event-bus.md) — platform and app events, subscriptions.
- [workspace-data-api](core/workspace-data-api.md) — files, frontmatter, projects, git state, tabs and pickers for apps; the safety rails.

### projects

The Projects panel's groups and projects — the central domain object every other module scopes to.

- [groups-and-projects](projects/groups-and-projects.md) — the Workspace row, nested groups, create, edit, delete, colors, reorder, collapse, counters.
- [icons](projects/icons.md) — the icon picker (icons, emoji, image), sizes, storage.

### filetree

The Files panel: a project's roots, live and lazy, and every file operation.

- [the-tree](filetree/the-tree.md) — roots, lazy loading, live refresh, the header and options menu, go to path, git marks.
- [mounts](filetree/mounts.md) — extra roots inside or outside the workspace, the outside-workspace doors.
- [file-management](filetree/file-management.md) — create, rename, move, copy, trash; drag and drop; collisions; tabs following moves.
- [multi-select](filetree/multi-select.md) — the click matrix and bulk operations.
- [symlinks](filetree/symlinks.md) — link indicators, the target popover, cycle safety.

### tabs

Every open thing is a tab; every project's tabs stay mounted and only the active one shows.

- [pane-host](tabs/pane-host.md) — the hidden-never-unmounted invariant and what follows from it.
- [tab-strip](tabs/tab-strip.md) — tab kinds, dots and marks, rename, colors, menus, cross-project moves, drag reorder.
- [preview-tabs](tabs/preview-tabs.md) — the one-preview-tab rule.
- [closing-tabs](tabs/closing-tabs.md) — close guards, batch closes, where focus lands, reopening.
- [scope-marks](tabs/scope-marks.md) — the ⚠ on documents outside the project or the workspace.
- [tab-details](tabs/tab-details.md) — a tab's persisted JSON, editable.
- [per-project-tab-state](tabs/per-project-tab-state.md) — what persists per project, who owns which field, what restores.

### editor

A doc tab edits one file in one of four views — Raw (CodeMirror), Live (byte-true rendered markdown,
the default), Rendered (Milkdown) or the CSV table — and never overwrites a change made elsewhere.

- [editing-modes](editor/editing-modes.md) — the mode button, which view a doc opens in, the parse-health gate, caret and position across toggles.
- [raw-view](editor/raw-view.md), [live-view](editor/live-view.md), [rendered-view](editor/rendered-view.md), [csv-editing](editor/csv-editing.md) — the four views.
- [markdown-editing](editor/markdown-editing.md) — paired elements, checkboxes, line breaks, em-dash, bold and italic.
- [frontmatter-properties](editor/frontmatter-properties.md) — YAML frontmatter as typed rows.
- [find-in-document](editor/find-in-document.md), [editor-links](editor/editor-links.md), [color-swatches](editor/color-swatches.md), [spellcheck](editor/spellcheck.md), [fonts](editor/fonts.md).
- [editor-header](editor/editor-header.md), [editor-context-menu](editor/editor-context-menu.md) — the pane's chrome.
- [save-and-file-lifecycle](editor/save-and-file-lifecycle.md) — saving, guards, Untitled, refused and outside-workspace files, version tabs.
- [external-changes](editor/external-changes.md) — rule 8: detecting other writers, the banner, Compare / Keep mine / Use disk version.
- [unsaved-recovery](editor/unsaved-recovery.md) — recovery copies and 7-day discarded drafts.

### terminal

PTYs in the main process, shown in tabs that survive project switches and restarts.

- [panes-and-lifecycle](terminal/panes-and-lifecycle.md) — opening, hidden panes, revive after restart, scrollback, close guards, attention.
- [rendering](terminal/rendering.md) — xterm configuration, widths, font, wake repaint.
- [shell-integration](terminal/shell-integration.md) — the zsh shim, markers, cwd, the child environment.
- [copy-paste-and-selection](terminal/copy-paste-and-selection.md), [file-and-url-links](terminal/file-and-url-links.md).
- [attached-terminals](terminal/attached-terminals.md) — tabs on sessions an app's keeper holds.

### agents

Coding agents (Claude Code, Codex, folder agents) as first-class tabs: launched, attributed to their
sessions, resumable.

- [agent-roster](agents/agent-roster.md) — discovery, per-project visibility, launch, command mapping.
- [agent-tabs](agents/agent-tabs.md) — agent tabs as apps see and steer them.
- [agent-providers](agents/agent-providers.md) — how an agent signals attention; the per-provider checklist.
- [session-attribution](agents/session-attribution.md) — how a tab learns its session id.
- [session-history](agents/session-history.md) — browsing and resuming past sessions.
- [session-stores](agents/session-stores.md) — per-provider facts about session stores.

### git

Git for a reviewer of agents' work: what changed, what isn't pushed, what landed — with previews and
rails on every operation.

- [git-in-the-tree](git/git-in-the-tree.md) — marks, badges, the git-state service.
- [git-panel](git/git-panel.md) — repo lists and the repo view.
- [operations-and-safety-rails](git/operations-and-safety-rails.md) — commit & push, get their changes, undo, discard; the rails.
- [operator-layer](git/operator-layer.md) — staging, branches, fetch, pull, publish, rebase.
- [branches-and-worktrees](git/branches-and-worktrees.md) — In progress, the branch tab, merge, cleanup, the agent session link.
- [conflict-tab](git/conflict-tab.md), [comparison-tab](git/comparison-tab.md), [commit-details](git/commit-details.md), [diff-view](git/diff-view.md).
- [document-history](git/document-history.md), [local-history](git/local-history.md) — a document's versions.
- [pomade-git](git/pomade-git.md) — the command, its run log, scheduled jobs.
