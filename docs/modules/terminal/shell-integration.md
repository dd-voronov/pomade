---
doc: docs/modules/terminal/shell-integration.md
audience: engineers, product
holds: the zsh shim and its markers, cwd reporting, the Apple_Terminal terminal identity, the child environment (sanitizing, Pomade variables); how it is built
kind: reference
---

# Shell integration — the zsh shim, cwd reporting, and the terminal identity

**Module:** `terminal` · **UI:** none (invisible plumbing behind busy state, agent detection, link
resolution, and attention) · **Code:** `src/main/pty-manager.ts` (`ZDOT_FILES`, `childEnv`,
`create`), the marker scanner in `pomade-kit/scanners` (`pty-scanners.ts`),
`src/main/app-commands-core.ts` (`terminalEnv`) · **e2e:** `terminals.spec.ts`, `attention.spec.ts`,
`terminal-last-exec.spec.ts`, `shell-history.spec.ts`

## What it does

Every Pomade terminal is `zsh -il` started with a generated **ZDOTDIR shim** that sources your real
startup files and adds invisible lifecycle markers. The shell itself then reports — deterministically,
with no polling — when it is busy, what it is running, where it is, and how the last command ended.
On top of that, the child environment is sanitized and the terminal **masquerades as Apple
Terminal**, which is what makes agent CLIs emit their turn-end notifications without flags.

## The shim

Generated into `userData/zsh-integration/` (safe to delete — recreated on demand). Each stage
(`.zshenv`, `.zprofile`, `.zshrc`, `.zlogin`) sources your real counterpart first, so a Pomade
terminal behaves like your normal shell. `.zshrc` additionally installs hooks that print **OSC 7879**
markers (an escape sequence xterm ignores, so nothing is visible):

- `precmd` → `pomade:status;<$?>` (the exit status of the command that just ended; registered ahead
  of the prompt hook), then `pomade:prompt;<$PWD>` — a prompt was drawn, and here is the shell's cwd.
- `preexec` → `pomade:exec;<cmdline>` (capped at 500 bytes) — a command is about to run.

`.zlogin` restores your environment afterwards, so **nested shells do not inherit the shim**.

**History.** macOS `/etc/zshrc` runs between the shim's `.zprofile` and `.zshrc` and sets
`HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history` — with `ZDOTDIR` still pointing at the shim. The shim's
`.zshrc` therefore first maps that one value back to your own file
(`${POMADE_USER_ZDOTDIR}/.zsh_history`, i.e. `~/.zsh_history` unless you set `ZDOTDIR`) and only then
sources your `.zshrc`, so a `HISTFILE` your `.zshrc` sets still wins. Pomade terminals and your other
terminals share one history.

Pairing the markers gives everything downstream:

- **exec → busy**, **prompt → idle** — the per-terminal busy flag behind close confirmations.
- **exec whose first word matches the agent roster** → the tab upgrades to an agent tab; the prompt
  that follows → the agent exited and the tab downgrades ([panes-and-lifecycle](./panes-and-lifecycle.md)). The status marker
  before that prompt classifies the end: 0 or 130 (Ctrl+C) is `exit`, anything else `crash`.
- **the prompt's `$PWD` payload** → the shell's live working directory, refreshed on every `cd` — the
  first resolution base for terminal file links ([file-and-url-links](./file-and-url-links.md)) and the directory a revived
  tab reopens in.
- **exec→prompt pairs ≥ 2 s apart** → the "long command finished" attention event.
- **the exec payload itself** → the tab's **last executed command** (`TerminalTab.lastExec`), which a
  revive types back into the fresh shell unsubmitted ([panes-and-lifecycle](./panes-and-lifecycle.md)). Only a real `preexec`
  overwrites it, and the pre-typed text is never executed, so it survives reloads until you run
  something else.
- **the first prompt marker of a fresh shell** → the moment main types that restored text in
  (marker-gated, never a timer: the startup files are done and zle is about to read a line).

## Terminal identity

Children see `TERM_PROGRAM=Apple_Terminal` (`TERM_PROGRAM_VERSION=453`), `TERM=xterm-256color` and
`POMADE=1`. Under this identity Claude Code's `auto` notification channel emits a turn-end BEL and
codex bells while unfocused, so Pomade injects **no** flags and **no** wrapper functions into any
launch. Apple Terminal is the most conservative identity to claim (no exotic OSC extensions a CLI
would try to exploit); anything that needs to know it is in Pomade checks `POMADE=1`. Truecolor is
unaffected (CLIs key color depth off `COLORTERM`, which passes through). `LANG` defaults to
`en_US.UTF-8` when unset. Per-provider evidence: [agent-providers](../agents/agent-providers.md).

## Pomade variables

Every terminal's environment carries:

- `POMADE_TAB_ID` and `POMADE_PROJECT_ID` — the tab's id and its project's stable id
  (`__workspace__` for the Workspace project), set when the shell starts, so a command run inside an
  agent's session finds its tab ([agent-tabs](../agents/agent-tabs.md)). A tab moved to another project keeps the old
  project id until it is relaunched or revived.
- `PATH` with Pomade's command folder first, `POMADE_HOME` and `POMADE_WORKSPACE` — so the commands of
  hosted apps and the platform's own (`pomade-git`, `pomade`) run in any Pomade terminal
  ([app hosting](../core/app-hosting.md)).
- `POMADE_USER_ZDOTDIR` and `ZDOTDIR` — the shim's plumbing; `.zlogin` removes them from nested
  shells.

## Environment sanitization

Pomade launched from a VS Code terminal (or inside a claude session) inherits identity that must not
leak into its children — otherwise a `claude` inside a Pomade terminal mis-detects VS Code as its host
IDE, or thinks it is a nested session. Stripped: `TERM_PROGRAM`/`TERM_PROGRAM_VERSION`, `VSCODE_*`,
`CLAUDE_CODE_*`, `CLAUDECODE`, `CLAUDE_EFFORT`, `AI_AGENT`, `__CFBundleIdentifier`, `USER_ZDOTDIR`,
`COPILOT_DEBUG_NONCE`, `ELECTRON_RUN_AS_NODE`, `ELECTRON_NO_ATTACH_CONSOLE`,
`ORIGINAL_XDG_CURRENT_DESKTOP`, `CHROME_DESKTOP`, an inherited `POMADE_TAB_ID`/`POMADE_PROJECT_ID`
(Pomade run inside a Pomade terminal), and `TERM_SESSION_ID` (Pomade started from a Terminal.app tab —
under the Apple_Terminal identity `/etc/zshrc_Apple_Terminal` would hand every PTY that tab's saved
session and its per-session history file); plus VS-Code-pointing `GIT_ASKPASS`/`ZDOTDIR` and the
`GIT_EDITOR=true` a parent claude session exports (it would silently break `git commit`). **Kept
deliberately:** auth and config you exported yourself — `ANTHROPIC_*`, `CLAUDE_CONFIG_DIR`,
`CODEX_HOME`, etc.

## Boundaries worth knowing

- **zsh only.** The shim is zsh startup files; running `bash` or `fish` inside a Pomade terminal
  works but stops emitting markers — busy state, agent detection and cwd tracking freeze at their
  last known values until you return to the shimmed zsh.
- The exec payload is capped at **500 bytes**. It is not a command log: a longer command line is cut,
  and a payload that came out *exactly* at a cap is treated as possibly cut mid-word — recorded, but
  never pre-typed on a revive (running a corrupted line is the one outcome worth refusing). A
  multi-line command is recorded and not pre-typed either — a newline in a line editor submits.
- A stale shim (an older app run, or a copy you kept) keeps working: the payload-less
  `pomade:prompt` form is accepted (it does not update the cwd), a missing status marker counts as a
  plain exit, and a 160-byte exec cap is honoured (its at-cap payloads simply are not pre-typed). The
  shim is regenerated per app run, so this only affects PTYs started by an older run.

Tickets: P-018, T-024, T-025, T-044, T-086, T-115.
