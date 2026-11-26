---
doc: docs/modules/git/git-panel.md
audience: engineers, product
holds: the Git panel — repo lists and the repo view (head, Changes, Not pushed, Discarded, In progress, History); scope, live updates, click rules; how it is built
kind: reference
---

# Git panel — repos, changes, landed work

**Module:** `git` · **UI:** the **Git** icon on the icon strip, under Files · **Code:**
`src/renderer/components/CheckToggle.tsx`, `src/renderer/modules/git/panel/` (`GitPanel.tsx`, `RepoList.tsx`, `RepoView.tsx`, `RepoStatus.tsx`,
`git-panel-store.ts`; `git.reveal` is served in `src/renderer/modules/apps/delegated-calls.ts`), `src/shared/git-history.ts` (`remoteLabel`), `src/main/git-history.ts`; operations in
`src/renderer/modules/git/ops/`, In progress in `src/renderer/modules/git/branches/` · **e2e:** `git-panel.spec.ts`, `git-not-pushed.spec.ts`, `git-ops.spec.ts`, `git-operator.spec.ts`, `git-branches.spec.ts`, `app-git-reveal.spec.ts` · **Contract:** [contracts/git-state-and-history](../../contracts/git-state-and-history.md) "History", "Repo state"; [contracts/git-operations](../../contracts/git-operations.md) "Requests", "Rails", "Conflicts", "In progress and branches"

## What it does

Answers "is everything safe?", "what is not pushed yet?" and "what landed?" for the repos the Projects panel selection covers, and runs
the operations on them, each with a preview first: the reviewer's — Commit & push, Get their changes then push,
Undo last commit, Discard changes, Connect remote ([operations and safety rails](./operations-and-safety-rails.md))
— up front, and the operator's — staging, Commit staged, Fetch, Pull, Publish branch, New / Switch branch,
Rebase ([operator layer](./operator-layer.md)) — on a row's hover, in the head and one level down in `⋯`; and work
not landed yet in **In progress** ([branches and worktrees](./branches-and-worktrees.md)). While the panel is
shown, opening a repo view with a remote fetches in the background at most every 5 minutes; Fetch (or Pull)
fetches at once. Detail opens as tabs — a
[commit-details tab](./commit-details.md) for a commit, a [comparison tab](./comparison-tab.md) for a file, the
[conflict tab](./conflict-tab.md) for a stopped rebase or merge, a branch tab for an In progress row.

## Scope follows the Projects panel

| Projects panel selection | Panel shows |
|---|---|
| The Workspace row | **All repositories** — every discovered repo (nested ones included) |
| A project that is one repo, or inside one | that repo's view directly |
| A project folder holding 2+ repos | **Repositories in <project>** — the list limited to the project |

A project folder that is not itself a repo also counts the repo around it, unless that repo ignores
the folder (a workspace repo ignoring `Projects/`). That exception is the panel's own: an app's `git.read`
scope (`gitReposInScope`) always includes the enclosing repo — it reports the state around the
folder, while the panel lists what belongs to the project. From a list, a row opens the repo view; the back arrow
returns. Which repo a project drilled into is kept for the session. The shown panel itself (Files
or Git) is remembered per project like every side panel. Before the first snapshot the body reads *Looking for
repositories…*; with nothing in scope, *No git repositories in this workspace.* (the Workspace project) or *This project is not
in a git repository.* The header carries **«** (*Collapse side panel (Cmd+Shift+B)*).

## Reveal a repo

An app's Host API call `git.reveal { path, projectId? }` ([HOST-API](../../HOST-API.md) §4 "`git.read`") takes the
person to a repo: main resolves `path` (real paths) to a workspace-relative repo root, and the renderer
(`delegated-calls.ts`) matches it against the git-state snapshot — no such repo is `not-found`. The target project is
`projectId`, else the active one; a repo outside that project's scope is shown in the Workspace project instead. Pomade
switches to that project, expands a collapsed side panel, selects Git and files a one-shot request in
`git-panel-store.ts` (`revealRepo`): a panel drilled into another repo returns to the list, a drill into this repo
stays. The list's row scrolls into view (`scrollIntoView`, nearest) once the panel shows; a repo view already showing the repo (one
repo in scope, or drilled into it) is the reveal itself, and the request is dropped. A newer request replaces an older one.

## A repo's row and header

Name (the folder name), branch (or "rebasing" while a rebase is stopped, "detached HEAD", "no commits yet"), then the marks: **● n**
uncommitted files, **↑n** commits not pushed to the upstream, **↓n** commits on the upstream not
here — *as of the last fetch*: the panel reads the remote-tracking refs; only the Fetch button on the remote line fetches. Clean and
pushed shows no marks. The second line is the repo's remote (`remoteUrl`, see
[git in the tree](./git-in-the-tree.md)) as `github.com/owner/name` — a local remote shows its path,
cut from the front — or **"Local only — commits exist only on this Mac"** in a muted
amber, wrapping rather than truncating. A branch with no upstream on a repo that has a remote adds
"· branch not pushed". A repo git cannot read shows git's error in red. The branch, the remote line and
each count explain their git term on hover (the one glossary).

The remote line ends in **Fetch** (its hover says what it does) and the repo view's head in **`⋯`**: *Pull…*
(a branch with an upstream) and *Get their changes, then push…* (one with commits to push), *Publish branch…* (a branch not on the remote
yet) · *New branch…*, *Switch branch…*, *Rebase onto main…* (off main), *Rebase onto origin/…* (a branch with an
upstream) · *Undo last commit…* (a repo with commits), *Connect remote…* (no remote) · *Discard all changes…*
(anything uncommitted). The button (*More git actions*) is disabled when the repo has no item to offer. While a rebase or a merge is stopped the menu holds only *Resolve conflicts…* and *Abort, back to
before…*, and a bar under the head says so with the same two buttons ([conflict tab](./conflict-tab.md)); another
operation stopped half-way (a cherry-pick or revert from a terminal) gets a bar saying to finish it in a terminal.
A branch that went a different way from its upstream (commits on both sides, as of the last fetch) gets a bar: *Your
branch and origin/main went different ways — 3 commits yours, 1 theirs.* · **Get their changes, then push…**.
A failed operation puts a red dot before the repo's row name in the lists and a mark on the Git strip icon,
until the repo's view is opened.

A repo a [`pomade-git`](./pomade-git.md) run touched shows that run under the remote line (*Commit & push done
13:00 · committed a1b2c3d*; a failure in red, also marking the row and the Git icon — even when it ran while Pomade
was closed). When `pomade-runner` answers, a line per job that targets the repo follows: *Scheduled: Commit & push
· 13:00, 20:00 — edit in Runner*; it is asked again when Runner's jobs change or one of its runs ends, so the
next and last run stay current.

## Changes

The uncommitted files, sorted by path, with the tree's letters and tints (`M` `U` `C` `R` `D`) and
the folder after the name. A click opens the [comparison tab](./comparison-tab.md) last commit
(HEAD) ↔ the current document — a renamed file from its old name, a new file against nothing; a
deleted file opens its last committed version (with Restore file); an untracked folder is revealed
in Files. The first 500 rows are drawn, then "and N more"; an empty list reads *Nothing uncommitted.* On hover a row
shows **Stage** (+) and a discard arrow (*Discard changes…* for that file, with its preview); a conflicted file's row
has neither, and neither does any row while a rebase, merge, cherry-pick or revert is stopped. While anything is staged, Changes splits into **Staged** (rows
with **Unstage**, −) and **Unstaged**; a file staged and edited again is in both. The Changes head carries
**Commit & push…** (**Commit…** without a remote, **Push…** with only commits to send), which opens the commit
box under it — with **Commit staged** beside it while anything is staged ([operator layer](./operator-layer.md)) and,
on a repo with a remote, **Push after committing** to keep a commit local
([operations and safety rails](./operations-and-safety-rails.md)). The head button is offered on a branch (not a
detached HEAD) when there is something to commit or push, or a branch not on its remote yet.

## Not pushed

The commits on the branch that its upstream does not have yet — the head's **↑n**, with that count — newest
first, rows like History's: a click opens the commit's details, right-click ▸ **Open in a new tab**. Every
commit is listed (a merge made here and its own commits are rows of their own; a merge row has no chevron), up
to 200, then "Only the newest 200 are listed." Shown only while the branch has an upstream and is ahead of it:
a repo with no remote, a branch not on the remote yet, or a branch that is pushed shows no group. Foldable like
the other sections (every section's fold state is kept per repo for the session). After a push the commits are in
History.

## Discarded

Files whose changes were discarded in this repo, kept 7 days, newest first, with when — only those whose content is
not back. Shown only when there are any. A row opens the document — present or gone — with its Document history,
where the discarded content can be compared or restored.

**Back** (`discardedRowShown`, decided in main by `recovery.discardedFiles`): the file holds the newest kept copy
exactly, or it was restored from Document history (any version — the restore stamps `restoredAt` on the file's
kept copies) after the newest discard and saved since (its mtime is later). A file that is gone is never back; a newer
discard makes the row show again. The section re-asks whenever the repo's changes or the kept drafts change.

**Forget** — `×` at the row's end on hover — turns the row into *Forget the kept copy of notes.md?* · **Forget** ·
**Keep** (Esc keeps); Forget deletes every kept git-discard copy of the file, so its Document history loses the
*Discarded change* rows too.

## In progress

Above History, shown once the repo has a commit: one row per worktree, per local branch main lacks, then per branch
only on a remote — kind, commits ahead / behind main, uncommitted changes, a live agent, last activity; a row opens
its branch tab. Empty: *Nothing in progress — every branch is in main.* Detail:
[branches and worktrees](./branches-and-worktrees.md).

## History

The branch's own line (`git log --first-parent`) as far as its upstream has it — commits not pushed yet are
under Not pushed, not here; for a branch with an upstream History starts where the two meet (`git merge-base`),
so after a merge from the remote that is not pushed yet, the remote's commits head History. One row per landed
piece of work — subject (a commit
a Runner job made, carrying `Pomade-Job:`, reads *Committed automatically · job "<name>" · 13:00*),
relative date ("3 h ago", "yesterday", "Oct 12"), author. A merge row has a chevron (or Right / Left arrow on the focused row) that expands it
to the commits it brought in (up to 200, newest first). **Every commit** (the shared `CheckToggle` — `src/renderer/components/CheckToggle.tsx`, the same switch as the
History panel's *Show all commits* and the comparison tab's *Changes only*; accessible name "Show every commit"; the
box shows its state, `aria-pressed`; its tooltip names the mode on screen) swaps in the full log. A row click opens the commit's
details; the row whose details tab is active is highlighted.

A repo with no commit reads *No commits yet.*; a branch whose upstream shares no commit with it, *Nothing pushed yet.*
History loads 50 rows at a time; the next page loads when the end of the list scrolls into view.
Nothing is fetched while the panel is hidden. The pages — and the Not pushed list — are cached per repo
and mode against where the branch stood when they were read (HEAD, the upstream and the ↑ / ↓ counts): when
that moves (a commit from a terminal, an agent, a push, a fetch, a pull), the shown lists reload.

## Live

Repos, marks, Changes and whether Not pushed shows come from the git-state snapshot ([git in the tree](./git-in-the-tree.md)),
which main refreshes on watcher and git-metadata changes — the panel never polls. Relative dates
re-render once a minute while the panel is shown.

## Single click, right-click

A single click on a change, a branch in progress or a commit (Not pushed or History) opens its tab through the project's
[preview tab](../tabs/preview-tabs.md) (Settings ▸ General ▸ Tabs ▸ "Single click opens a preview
tab", shared with the tree), so skimming History leaves one tab, its title in italics. Using the tab
keeps it — a click into its pane, an edit, switching away. Right-click a row ▸ **Open in a new tab**,
or Enter on a focused row, opens a tab that stays. A double click does nothing more than a click.
A deleted file's row says what opens: in a commit or branch tab **Open the deletion in a new tab**
(the comparison, a tab that stays); in Changes **View last committed version** (the deleted-file
view with Restore file, which is an overlay, not a tab). An untracked folder's row in Changes reads
**Show in file tree**: it reveals the folder in the file tree.

## Width

The panel takes the side panel's width (160–560 px). Below 200 px the "Every commit" label drops
and the box stays (its tooltip names it; the head's container query hides the label through `labelClassName`); repo names keep at least three characters while the
branch gives way first.

Tickets: T-276, T-320, T-322.
