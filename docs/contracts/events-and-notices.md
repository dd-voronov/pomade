---
doc: docs/contracts/events-and-notices.md
audience: engineers
holds: the event bus (platform and app events, agentTab.exited, the renderer's platform events) and notices (notices.post, the notices store, marks and badges, the closed-Pomade queue, mute and coalescing), with the events and notices IPC namespaces
kind: reference
---

# Event bus and notices

App-facing contract: `docs/HOST-API.md` §1 `events`, §4 `events`, §4 `notices`. The protocol, the
name rules, the payload checks and the bus core (`EventBus`: members, subscriptions, delivery that
skips the publishing connection, the sticky event, `events.subscribersChanged` to the publisher on a
0↔1 flip) come from `pomade-kit/protocol`. The manifest's `events` lists are the gate
(`METHOD_CAPABILITY['events.*'] = null`).

## The bus (`main/event-bus.ts`)

- One `EventBus` for the app. `openBusConnection(conn: { appId, deliver(name, payload) },
  subscriptions?)` is the seam for every transport: each frame session and each socket session
  opens one (a frame with `project.changed` and `theme.changed` subscribed) and closes it with the
  session.
- `callEvents(member, manifest.events, method, params, deliverAfter)` serves `events.publish` /
  `subscribe` / `unsubscribe` / `hasSubscribers` for any connection; a sticky event is delivered
  after the call's answer (`setImmediate`). Payloads: JSON ≤ 64 KiB.
- `publishPlatformEvent(name, payload)` — `pomade.ready` is sticky (cleared on workspace teardown);
  everything else plain. `publishPlatformEventTo(appId, name, payload)` — one app's subscribers only.
- Frame delivery: `apps:event` (`AppBusEvent { frameId, name, payload }`) to the frame's
  webContents (a destroyed window is skipped). `project.changed` reaches a frame only when it
  differs from the project the session last saw (seeded from `AppFrameRequest.project`).
- Test hook: `POMADE_TEST_EVENT_LOG` ([test-hooks](./test-hooks.md)).

## `events` IPC

```ts
events.platform(name: string, payload: unknown, to?: string): Promise<void>
```

A platform event the renderer owns, for main's bus; a name that is not a platform event is ignored.
`to` = one app id (only its subscribers get it).

## Who publishes what

- **Renderer** (`modules/apps/platform-events.ts`, `startPlatformEvents()` mounted once): per
  workspace load a new baseline. `project.created` / `project.renamed { project, previous }` (name
  or root change) / `project.removed` (with the ref as it was, first); `project.changed` on every
  change of the active `ProjectRef`; `project.opened` on a scope's first activation once ready;
  `pomade.ready` once the Workspace project and every project are hydrated, then `project.opened` for
  the active scope; `project.updated` — `{ changes: ['group' | 'agents'] }` to everyone,
  `{ changes: ['settings'] }` only to the app whose `appSettings` entry changed.
  `agentTab.changed` (`modules/agents/agent-tabs.ts`) for every change of the agent-tab set, a
  session, title, state or project; a session change carries `session: { cause, previousSessionId }`
  ([ipc-terminal](./ipc-terminal.md) "Agent tabs on the Host API").
- **Main** — `agentTab.exited { tabId, projectId, agentId, sessionId, reason }`, once per agent
  run and only for a term with a known tab (`pty.setTab`): the agent hands the shell back → `exit`
  for status 0, 130 or unknown, else `crash` (the shim prints `pomade:status;$?` first in precmd);
  the pty exits with the agent running → `crash`; `kill` of a live term → `tab-closed` (before the
  kill); `killAll` (quit, workspace switch) → `quit`. `sessionId` = the session the term owns, else
  null. `theme.changed` from `setPomadeTheme`. `attachedTab.action` to the owning app only
  ([ipc-terminal](./ipc-terminal.md)).
- `stores/pty-tab-refs.ts#startPtyTabRefs` reports each term's tab when it appears and when it moves
  project — never on close (the reaper's kill still needs the tab).

## `notices.post`

Main runs the kit's `checkNotice` (title one line ≤ 200; body ≤ 2000; action paths by the
workspace-path rule) and the action's capability (`tabs.open` for `openFile` / `openTerminal`, none
for `openApp`), then delegates `{ method: 'notices.post', params, appId }`. The renderer posts it to
the notices store with `source = appId` and a posting project: a tab frame's own project, the
active project for a panel or overlay, the Workspace project for a socket client or the queue.
`withPostingProject` fills an absent `action.projectId`, so every stored notice carries a project.

## Notices store (`stores/notices-store.ts`, runtime only)

```ts
interface Notice { id; source; title; body?; action?: NoticeAction; projectId; postedAt; read }
interface NoticeToast { id; source; noticeId; more: number; projects: string[]; seq: number }
// actions: post(NoticeInput) → Notice · dismissToast · markRead · markAllRead · remove(ids) · clear · mute(source)
```

- `NOTICES_MAX` 200 (oldest dropped), `NOTICE_TOAST_MS` 6000 (never leaves while hovered).
- `runNoticeAction(notice)` serves the action as the Host API call it names (`tabs.openFile`,
  `tabs.openTerminal`, `tabs.openApp` with `appId = notice.source`); a failure is an error toast.
- **Mute and coalescing.** `AppSettings.mutedNoticeSources`: a muted source gets no notice toast and its
  unread notices count only as a quiet mark; while a source's notice toast is up, a new notice from it takes
  the notice toast over (`more += 1`, timer restarted). Pure model in `modules/notices/notice-model.ts`.

## Marks and badges (`stores/marks-store.ts`, runtime only)

```ts
interface Mark { count: number; urgent: boolean; quiet?: boolean }
// marks: target → source → Mark;  setMark(target, source, mark | null) (count ≤ 0 removes) · clearSource(source)
```

- Targets: `strip:<stripKey>` (`files`, `git`, `notices`, `app:<appId>/<iconId>`),
  `row:project:<id>`, `row:repo:<root>`.
- Sources: `app:<appId>` (`strip.setBadge`), `notices` / `notices-muted` (unread notices of unmuted /
  muted sources on `strip:notices`), `git:<root>` (a failed git operation), `git-run:<root>` (an
  unseen failed `pomade-git` run) — the last two on `strip:git` and `row:repo:<root>`.
- `combinedMark`: counts summed, urgent if any, quiet only if all. A project row's count =
  its dotted (`attention`) tabs plus any marks on `row:project:<id>` (`useProjectRowCounts`).

## The closed-Pomade queue

```ts
notices.attach(): Promise<QueuedNotice[]>      // start serving: what was queued so far, drained, in posting order
notices.onQueued(cb: (n: QueuedNotice[]) => void): () => void   // EV 'notices:queued', later drains
type QueuedNotice = NoticeParams & { source: string; postedAt: number }
```

- Folder `<userData>/notices/queue/`. Posters (`pomade-kit/node` `postNotice` / `queueNotice`) write a
  dot-file and rename it to `<zero-padded epoch ms><nonce>.json`, so name order is posting order.
  `postNotice` delivers over the socket while Pomade runs and queues otherwise
  (`{ delivered: 'pomade' | 'queue', path }`).
- Main `notice-queue.ts`: `attach` creates and watches the folder, drains debounced 100 ms and
  serialized: a valid file is read and deleted, an invalid one renamed `<name>.invalid`.
- The renderer (`startNoticeQueue()`) posts each with its `source` and `postedAt`, project =
  the Workspace project. A queued `openApp` targets the source app.

Tickets: E-031, E-032, E-028, T-151.
