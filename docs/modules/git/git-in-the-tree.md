---
doc: docs/modules/git/git-in-the-tree.md
audience: engineers, product
holds: git marks in the file tree, Projects panel badges and rail dots; the git-state service (discovery, status, freshness) and its snapshot
kind: reference
---

# Git in the tree — "am I safe?" at a glance

**Module:** `git` · **UI:** file-tree rows, Projects panel project rows and rail launchers · **Code:**
`src/main/git-state.ts`, `src/shared/git-state.ts`, `src/renderer/modules/git/` (`tree-marks.tsx`,
`GitBadge.tsx`, `DeletedFileOverlay.tsx`, `git-state-store.ts`), `filetree/TreeNodes.tsx` ·
**e2e:** `git-tree.spec.ts` · **unit:** `shared/git-state.unit.test.ts`

## What it does

The file tree shows what changed since the last commit; the Projects panel shows, per project, how many
files are uncommitted and how many commits are unpushed.

| Mark | Meaning | Hover |
|---|---|---|
| `M`, amber name | modified — staged or not, the tree makes no distinction | M — Modified: changed since the last commit |
| `U`, green name | new: untracked or newly added | U — New: not in any commit yet |
| `C`, red name | conflict left by a merge | C — Conflict: a merge left both versions in this file |
| `R`, blue name | renamed, as git records it (see below); shown at the new name only | R — Renamed from `<old name or path>` |
| `D`, red struck-through **ghost row** | deleted: in the last commit, gone from disk | D — Deleted: gone from disk, still in the last commit. Click to view or restore |
| amber dot on a folder | something inside changed (expanded or collapsed) | Something inside changed since the last commit |
| dimmed row | gitignored | — |

An untracked folder carries `U` itself and everything inside reads as new.

**Deleted files** stay in their old place as ghost rows; a deleted folder is a ghost folder that
expands to its ghost children. Clicking a ghost file opens its last committed version read-only,
titled *"notes.txt · deleted"*, with **Restore file**: it writes the file back from the last commit
(index and disk) and the row turns normal. Restore refuses when something already exists at the
path. Binary files show their size instead of content and can still be restored.

**"Hide git status" / "Show git status"** in the tree's ⋯ menu, between *Ignored items…* and
*Show ignored items*, turns every mark and ghost row off or on. On by default; remembered
across launches (app-level).

**Projects panel.** A project row shows `● 5 ↑2`: uncommitted files, then commits not yet on the
upstream; nothing at all when clean and pushed. It sits before the red unread counter; with
no counter showing, a project row keeps the counter's slot empty, so badges line up from row to
row and the row's hover ⋮ lands in that slot, never over the counts. A
project counts the uncommitted entries under its folder (whichever repo holds them) and the
unpushed commits of the repos inside it plus the repo that contains it. The Workspace row sums
every repo. `↑` needs an upstream: a branch tracking nothing shows no arrow. The hover lists each
repo by folder name (*"Pomade: 3 uncommitted files · 2 unpushed commits"*). On the collapsed
rail a launcher gets a corner dot (amber when anything is uncommitted, blue when only unpushed)
and its tooltip carries the same lines. Git tooltips are the shared tooltip box: one line when short, wrapped inside 320px when longer.

## How it works

**Repos.** Main discovers repos by walking up to 3 folder levels below the workspace root for
`.git` entries, nested repos included — the workspace root, `Knowledge`, every `Projects/*`. It skips
`node_modules`, `.pomade`, build/vendor folders and every dot-folder. Each repo is named by its
folder; the workspace-root repo by the workspace folder's name. Each repo also carries its
absolute path and its remote URL — the upstream's remote, else `origin`, else the first remote — or
none, which makes it local only.

**Status.** One `git status --porcelain=v2 -z --branch --renames --untracked-files=normal --ignored=matching` per repo, run
without optional locks so it never writes the index under an agent's feet. A file belongs to its **nearest** repo:
the parent repo's view of a nested repo (an untracked or ignored folder) is dropped, so a change in
`Projects/Pomade` marks only Pomade's file. Untracked folders count as one entry each. Remotes come
from one `git config` read per repo, run alongside the status and kept until the repo's
`.git/config` changes or a full refresh runs.

**Freshness.** Git state listens through the platform watcher (no watcher of its own): a file
change refreshes its repo, a change to git's own metadata (`.git/index`, `HEAD`, `refs/…` — a
commit, checkout, fetch or push) or `.git/config` (a remote added, changed or removed) refreshes that
repo, a `.git` appearing or vanishing re-runs
discovery. Window focus re-discovers and refreshes everything (at most every 3 s), which covers
repos outside the tree's current root. Refreshes coalesce over 250 ms and never overlap.

**One model.** The snapshot (`GitSnapshot`, `shared/git-state.ts`) is a typed, pure data shape —
every repo's name, path, remote, branch, upstream, ahead/behind and changes. Hosted apps read the same snapshot through
the Host API (`git.read`, [workspace data API](../core/workspace-data-api.md) "Git state"); no app
call runs git.

## Boundaries worth knowing

- Repos deeper than 3 levels below the workspace root are not discovered.
- Repos outside the current tree root refresh on window focus, not on every change.
- **When `R` shows.** Only when the rename is recorded in git's index: `git mv old new`, or both
  halves staged (`git add -A`, or staging the deleted and the new file in the Git panel). This is
  the only case; git and VS Code behave the same. A rename anywhere else — Pomade's tree, Finder,
  a plain `mv`, an agent — is a deletion plus a new file to git, so the tree shows a ghost `D` at
  the old name and a `U` at the new one until both are staged.
- Outside-workspace mounts carry no git marks.
- There is no repo list, staging, committing or pushing here — that is the [Git panel](./git-panel.md) and
  [safe operations](./operations-and-safety-rails.md).

Tickets: E-036, E-030.
