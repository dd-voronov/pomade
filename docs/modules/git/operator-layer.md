---
doc: docs/modules/git/operator-layer.md
audience: engineers, product
holds: the operator's git operations — staging, Commit staged, New / Switch branch, Fetch, Pull, Publish, Rebase — and the stopped-rebase flow
kind: reference
---

# Git operator layer — staging, branches, fetch, pull, publish, rebase

**Module:** `git` · **UI:** the [Git panel](./git-panel.md)'s repo view — Stage / Unstage on a change row, the
Staged and Unstaged lists, **Commit staged** in the commit box, **Fetch** on the remote line, the `⋯` items; the
[conflict tab](./conflict-tab.md) · **Code:** `src/main/git-operator.ts` (Electron-free), the rails in
`src/main/git-run.ts`, the model in `src/shared/git-ops.ts` and `src/shared/git-conflict.ts`, the UI in
`src/renderer/modules/git/ops/` and `src/renderer/modules/git/panel/RepoView.tsx` · **e2e:**
`git-operator.spec.ts` · **Contract:** [contracts/git-operations](../../contracts/git-operations.md) "Conflicts", "Requests", "Previews and results", "Rails"

## What it does

Everything needed to operate git by hand, one level down so the reviewer's flows
([operations and safety rails](./operations-and-safety-rails.md)) stay up front. Every operation goes through the
same rails: a preview that says exactly what will happen (or why it cannot), a run that refuses when the
repository changed since, one operation per repository at a time, git that never waits for a prompt, failures in
plain words with a copy button, every git term explained on hover.

| Operation | Where | What the preview says |
|---|---|---|
| **Stage** / **Unstage** | + / − on a change row's hover | *This will stage README.md — it goes into the next commit; the rest stays as it is.* (the hover; the click runs it) |
| **Commit staged** | the commit box, while anything is staged | *This will commit the staged file (README.md) and push 2 commits to GitHub (origin/main). 1 other change stays uncommitted.* — Push after committing off: *This will commit the staged file (README.md). 1 other change stays uncommitted; nothing is pushed.* |
| **New branch** | `⋯` | *This will create the branch “fix/typo” from main (abc1234) and switch to it. Your 2 uncommitted changes come along.* |
| **Switch branch** | `⋯` — a list of branches, local first, then those only on a remote | *This will switch to “main”: the files change to that branch’s version.* — a remote-only branch: *This will make a local “feature” from origin/feature (it follows it) and switch to it…* |
| **Fetch** | the button after the remote line | *This will look at GitHub (origin) and note its new commits, without changing your files (fetch).* (the hover) |
| **Pull** | `⋯`, a branch with an upstream | *This will get the new commits from GitHub (origin/main) and put your 2 unpushed commits on top of them (rebase). If their changes conflict with yours, a conflict tab opens…* |
| **Publish branch** | `⋯`, a branch not on the remote yet | *This will publish the branch “feature” to GitHub as origin/feature — 1 commit goes there — and the branch follows it from now on.* |
| **Rebase onto main** / **onto origin/…** | `⋯` | *This will put your 1 commit on top of main’s 2 newer commits (rebase). If their changes conflict…* |

Stage, Unstage and Fetch run on the click: their hover is the preview, and the run still takes the preview's
token; a preview that blocks answers with its reason in a toast. The others open the operation dialog (title =
the operation's name; the confirm button names what it does: *Create branch*, *Switch*, *Pull*, *Publish*,
*Rebase*; New branch takes a name box, Enter runs it). Stage and Unstage are not offered on a conflicted file or
while a rebase, merge, cherry-pick or revert is stopped.

## Staging

Whole files, never parts of one: `git add -A` / `git restore --staged` on the named paths (a renamed file with
its old name). Before the first commit, unstaging takes the file out of the index (`rm --cached`); it stays on
disk. A change's `staged` (`all`, or `part` when it was edited again after staging) comes from the status
snapshot, so staging done in a terminal shows the same way. Changes splits into **Staged** and **Unstaged** only
while something is staged. **Commit staged** commits exactly the index (`git commit` with no paths), then pushes
when **Push after committing** is on ([operations and safety rails](./operations-and-safety-rails.md)); **Commit &
push** takes every change.

## Branches

**New branch** checks the name with `git check-ref-format --branch`, refuses an existing one, and runs `git switch
-c <name> --no-track` from HEAD — nothing uncommitted can be in the way, so it all comes along. It follows nothing
until it is published.

**Switch branch** lists every local branch (newest first) and every branch only on a remote. Before switching,
the preview compares HEAD with the target (`git diff --name-only HEAD <target>`): an uncommitted file — or a
new folder holding one — that differs there would be replaced, so the switch is **blocked** with the file named
and the two ways out: **Commit first…** (the commit box) and **Discard it first…** (the discard dialog for exactly
those files). **Pomade never stashes**: a hidden stash is work a person can lose track of. An ignored file the
switch would overwrite blocks it too. The switch itself is plain `git switch` — no `--force`, no `--merge` — so
git refuses on its own as well. A remote-only branch becomes a local one following it (`switch -c <name> --track
<remote>/<name>`).

**Publish branch** is the first push of a branch: `git push -u <remote> refs/heads/<b>:refs/heads/<b>` to
`origin` (or the only remote), never forced. The preview names the remote and the branch it becomes.

## Fetch, Pull, Rebase

**Fetch** runs `git fetch --no-write-fetch-head <remote>` (the upstream's remote, else `origin`, else the only
one) and says what is new for the branch; ↓n follows.

**Pull** fetches, then rebases the branch onto its upstream; **Rebase** puts it on top of the local `main` (else
`master`) or of its upstream as of the last fetch. Both need **nothing uncommitted** (untracked files included) —
refused up front otherwise — so that Abort can always put the repository back exactly. Before the rebase, Pomade
records the repository's fingerprint (HEAD, the branch, every index entry, the full status with untracked and
ignored files), refuses when their changes would land on a file git ignores here, then runs `git rebase
--rebase-merges --no-autostash --no-update-refs <target>`.

- **Done** — a toast says what moved (*Put your 1 commit on top of main (2 new commits).*).
- **A conflict** — the rebase stays stopped and the [conflict tab](./conflict-tab.md) opens. The repo view shows a
  bar (*A rebase stopped on a conflict in 1 file.* · **Resolve conflicts…** · **Abort, back to before**) and the
  branch reads "rebasing" until it ends.
- **Any other failure** — `rebase --abort` at once and the fingerprint compared: *…Nothing was changed — the
  repository is exactly as before.*, or a loud message naming what differs and `git status` to copy.

The fingerprint is kept per repository in memory until the rebase ends. A rebase started in a terminal (or before
a restart) has none: its Abort is git's alone, and the message says so.

Tickets: E-040.
