---
doc: docs/modules/agents/agent-roster.md
audience: engineers, product
holds: the agent roster — discovery, per-project visibility, launch modes, command validation and mapping, launching and in-shell detection; how it is built
kind: reference
---

# Agent roster — discovery, per-project visibility, command mapping

**Module:** `agents` · **UI:** the "+" launcher's agent entries, the `!` badge, the `Map "…"` dialog
(`agent-mapping`), the project dialog's **Visible agents** field, the document context menu's
**New agent chat** · **Code:** `src/main/agent-service.ts`, `src/main/agent-check-core.ts`,
`src/renderer/modules/terminal/TerminalActions.tsx`, `AgentMappingDialog.tsx`,
`agent-commands.ts`, `src/renderer/modules/projects-panel/ProjectModal.tsx` · **e2e:**
`app-agent-tabs-absent.spec.ts`, `project-visible-agents.spec.ts`, `agent-check-slow-shell.spec.ts`
· **unit:** `agent-check-core.unit.test.ts`, `agent-commands.unit.test.ts`

## What it does

The roster is the list of agents you can launch from the "+" menu. Its owner is the **agents app**
(`pomade-agents`): when it is installed and answers, the roster is its `roster.list` — names,
commands, providers, session folders and launch modes ([HOST-API](../../HOST-API.md) §4 "Platform
reads of app APIs"). When the app is absent, not running, slow (1.5 s) or answers badly, Pomade uses
its own scan (PLATFORM rule 7): the built-ins **Claude** and **Codex**, always, plus **one agent per
`<workspace>/Agents/<name>/` folder** that contains a `CLAUDE.md` — Pomade's convention for
specialised Claude Code instances (they run with `CLAUDE_CONFIG_DIR` pointed at their folder). The
"+" menu asks again each time it opens. Each project chooses which agents it shows; each agent's
launch command can be remapped without touching your shell config.

## Discovery

- Built-ins `claude` / `codex` are always present in the scan (`kind: 'claude'` / `'codex'`). Their
  session stores are `$CLAUDE_CONFIG_DIR` / `$CODEX_HOME` when Pomade's own environment sets them,
  else `~/.claude` / `~/.codex`.
- The `Agents/` scan skips `_shared` and any folder whose name contains `template`; a folder
  shadowing a built-in id is ignored. Folder agents are `kind: 'custom'`, run the command named after
  the folder, and use the folder as their config dir — which is what surfaces their session history
  and resume exactly like the built-in claude (see [session-history](./session-history.md)).
- **From the app's roster**, an agent's provider decides its kind (`codex` → `codex`, the id
  `claude` → `claude`, else `custom`) and its session folder (`configDir`, default the provider's).
  The overrides below apply to the app's agents too.
- **App-shipped skills** are not linked to agents by Pomade: `pomade apps install` reports where each
  one is, and the user copies or links it into an agent's `skills/` folder
  ([app hosting](../core/app-hosting.md)).
- **Per-project visibility:** `Project.visibleAgents` (`['*']` = all) filters the "+" menu, the
  document context menu's agent list and Session history. It is set in the project dialog's
  **Visible agents** field (an **All agents** checkbox plus one checkbox per roster agent, an
  `unresolved` tag on agents whose command was not found), and by apps through `project.getAgents` /
  `project.setAgents`. The Workspace project shows all agents.
- **Modes.** Every agent has launch modes: the app's, else its provider's — **Normal** (no
  arguments) and **Full autonomy** (`--dangerously-skip-permissions`; codex
  `--dangerously-bypass-approvals-and-sandbox`). An app launching an agent names a mode
  (`agentTabs.launch`, [agent-tabs](./agent-tabs.md)); the "+" menu launches Normal.

## Command validation and the mapping dialog

Every roster build checks the agents' commands in **one** `zsh -ilc` — your *interactive login*
shell, so aliases and functions count. The command words travel as the shell's arguments (never
spliced into the script) and the shell prints one line per word with `whence`'s answer; a command is
checked by its first word (`codex --full-auto` ⇒ `codex`, the same word in-shell detection matches
on). Each word ends up **found**, **not found** (the shell answered "no"), or **unknown** (the shell
was slower than the roster's wait, timed out, or never reported):

- Only **not found** marks an agent unresolved. An unresolved agent shows a **`!` badge** (tooltip
  "Command not found — click to map") in the "+" menu; clicking it opens the **Map "name"** dialog
  instead of launching. Enter the command that actually starts the agent — it is checked the same
  way, saved, and the agent launches immediately if it now resolves (saving a still-unresolved
  command is allowed, with the error toast `"<command>" still not found in your shell`).
- **Unknown** is shown as resolved: a check that could not finish never shows a false `!`.
- A roster build waits at most **1.5 s** for the shell, so a slow login shell (a busy first start)
  never holds up the "+" menu or a restored agent tab's revive. The shell keeps running in the
  background (killed after 30 s, or when the app quits — with everything its startup files started),
  and its answer serves the next roster build.
- **Found** is remembered for the app run; **not found** and **unknown** are never remembered — the
  next roster build (every "+" menu open) asks again. A remap forgets the old command's word.
- Each failed check is logged once to the main process log: the word, `not-found` or `unknown`, the
  reason (`whence` exit status, timeout, signal, or the shell's exit) and the head of its stderr.

Overrides persist to **`.pomade/agents.json`** (`{ commands: { <agentId>: <command> }, hidden:
[<agentId>] }`) — workspace-level, so they travel with the repo. `hidden` removes an agent from the
roster entirely (no UI for it; edit the file).

## Launch and in-shell detection

- Launching an agent creates a PTY at the project root (or the folder an app names) and *types* the
  roster command into the interactive shell (aliases loaded), so the tab behaves exactly like a
  manual launch. A mode's args follow the command, quoted for zsh. Resuming appends the resume args
  after any mode args: `<command> --resume <id>` (claude-style) / `<command> resume <id>` (codex).
- A document's context menu starts an agent with the file as context: **New agent chat** (with a
  selection) or **New agent chat with this file in context** (without) lists the project's visible
  agents (an unresolved one carries the `!` badge and still launches — the shell reports the missing
  command in the tab, no mapping dialog); the new agent tab is sent `Read <path>`, then the selected
  text typed unsubmitted into its input. Both are sent once the agent has produced output and after
  a 700 ms settle.
- **Session history.** The tab strip's Session history button opens the agents app's Sessions view (its tab at route
  `sessions`) when the app is installed and available; otherwise Pomade's own [Session history](./session-history.md).
- The same roster drives **in-shell detection**: a command typed into any Pomade terminal whose
  *first word* matches a roster agent's command upgrades that tab to an agent tab (and the prompt
  after its exit downgrades it back) — see [panes-and-lifecycle](../terminal/panes-and-lifecycle.md). The match reads the
  whole roster (hidden agents excepted), not the project's visible subset, and runs no command check.

## Boundaries worth knowing

- A command found once stays found for the app run; a command removed mid-run is noticed only after a
  restart or a remap (which re-checks it).
- First-word matching means a folder agent whose command is a multi-word wrapper matches manual
  launches only by its first word.
- No Pomade-side flag injection anywhere: what an agent needs to notify at turn end is covered by the
  terminal identity ([agent-providers](./agent-providers.md)); a provider that cannot emit under it puts its flags in its
  `.pomade/agents.json` command.

Tickets: E-033, E-043.
