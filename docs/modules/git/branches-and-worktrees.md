---
doc: docs/modules/git/branches-and-worktrees.md
audience: engineers, product
holds: In progress (worktrees, branches, remote branches), the branch tab, worktree checkout, merge into main, landed cleanup, rebase, PR hand-off, agent-live checks and the agent session link
kind: reference
---

# Branches and worktrees — In progress, the branch tab, landing and cleaning up

**Module:** `git` · **UI:** the [Git panel](./git-panel.md)'s repo view — the **In progress** section above
History; the **branch tab** a row opens; the operation dialog · **Code:** `src/main/git-branches.ts`
(Electron-free), `src/main/agents-live.ts`, `src/main/agent-sessions.ts`, `src/shared/git-branches.ts`, the UI in
`src/renderer/modules/git/branches/` · **e2e:** `git-branches.spec.ts`, `git-branches-agent.spec.ts`,
`git-branch-session.spec.ts` · **Contract:** [contracts/git-operations](../../contracts/git-operations.md) "In progress and branches", "Rails", [HOST-API](../../HOST-API.md) §4 `apps` (Platform reads of app APIs)

## What it does

Work that has not landed is visible and workable: agents' worktrees, your own branches and colleagues'
branches on the remote show as **In progress**; each can be looked at, checked out without disturbing the
repository's own checkout, landed on main as one commit (or with a merge commit), cleaned up once it landed,
and handed to GitHub / GitLab for a pull request. Every operation runs on the same rails as the rest
([operations and safety rails](./operations-and-safety-rails.md)): a preview, a token, one operation per
repository, git that never prompts.

## In progress

Shown once the repository has a commit. One row per **linked worktree** (whatever its branch, or a detached one), per **local branch** that has commits
main does not have (except one a worktree holds — its worktree's row stands for it), then — under a *Remote*
label — per **branch only on a remote** with commits main does not have (a remote branch with a local branch of
the same name shows as that local branch). Main is the local `main`, else `master`. Each group is most recent
first. Empty: *Nothing in progress — every branch is in main.*

A row: an icon (folder = worktree, branch mark = branch, cloud = remote), the branch name, an **agent** pill while
an agent is live there, and a line `2 ahead · 1 behind · 4 uncommitted · 5 min ago` (*checked out ·* first when
the repository's own checkout is on it). **Last activity** is the newest commit, or a newer change to an
uncommitted file in a worktree. The hover says where the worktree is, what the counts mean, who is working
there, the agent session, and whether the work is in main.

**The agent session behind it.** With `pomade-agents` installed and answering, a local row gets a
third line — *agent · session name* (*unnamed session* in italics) — naming the session working on it: the one
live there, else the latest. A worktree is matched by its folder (`sessions.forRepo { folder }`), a branch by the
repository's folder and its name (`{ folder, branch }`); a remote row has none. Clicking it goes to the session's
live agent tab, or resumes the session in a new agent tab in its start folder, in its project (the Workspace project when it
has none or that project is gone — PLATFORM rule 9) — the same as `agentTabs.resume`; a session that cannot be resumed says why in a toast. Without the app (absent, not
responding, a malformed answer) there is no line and nothing else changes.

The list is read when the repo view shows and again whenever the repo's git state moves, an agent starts or
ends, or an agent tab's session changes. **Opening the repo view fetches in the background** (the remote the branch follows, else `origin`), at most
once every 5 minutes per repository, quietly: a failure or a busy repository is left to the Fetch button. It runs
as a background operation, so it never makes the user's own operations wait or refuses them — it gives way
([operations and safety rails](./operations-and-safety-rails.md) "The rails").

## The branch tab

A row opens it (single click: the [preview tab](../tabs/preview-tabs.md), like a commit; right-click ▸ Open in a new tab or Enter: a tab that stays; the same for its commit and file rows; a deleted file's row reads **Open the deletion in a new tab**). A detached worktree has no branch and does not open a tab. The tab reads *Loading branch…*, then shows the kind, the counts against main, the
worktree's folder and uncommitted changes, the live-agent note, then:

- **Commits main doesn't have** — `main..branch`, newest first (200 at most, then *and N older.*); each opens its
  commit tab. Nothing there: *None — its work is in main.*
- **All its changes** — the total change against where it left main (the merge base); each file opens the
  comparison tab, that point ↔ the branch. Over 2000 files the list is cut (*Only the first 2000 files of N are
  listed.*). A worktree's uncommitted changes are not included, and the tab says so.

And the actions, each opening the operation dialog with its preview:

| Action | Shown for | What it does |
|---|---|---|
| **Merge into main…** | every row but the checkout's own branch; off when main already has all its commits | squash (default) or merge commit — below |
| **Rebase onto main…** | local rows; off when the branch is on top of main already | puts the branch on top of the local main |
| **Check out to a worktree…** | branches and remote rows | a new folder, outside the repository |
| **Open folder** · **Open terminal there** | worktrees | the folder in Files when it is inside the tab's project, else in Finder · a terminal tab in the folder |
| **Open on GitHub / GitLab** | a remote on github.com or a GitLab host | the pull / merge request page in the browser; off (with the reason) until the branch is on that remote |
| **Remove branch and worktree…** (**Remove branch…** without a worktree) | a branch whose work is in main | below |

Merge, Rebase and Remove are **off while an agent is live** in the checkout that holds the branch, and the note
says so: *An agent is working here (claude) — Merge, Rebase and Remove wait until it ends.* The operations refuse
on their own too.

## Agent live here?

`agents-live.ts` `agentsLiveIn(folder)` — the one answer for every caller (the Host API's `agents.liveIn`, so
`pomade-git` too; these blocks; the rows' **agent** pill). Two sources, joined:

- agents running in Pomade's terminals whose **folder at launch** is the folder or inside it. An agent counts
  where it started, so the way to work in a worktree is to open a terminal there (**Open terminal there**) and
  start the agent in it;
- with `pomade-agents` installed and answering, its `sessions.liveIn` — agent tabs (also one not prompted yet)
  and unattended Runner runs there. An app that is absent, lets a call time out (then it is left alone
  for 10 s) or answers malformed adds nothing.

Each entry is `{ agentId, cwd, state?, terminalPids? }` (`LiveAgentEntry`): `state` is `working`, `needs-you` or
`idle` when known, from the app for its sessions and from the terminal's agent scanner for Pomade's terminals
(`idle` only at the agent's empty prompt; nothing before the first reading); `terminalPids` are the shells of the
Pomade terminals the agent runs in. `joinLiveAgents` (`shared/git-branches.ts`) keeps one entry per agent and folder
with the busiest state (working, not known, needs-you, idle), takes no `idle` from a run, and lets an app tab without
a `state` take the terminal's reading. The pill and the blocks above count **every** entry, idle or not; only
[`pomade-git`](./pomade-git.md) "Rails" tells them apart.

For the repository's own checkout, agents inside one of its worktrees (e.g. `.claude/worktrees/…`) do not count.

## Check out to a worktree

`git worktree add <folder> <branch>`; a remote-only branch gets a local branch following it (`worktree add --track
-b <name> <folder> <remote>/<name>`). The folder is **`<Pomade home>/worktrees/<repo>/<branch>`** —
`~/.pomade/worktrees/…` (the dev build: `~/.pomade-dev/worktrees/…`), `-2`, `-3`… when taken;
`POMADE_WORKTREES_DIR` replaces the root. Outside every repository and the workspace, so neither the repository's
checkout nor the file tree changes. Refused when the branch is checked out already (it names where) or a local
branch of that name exists.

## Merge into main

From the repository's own checkout, which must be **on main with nothing uncommitted**. Refused also when the
branch has nothing main lacks, its worktree has uncommitted changes (they would not land), an agent is live there,
git has no identity, or the landing would overwrite an ignored file. The dialog: **Squash into one commit**
(default) or **Merge commit**, a message box prefilled with the branch name and its commit subjects, and the
preview — *This lands 4 commits from “feature” as 1 commit on main (squash merge). If its changes conflict with
main's, a conflict tab opens…*

The run records the repository's fingerprint, then `git merge --no-ff --no-commit <branch>` — always a real merge
in progress, so a conflict stops it with git's own `merge --abort` behind Abort:

- **No conflict** — finished at once: a squash runs `merge --quit` (the index and files stay as combined) and
  commits them with one parent; a merge commit commits with both. Hooks run. The message is the one typed.
- **A conflict** — the [conflict tab](./conflict-tab.md) opens (main on the left, the branch on the right); the
  repo view's bar reads *A merge stopped on a conflict*. The last file resolved — or **Finish the merge** —
  commits it as above; **Abort, back to before** runs `merge --abort` and checks the fingerprint.
- **Any other failure** — `merge --abort` at once, checked the same way.
- A squash whose commit fails (a hook refusing) leaves the combined changes staged on main and says so: commit
  them, or discard them to go back. Nothing is lost.

The record (mode, message, fingerprint) is kept in memory until the merge ends; a merge stopped before a restart
— or started in a terminal — finishes as git's own merge commit.

## Landed — remove branch and worktree?

A merge that lands a local branch replaces the dialog with the offer. **Remove** is only possible after a
**verified landing**: the branch tip is reachable from main, or Pomade squash-merged exactly that tip and its
squash commit is still on main (kept in memory for the session). Then `git worktree remove <folder>` — never
`--force`, so git also refuses a worktree with changes or untracked files — and the branch ref is deleted at that
exact tip (`update-ref -d refs/heads/<b> <tip>`: a branch that moved since is left alone), with its config
section. A remote branch of the same name stays, and the preview says so. Refused while an agent is live there,
while the worktree has uncommitted changes, is locked, or the repository's checkout is on the branch. **An
unmerged branch is never deleted** (P-032).

## Rebase onto main

A branch that is not the checkout's own: in its worktree, or — checked out nowhere — in a temporary worktree
outside the repository, removed afterwards. Needs nothing uncommitted there. The state before is recorded; a
conflict (or any failure) is aborted at once and checked: *main's changes conflict with “feature”'s in intro.md.
Nothing was changed — “feature” is exactly as before. Merge it into main instead (a merge conflict opens the
conflict tab), or rebase it in a terminal there.* The checkout's own branch uses the operator layer's
[Rebase onto main](./operator-layer.md), conflict tab included.

## Open on GitHub / GitLab

`pullRequestUrl(remoteUrl, branch, main)`: from an ssh (`git@host:owner/repo.git`, `ssh://`) or https remote —
GitHub `https://<host>/<owner>/<repo>/compare/<main>...<branch>?expand=1`, GitLab
`https://<host>/<group/…/project>/-/merge_requests/new?merge_request[source_branch]=…&merge_request[target_branch]=…`
(`<host>` is the remote's own host).
The remote is the branch's upstream's, else `origin`. Hidden for any other host or a local remote. No in-app
review (P-034).

Tickets: E-041, E-043, T-225.
