---
doc: docs/CONTRACTS.md
audience: engineers
holds: the index of Pomade's binding shared surface — what a contract is here, the rule for changing one, and a summary of each contract sub-doc in docs/contracts/
kind: reference
---

# Pomade — Contracts

A **contract** is a surface that more than one part of Pomade relies on, so changing it on one
side breaks the other: the IPC API between renderer and main (`src/shared/ipc-api.ts`,
`src/preload/index.ts`), the cross-process types (`src/shared/types.ts` and the pure
`src/shared/<area>.ts` models), the renderer store shapes, the on-disk formats Pomade owns, the
host side of the Host API that apps call, and the test hooks e2e drives. How a feature behaves
for the user lives in `docs/modules/`; how the system fits together lives in
[ARCHITECTURE](./ARCHITECTURE.md); what apps code against lives in [HOST-API](./HOST-API.md).

**The rule: a contract changes in the same change as the code.** A change to a signature, a type,
a store action, a persisted field or a hook updates the sub-doc that states it, in the same commit.
`PomadeApi` in `ipc-api.ts` is the single source of truth for every channel's signature; these docs
add the semantics the types cannot say.

## Sub-docs

- **[types](./contracts/types.md)** — the types in `src/shared/types.ts`: `WorkspaceConfig`,
  `Group`, `Project` (`workspace.json`); `ProjectState` and `Mount` (per-project state);
  `WorkspaceUiState`; every tab kind and its persisted fields, the tab-details validator maps;
  `AppSettings` and its defaults and merge rule; file and path types (`FileNode`, `FileStat`,
  `PathProbe`, `classifyScope`); `AgentInfo`; the app-hosting and terminal payload types.
- **[ipc-app](./contracts/ipc-app.md)** — how the IPC boundary is typed and wired (`CH`, `EV`,
  `PomadeApi`, `ChannelMap`, the preload helpers, `defineHandler`, one listener per terminal event
  channel), a namespace map, and the `app` / `env` namespaces: version, OS hand-offs, settings,
  clipboard, spellcheck, every menu accelerator event, wake, and the quit pipeline.
- **[ipc-workspace-and-files](./contracts/ipc-workspace-and-files.md)** — `workspace` (the root,
  `workspace.json`, switching and its teardown hooks), `state` and `workspaceUi` (partial saves
  merged in main), and `fs`: reads and writes, collision rules for copy / move / rename, trash, the
  outside-workspace doors, the one-descriptor watchers, pickers, the frontmatter index and the
  case-folding name index behind terminal and editor links.
- **[documents](./contracts/documents.md)** — rule 8 and everything that keeps a document's text
  safe: the open-doc watcher, recovery copies and discarded drafts, local history snapshots,
  comparison sources, the Document history model, version tabs, doc channels and the
  `EditorController` each engine registers.
- **[ipc-terminal](./contracts/ipc-terminal.md)** — `pty`, `agents`, `attached`: pty creation and
  the child environment, the zsh shim markers and the events built on them (busy, cwd, exec, agent
  start/exit/state, attention), session attribution and the `resumeSessionId` writers, revive and
  scrollback snapshots, the roster, the agent-tab Host API methods, and attached terminals on an
  app keeper's sessions.
- **[git-state-and-history](./contracts/git-state-and-history.md)** — the read side of `git`:
  repo discovery and status (`GitSnapshot`, its freshness), deleted-file view and diffs, commit
  history, file history with rename following, revision reads, and `pomade-git` run summaries and
  Runner's scheduled jobs.
- **[git-operations](./contracts/git-operations.md)** — the write side: the one `preview` → `run`
  entry, every `GitOpRequest`, previews, results and failure kinds, the safety rails and the repo
  lock, conflicts, In progress and branch reads, worktrees, `git-core` and the `pomade-git` command.
- **[host-api-frames](./contracts/host-api-frames.md)** — Pomade's host side of the Host API for
  app frames: the `apps` namespace, frame identity and the capability gate, the `.pomade` rule,
  serving, discovery, installs and bundled apps, the strip and badges, app state, routes, overlays,
  app shortcuts, the workspace data methods (atomic and conditional writes, watches that settle),
  delegated calls, pickers, and git state for apps.
- **[host-api-socket](./contracts/host-api-socket.md)** — the unix socket for backends and
  commands: handshake and per-app keys, sessions, the window's half of delegated calls, with-Pomade
  and always-on backends, the app-to-app broker, app commands and the Pomade home, the PATH line,
  and platform commands.
- **[events-and-notices](./contracts/events-and-notices.md)** — the event bus (connections, sticky
  `pomade.ready`, who publishes which platform event, `agentTab.exited`), `notices.post`, the
  notices store, marks and badges, mute and coalescing, and the closed-Pomade notice queue.
- **[stores](./contracts/stores.md)** — every renderer zustand store's shape and the rules others
  rely on: per-project persistence, tab placement, close focus and guards, preview tabs, attention
  dots, cross-project moves, the PTY reaper and revive, workspace switch and project deletion.
- **[renderer](./contracts/renderer.md)** — renderer-internal contracts between modules: the pane
  host and pane registry, the tab-drag marker, overlay primitives and the clamp hook, the editor's
  context-menu and spellcheck invariants.
- **[test-hooks](./contracts/test-hooks.md)** — every environment variable and global the app
  honours for tests: storage redirects, dialog stubs, tuned intervals, test-mode window and quit
  behaviour, main and renderer globals, and how e2e triggers menu items.
