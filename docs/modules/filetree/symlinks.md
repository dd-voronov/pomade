---
doc: docs/modules/filetree/symlinks.md
audience: engineers, product
holds: symbolic links — the chain-link indicator on rows, tabs and the editor header, the target popover, write-through, cycle safety; how it is built
kind: reference
---

# Symlinks — indicators and the target popover

**Module:** `filetree` · **UI:** the chain-link glyph on tree rows, doc tabs, and the editor
header · **Code:** `src/renderer/modules/filetree/SymlinkPopover.tsx`, `src/main/fs-tree.ts`
(`lstat` detection), `src/main/fs-ops.ts` (`resolveLinkTarget`, behind `fs.linkTarget`) · **e2e:**
`filetree-manage.spec.ts`

## What it does

Symbolic links are first-class and honest: a linked entry behaves like its **target** (a
symlinked file opens, a symlinked folder expands), while a chain-link glyph marks it as a link.
Clicking the glyph opens a popover that resolves the final target and offers exactly the actions
that make sense for where it points. Broken links get a danger-tinted glyph.

## The three indicators

The same glyph, clickable in all three places a linked file surfaces:

- **Tree row** — an accent chip at the row's right edge (danger-tinted when the link is
  broken);
- **Tab strip** — between the doc tab's title and its ×;
- **Editor header** — a chip next to the file name.

Tooltip everywhere: `Symbolic link — click to see target`.

## The popover

Anchored under the clicked indicator; Esc or click-outside closes. Chained links resolve once to
the **final** target; the state decides the body:

- **Target inside the workspace** — the target path (directory part muted), then: **Open
  target** (files only — opens a normal doc tab), **Reveal in tree** when the target is under
  the current project's root — otherwise **Open in project…**, listing every project whose root
  contains the target (the Workspace project always qualifies; picking one switches
  project, then reveals) — and **Copy path**.
- **Target outside the workspace** — the absolute path, an honest note ("Pomade can't open it
  or show it in the tree"), **Copy full path**, and **Reveal in Finder**.
- **Broken link** — the dangling target path, a danger note ("Target doesn't exist — the link
  is broken"), and **Copy path**.

## How links behave elsewhere

- **Editing writes through the link** to the target file — the link itself is never replaced by
  a regular file.
- A symlinked **directory** keeps `kind: dir` (the target's kind), so it expands normally — but
  the tree walk only enters it on an **explicit expand**, never auto-follows it deeper, which
  makes link cycles safe.
- The link flag rides onto the doc tab at open time, so the tab glyph appears however the file
  was opened (tree click, go-to-path, bulk open).

## Boundaries worth knowing

- "Open target" is hidden for directory targets (reveal covers them).
- Broken links offer no open/reveal — just the path, so you can fix the link.
- A link under an outside-workspace [mount](./mounts.md) shows the glyph, but its popover cannot
  resolve: `fs.linkTarget` takes workspace-relative paths only, so the popover stays on `Resolving…`.
- Detection is one `lstat` per entry plus one follow-`stat` for links — cheap enough that it is
  always on; there is no setting.

Hosted apps create and remove symlinks only inside the folders their manifest declares — see
[workspace data API](../core/workspace-data-api.md); the tree shows those links like any other.

Tickets: E-012.
