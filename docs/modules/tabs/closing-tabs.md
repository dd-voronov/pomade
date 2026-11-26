---
doc: docs/modules/tabs/closing-tabs.md
audience: engineers, product
holds: closing tabs — the close guards and what they ask, batch closes and the bulk close confirm, where focus lands, reopening closed tabs, the reopen stack; how it is built
kind: reference
---

# Closing tabs — guards, confirmations, batch semantics

**Module:** `tabs` · **UI:** the tab ×, **Cmd+W**, the tab context menu's close variants, the
Bulk actions menu, the strip's empty-space menu · **Code:** `stores/tabs-store.ts` (`closeTab`, the
close-guard registry, `requestClose*`, the reopen stack, the MRU activation stack),
`hooks/useCloseGuard.ts` (the shared guard), `modules/editor/EditorPane.tsx` and
`modules/terminal/TerminalPane.tsx` (the two guards), `modules/terminal/BulkCloseConfirm.tsx` (the bulk
confirm), `stores/terminals-store.ts` (`stopAllTerminals`, `exitAllAgents`, `bulkClose`, `reopenClosedTab`) ·
**e2e:** `tabs.spec.ts`, `tab-hotkeys.spec.ts`, `close-focus.spec.ts`, `reopen-closed-tab.spec.ts`,
`reopen-nonclose-paths.spec.ts`, `bulk-close-confirm.spec.ts`

## What it does

Every per-tab close request — ×, Cmd+W, the context-menu closes, **Close all docs** — routes through
the tab's **close guard**; the pane decides whether to ask first:

- **Clean doc** — closes silently.
- **Dirty doc** — an `Unsaved changes` dialog: `Cancel` / `Discard` / `Save`. Discard closes the tab
  and keeps the unsaved text as a discarded draft ([unsaved recovery](../editor/unsaved-recovery.md)).
  Saving an untitled doc opens Save As and leaves the tab open. A dirty **version tab** saves by
  replacing the document, which asks first ([document history](../git/document-history.md#a-version-in-its-own-tab)).
- **Live agent** — always confirms (`Close agent tab?`, an agent conversation is work in progress):
  `Cancel` / `Close`.
- **Live plain terminal** — confirms (`Close running terminal?`) only when **busy** (a foreground
  command is running; an idle shell closes silently). Pomade knows busy-vs-idle from its shell
  integration markers, not guesswork.
- **Dead terminal** — closes silently.
- **App, commit, comparison, conflict, branch and attached tabs** — have no guard and close
  silently. Closing an attached tab only detaches; nothing ends
  ([attached terminals](../terminal/attached-terminals.md)).

**A silent close never touches your focus.** The guard activates its tab only when it is about to
*ask* something — the dialog lives inside the pane, so you have to be looking at it
(`useCloseGuard`). A close that resolves silently leaves the active tab exactly where it was, so
closing a background tab's × can never pull you out of the tab you are working in.

## Batch closes

**Close others**, **Close to the right** (tab context menu) and **Close all docs** (Bulk actions
menu, strip menu) process their targets **sequentially**: each **prompted** tab is focused, then
prompted, one at a time — you always see what you're deciding about. Tabs that close silently
(clean docs, idle terminals, unguarded tabs) close in between without moving focus; Close others and
Close to the right end on the kept/anchor tab (Close others also activates it first).

**Cancel aborts the whole remainder** — nothing else closes after a Cancel. (Save/Discard
advance the batch.)

**Close saved docs** only ever touches clean docs, so it closes them directly.

### Stop all terminals and Exit all agents — the bulk close confirm

Neither action goes through the per-tab close guards. **Stop all terminals** kills every plain
terminal of the project and closes its tab; **Exit all agents** sends `/exit` to every live agent
and closes its tab once the process ends (a shell left behind is killed after 1.2 s). Each first
looks for tabs holding work in progress, by the rule of the per-tab guard:

- terminals: a live plain terminal is busy while a foreground command runs (main's shell-integration
  flag, `pty.list()`), so the idle ones are not counted;
- agents: a live agent is busy while it is **mid-turn** — `working`, or `needs-you` at a permission
  prompt (`agent-live-store`). An idle agent at its prompt is not busy, unlike the per-tab close,
  which always confirms a live agent: `/exit` is the clean end the action asks for.

With nothing busy the action runs at once. Otherwise it sets `terminals-store.bulkClose` and
closes nothing: **one** confirm (`bulk-close-guard`, `BulkCloseConfirm`, rendered by `PaneHost`) asks for
the whole batch, with `Cancel` / `Close` (`bulk-close-cancel`, `bulk-close-confirm`). Its copy
names the busy tabs: one busy terminal `Close running terminal?` and its title, several
`Close running terminals?` and the count; one mid-turn agent `Close working agent?`, several
`Close working agents?`. Cancel leaves every tab and process untouched. Close runs the action over
the project's tabs as they are at that moment — idle ones and dead terminals included, not only the
busy ones. The dialog shows only while its project is the active one; a pending ask waits while
you look elsewhere. After the action runs a toast reports it (`Stopped all terminals` /
`Sent /exit to all agents`).

## Where focus lands after a close

Closing the **active** tab returns to the **previously-active** tab. Each project keeps a
most-recently-used stack of its tabs (`activationHistoryByProject`): every activation, every open
and every reopen pushes the tab on top and the tab it displaced below it, each id at most once,
capped at 50. Closing the active tab focuses the most recent surviving entry — so a doc opened from
a terminal returns to that terminal when it closes, and a chain `T → D1 → D2` unwinds most-recent
first.

Only when no entry survives (a project whose session history is empty, or the return target was
closed or moved away) does the geometric rule apply: the **right neighbour** — the tab that slides
into the closed one's slot — falling back to the **left** neighbour when the active tab was the
last one. The stack is session-local: it is not persisted and a workspace switch drops it.
Closed and moved-away tabs are pruned from it.

Closing a **non-active** tab leaves the active tab where it is — that also holds for a tab whose
pane has a guard, since a silently-resolving guard does not focus it first. The rule holds across
every close path — ×, Cmd+W, context-menu Close, `Close all docs`, `Stop all terminals`,
`Exit all agents` — except two geometric ones:

- **Close saved docs** (and the restore-time prune of vanished docs): when the active tab is among
  those removed, focus goes to the first survivor at or right of its slot, else the last survivor.
- **Move to another project** (menu or drag onto a Projects panel row): the source strip focuses the moved
  tab's right neighbour, falling back left.

## What closing a terminal tab does

The PTY is killed exactly when no tab references it any more — closing the tab is what ends the
process. There is no "detached" terminal; if you want the process to survive, keep the tab (it
survives project switches for free — see [pane-host](./pane-host.md)).

## Reopening a closed tab

Every explicit close is undoable. Each close pushes the tab — its full object plus the index it held
in the strip — onto a **per-project reopen stack**: LIFO, capped at 10 (`REOPEN_STACK_CAP`), and
**persisted** in `ProjectState.reopenStack`, so it survives an app restart. *Reopen closed tab* pops
the top and brings it back at its **original index** (clamped to the current strip length) as the
active tab — the one deliberate exception to "new tabs open right of the active one".

- A **doc** is re-added from disk (mode / rich view / color / reading position kept). An
  outside-workspace doc whose file has since vanished is silently skipped and the next entry is tried
  (matching the restore-time prune); an in-workspace doc is always re-added (the editor shows its own
  "no longer exists" notice). A version tab comes back as a version tab.
- A **terminal** comes back as a fresh shell at its old cwd, with its **scrollback replayed** above a
  restore divider and its last command pre-typed — the same machinery an app restart uses. A tab that
  was already dead when closed comes back as a dead pane.
- An **agent** re-enters its conversation via `--resume` (roster match + validated session id); a
  session the disk can't back becomes an honest dead pane, tab kept.

A reopened tab **keeps its original id** — that id is the scrollback snapshot key, so replay works
unchanged. What pushes: every explicit close — ×, Cmd+W, the context-menu closes, the Bulk actions /
strip-menu actions (Close all docs / Close saved docs / Stop all terminals / Exit all agents), and
pane-side closes. What does **not**: *moveTabToProject*, preview replacement, reorder, and the
restore-time prune of vanished docs — none of these is a close.

The 11th close evicts the oldest entry and forgets its scrollback snapshot. Bulk closes push their
victims in strip order, so repeated reopen resurrects them most-recent-first.

**Three entry points:** the Bulk actions item (*Reopen closed tab*, first item, disabled when the
stack is empty), a **right-click on the empty strip area** (a menu carrying the same five actions as
Bulk actions — a deliberately independent copy, not shared config), and **Cmd+Shift+T** (acts on the
active project).

## Boundaries worth knowing

- **Cmd+W** targets the active tab of the active project; with no tab open it is a no-op (the
  window never closes from Cmd+W — closing the window is **Cmd+Shift+W**).
- **Cmd+Shift+T** reopens the active project's most-recently closed tab; a no-op when its stack is
  empty.
- A reopened terminal replays the **last persisted** snapshot, which for a same-session reopen is at
  most `SNAPSHOT_IDLE_MS` (2 s) behind the moment of close — a requested kill does not force a final
  flush. A reopen after a full restart replays the quit-flushed snapshot, which is exact.
- Quitting the app does not run the per-tab close guards. A quit asks once for the whole app instead,
  and for dirty docs offers `Save all docs` / `Discard all changes`; a discarded buffer is kept as a
  draft ([app shell](../core/app-shell.md) "Quit protection"). Tab **state** is flushed to disk on
  quit.
- A requested close (×, batch, quit, workspace switch) never raises the unread counter; only
  a *natural* terminal exit does.

Tickets: T-044, T-107, T-118, T-149, T-189, T-299.
