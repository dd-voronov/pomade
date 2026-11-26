---
doc: docs/modules/core/notices.md
audience: engineers, product
holds: notices (notice toasts, the Notices panel, muting, coalescing, the closed-Pomade queue) and the unread dots, counters and badges on strip icons and project rows; how it is built
kind: reference
---

# Notices — unread and badges

**Module:** `core` · **UI:** notice toasts (the shared toast host), the Notices side panel ·
**Code:** `src/renderer/modules/notices/` (`notice-model.ts`, `NoticeToasts.tsx`, `NoticesPanel.tsx`,
`notice-actions.ts`, `source-name.ts`), `src/renderer/stores/notices-store.ts`,
`src/renderer/stores/marks-store.ts`, `src/renderer/modules/side-panels/builtin-panels.tsx`,
`src/renderer/modules/apps/delegated-calls.ts`, `src/main/host-api.ts` (`notices.post`),
`src/main/notice-queue.ts`, `src/main/notice-queue-core.ts` · **unit:** `notice-model.unit.test.ts`,
`marks-store.unit.test.ts`, `notice-queue-core.unit.test.ts` · **e2e:** `app-notices.spec.ts`, `notice-queue.spec.ts`, `notice-posting-project.spec.ts`, `notice-project-label.spec.ts`, `no-project-workspace.spec.ts` ·
**Contract:** [HOST-API](../../HOST-API.md) §4 `notices` · internal surface:
[contracts/events-and-notices](../../contracts/events-and-notices.md)

## Notices

A notice is a short message from Pomade or an app — a title, an optional body and what clicking it
does. It pops up as a notice toast in the bottom-right corner, in the same stack and with the same look as
Pomade's other toasts: the source (an app's name, "Pomade" for Pomade's own, else the id) and, muted beside it, the project the notice
belongs to ("Hello · Beta"; always, so a click that switches project is never a surprise), the title in bold (a long one wraps to two lines, then an ellipsis), up to two lines of body, and
a × to dismiss it (beside the bell-slash that mutes its source; both are full-size icon buttons). It
leaves after six seconds, but not while the pointer rests on it.

Clicking a notice runs its action and dismisses the notice toast:

- **Open the app's tab** at a route — exactly what the app's own `tabs.openApp` (without a `key`)
  does: the strip icon's tab for that route, else the app's plain tab, navigated to the route when the
  tab's recorded route differs. A notice never reaches a keyed tab.
- **Open a file** in an editor tab, or **a terminal** in a folder (optionally running a command) —
  only for an app that may open tabs (`tabs.open`); main refuses a notice whose action needs a
  capability the app lacks (`capability-denied`).
- **Nothing** — a notice can be just news.

The notice's project becomes active and the target opens there. A notice belongs to the project it
was posted from: an app that names a project gets that one; otherwise it is the project of the app
tab that posted it, or the project in front when a panel or an overlay posted it. A backend or a
command is in no project, so its notice — sent while Pomade runs or queued while it was closed —
belongs to the Workspace project: it reads "Runner · Workspace", and clicking it switches to the Workspace project
([PLATFORM](../../PLATFORM.md) rule 9). Clicking it
later — from the notice toast or from its row in the Notices panel — switches back to that project, whichever
one is in front by then. A notice whose project has since been removed shows no project name. When the click cannot run — the project or the app is gone — an error
toast says so.

## No storms, and muting

A burst from one source never stacks up: while a source's notice toast is on screen, each new notice from
it takes that notice toast over — it shows the newest, restarts its timer and counts the rest, "5 more
from Runner". Clicking that line opens the Notices panel, where each notice is listed on its own:
when every notice of the burst belongs to one project, Pomade switches to that project first; when
they span several, the panel opens in the project in front and each row names its own. Different
sources keep separate notice toasts.

The bell-slash on a notice toast mutes its source: its notices no longer pop up, but they are still listed
in the panel and still counted on the Notices icon — in grey while every unread notice is from a
muted source. With unread notices from both muted and unmuted sources, the badge counts them all in
its normal colour: the number is always "unread notices", the colour says whether any of them is
from a source you listen to. Unmuting a source turns its notices' count back to the normal colour. The panel's "Muted" section, under the
list, has an Unmute for each muted source. Mutes are kept across restarts in the workspace's `.pomade/settings.json` (`mutedNoticeSources`), shared by the
dev and the stable Pomade opened on it.

## The Notices panel

Every notice of this run stays in the **Notices** side panel (the bell in the icon strip, after
Files and Git), newest first (the 200 newest are kept), with its source, the project it belongs to (muted, "Hello · Beta") and how long ago it came, then the title (up to two lines, then an ellipsis) and up to three lines of body. Clicking a row runs the
notice's action again. Looking at the panel reads them all. The list starts empty at each launch.

Deleting: a row shows a × in place of its time while the pointer is on it — it deletes that notice.
Cmd-click selects or unselects a row, Shift-click selects the rows from the last one clicked to this
one (Cmd+Shift-click adds them) — selecting never runs a notice. A bar above the list counts the
selection, with a Delete button; Delete or Backspace does the same, Escape drops the selection. The
trash icon in the header deletes all. Deleting a notice whose notice toast is still up takes the toast too.

## Marks and badges

Counts and unread dots on strip icons and Projects panel rows come from one place. A **mark** is a
count, optionally urgent (red), that one **source** puts on one **target**; a target shows all its
sources added up, red if any of them is urgent.

- **Strip icons.** An app's `strip.setBadge` marks its own icon; unread notices mark the Notices
  icon (grey when they are all from muted sources); Pomade's own producer marks Git the same way (a failed git operation, or a failed scheduled
  `pomade-git` run, in that repo, until the repo is opened). The badge is the same chip on every
  icon (accent, red when urgent, grey when quiet, `99+` at most), and the icon's name read aloud includes the count.
  Counts change live: each new mark redraws the badge at once.
- **Project rows.** A project row (and its launcher on the collapsed rail) counts its tabs that
  carry the red unread dot — a terminal or agent that finished or asked something, a tab marked unread; any
  mark set on that row adds to it. The count is derived live from the tabs and falls as the dotted tabs
  are read.

## Notices while Pomade is closed

A backend or a command — Runner's keeper overnight, `pomade-git` after a failed scheduled push —
posts with `pomade-kit/node`'s `postNotice`, whether Pomade is running or not. The notice is a small
file in Pomade's user data (`notices/queue/`); Pomade shows every waiting notice at its next launch,
oldest first, each keeping the time it was posted, and while it runs shows a new one within moments
(the queue folder is watched, drains debounced 100 ms). Each file is removed once shown; a
file that is not a valid notice is renamed `.invalid` and never shown. A dev Pomade and the stable
one have separate queues, like everything else in their user data. Pomade posts no macOS system
notifications — Runner shows its own when the user is away.

Tickets: T-313.
