---
doc: docs/modules/git/conflict-tab.md
audience: engineers, product
holds: the conflict tab — combining a stopped rebase or merge file by file (theirs / result / yours), continue and abort
kind: reference
---

# Conflict tab — theirs / result / yours

**Module:** `git` · **UI:** a tab with the three-sheets glyph, titled `Conflict · <repo>`; opened by a Pull or
Rebase that stops on a conflict — or a Merge into main ([branches and worktrees](./branches-and-worktrees.md)) — by **Resolve conflicts…** on the repo view's bar or in `⋯` · **Code:**
`src/renderer/modules/git/conflict/ConflictPane.tsx`, `src/shared/git-conflict.ts`, `readRebase` /
`readConflictFile` / the resolve, continue and abort operations in `src/main/git-operator.ts` · **e2e:**
`git-operator.spec.ts`, `git-branches.spec.ts` · **Contract:** [contracts/git-operations](../../contracts/git-operations.md) "Conflicts", "In progress and branches"

## What it does

Combines a rebase stopped on a conflict, file by file, and either finishes it or puts everything back. Words:
**theirs** is what your commits are being put on top of (main, origin/main); **yours** is your commit being
replayed. git's own "ours / theirs" — reversed during a rebase — never shows.

**A merge** landing a branch on main uses the same tab: the left side is **Main** (git's stage 2), the right
**Landing** — the branch (stage 3); the take arrows and whole-file cards name them (*Take main*, *Take feature*). The
summary reads *Landing feature on main. Both changed the same lines…*; the last file resolved, or **Finish the
merge**, commits it (one commit for a squash); Abort runs `merge --abort`, checked against the state before.

## Layout

- **Header** — `Conflict · alpha`, the branch, and **Abort, back to before**, always there whatever is shown.
- **Summary** — *Putting your commit “Fix typo” (2 of 2) on top of main. Their change and yours touch the same
  lines — pick what the file should say.* The "(n of m)" shows only when the rebase replays more than one commit and
  counts commits only (`--rebase-merges`' label and reset steps are not counted).
- **Files** — one chip per file with an open conflict (the full path on hover); the first is selected.
- **Action bar** — the preview line and **Mark resolved & continue**, above the columns where no toast covers it.
- **Labels** — Theirs (and its name) · Result (*1 of 2 to decide*) · Yours (the commit's subject), the comparison
  tab's label row.
- **Body** — one row per stretch of the file. A stretch both sides agree on (or git combined on its own) spans the
  three columns, muted; longer than 8 lines it folds to its first and last 3 with *⋯ N unchanged lines*. A
  conflict is five columns: theirs · **→** · the result · **←** · yours.

## Combining

Each conflict's result starts empty and undecided (amber, dashed). **→** puts theirs into it, **←** yours; the
second take adds after the first, so both sides are kept in click order. The result can be typed in; **Start
over** empties it. **Mark resolved & continue** is off until every conflict of the file is decided. The result is
the file: the stretches as they are, each conflict replaced by its result (a typed result that lost its line end
gets it back).

The sides come from git's index stages (`git ls-files -u`: 1 the version both started from, 2 theirs, 3 yours),
combined with `git merge-file -p --diff3` in a temp folder outside the repository, with 31-character markers so a
line of the file is never read as one. A file with a deleted side, a binary side or a side over 2 MB is
combined **whole**: two cards, **Take theirs** / **Take yours** (a deleted side reads *Take this — delete the
file*).

## Mark resolved & continue

The preview says what happens: *This will save the result as README.md, mark it resolved, then continue the
rebase.* — or, with other files open, *…and mark it resolved — 1 more file to resolve before the rebase goes on.*
The run writes the result (or the side's exact bytes, or deletes the file) and `git add`s it (`git rm --cached`
for a delete); on the last file it continues: `git rebase --continue`, or `--skip` when the combined commit
changes nothing. A next commit that conflicts too stops again in the same tab; a finished rebase toasts *Rebase
finished — “feature” is on top of main.* and the tab reads *Nothing is stopped on a conflict in alpha — there is
nothing to combine. You can close this tab.* With every file
combined (resolved in a terminal, say) the action bar offers **Continue the rebase**.

A rebase started by **Get their changes, then push** ([operations](./operations-and-safety-rails.md) "Get their
changes, then push") is pushed when it finishes: the last file's preview adds *Once it finishes, your commits are
pushed to origin/main.*, and the toast reads *Rebase finished — “main” is on top of origin/main — and pushed to …*.

## Abort, back to before

Opens the operation dialog: *This puts everything back exactly as before the rebase: “feature” at abc1234, your
files as they were (abort). Pomade checks it afterwards.* The run is `git rebase --abort`, then the repository's
fingerprint is compared with the one recorded before the rebase: equal → *Back to before — “feature” at
abc1234, exactly as it was (checked).*; different (something changed it while the rebase was stopped) → a loud
failure naming what differs, with `git status` to copy. Edits made during the stop go with the abort — that is
what "back to before" means.

## Lifecycle

One tab per repository, never through the preview slot (it holds work in progress). It persists only the repo;
the rebase and each file's versions are read from git when the pane mounts and whenever the repo's git state
changes, so a restored tab shows the current stop, or the notice. Results being combined live in the pane and
start over when a file's versions change. A file whose conflict git already combined shows *No lines conflict — git
combined the two. Mark resolved takes the file below.* When nothing can be read the tab says *Could not read what
stopped: …*.

Tickets: E-040, E-041, T-308.
