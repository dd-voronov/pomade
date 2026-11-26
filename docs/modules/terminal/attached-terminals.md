---
doc: docs/modules/terminal/attached-terminals.md
audience: engineers, product
holds: attached terminal tabs — sessions an app's keeper holds, shown in a Pomade tab; the pane, input rule, snapshots, reconnects, header actions; how it is built
kind: reference
---

# Attached terminals — tabs on sessions an app owns

**Module:** `terminal` · **UI:** the attached pane (`attached-<tabId>`: header + xterm), its tab
("Coda web · Runner") · **Code:** `src/main/attached-terminals.ts`,
`src/renderer/modules/terminal/AttachedTerminalPane.tsx`, `useAttachedXterm.ts`, `attached-status.ts`,
`open-attached.ts`; the keeper and the protocol in `pomade-kit` (`pomade-kit/keeper`,
`pomade-kit/protocol` attach.ts, `pomade-kit/node` keeper.ts) · **e2e:** `attached-terminals.spec.ts`

## What it does

An app that runs things without Pomade — Runner's services and jobs — keeps their terminals in a
**keeper**: a small process that holds the PTYs and keeps running when Pomade quits. A Pomade tab
can **attach** to any of those sessions: it shows the earlier output and the live output, takes
typing, pastes and resizes, and closing the tab only detaches. Quit Pomade, reopen it, and the tab
comes back attached, with what the session printed meanwhile.

There is one attached tab per session per project: opening the same reference again focuses the open
tab (and applies a new title, which marks the tab `renamed`); the new tab opens right of the active
tab.

Example: Runner runs `npm run dev` for Coda as a service. Its "Running now" list calls
`tabs.openAttached({ session: { app: "pomade-runner", session: "svc:coda-web" } })`; a tab "Coda web ·
Runner" opens, showing the dev server's log and taking Ctrl+C.

## Who runs what

- **The keeper** is `pomade-kit/keeper` — a library, not Pomade code. The owning app's **always-on
  backend** (a login item, [app-backends](../core/app-backends.md)) starts it as its own detached process
  (`startKeeper`), on Pomade's Electron binary in Node mode. The backend may restart or update; the
  keeper and its sessions do not notice.
- **The socket** is fixed per app: `<userData>/run/keepers/<appId>.sock` (folder 0700). Pomade gives
  every backend the path as `POMADE_KEEPER_SOCKET` (also in an always-on backend's launchd plist) and
  creates the folder. A path longer than macOS allows (103 bytes) is refused by the keeper with a
  message that says so.
- **Pomade** is a client. Main follows each attached tab's session (`followSession`) straight at that
  socket — a **session reference** `{ app, session }` is all it needs; the owner is never called to
  attach ([PLATFORM](../../PLATFORM.md) rule 4). Any app can open a tab on another app's session.

## The pane

- **Header** (the editor header's look): the title, the owner's name after a dot ("Ticker · Demo
  Runner" — the app's manifest name, its id when it is not installed), a status chip, and on the
  right the header actions the owner contributed (Restart) and **Stop**.
- **Status chip:** `Attaching…` / `Reconnecting…` (a keeper update) · `Running` (green dot) ·
  `Exited` · `Crashed · code 3` · `Stopped` (by the owner) · `Stopped by you` · `Stopped · time
  limit` · `Lost · keeper crashed` · `Keeper not running` (the owner's background part is down;
  retried) · `Session not found` (retried — the tab attaches when the owner starts that id again) ·
  `Refused`. Its tooltip explains it. When nothing could be shown yet (keeper down, session gone),
  the body shows the same words as a centred notice.
- **Terminal:** the same xterm as a PTY tab — the user's font, Unicode 11 widths, Cmd+click file and
  URL links (resolved against the session's folder, then the project and the workspace),
  copy-on-select, Cmd+C, the right-click menu (Copy · Paste to input · Select all · Clear). An ended
  session's screen stays, read-only.
- **Title:** the session's own title from the keeper, kept in step with it — unless the caller of
  `openAttached` gave one or the user renamed the tab (`renamed`).
- **Attention:** a bell or an OSC 9/99/777 notification in the live output (the kit's
  `AttentionScanner`, as for a PTY), and an end nobody asked for (`exited`, `crashed`, `time-limit`,
  `lost-in-keeper-crash`) put the red dot on a tab that is not active. A stop — from this tab or the
  owner — does not. Typing or pasting into the tab clears it.
- **Closing** an attached tab detaches without asking: nothing ends.
- **Stop** is shown while the session runs and reads `Stopping…` until it ends; **Paste to input** in
  the right-click menu is disabled unless the session is running.

## Input: the keeper answers, the tab never does

Programs ask their terminal questions in-band ("where is the cursor?" `ESC[6n` → `ESC[2;60R`). The
keeper's headless terminal sees every byte and answers them; the tab's xterm sees the same output
and would answer too — on xterm's `onData`, indistinguishable from typing — so the program would get
every answer twice. The pane therefore forwards only what the user did:
xterm data events flagged as user input (keys, mouse reports, wheel, IME), focus reports (the
program asked for them, and only the tab knows focus) and binary mouse reports; pastes go as
`paste`, which the keeper brackets according to the program's current mode. The hook is xterm's core
data path (private API, pinned with the xterm version; without it the pane falls back to keystrokes
only — never to the answers).

Order holds too: a key or paste reaches the program only after the keeper's headless terminal has
parsed everything the program printed before it, so the keeper's answers to earlier questions always
come first — a key typed the instant the questions show never jumps ahead of them.

A snapshot never asks anything either: it is the keeper's screen serialized (scrollback up to 1000
lines, the normal or alternate screen, colours, cursor, modes, scroll region, mouse encoding, cursor
visibility), not a replay of recorded bytes. The pane empties its terminal and draws it.

## Size

The tab attaches with its own size and resizes the session whenever its pane changes size or
becomes visible: the last active client wins. When another client resizes the session, the tab's
terminal takes that size until it is shown or resized again.

## Restore, reconnects, updates

- An attached tab persists only `{ session, title, renamed?, color?, attention? }`. After a restart
  its pane attaches again and gets a fresh snapshot — the output from while Pomade was closed included.
- When the keeper connection ends — a keeper **update** (`keeper-restarting`), a restart, a crash —
  main reconnects with back-off and attaches with what the tab saw (`since`): the missed output
  arrives as a `delta` and is written on top; when the keeper no longer holds it, a fresh snapshot.
- A keeper update hands the PTYs to the new keeper process (fd hand-off): sessions, screens and pids
  survive; the tab shows `Reconnecting…` for tens of milliseconds.
- A keeper crash ends its sessions (the kernel hangs up their PTYs); the restarted keeper reports
  them `Lost · keeper crashed`.

## Header actions

The owner sets header actions per session when it spawns it (`actions: [{ id, title }]`, at most
four) and may change them. A click publishes the platform event `attachedTab.action`
`{ session, action, projectId }` on the event bus — **to the owning app only** — which subscribes in
its manifest (`events.subscribe`). The owner acts through its own keeper connection (Restart = stop,
then spawn the same id: the attached tab follows the new session). Nothing goes over the keeper
socket from Pomade but attach traffic.

## Boundaries worth knowing

- **Stop** from the tab ends the session as `stopped-by-you` (SIGTERM, SIGKILL after 3 s). So does
  Ctrl+C typed through the tab when the program exits within 5 s.
- The owner's keeper and backend are the owner's: Pomade starts neither for an attached tab. A tab on
  an app whose keeper is down waits (`Keeper not running`) and attaches when it comes back.
- A keeper that crashed leaves its sessions `Lost · keeper crashed`; the next keeper the owner starts
  kills what those sessions left running, when it can prove the processes are theirs (their start
  time falls in the window recorded at spawn). One keeper runs per state folder. The owner can watch
  session `info` and `exit` without the output stream (`watch`, owner-only) — see the kit README.
- A tab attaches while its pane is mounted — when its project's tabs are loaded.
- X10-encoded mouse reports (the default encoding, used by few programs) past column 95 are sent as
  UTF-8 text, not raw bytes.
- On macOS the PTY's own output processing occasionally doubles a CR under a flood (`\r\r\n`); those
  bytes are the terminal's, and they reach every client alike.

Tickets: E-034.
