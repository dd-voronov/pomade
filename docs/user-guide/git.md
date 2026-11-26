---
doc: docs/user-guide/git.md
audience: users
holds: how to work with git in Pomade — marks, the Git panel, commit and push, history, comparison, branches and worktrees, conflicts, the pomade-git command, shortcuts
kind: reference
---

# Git

Pomade shows whether your work is safe, lets you commit and push without a terminal, and keeps every earlier
version of a document within reach. It runs your system `git`, so whatever signs you in at a terminal
(SSH agent, credential helper, `gh auth login`) signs Pomade in; Pomade stores no credentials.

Every action that changes a repository **says what it will do before it runs**. A change is never lost
silently: discarded text is kept 7 days, and Pomade never force-pushes, hard-resets, cleans or stashes.

## What the marks mean

**In the file tree**

| Mark | Meaning |
|---|---|
| `M`, amber name | changed since the last commit |
| `U`, green name | new — in no commit yet |
| `C`, red name | conflict — a merge left both versions in the file |
| `R`, blue name | renamed (shown only when git recorded the rename: `git mv`, or both halves staged) |
| `D`, red struck-through row | deleted — gone from disk, still in the last commit; click it to view or restore |
| amber dot on a folder | something inside changed |
| dimmed row | ignored by git |

Hover any letter for its explanation. A rename made in Pomade's tree or Finder shows as `D` at the old name and `U`
at the new one until both are staged. To turn the marks off or on, open the tree's `⋯` menu and choose **Hide git
status** / **Show git status**.

To bring back a deleted file: click its `D` row (*&lt;name&gt; · deleted* opens its last committed version), then
**Restore file**. Esc or **×** closes the view. Restore refuses when something already exists at that path.

**In the Projects panel.** A project row shows `● 5 ↑2` — 5 uncommitted files, 2 commits not yet pushed. Nothing is shown
when everything is committed and pushed. The Workspace row sums every repo; hover for the per-repo numbers. On the
collapsed rail a project gets a corner dot: amber when anything is uncommitted, blue when only unpushed.

**In the Git panel.** A repo row shows `● n` uncommitted files, `↑n` commits not pushed, `↓n` commits on the remote
you do not have — *as of the last fetch*. A red dot on a repo row, and a mark on the Git icon in the side strip,
means the last git operation or a `pomade-git` run failed; opening that repo clears it.

## The Git panel

Click the **Git** icon in the icon strip (under Files).

| You select | The panel shows |
|---|---|
| The Workspace row | **All repositories** — every repo found in the workspace |
| A project that is one repo, or inside one | that repo directly |
| A project holding 2 or more repos | **Repositories in &lt;project&gt;** — click a row to open one; the back arrow returns |

A row shows the repo name, branch, the marks above, and the remote on the second line as `github.com/owner/name`.
**Local only — commits exist only on this Mac** means no remote: losing the disk loses the history (see
[Connect a remote](#connect-a-remote)). **· branch not pushed** means the branch is not on the remote yet.

The repo view stacks: the head (name, branch, marks, remote line with **Fetch**, and **`⋯`**), **Changes**,
**Not pushed**, **Discarded**, **In progress** and **History**. Each section folds. The panel updates by itself when
files, commits or the remote change — there is nothing to refresh.

## Commit and push

**To commit and push everything:** open the repo, click **Commit & push…** in the Changes head, type what changed
(e.g. *Fix the typo in the login page*), read the preview line (*This will commit 5 files and push 1 commit to
GitHub (origin/main).*), click **Commit & push**. The buttons stay disabled while the message is empty. Cmd+Enter in the
message box commits; Esc closes the box.

**To commit without pushing:** uncheck **Push after committing** (shown when the repo has a remote) — the button
becomes **Commit**. The commit appears under **Not pushed** and the head shows `↑1`.

**To push commits you already made:** click **Push…** in the Changes head, then **Push**. With nothing left to
commit there is no message box.

**To commit only some files:** hover a row in Changes and click **+** (*Stage*). Changes then splits into **Staged**
and **Unstaged**; **−** (*Unstage*) takes a file back out. In the commit box click **Commit staged** (or **Commit
staged & push**). Files are staged whole, never in parts. Unstaged changes stay uncommitted.

**If the push is rejected** (someone pushed first), the box says so and offers **Get their changes, then push…**:
Pomade fetches, puts your commits on top of theirs, and pushes. If their changes conflict with yours, the conflict
tab opens: combine them there and Pomade pushes once the rebase finishes — or **Abort, back to before** (see
[Conflicts](#conflicts)). It needs nothing uncommitted. The same action is in `⋯` while you have commits to push.

Pomade often knows before you push: when the remote has commits you don't have (↓ in the repo head), the Push box
says the push would be turned down and offers **Get their changes, then push…**, and when your branch has commits of
its own too, a bar under the repo head says *Your branch and origin/main went different ways — 3 commits yours, 1
theirs.* with the same button.

**If git does not know who you are,** Pomade says so and shows the two `git config --global` lines to run; **Copy**
copies them.

**To undo the last commit:** `⋯` ▸ **Undo last commit…**. Not pushed yet: the commit goes away and its changes come
back as uncommitted. Already pushed: Pomade adds a commit that cancels it and pushes that (**Add cancelling commit
& push**) — nothing is rewritten. The very first commit of a repo cannot be undone.

**To throw changes away:** hover a row and click the arrow (*Discard changes…*) for one file, or `⋯` ▸
**Discard all changes…**. The dialog lists each file and what happens to it; **Discard N files** runs it. What the
files held is kept 7 days: see [Get back discarded work](#get-back-discarded-work). Binary files, files over 2 MB and
more than 500 files at once are left as they are, and the dialog says so.

### Connect a remote

For a repo showing **Local only**: `⋯` ▸ **Connect remote…**, paste the address of a repository you created on
GitHub or GitLab (`git@github.com:you/repo.git` or `https://…`), **Check** — Pomade asks the remote before adding
it — then **Connect**. The next **Commit & push…** publishes the branch there.

### Start a repo for a new project

In **New project** (the project dialog), a project from **New from template**, or from a folder that does not exist
yet, has **Track with git** checked: **Create project** runs `git init` and a first commit named *Start &lt;name&gt;*.
An existing folder without git has the box unchecked. A folder that is already a repo shows its remote; a folder
inside another repo says *Tracked by the &lt;name&gt; repository*.

## Fetch, pull, publish, switch

All from the repo view; each opens a dialog with its preview and a confirm button.

- **Fetch** (the button after the remote line) looks at the remote and updates `↓n`. It changes none of your files.
  Opening a repo also fetches quietly at most every 5 minutes.
- **Pull…** (`⋯`, a branch with a remote branch) gets their commits and puts yours on top. It needs nothing
  uncommitted.
- **Publish branch…** (`⋯`, a branch not on the remote yet) pushes it for the first time and makes it follow the
  remote branch.
- **New branch…** (`⋯`) asks a name, creates the branch from where you are and switches to it; your uncommitted
  changes come along.
- **Switch branch…** (`⋯`) lists local branches, then those only on the remote. If an uncommitted file would be
  replaced, the switch is blocked and the dialog offers **Commit first…** or **Discard it first…** — Pomade never
  hides changes away.
- **Rebase onto main…** / **Rebase onto origin/…** (`⋯`) puts your commits on top of main's (or the remote
  branch's) newer ones.

Only one operation runs in a repo at a time; a second is refused, not queued.

## Look at what happened

**History** lists the branch's landed work, one row per piece: subject, how long ago, author. A merge row has a
chevron (or press Right) that shows the commits it brought in. Tick **Every commit** (the small checkbox in the History heading) to see every commit. Commits made
by a scheduled job read *Committed automatically · job "&lt;name&gt;" · 13:00*.

**Not pushed** lists the commits the remote lacks, newest first; it appears only while there are any.

**To open a commit:** click a row in History or Not pushed. The tab shows the subject, author, date, a short hash
(click it to copy the full hash), the message rendered as markdown, and **Files changed** with `A` `M` `D` `R` and
`+added −removed`. Click a file to compare its version before and after.

**Single click opens a preview tab** (its title in italics) that the next click replaces, so skimming leaves one tab.
Using the tab keeps it. To keep one at once, right-click the row ▸ **Open in a new tab**, or press Enter on it.
The setting is **Settings ▸ General ▸ Tabs ▸ Single click opens a preview tab**.

**To compare a changed file with its last commit:** click its row in **Changes**. The comparison tab shows the last
commit on the left, your document on the right.

## Document history

Every version of one document, with or without git.

**To open it:** click **History** in the editor header, right-click a file in the tree ▸ **Show history**, or press
Cmd+Shift+H (Ctrl+Shift+H elsewhere; pressed again it closes). The panel opens at the right of the document.

Rows come in foldable groups:

| Group | Rows |
|---|---|
| **Current** | **Unsaved edits** (while the document has unsaved changes); **Saved · Nov 11 11:42** — the file as it is on disk. A small `current` mark shows which of the two is what the editor holds. |
| **Discarded** | **Discarded draft** (text you closed or replaced without saving); **Discarded change** (discarded in the Git panel) — both kept 7 days |
| **Local versions** | every version Pomade saw on disk in the last 7 days, e.g. *Nov 11 11:00 · changed on disk* (another program wrote it) or *· saved in Pomade*; the newest one is shown as the **Saved** row when it matches the file on disk |
| **Commits** | the commits that touched the file, following it across renames; **Show all commits** lists every one, **Show older** pages |

The **Saved** row's second line says where git stands: `not committed` (the file differs from the last commit),
`new file · not committed`, `renamed from old.md · not committed`, `same as 0b8e744` (it equals the last commit
that touched it) or, outside a repository, `local version · 1.2 KB`.

**To bring yesterday's version back:** click its **Restore**. The whole version goes into the editor as **one
unsaved edit**: Cmd+Z undoes it, and nothing is final until you save. A version kept under an earlier file name asks
*Restore … under its earlier name …?* and renames the file back first (**Rename back and restore**).

**To see what changed:** click a row — a comparison tab opens with that version on the left and your document on the
right. To compare two versions, tick two rows (the box shows on hover; Cmd+click, or Space on a focused row), then
click **Compare** in the bar. **Clear** drops the ticks.

**To edit an old version or make it the document:** right-click the row ▸ **Open this version in a tab**. The tab is
titled like `notes.md @ 0b8e744` and carries a **Version 0b8e744** chip. **Save** asks *Replace notes.md with this
version? The current text stays in History.* — **Replace** keeps what the file holds now as a local version first.
Other tabs of the file take the new text.

The right-click menu also has **Compare with your document**, **Restore** and, on a commit, **Copy hash**.

**To compare two files:** select both in the tree, right-click ▸ **Compare**. The first is the left side as on
disk; the second is the right side, editable.

A document outside any repo shows only its unsaved, discarded and local versions, and *Git history appears when this
file is in a repository.*

### Local versions

Pomade keeps a copy of a text file in the workspace each time its content changes — written by an agent, git,
an app or Pomade itself — for 7 days. It sees changes only while Pomade is open. Files over 2 MB,
binary files, empty files and files git ignores are not kept. A rename or move in Pomade carries the history along.

Every change is kept for a document open in Pomade, for your saves, and for files ending in `.md` or `.txt`. Any
other text file keeps getting versions unless its content changes constantly — more than 12 times within an
hour, like a build output or a script's scratch file. Saving the same text again does not count. It then gets no
new versions until it has been quiet for an hour; the versions it already has stay. Files ending in `.log`, `.jsonl` or `.ndjson` get no versions at all. Both lists of
extensions are in **Settings ▸ General ▸ Local history** ([settings.md](./settings.md#local-history)).

Versions are stored in the workspace, in `Apps/Pomade/local-history/` (git ignores it), so they travel with the
workspace folder to another Mac. They take up to 256 MB per workspace; the oldest go first beyond that. **Settings ▸
General ▸ Local history** has **Space for local versions** (64 MB to 2 GB) and **Delete versions now** — pick a group
(**Local versions** or **Discarded**) and an age (**Any age**, or older than 1–6 days); Pomade shows how many versions
and how much space go before **Delete…** asks you to confirm. It cannot be undone.

### Get back discarded work

Open the repo in the Git panel; **Discarded** lists the files discarded in the last 7 days whose discarded text is not
back, newest first. Click a row: the document opens (even if its file is gone) with its Document history showing the
*Discarded change* row — compare it or **Restore** it, then save. Once the file holds the discarded text again, or you
restored any version from Document history and saved, the row hides; if the file is deleted later, it shows again.
**×** at a row's end (on hover) forgets it: Pomade asks once, in the row, then deletes the kept copies for good.

## Compare and quick peek

**The comparison tab** shows two versions side by side: old lines red, new lines green. Labels over each side name the
version (`HEAD · c60bfe4 · Oct 17`, *Now*, *On disk now*). When the right side is your document it is editable, in
sync with the document's own tab; Cmd+S or **Save** saves it, **Open in editor** goes to the document's tab. The
arrow between the sides (**Take old**) copies that one change's old text into your document as an unsaved edit; Cmd+Z
undoes it. A side that is a fixed version has **Open in tab** to edit it separately. Files over 2 MB and binary files
are not compared.

**Changes only** (checkbox in the tab's header, left of **Open in editor**) hides the unchanged lines and keeps 3
lines around each change. Each hidden stretch shows as one band across both sides, `⦚ 12 unchanged lines ⦚`;
click it to show those lines. The choice is one for all comparison tabs, open and future, and stays after a restart.

**When the file changed on disk under your unsaved edits,** the editor shows *File changed since your edits.* Click
**Compare**: the tab opens disk ↔ your edits with **Keep mine** (the next save writes your edits) and **Use disk
version** (your edits are kept as a discarded draft).

**Quick peek:** Cmd+Shift+G on a document opens a read-only overlay with three comparisons — **Saved ↔ Unsaved**,
**Working vs HEAD** and **HEAD vs Previous** (the last two when the file is in a repo). Esc, **×** or a click outside
closes it. The *Recovered unsaved edits* banner's **Compare** opens it too.

## In progress: branches and worktrees

**In progress** lists work that has not landed on main: a row per **worktree** (a second folder an agent works in),
per local branch main lacks, and under **Remote** per branch only on the remote. A row shows the name, an **agent**
tag while an agent works there, and `2 ahead · 1 behind · 4 uncommitted · 5 min ago`. With the agents app installed,
a row also names the agent session behind it; click it to go to that session or resume it.

**To inspect a branch:** click its row. The branch tab lists **Commits main doesn't have** and **All its changes**
(click a file to compare the version where the branch left main with the branch).

The actions in the branch tab, each with a preview:

- **To land a branch on main:** from the repo's own checkout, on main with nothing uncommitted, click **Merge into
  main…**, choose **Squash into one commit** (the usual choice) or **Merge commit**, edit the message, click **Squash
  & merge** (or **Merge**). If the changes conflict, a [conflict tab](#conflicts) opens.
- **To clean up after landing:** the dialog then offers **Landed — remove branch and worktree?** → **Remove**. Only a
  branch whose work is in main can be removed, never one with uncommitted changes in its worktree; a branch of the
  same name on the remote stays. Later: **Remove branch and worktree…** in the branch tab.
- **To put a branch on top of main:** **Rebase onto main…** (off when it already is).
- **To work on a branch without touching your checkout:** **Check out to a worktree…** — a new folder under
  `~/.pomade/worktrees/<repo>/<branch>`. **Open folder** and **Open terminal there** then go to it. Start an agent in
  that terminal.
- **To open a pull request:** **Open on GitHub** / **Open on GitLab** opens the page in your browser (off until the
  branch is on the remote).

While an agent is working in a checkout, **Merge**, **Rebase** and **Remove** wait: the note says
*An agent is working here (claude) — Merge, Rebase and Remove wait until it ends.*

## Conflicts

When **Pull**, **Rebase** or **Merge into main** meets changes it cannot combine, a **Conflict · &lt;repo&gt;** tab
opens (also from **Resolve conflicts…** in the repo head's bar or `⋯`). In a rebase the left column is **Theirs**
(main, origin/main), the right **Yours** (your commit being replayed); in a merge they are **Main** and **Landing**.

1. Pick a file chip, if there are several.
2. For each conflict, click **→** to take the left version into the result, **←** to take the right one; click both to
   keep both, or type the result yourself. **Start over** empties it. A file that cannot be combined line by line
   (deleted, binary or over 2 MB) shows two cards: **Take theirs** / **Take yours**.
3. When every conflict is decided, click **Mark resolved & continue**. The last file continues the rebase
   (**Continue the rebase**) or finishes the merge (**Finish the merge**).

**To give up:** **Abort, back to before** puts everything back exactly as before and checks it. Edits made during
the stop go with it.

## The `pomade-git` command

Git operations without opening the Git panel, with Pomade open or closed — for scheduled jobs (Runner) and agents.
Pomade's own terminals have it on PATH; for other terminals turn on **Settings ▸ General ▸ Commands**.

```
pomade-git <commit-push | pull | push | fetch> <repo…> [--json] [--job <name>] [--message <text>] [--wait <seconds>]
```

A repo is its name in the Git panel (`Knowledge`, `Pomade`) or a path.

- **commit-push** commits every change (*Committed automatically · &lt;date time&gt;*), gets their changes, pushes.
- **pull**, **push**, **fetch** do what they say. pull only on a repo with nothing uncommitted.
- It **skips** a repo where an agent is working or waiting for you (`agent working`), or another operation holds it
  for longer than `--wait` (default 30 s). An agent that Pomade sees idle at its prompt, and the process in its
  terminal, do not hold the repo. With Pomade closed, any `claude` or `codex` running in the repo holds it.
- It **fails** without changing anything if their changes conflict — the repo ends exactly as before. A push that
  fails keeps the commit; the next run pushes it.
- Exit code: 0 done or skipped, 1 a repo failed, 2 bad command line. `--json` prints the structured result.

The Git panel shows each repo's last run under its remote line (*Commit & push done 13:00 · committed a1b2c3d*), marks
a failed run until you open the repo, and — when Runner is installed — lists the jobs that target it (*Scheduled:
Commit & push · 13:00, 20:00 — edit in Runner*).

## Explanations in the interface

Every git term explains itself on hover: a one-line definition and an example. Terms inside sentences (commit, push,
rebase, conflict, upstream, worktree…) are underlined with dots; the controls — `●`/`↑`/`↓` counts, the branch, the
remote line, **Fetch**, **+**, the discard arrow, `⋯` items, **Track with git**, **In progress** — carry the same
hover. Every operation's preview line is the sentence of what is about to happen.

| Term | In short |
|---|---|
| repository | a folder whose every saved version git keeps |
| commit | a saved snapshot of the files, with a message |
| uncommitted | changes on disk no commit holds yet |
| push / pull / fetch | send your commits · bring theirs in · look at the remote without changing files |
| remote / upstream | the server copy (e.g. GitHub) · the remote branch yours sends to |
| branch | a named line of commits |
| merge / squash | join a branch into this one · land it as one commit |
| rebase | replay your commits on top of newer ones |
| revert | a new commit that cancels an earlier one |
| stage | pick what goes into the next commit |
| worktree | a second folder checked out from the same repo |
| conflict | two changes to the same lines git cannot combine |
| publish | the first push of a branch |
| abort | stop a half-done operation and put everything back |
| in progress | work not on main yet |

When something fails, the message says it in plain words (*GitHub refused the push — not signed in. Run `gh auth
login` in a terminal.*) with git's own last line under it and a **Copy** button for the command to run.

## Shortcuts

| Keys | Does |
|---|---|
| Cmd+Shift+H (Ctrl+Shift+H) | open or close Document history; on a comparison or version tab, open its document's Document history |
| Cmd+Shift+G (Ctrl+Shift+G) | quick peek of the active document |
| Cmd+Enter (Ctrl+Enter) in the commit box | commit (staged files when any are staged) |
| Esc | close the commit box (while typing in it) · the quick peek · the deleted-file view · the Document history panel (inside it) |
| Cmd+S in a comparison tab | save the document |
| Cmd+Z | undo a Restore or a Take old |
| Enter on a row | open it in a tab that stays (change, commit, branch, branch file, Document history version); on a Discarded row, open its Document history |
| Right / Left on a merge row | show / hide the commits it brought in |
| Cmd+click (Ctrl+click), Space on a Document history row | tick it for comparing |
| Cmd+Shift+B | collapse or expand the side panel |
