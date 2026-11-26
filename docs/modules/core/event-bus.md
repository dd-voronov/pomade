---
doc: docs/modules/core/event-bus.md
audience: engineers, product
holds: the event bus — platform events, app events, subscription-aware publishing, connections; how it is built
kind: reference
---

# Event bus — platform events and app events

**Module:** `core` · **UI:** none · **Code:** `src/main/event-bus.ts`, `src/main/host-api.ts` (frame
and socket connections), `src/main/pty-manager.ts` (`agentTab.exited`), `src/main/theme.ts` (`theme.changed`),
`src/main/attached-terminals.ts` (`attachedTab.action`), `src/renderer/modules/apps/platform-events.ts`,
`src/renderer/modules/agents/agent-tabs.ts` (`agentTab.changed`), `src/renderer/stores/pty-tab-refs.ts`; the bus core is `EventBus` in `pomade-kit/protocol` ·
**unit:** `src/renderer/modules/apps/platform-events.unit.test.ts` (`projectEvents`, `projectUpdates`), `src/shared/app-manifest.unit.test.ts`;
the kit's `bus.test.ts`, `events.test.ts` · **e2e:** `app-event-bus.spec.ts`, `app-agent-tab-exited.spec.ts`, `app-kit-hello.spec.ts` (hello's live group and agents lines) ·
**Contract:** [HOST-API](../../HOST-API.md) §1 `events`, §4 `events` · internal surface:
[contracts/events-and-notices](../../contracts/events-and-notices.md) "The bus"

## What it does

Apps react to what happens in Pomade and in other apps without calling each other. Pomade
publishes **platform events**; an app publishes **its own events**, declared in its manifest; any
app subscribes to either, also declared in its manifest. A publisher never learns who listens — it
can only ask whether anyone does — so an event is not a dependency between two apps (PLATFORM rule
4): Runner publishes "run finished", Agents subscribes, and neither calls the other.

## Platform events

| Event | Fires when |
|---|---|
| `pomade.ready` | the workspace's tabs are restored — at launch and after a workspace switch. It stays "raised" until the workspace closes: a frame that subscribes later (a panel loaded after launch, a reloaded tab) gets it at once |
| `project.created` | a project is added (the New project dialog, starting a project from a folder) |
| `project.renamed` | a project's name or folder changes; the payload carries the project before and after |
| `project.removed` | a project is removed from the workspace (the Projects panel's Delete). The payload is the project as it was; its id is never used again, so an app drops what it keeps for it. When it was the active project, `project.changed` to the Workspace project follows |
| `project.opened` | a project — or the Workspace project — becomes active for the first time since the workspace loaded. The project active at launch counts as opened right after `pomade.ready` |
| `project.changed` | the active project changes, the Workspace project included, or the active project is renamed or moved. Every app frame gets it without subscribing; a frame never gets the project it already has |
| `project.updated` | a project moves to another group (or its group is renamed or moved), its visible agents change, or an app's settings for it change. The payload is the project as it is now and what changed (`group`, `agents`, `settings`). A settings change reaches only the app the settings belong to, so an app hears its own writes and never another app's |
| `agentTab.exited` | an agent process in a Pomade tab ends, whatever ended it |
| `agentTab.changed` | an agent tab joins or leaves the list, or its session, title, state or project changes; events start once the workspace's tabs are restored ([agent tabs](../agents/agent-tabs.md)) |
| `attachedTab.action` | a person clicks a header action an app contributed on an attached tab; delivered only to the app that owns the session ([attached terminals](../terminal/attached-terminals.md)) |
| `theme.changed` | Pomade's theme changes (`src/main/theme.ts`). Every app frame gets it without subscribing; its `welcome` carries the theme (a socket client's too, and it hears the change when it subscribes) |

**`agentTab.exited`** names the tab, its project, the agent, the session bound to the tab at that
moment (or none) and why it ended:

- **exit** — the agent quit by itself (`/exit`, status 0) or was interrupted with Ctrl+C.
- **crash** — the agent ended with any other status, or the tab's shell died under it.
- **tab-closed** — the tab was closed: ×, Cmd+W, a close-others / close-to-the-right, a project's
  removal.
- **quit** — Pomade quit or switched workspace. It is reported before the windows close.

"Exit all agents" sends each agent `/exit`, so each reports **exit**; one that does not quit in time
is closed with its tab and reports **tab-closed**. The attention dot ignores a requested close —
nobody needs to look at a tab they closed — but this event does not: every end counts. After the
agent hands its shell back, the tab is a plain terminal; an agent started in it later reports its
own end.

Two sides publish: the renderer reports what it owns (ready, project created / renamed / removed /
opened / changed / updated) over `events.platform`, to one app when the event is for one app
(`project.updated` for settings), and main publishes `agentTab.exited`, `theme.changed` and
`attachedTab.action` itself. Under test, `POMADE_TEST_EVENT_LOG` names a file every platform event
is appended to as a JSON line — the only witness of an event published while Pomade quits.

## App events

An app declares what it publishes (`"publish": ["run.finished"]`) and what it listens to
(`"subscribe": ["pomade.ready", "pomade-agents:session.closed"]`). Other apps see its events as
`<appId>:<event>`. A published event reaches every subscribed connection of every app — tab, panel, overlay and
launch-panel frames, hidden or not, and backends — except the one that published it. An
app may subscribe to its own events (`"subscribe": ["pomade-agents:session.closed"]` in
`pomade-agents`): its backend publishes, its frames hear it. An
undeclared name is refused (`capability-denied`), so the install summary's "Events:" line is the
complete list of what an app publishes and hears.

## Subscription-aware publishing

Some events are expensive to produce (Agents computing a session's "turn finished"). The publisher
asks `events.hasSubscribers` before doing the work, and every connection of the publishing app (frames and its backend) is told
(`events.subscribersChanged`) when one of its events gains its first subscriber or loses its last —
so it can start or stop producing without polling.

## Lifetime

Subscriptions belong to a frame's handshake: a reload, an app update or a closed tab ends them, and
the frame subscribes again when it loads. Events are not stored or replayed — an app that was not
running when something happened reads the current state instead — except `pomade.ready`, which is
a state ("the tabs are restored") rather than a moment.

## Connections and transports

A subscriber or publisher on the bus is a **connection**: an app frame, or the socket client of an
app's backend or command ([app backends](./app-backends.md)). Each frame session opens one
connection for its handshake (subscribed to `project.changed` and `theme.changed` from the start)
and closes it with the session; a socket session opens one with no initial subscriptions, so a
backend hears only what it subscribes to (declared in its manifest), `project.changed` included, and
its connection ends with its socket. Every transport joins the bus by opening its own connections
the same way (`openBusConnection`) and serving the `events.*` methods through `callEvents`; the bus
itself does not change. Pomade's own main process joins the same way when it listens to an app's
event (the Git panel listens to `pomade-runner:jobs.changed` and `pomade-runner:runs.changed`, and
asks Runner again for each repo row's scheduled jobs when either arrives).
