---
doc: docs/modules/git/operations-and-safety-rails.md
audience: engineers, product
holds: the reviewer's git operations (commit & push, get their changes, undo, discard, connect remote, track with git) and the rails every operation runs on
kind: reference
---

# Git operations and safety rails — commit, push, undo, discard, connect

**Module:** `git` · **UI:** the [Git panel](./git-panel.md)'s repo view — **Commit & push…** in Changes, the
discard arrow on a change row, the `⋯` menu in the repo head, the **Discarded** section; **Track with git** in
the project dialog ([groups & projects](../projects/groups-and-projects.md)) · **Code:** `src/main/git-ops.ts`,
`src/main/git-run.ts` + `src/git-core/` (the rails, shared with [`pomade-git`](./pomade-git.md)), `src/shared/git-ops.ts`, `src/shared/git-glossary.ts`, `src/renderer/modules/git/ops/`,
`src/renderer/modules/git/GitTerm.tsx` · **e2e:** `git-ops.spec.ts`, `git-ops-new-project.spec.ts` ·
**Contract:** [contracts/git-operations](../../contracts/git-operations.md) "Entry points", "Requests", "Previews and results", "Rails"

## What it does

The operations that change a repository, built so a first-time committer cannot lose work: every operation says
what it will do before it runs, every one is undoable or previewable, nothing discarded is lost for 7 days,
failures are explained in plain words with a copy button, and a failure leaves a mark until it is seen. The
operator's operations — staging, branches, Fetch, Pull, Publish, Rebase and the conflict tab — run on the same
rails: [operator layer](./operator-layer.md).

## Preview, then run

Every operation is two calls to main: **preview** reads the repository and returns exactly what will happen — or
`blocked`, why it cannot happen now — and **run** does it. The preview carries a token (HEAD, the branch, its
upstream and every uncommitted path with its status); run refuses with *"The repository changed since the
preview"* when the repository no longer matches, so an agent writing in between can never make an operation do
something other than what was shown. Previews reload whenever the repo's state changes.

| Operation | Where | What the preview says |
|---|---|---|
| **Commit & push** | Changes head → an inline box: message, preview line, **Push after committing**, one button | *This will commit 5 files and push 1 commit to GitHub (origin/main).* — Push after committing off (**Commit**): *This will commit 5 files. Nothing is pushed — the commit stays on this Mac until you push.* — local only: *This will commit 5 files. No remote — the commit stays on this Mac.* — nothing to commit: *This will push 2 commits to …*; a branch not on the remote yet adds *— a new branch there.* |
| **Get their changes, then push** | the failure of a rejected push, a blocked Push, the went-different-ways bar, and `⋯` (with commits to push) | *This will get the new commits from GitHub (origin/main), put your 1 unpushed commit on top of them (rebase), then push. If their changes conflict with yours, a conflict tab opens: combine them there, then it pushes — or abort, back to before.* |
| **Undo last commit** | `⋯` | not pushed: *Not pushed yet — this takes back “Fix typo”: the commit goes away and its changes are back as uncommitted.* · pushed: *Already on GitHub — this adds a commit that cancels “Fix typo” (revert) and pushes it. Nothing is rewritten.* |
| **Discard changes** | the arrow on a change row (one file), `⋯ › Discard all changes…` | *This will discard the changes to 2 files. What they hold now is kept for 7 days in Document history.* plus one line per file and per file that stays |
| **Connect remote** | `⋯`, on a repo with no remote | after **Check**: *github.com/you/repo answered — it has 3 branches. This will add it as the remote “origin”; Commit & push then sends your commits there.* |

The host is named from the remote URL: GitHub, GitLab, a host name, or the path of a local remote.

**Push after committing.** On a repo with a remote, the commit box has a checkbox under its preview lines —
shown while there is something to commit, on each time the box opens. It decides whether a commit is pushed, for
both buttons: **Commit & push** / **Commit** and, while anything is staged, **Commit staged & push** / **Commit
staged**; the preview lines follow it. Off, the commit lands, the repo head shows it unpushed (↑1) and the repo
view lists it under **Not pushed** ([Git panel](./git-panel.md)); a later **Push…** sends it — with nothing to
commit the box takes no message, its one button is **Push**. The choice rides in the request (`push`), so the preview and the run agree. Without a remote
there is no checkbox: the commit stays on this Mac.

**The message gates every commit button.** While the message is empty (or only whitespace) **Commit & push** /
**Commit** and **Commit staged & push** / **Commit staged** are all disabled, in either state of **Push after
committing**, and a disabled button is drawn so — half opacity, a not-allowed cursor — whichever variant it is. Typing
a message enables them together. **Cmd+Enter** (Ctrl+Enter elsewhere) in the message box runs the staged commit while
anything is staged, else the all-changes one; **Esc** closes the box. A failed commit stays in the box with its copy
button. A box with nothing to commit has no message field; its **Push** is not gated.

## The rails

- **Never** force-push, `reset --hard`, `clean`, or `stash` (P-032), and never delete a branch that has not landed
  on main ([branches and worktrees](./branches-and-worktrees.md) "Landed — remove branch and worktree?").
- **One operation at a time per repository.** A second one, while the first runs, is refused: *“Commit & push”
  is still running in this repository — wait for it to finish, then try again.* Refused, not queued: what it
  previewed may not hold once the first is done. The lock is a file in the repo's git directory, so a
  [`pomade-git`](./pomade-git.md) run in the same repo holds it too.
- **The background fetch gives way.** The repo view's quiet fetch ([branches and
  worktrees](./branches-and-worktrees.md) "In progress") holds the lock as a *background* operation. Anything the
  user asks for meanwhile — a stage, a commit, Fetch itself, a `pomade-git` run — does not get refused because of
  it: it leaves a give-way request next to the lock (`pomade-operation.yield`), the fetch stops its git (SIGTERM,
  then SIGKILL after 2 s; a stopped fetch has changed nothing but remote-tracking refs, each updated whole) and
  lets go, and the operation runs. It waits for that at most 5 s; a background holder that still has not let go
  then refuses it as busy, like any other holder. A background operation itself never waits: on a busy repo it is
  skipped. Only Fetch runs in the background.
- **git never waits for a prompt.** Every mutating call runs with `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`,
  ssh in `BatchMode` (the user's own ssh command — `GIT_SSH_COMMAND`, else the repo's `core.sshCommand` — and
  `~/.ssh/config` are kept; only `-o BatchMode=yes` is added), editors set to `true`, stdin closed, and a time
  bound: 60 s for a network step (fetch, push, ls-remote), 120 s for a local one (a commit with its hooks, a
  rebase, a revert). **Pomade stores no credentials**: the system `git` uses whatever auth works in a terminal
  (SSH agent, credential helper, `gh auth`).
- **A commit takes exactly the previewed files** (`git add -A` on those paths, literal pathspecs, nested
  repositories left out), the message as typed (`--cleanup=whitespace`: a line starting with `#` stays). Hooks
  run. When the commit fails, the index is put back as it was before the files were added.
- **Pushes are explicit**: `git push --porcelain <remote> refs/heads/<branch>:refs/heads/<upstream branch>`,
  with `-u` when the branch has no upstream (it then goes to `origin`, or the only remote, under its own name).
- **Git identity.** No `user.name`/`user.email` (config or the `GIT_AUTHOR_*` env) blocks a commit up front with
  *Git doesn’t know your name and email yet…* and the two `git config --global` lines to run (the copy button
  copies them). Never a silent failure.
- **A half-done git operation** (a rebase, merge, cherry-pick or revert in progress) blocks every operation with
  what is going on; a detached HEAD blocks committing and undoing.

### Get their changes, then push

Runs only when nothing is uncommitted (untracked files included) — refused up front otherwise — so a conflict can
always be undone exactly, without stashing — and only with commits of its own to push (else it is Pull). Steps:
`fetch <remote>` → nothing new: push → else Pull's rebase onto `@{u}` ([operator layer](./operator-layer.md) "Fetch,
Pull, Rebase": the fingerprint recorded, the ignored-file check, `rebase --rebase-merges --no-autostash
--no-update-refs`) → push. **A conflict** stops the rebase and opens the [conflict tab](./conflict-tab.md), with the
push remembered: when the rebase finishes there, the branch is pushed (*Rebase finished — “main” is on top of
origin/main — and pushed to …*); the last file's preview says so. A push that then fails says the rebase finished
and the commits are on this Mac. **Abort, back to before** drops the push and is checked against the fingerprint.
Any other rebase failure is aborted and checked as for Pull. The remembered push lives in memory: after a restart the
rebase still finishes, unpushed.

**Seen before pushing.** The Push box (nothing to commit) is blocked while the upstream has commits this branch
lacks as of the last fetch — *origin/main has 1 commit you don’t have yet — get their changes first, or the push is
turned down.* — and offers **Get their changes, then push…**; with something to commit, the preview says the push
would be turned down.

### Undo last commit

**Pushed** means a remote-tracking branch holds the commit (`git branch -r --contains`): a commit made here reaches
a remote only by a push from this clone, which moves the tracking ref, so no fetch is needed to know.

- **Not pushed → `git reset --soft <commit>^1`.** Only the branch pointer moves; the index and every file stay
  byte-identical, so the commit's changes show as uncommitted and nothing else moves. `--soft` rather than
  `--mixed`: `--mixed` would also reset the index, dropping anything staged before the commit — `--soft` touches
  nothing but the pointer — what was staged stays staged. An
  unpushed merge goes back to its first parent; what it brought in is uncommitted.
- **Pushed → `git revert --no-edit [-m 1] <commit>`, then push.** A merge is reverted against its first parent.
  Needs nothing uncommitted (the cancelling commit holds only the undo). A failed revert is aborted.
- **The repository's first commit cannot be undone** — there is no earlier state to return to, and reverting it
  would be a commit that deletes everything. The preview says so.

### Discard changes

Per file and for all. Before a single file is touched, what it holds is kept in [E-035](../editor/save-and-file-lifecycle.md)'s
drafts store as a **discarded change** (reason `git-discard`), shown for 7 days in
[Document history](./document-history.md) and in the repo view's **Discarded** section:

1. Read every file the discard will remove or replace (a modified file, a new file, a renamed file and the name
   it goes back to). A file whose staged version differs from both the last commit and the file keeps that staged
   version too (`git-discard-staged`).
2. Keep them all — **all or nothing**: if one cannot be kept, the ones written are removed and nothing is
   discarded.
3. Re-read each file: anything changed since step 1 (an agent writing) → the kept copies are dropped and nothing is
   discarded.
4. Discard: new files are untracked (`git rm --cached`) and deleted, tracked ones restored from the last commit
   (`git restore --source=HEAD --staged --worktree`), a deleted file comes back, a rename goes back. Never `clean`.
   An untracked folder is discarded file by file; folders left empty go.

**The bound:** Pomade keeps text — UTF-8 that round-trips exactly, no NUL byte — up to **2 MB** per file (what
Document history can show and restore), at most **500 files** per discard. A binary, larger or non-UTF-8 file is
**not discarded**: it stays as it is, and the preview says so line by line (*photo.png — stays: binary files are
not discarded (Pomade can keep text files up to 2 MB)*). Nothing is ever lost silently.

**Getting it back:** a row in **Discarded** opens the document — even when the file is gone (the editor's
"no longer exists" notice) — with its Document history showing the *Discarded change · Nov 10 19:32* row: compare it, or
**Restore** it into the editor as an unsaved edit and save. A row shows only while the file is not back
([Git panel](./git-panel.md) "Discarded"); **Forget** on it deletes the kept copies.

### Connect remote

`⋯ › Connect remote…` on a repo with no remote. Paste an address, **Check**: `git ls-remote --heads <url>` must
answer before anything is added (an option-like or spaced address is refused before git sees it). Then **Connect**
runs `git remote add origin <url>`. Pomade does not create remote repositories; the next Commit & push publishes
the branch there (`-u`).

## Failures in plain words

git's output is mapped to a sentence (`classifyGitError`): auth (*GitHub refused the push — not signed in. Run `gh
auth login` in a terminal.*; over ssh: *your SSH key was not accepted. Check it with `ssh -T git@github.com`*;
GitLab: `glab auth login`; another host: make `git push` work in a terminal), a missing repository, the remote
moved on, a hook or protected branch refusing (*GitHub refused the push: protected branch hook declined.*), the
network, a lock held by another git program, a timeout, a missing identity. Anything else shows **git's last
error line** (the last `fatal:`/`error:` line, else the last line). Pomade's own sentences show git's line under
them. The **copy button** copies the command to run, or git's line.

A commit that landed before a failing push says so first: *Committed 9da208b, but it was not pushed. …* — the
commit stays; the box then offers **Push**, or **Get their changes, then push…** when the remote moved on.

## Failure marks

A failed operation shows a toast, stays in the box or dialog where it was started, and puts a badge on
the **Git strip icon** and the **repo's row** in the repo lists — E-032's marks (`marks-store`, source
`git:<root>`, targets `strip:git` and `row:repo:<root>`). Opening that repository's view clears them. A refusal
Pomade made before touching anything (a stale preview, another operation running, a blocked preview) marks
nothing.

## Explanations

Every git term in the UI — in previews, the dialogs, the repo head (branch, remote, Local only), the counts
(uncommitted, push, fetch), the `⋯` items, Track with git — explains itself on hover in one line with an example.
One source: `shared/git-glossary.ts` (`GIT_GLOSSARY`: repository, commit, uncommitted, push, pull, fetch, remote,
upstream, branch, merge, rebase, revert, undo-commit, discard, stage, worktree, local-only, conflict, publish, abort, squash, in-progress); a term in
text is a `<GitTerm>` (dotted underline), a control gets `glossaryLines(term)` as its tooltip.

## Track with git (new projects)

In the project dialog: **New from template**, or **From existing folder** on a folder that does not exist yet
(it is created — a project from scratch) → **Track with git** is checked; Create runs `git init` and a first
commit of everything, *Start <name>*. An existing folder without git → offered unchecked. A folder that is a
repository → its remote, or *Local only — commits exist only on this Mac*, and no checkbox; a folder another
repository tracks → *Tracked by the <name> repository*. When the first commit cannot be made (no identity), the
project is still created and the dialog stays open with the reason and what to run.

Tickets: E-039, T-221, T-225, T-232, T-308, T-309, T-310.
