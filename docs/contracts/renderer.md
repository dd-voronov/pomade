---
doc: docs/contracts/renderer.md
audience: engineers
holds: the renderer-internal contracts shared across modules — the pane host and pane registry, the tab-drag marker, overlay primitives and the clamp hook, the editor context-menu and spellcheck invariants
kind: reference
---

# Renderer-internal contracts

Contracts between renderer modules that no IPC or store shape expresses. Breaking one breaks
another module silently.

## Pane host and pane registry

- `layout/PaneHost.tsx` renders one pane per tab of **every** project as direct children of the
  host, keyed by tab id; the pane's project is data (`data-project-id`), the host carries
  `data-active-project`. Hidden panes are `display: none`, **never unmounted**: a project switch
  or a cross-project move is a prop change on the same DOM node, so an xterm or an editor survives
  it. Effects that must not rebuild on a move do not depend on `projectId`.
- `panes/registry.ts#registerPane(kind: TabKind, component)` — one pane component per tab kind
  (`doc`, `terminal` / `agent`, `app`, `commit`, `compare`, `attached`, `conflict`, `branch`).
- Panes are views: lifecycle effects of a pane never kill a PTY, close a tab or write a file on
  unmount (React StrictMode double-mounts every pane in dev builds).

## Tab drag

`src/renderer/dnd.ts`: a tab dragged off the strip writes `TAB_DRAG_MIME`
(`application/x-pomade-tab`) next to its `text/plain` tab id. A drop target outside the strip
detects a tab drag with `isTabDrag(dataTransfer)` (only `.types` is readable during `dragover`),
never by sniffing `text/plain`, and handles `dragover` / `drop` **without** `stopPropagation` —
the strip clears its drop indicators from window-level listeners. Projects panel project rows are such
targets (drop = `moveTabToProject`).

## Overlays

- `components/ContextMenu.tsx` is the one renderer-built menu (no native menus): items, submenus,
  keyboard navigation, clamping. `components/Popover.tsx` is the one anchored popover;
  `components/Modal.tsx` is the window-level dialog (Esc closes only the topmost open one, so a
  confirm over Settings closes alone), `components/DialogShell.tsx` the pane-scoped one; `components/Tooltip.tsx` the one tooltip box.
- Every pointer-positioned overlay clamps through `hooks/use-clamped-position.ts`
  (`useClampedPosition` for menus and pickers, `useClampedSubmenu` for flyouts, `useClampedTooltip`)
  — 8 px viewport margin, measured parked at the origin inside a layout effect; a submenu is
  `position: fixed` and flips left when the right side has no room. A new overlay uses the hook
  (through `ContextMenu` when it is a menu), never a raw `left` / `top`.

## Editor invariants

- **Context menu in an editable.** The editor's `contextmenu` handler must not `preventDefault()`
  (the browser-level context-menu request carries the spellcheck data) and must not mount the menu
  in the same task (its scrim would take Chromium's hit test): the menu is parked and mounted when
  `app:spell-context` arrives (200 ms fallback). Any overlay opened from a `contextmenu` handler in
  an editable pane follows the same rule.
- **Spell markers.** The raw, live and rendered editors never rebuild an unchanged line's text
  nodes when the caret moves: a per-line decoration keyed on the selection is a **line**
  decoration (wrapper attributes), never a mark decoration over the line's text.
- The terminal link scanner (`modules/terminal/term-links.ts`) and resolver
  (`term-link-open.ts`) are shared with the editor's link layer; the resolver never underlines a
  path that does not exist on disk.

Tickets: T-083, T-088, T-097, T-104, T-119, T-158, T-169, T-184.
