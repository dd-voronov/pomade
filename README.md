# Pomade

**P**roject **M**anagement + **A**gentic **D**evelopment **E**nvironment — a personal macOS desktop app for running AI agents (Claude Code, Codex, and your specialized instances) across many projects in one workspace.

## Run it

```bash
npm install        # first time (rebuilds node-pty for Electron)
npm run dev        # development with HMR
npm start          # production build + run
npm run dist:mac   # package a .dmg (unsigned, personal use)
```

First launch asks for your workspace folder. It's remembered afterwards.

## What it does

- **Projects & groups** in the Projects panel; the workspace root is always available as the Workspace project. Deleting a project/group only removes Pomade config — files are never touched.
- **Project switching** hides (never closes) the current project's tabs — terminals and agent sessions keep running while invisible. Open tabs are remembered across app restarts; terminals restore as dead panes with Relaunch/Resume.
- **File tree** re-roots to the active project's folder; create files/folders, live refresh.
- **Editor**: raw (CodeMirror) + rendered-editable markdown (Milkdown), CSV table view. A file the rich view can't parse opens raw (frontmatter is preserved verbatim either way).
- **Terminals & agents**: "+" opens a terminal or any agent visible to the project (roster = `claude`, `codex`, plus every folder in `<workspace>/Agents/` with a `CLAUDE.md`; unresolved commands get a mapping dialog). Session history per project with `--resume`.
- **Git**: status letters in the file tree and counts on project rows; a Git panel with every repo's state, uncommitted changes and history; a comparison tab where any change can be taken back; Cmd+Shift+G for a quick diff of the focused doc; Document history (Cmd+Shift+H) lists every version of a doc — unsaved, discarded, uncommitted and committed — to compare and restore. Pomade runs no git on a timer.
- **Disk is truth**: a file changed on disk under unsaved edits is never overwritten silently; unsaved edits survive a crash.
- **Apps**: Pomade is a platform — separately built apps open as tabs, side panels and overlays, may run a background process and ship commands, and talk to Pomade only through the Host API. Install with `bin/pomade apps install <path>`; Pomade works with zero apps installed.

State lives in `<workspace>/.pomade/` (`workspace.json` + `agents.json` are git-synced; `state/` is machine-local and gitignored).

## Docs

- `docs/PLATFORM.md` — platform vs apps, the rules, the registry of shared building blocks
- `docs/HOST-API.md` — the contract apps code against
- `docs/ARCHITECTURE.md` — stack, process model, data model, design tokens
- `docs/CONTRACTS.md` — IPC surface, types, stores, test hooks
- `docs/user-guide/` — how to use Pomade, with shortcuts
- `docs/modules/` — how each feature works
