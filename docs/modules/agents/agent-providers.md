---
doc: docs/modules/agents/agent-providers.md
audience: engineers, product
holds: how Pomade learns an agent finished its turn or asked something (the attention event) — the scanned signals, the per-provider checklist (Claude Code, Codex CLI), the template for a new provider
kind: reference
---

# Agent providers — turn-end notification integration

**Module:** `agents` · **Code:** `src/main/pty-manager.ts` (`childEnv`, `create`), the scanners in
`pomade-kit/scanners` (`AttentionScanner`, `MarkerScanner`, `AgentStateScanner`) · **e2e:**
`attention.spec.ts`, `terminals.spec.ts`

Pomade owns every PTY, so it detects that an agent finished its turn or paused for a
permission prompt (the attention event) by scanning the PTY output stream for the notification bytes agents emit. Pomade
PTYs **masquerade as Apple Terminal**: `childEnv()` sets `TERM_PROGRAM=Apple_Terminal`
(`TERM_PROGRAM_VERSION=453`) and exports `POMADE=1` so scripts and agents can still detect the real
host. Under this identity the built-in agents emit their turn-end signal with no flags, so Pomade
injects **no** flags into launch commands and **no** wrapper functions into shells. Truecolor is
unaffected (CLIs key color depth off `COLORTERM`, which passes through).

This doc is the per-provider checklist. **Adding a new agent provider is not done until it has a
filled-in section here.** Copy the template at the bottom.

## What Pomade detects (all providers)

`pty-manager.ts` runs three output scanners from `pomade-kit/scanners` over every terminal's output:
`MarkerScanner` (the shim's OSC 7879 markers → busy, cwd, exit status, agent start/exit),
`AttentionScanner` (the signals below) and, while an agent runs in the shell, `AgentStateScanner`
([agent-tabs](./agent-tabs.md)). Their recognition rules and unit matrix live in the kit; Pomade wires the events.
Pomade raises a per-terminal `pty:attention` event on any of:

- a **standalone BEL** (`0x07`) that is not an OSC terminator;
- an **OSC 9** (`ESC ] 9 ; … BEL`, iTerm2 style), **OSC 99** (kitty), or **OSC 777** (urxvt / Ghostty
  / WezTerm style) notification sequence;
- a **natural PTY exit** (the process died / the user typed `exit`) — a requested kill (tab close,
  bulk-stop, quit, workspace switch) does **not** count;
- a **long foreground command finishing**: the shim's busy→idle transition when the command ran
  ≥ 2 s — plain terminals emit no turn-end byte, so `sleep`, builds and tests would otherwise end
  silently. Instant commands never fire.

It deliberately does **not** fire on **OSC 0/1/2** window/icon **title** sequences (which also end in
BEL) nor on Pomade's own **OSC 7879** shim markers. The raw bytes still pass through to xterm.js, so
the visible terminal keeps its own unobtrusive bell.

The renderer sets the terminal's tab as unread (the red dot) unless it is the active tab of the
active project. The project's red Projects panel counter is a **live count of its unread tabs**, so it
reflects those dots — including unread tabs in the project you are in — and does not reset when you
open the project (it ticks down as you read them). See [panes-and-lifecycle](../terminal/panes-and-lifecycle.md)
"Attention".

## Evidence for the masquerade

Real CLIs, real turns, in a PTY harness (probe-verified 2026-07-24):

- **claude** under `TERM_PROGRAM=Apple_Terminal`, no flags → exactly **1 standalone BEL** at turn end.
  Under `TERM_PROGRAM=Pomade` its `auto` channel emits nothing.
- **codex** (0.145) → exactly **1 standalone BEL** at turn end while **unfocused**, with or without
  the `-c tui.notifications=true` flag and under either `TERM_PROGRAM` — its notifications are
  focus-gated (`tui.notification_condition` defaults to `unfocused`), not terminal- or flag-gated.
  Focused codex never bells, which is right: attention only matters for panes the user is not looking
  at. It needs xterm.js focus reporting (mode 1004), which codex enables and xterm.js supports.
- A manually launched agent in any Pomade terminal behaves like a button-launched one: there is no
  per-shell wrapper that a freshly opened terminal could miss.

---

## Provider: Claude Code (`kind: 'claude'`)

| Field | Value |
| --- | --- |
| Launch command (default) | `claude` |
| Turn-end signal | standalone **BEL** (`0x07`) — see timing below |
| What makes it appear | `TERM_PROGRAM=Apple_Terminal` — `preferredNotifChannel: auto` bells in Apple Terminal |
| Injected flags | none |

**Timing (probe-verified 2026-07-24).** Claude's built-in bell is its **idle notification**: it fires
a hardcoded **~60 s after the turn ends**, and only if the user has not interacted since — not at turn
end (measured: answer at +13 s, BEL at +74 s). No threshold setting exists (`messageIdleNotifThreshold`
probed inert; configurability is [claude-code#13922](https://github.com/anthropics/claude-code/issues/13922)).
Consequences: a bell means "waiting for you for a minute"; if you return to the tab within 60 s no
bell fires (no stale dots); permission prompts notify on their own (not idle-gated).

**Optional immediacy (user-level config, no Pomade involvement).** A `Stop` hook in
`~/.claude/settings.json` emits a BEL the moment a turn ends (probe-verified: BEL at answer +0 s; the
idle bell still follows at +60 s if the session stays unattended — an abandoned turn then counts
twice, which reads as "still waiting"):

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "echo '{\"terminalSequence\":\"\\u0007\"}'" }] }]
  }
}
```

**Verification steps.**
1. e2e (`e2e/attention.spec.ts`, "agent launch command carries no injected flags"): launch built-in
   `claude` (command overridden to an echo fixture) → the PTY command carries **no** `--settings` flag.
2. e2e ("manually typed claude/codex run unwrapped"): type `claude` in a Pomade terminal (a fake
   `claude` on PATH echoes its argv) → resolves as a plain `command`, argv clean.
3. e2e (`e2e/terminals.spec.ts`): a PTY child sees `TERM_PROGRAM=Apple_Terminal` + `POMADE=1`.
4. Manual: a real `claude` session in a **hidden** project → counter +1 (~60 s after turn end, or
   immediately with the Stop hook above); same after `/exit` then relaunch by typing `claude`; same in
   a freshly opened terminal.

## Provider: Codex CLI (`kind: 'codex'`)

| Field | Value |
| --- | --- |
| Launch command (default) | `codex` |
| Turn-end signal | standalone **BEL** at turn end (per `tui.notification_method: auto`) |
| What makes it appear | pane unfocused (`tui.notification_condition: unfocused`, default) — hidden/inactive panes qualify; xterm.js answers codex's focus-reporting query |
| Injected flags | none (codex ≥ 0.145; an older codex needs `-c tui.notifications=true` — put it in the `.pomade/agents.json` command if pinned to an old version) |

**Verification steps.**
1. e2e: launch built-in `codex` (echo fixture) → the PTY command carries **no** `tui.notifications`
   flag.
2. e2e: type `codex` manually (fake on PATH) → plain `command`, argv clean.
3. Manual: a real `codex` session in a hidden project → counter +1 at turn end.

---

## Template for a new provider (MANDATORY before shipping the provider)

```
## Provider: <name> (`kind: '<kind>'`)

| Field | Value |
| --- | --- |
| Launch command (default) | <command> |
| Turn-end signal | <BEL / OSC 9·99·777 / none — exit-only> |
| What makes it appear | <terminal identity, focus state, config default — the condition that triggers emission under Pomade's Apple_Terminal masquerade> |
| Injected flags | <normally "none"; if the tool CANNOT emit under the masquerade, the flags its roster command must carry> |

**Why it works.** <settings schema, defaults, which channel, probe evidence>

**Verification steps.**
1. e2e: <launch-command assertion>
2. Manual: <real session in a hidden project → counter increments at turn end>
```

Checklist for the new provider:
- [ ] Probe the real CLI under `TERM_PROGRAM=Apple_Terminal` (spawn in a PTY, run a real turn, scan
      for BEL / OSC 9·99·777; send `ESC [O` focus-out after launch — focus-gated tools suppress
      notifications while focused).
- [ ] If it emits nothing flag-free, put the enabling flags in the roster command
      (`.pomade/agents.json`) — Pomade injects no flags into launch commands.
- [ ] Confirm the attention scanner detects the emitted bytes (BEL / OSC 9·99·777); if it emits
      something else, extend the scanner and note it under "What Pomade detects".
- [ ] Fill in a section above and add e2e coverage to `e2e/attention.spec.ts`.

Tickets: E-011, P-018.
