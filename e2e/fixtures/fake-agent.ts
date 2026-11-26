// Pomade e2e — the shared fake-agent stand-in (T-161).
//
// A test agent is just an executable the launcher spawns in a pty; the stand-in below IS the
// agent-behavior contract the agent specs assert against. Before this module the zsh script was
// copy-pasted into 13 spec files in two drifting generations (an echo-only one and the E-025
// store-writing resume one), and `seedFakeAgent` was re-implemented nine times.
//
// The scripts are exported as named constants so a spec picks the exact behavior it exercises;
// `seedFakeAgent`/`seedFakeAgentScript` put a chosen script on disk (and, for the former, map the
// fixture's `claude-test` folder agent onto it via `.pomade/agents.json`). The default script is
// the echo-only stand-in — the most common shape. All scripts run `#!/bin/zsh`, so a spec that
// seeds one is a real-terminal spawner and belongs in the heavy partition (playwright.config.ts).

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/** Echo-only: announces readiness, echoes every submitted line. No `/exit` handling. */
export const FAKE_AGENT_ECHO = `#!/bin/zsh
echo AGENT_READY
while IFS= read -r line; do
  echo "AGENT_GOT: $line"
done
`

/** Echo-only that also exits on `/exit` (silently). */
export const FAKE_AGENT_ECHO_EXIT = `#!/bin/zsh
echo AGENT_READY
while IFS= read -r line; do
  echo "AGENT_GOT: $line"
  if [[ "$line" == "/exit" ]]; then exit 0; fi
done
`

/** Echo-only that announces `AGENT_EXITING` before exiting on `/exit`. */
export const FAKE_AGENT_ECHO_EXIT_ANNOUNCE = `#!/bin/zsh
echo AGENT_READY
while IFS= read -r line; do
  echo "AGENT_GOT: $line"
  if [[ "$line" == "/exit" ]]; then
    echo AGENT_EXITING
    exit 0
  fi
done
`

/** E-025 harness (the "v2" generation). Announces readiness and echoes lines; `--resume <id>`
 *  APPENDS a real line to `<id>.jsonl` in the isolated store (keyed by the CLI's own $PWD, exactly
 *  like claude) and emits an output BURST — so a concurrent same-cwd revive makes BOTH transcripts
 *  grow across the same poll ticks (the T-127 recency killer). The store root comes from
 *  `FAKE_AGENT_STORE` (per app launch); without it the resume write is skipped and only the echo
 *  remains. On `/exit` it prints the resume hint the session-capture flow looks for. */
export const FAKE_AGENT_RESUME = `#!/bin/zsh
current=""
if [[ "$1" == "--resume" && -n "$2" ]]; then
  current="$2"
  if [[ -n "$FAKE_AGENT_STORE" ]]; then
    dir="$FAKE_AGENT_STORE/projects/\${\${PWD:A}//[^a-zA-Z0-9]/-}"
    mkdir -p "$dir"
    print -r -- "{\\"type\\":\\"user\\",\\"message\\":{\\"role\\":\\"user\\",\\"content\\":\\"resumed\\"},\\"timestamp\\":\\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\\"}" >> "$dir/$2.jsonl"
  fi
  echo "RESUMED $2"
  for i in {1..30}; do echo "resume burst $i"; done
fi
echo AGENT_READY
while IFS= read -r line; do
  if [[ "$line" == "/exit" ]]; then
    echo "To resume this session, run: claude --resume \${current:-unknown}"
    exit 0
  fi
  echo "AGENT_GOT: $line"
done
`

/** Resume-AWARE but store-silent: reads `--resume <id>` but writes no transcript; exits on
 *  `/exit` (checked BEFORE the echo, so `/exit` is not echoed). */
export const FAKE_AGENT_RESUME_SIMPLE = `#!/bin/zsh
current=""
if [[ "$1" == "--resume" && -n "$2" ]]; then
  current="$2"
fi
echo AGENT_READY
while IFS= read -r line; do
  if [[ "$line" == "/exit" ]]; then exit 0; fi
  echo "AGENT_GOT: $line"
done
`

/** Turns on mouse tracking on startup, then echoes; a `/exit`-containing line announces
 *  `AGENT_EXITING` and exits (checked before the echo). */
export const FAKE_AGENT_MOUSE = `#!/bin/zsh
builtin printf '\\033[?1004h\\033[?1003h\\033[?1006h'
echo AGENT_READY
while IFS= read -r line; do
  if [[ "$line" == *"/exit"* ]]; then
    echo AGENT_EXITING
    exit 0
  fi
  echo "AGENT_GOT: $line"
done
`

/** A TUI agent: enters the alternate screen, paints a frame, queries the terminal, leaves the
 *  alt screen, then behaves like the mouse agent; `/exit` re-arms mouse tracking, announces, and
 *  prints a resume hint before exiting. */
export const FAKE_AGENT_TUI = `#!/bin/zsh
builtin printf '\\033[?1004h\\033[?1003h\\033[?1006h'
builtin printf '\\033[?1049h'
echo AGENT_TUI_FRAME
builtin printf '\\033[6n'
builtin printf '\\033[c'
builtin printf '\\033[?1049l'
echo AGENT_READY
while IFS= read -r line; do
  if [[ "$line" == *"/exit"* ]]; then
    builtin printf '\\033[?1004h\\033[?1003h\\033[?1006h'
    echo AGENT_EXITING
    echo "To resume this session, run: claude --resume abc"
    exit 0
  fi
  echo "AGENT_GOT: $line"
done
`

/** Prints its argv then `cat`s stdin — used to assert exactly what argv the launcher passed. */
export const FAKE_AGENT_ECHO_ARGV = `#!/bin/zsh
echo "ARGV: $@"
cat
`

/** Prints its argv and exits immediately (a non-interactive "wrapper" stand-in). */
export const FAKE_AGENT_WRAP_ECHO = `#!/bin/zsh
echo "WRAP: $@"
`

/** The workspace subset a seeder needs. `Fixture` satisfies it structurally. */
interface SeedTarget {
  workspaceRoot: string
}

export interface SeedFakeAgentOpts {
  /** Which stand-in to put on disk (default `FAKE_AGENT_ECHO`). */
  script?: string
  /** The script's filename under the workspace root (default `fake-agent.sh`). */
  name?: string
  /** The folder-agent id to map onto the script in `.pomade/agents.json` (default `claude-test`). */
  agentId?: string
}

/** Write a stand-in under the workspace root AND map a folder agent onto it (so the roster
 *  resolves it and the launcher can start it). Returns the absolute script path. */
export async function seedFakeAgent(
  fixture: SeedTarget,
  opts: SeedFakeAgentOpts = {}
): Promise<string> {
  const { script = FAKE_AGENT_ECHO, name = 'fake-agent.sh', agentId = 'claude-test' } = opts
  const scriptPath = join(fixture.workspaceRoot, name)
  await fs.writeFile(scriptPath, script, { mode: 0o755 })
  await fs.chmod(scriptPath, 0o755)
  await fs.writeFile(
    join(fixture.workspaceRoot, '.pomade', 'agents.json'),
    JSON.stringify({ commands: { [agentId]: scriptPath }, hidden: [] }, null, 2)
  )
  return scriptPath
}

/** Write a stand-in script under `root` WITHOUT touching `.pomade/agents.json` (for specs that map
 *  the agent themselves, or key it by directory). Returns the absolute script path. */
export async function seedFakeAgentScript(
  root: string,
  opts: { script?: string; name?: string } = {}
): Promise<string> {
  const { script = FAKE_AGENT_ECHO, name = 'fake-agent.sh' } = opts
  const scriptPath = join(root, name)
  await fs.writeFile(scriptPath, script, { mode: 0o755 })
  await fs.chmod(scriptPath, 0o755)
  return scriptPath
}
