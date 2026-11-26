---
doc: docs/modules/git/commit-details.md
audience: engineers, product
holds: the commit-details tab — what it shows, how its files open, its lifecycle
kind: reference
---

# Commit details tab

**Module:** `git` · **UI:** a History row in the [Git panel](./git-panel.md) → a tab with the commit
glyph, titled by the subject · **Code:** `src/renderer/modules/git/commit/` (`CommitPane.tsx`,
`CommitMessage.tsx`), `open-git-tabs.ts`, `src/main/git-history.ts` (`readCommit`) · **e2e:**
`git-panel.spec.ts` · **Contract:** [contracts/git-state-and-history](../../contracts/git-state-and-history.md) "History"

## What it shows

- The **subject** as the title; a **Merge** tag on a merge commit.
- **Author** (email on hover), the **date** (`Oct 12, 2026, 14:03`; relative on hover), the repo, and
  the **short hash** as a button: a click copies the full hash and the button reads "Copied" for a
  moment.
- The rest of the **message rendered as markdown** — lists, task boxes, code, tables, links (open in the
  browser). Raw HTML in a message shows as text.
- **Files changed** against the first parent — for a merge, what it brought into the branch — each with
  its letter (`A` added, `M` modified, `D` deleted, `R` renamed; the old name on hover), the folder, and
  **+added −removed** lines ("binary" for a binary file, "moved, unchanged" for a pure rename). The
  header sums the counts. A file click opens the [comparison tab](./comparison-tab.md) parent ↔ commit (both read-only) in the
  project's [preview tab](../tabs/preview-tabs.md); its right-click menu offers **Open in a new tab**
  (that comparison, in a tab that stays) and **Open this version in a tab** (the file as in this
  commit, as a [version tab](./document-history.md#a-version-in-its-own-tab)). A file the commit deleted
  has no version in it: its menu is **Open the deletion in a new tab** alone — the removed content
  against "not in this version", in a tab that stays. Over 2000 files the list is cut: *Only the first 2000 files of N are listed.*

## Lifecycle

The tab stores only the repo root and the full hash (`CommitTab`), and reads the commit once when its
pane mounts. Like every pane it stays mounted while hidden. It survives a restart; a commit that no
longer exists (rewritten history, a replaced repo) restores to a notice — "Commit deadbee cannot be
shown" with git's reason — never a crash. While it reads, the pane says *Loading commit…*. It can be renamed and colored like other tabs; it has no
Reveal in Finder.

Tickets: E-037, T-226, T-228, T-233.
