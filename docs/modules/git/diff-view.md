---
doc: docs/modules/git/diff-view.md
audience: engineers, product
holds: the Cmd+Shift+G quick-peek diff overlay — its three modes, how it reads each side
kind: reference
---

# Diff view — the quick peek for the active document

**Module:** `git` · **UI:** Cmd+Shift+G over a doc tab, or Compare on the recovery banner →
overlay (`diff-overlay`) · **Code:** `src/renderer/modules/git/DiffOverlay.tsx` + `DiffView.tsx` +
`quick-peek.ts`, `src/renderer/modules/editor/doc-buffers.ts`, `src/main/git-service.ts` ·
**e2e:** `git.spec.ts`, `rule8-recovery.spec.ts`

## What it does

With a document tab active, **Cmd+Shift+G** (Ctrl+Shift+G elsewhere) opens a read-only, side-by-side diff of that doc
in an overlay. Modes switch in place:

- **Saved ↔ Unsaved** — the file as on disk vs the editor buffer. Every doc has it, git or
  not; an Untitled doc compares against an empty "Saved (not on disk)" side.
- **Working vs HEAD** — what you'd commit right now (file inside a repo only).
- **HEAD vs Previous** — the last commit's change to this file (file inside a repo only).

A dirty doc opens on Saved ↔ Unsaved; a clean doc in a repo opens on Working vs HEAD. Column
headers carry real labels — "Saved (on disk)", "Unsaved (editor)", "HEAD (a1b2c3d)",
"Working tree", "Previous (…)"; the overlay's title reads `Diff · <doc name>` and a button row switches the
modes. Esc, the × button, or clicking outside closes it.

## How it works

Saved ↔ Unsaved is renderer-only: the disk side is read through the doc's own fs door
(line endings normalized like the buffer), the buffer side comes from the pane's registered
buffer reader (`doc-buffers.ts`), snapshotted when the overlay opens. For the git modes, main
resolves the file's owning repo by walking up from the file to the nearest `.git`
(bounded by the workspace) — nested repos are handled naturally, the file diffs against *its*
repo. Content comes from `git show <rev>:<path>` and the working tree; a side that doesn't
exist at that revision (new file, no commits yet) renders as empty, labeled honestly ("HEAD
(no commits)", "Previous (none)"). The rendering is `@codemirror/merge` with change
highlighting, line numbers, wrapping, both sides read-only, themed and syntax-highlighted like
the editor.

An active tab that isn't a doc explains itself via toast: "Open a document to diff it
(Cmd+Shift+G).". A file containing NUL bytes refuses with "it looks like a binary file".

## Boundaries worth knowing

- **Cmd+Shift+G** (and the Compare of the "Recovered unsaved edits" banner) are the only entry points — no menu
  item, no context-menu action. Every version of a doc, not three fixed ones, is
  [Document history](./document-history.md) (Cmd+Shift+H). It is a renderer window shortcut (not an app-menu
  accelerator like Cmd+W/Cmd+F).
- Three fixed comparisons only: no arbitrary revision picking, no commit log, no per-hunk
  staging — this is a review surface, not a git client.
- The git modes show the file **as on disk**; only Saved ↔ Unsaved shows the buffer.
- Text files only; binaries are refused, not rendered.

Tickets: E-035.
