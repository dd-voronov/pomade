---
doc: docs/modules/tabs/pane-host.md
audience: engineers, product
holds: the pane host — every project's every tab stays mounted and only the active one is shown; why it is the core invariant and what follows from it
kind: reference
---

# Pane host — hidden, never unmounted

**Module:** `tabs` · **UI:** the main pane area (testid `panehost`) · **Code:**
`src/renderer/layout/PaneHost.tsx`, `src/renderer/panes/registry.ts`, `src/renderer/App.tsx`
(pane registration) · **e2e:** `tabs.spec.ts`, `terminals.spec.ts`, `tab-cross-project.spec.ts`

## What it does

Renders the panes of **every project's every tab** — all at once — and shows exactly one: the
active tab of the active project. Everything else stays mounted in the DOM with `display:none`.
Switching tabs or projects is purely a **visibility flip**, never a mount/unmount.

A pane renderer is looked up by tab kind (`getPane(tab.kind)`): `EditorPane` (doc), `TerminalPane`
(terminal, agent), `AppPane` (app), `CommitPane`, `ComparePane`, `ConflictPane`, `BranchPane`,
`AttachedTerminalPane` (attached). A kind with no renderer shows `No renderer registered for “<kind>”.`

## Why this is THE invariant

Terminals are the reason. An xterm instance + its PTY only survive as long as their React
component stays mounted; if a project switch unmounted panes, every terminal would die the
moment you glanced at another project. Because panes only hide:

- **Terminals keep running across project switches** — output keeps streaming into hidden
  panes, which is also what lets a hidden project's agent raise the red unread counter.
- **Editor state survives** — scroll position, caret, an in-flight dirty buffer — without any
  save/restore machinery.
- Column resizes and tab reorders are equally non-destructive (pure CSS / array moves).

A pane is visible iff `project === activeProject && tab === project.activeTab`; there is no
other visibility rule.

## How it is built

The pane list is **flat** — one `PaneSlot` per tab of any project, keyed by **tab id alone** — and a
pane's project is *data* on the slot (`data-project-id`), not DOM structure. That is what lets a tab
**change project** (tab strip ▸ *Move to another project*) without a remount: the slot's props
change, the DOM node and the xterm inside it are the same ones. A wrapper div per project, or a key
that includes the project id, would make that move unmount the pane and rebuild the terminal from
the PTY ring buffer — losing older scrollback and any full-screen TUI's state. The host carries
`data-active-project` so the active project is still readable from the DOM.

Re-renders are scoped by identity, not content. `PaneHost` selects a flat array of `projectId tabId`
strings (`useShallow` compares them by value), so a field mutation (cwd, last command, color, dirty)
on any tab — which never adds, removes or moves a tab — does not re-render the host. Each
`PaneSlot` is `memo`-ized and subscribes to its own tab by id; `.find` returns the same object for
every tab that did not change, so the slot, and the real terminal or editor under it, skip the
render.

The host also renders the **app overlay** (`AppOverlay`, [app hosting](../core/app-hosting.md)): a
small app frame centred over the active tab, covering the pane area only.

It also renders the **bulk close confirm** (`BulkCloseConfirm`) for Stop all terminals / Exit all
agents, centred over the pane area like a pane's own close guard
([closing-tabs](./closing-tabs.md) "Stop all terminals and Exit all agents").

## Boundaries worth knowing

- **Panes are views.** They must never own process lifecycle: killing a PTY is the tab
  lifecycle's job (a PTY dies exactly when no tab references it). A pane killing its PTY on
  unmount is the classic regression here (React StrictMode remounts every pane in dev).
- The **one sanctioned teardown** is a workspace switch — it kills all PTYs and watchers by
  design.
- Hidden panes stay **queryable in the DOM** (each pane carries `data-visible`, `data-tab-id`,
  testid `pane-<tabId>`), which e2e relies on.
- With no tabs in the active project, the host shows the empty state (`panehost-empty`): "No tabs
  open in this project." and "Use the “+” in the tab strip to open one."

Tickets: T-097, T-181, T-299.
