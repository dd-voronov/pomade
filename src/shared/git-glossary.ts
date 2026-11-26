// Pomade — E-039: the one glossary for every git term the UI shows. A term in the UI is a
// `<GitTerm>` (renderer/modules/git/GitTerm.tsx) whose hover is the term's line plus an example,
// both read from here — no other place words a git term. Pure: no I/O, no React.

export type GlossaryTerm =
  | 'repository'
  | 'commit'
  | 'uncommitted'
  | 'push'
  | 'pull'
  | 'fetch'
  | 'remote'
  | 'upstream'
  | 'branch'
  | 'merge'
  | 'rebase'
  | 'revert'
  | 'undo-commit'
  | 'discard'
  | 'stage'
  | 'worktree'
  | 'local-only'
  | 'conflict'
  | 'publish'
  | 'abort'
  | 'squash'
  | 'in-progress'

export interface GlossaryEntry {
  /** One line: what it is, in plain words. */
  line: string
  /** A concrete example, starting with "e.g." */
  example: string
}

export const GIT_GLOSSARY: Readonly<Record<GlossaryTerm, GlossaryEntry>> = {
  repository: {
    line: 'A folder whose every saved version git keeps.',
    example: 'e.g. Projects/Pomade — its whole history lives in its .git folder.'
  },
  commit: {
    line: 'A saved snapshot of the files, with a message saying what changed.',
    example: 'e.g. “Fix the login typo” — 2 files, by you, today 14:03.'
  },
  uncommitted: {
    line: 'Changes on disk that no commit holds yet.',
    example: 'e.g. you edited BACKLOG.md after the last commit: it shows M here.'
  },
  push: {
    line: 'Send your commits to the remote, so they exist beyond this Mac.',
    example: 'e.g. ↑2 means two commits are only here until you push.'
  },
  pull: {
    line: 'Get the commits others pushed to the remote and add them here.',
    example: 'e.g. an agent pushed from another clone — pulling brings its commit here.'
  },
  fetch: {
    line: 'Look at the remote and note what it has, without changing your files.',
    example: 'e.g. after a fetch, ↓3 says the remote has three commits you don’t.'
  },
  remote: {
    line: 'The copy of the repository on a server, usually GitHub or GitLab.',
    example: 'e.g. github.com/dd-voronov/pomade, named origin.'
  },
  upstream: {
    line: 'The branch on the remote that this branch sends its commits to.',
    example: 'e.g. origin/main — your main pushes there.'
  },
  branch: {
    line: 'A named line of commits; work happens on one at a time.',
    example: 'e.g. main, or agent/t-197 for an agent’s work in progress.'
  },
  merge: {
    line: 'Join another branch’s commits into this one, as one commit with two parents.',
    example: 'e.g. “Merge T-197” brings the agent’s two commits into main.'
  },
  rebase: {
    line: 'Replay your commits on top of newer ones, as if you had started later.',
    example: 'e.g. their 2 commits land first, then your 1 commit goes on top.'
  },
  revert: {
    line: 'A new commit that cancels an earlier one; history is kept, nothing is rewritten.',
    example: 'e.g. “Revert ‘Fix typo’” puts the typo back, and both commits stay in History.'
  },
  'undo-commit': {
    line: 'Take back the last commit: unpushed, it goes away; pushed, a revert cancels it.',
    example: 'e.g. you committed too early — its changes come back as uncommitted.'
  },
  discard: {
    line: 'Throw away uncommitted changes and go back to the last commit.',
    example: 'e.g. an agent mangled notes.md — discard brings the committed one back (Pomade keeps a copy 7 days).'
  },
  stage: {
    line: 'Pick which changes go into the next commit (the rest stays uncommitted).',
    example: 'e.g. stage only README.md and commit it alone.'
  },
  worktree: {
    line: 'A second folder checked out from the same repository, on another branch.',
    example: 'e.g. .claude/worktrees/e039 — an agent works there without touching main.'
  },
  'local-only': {
    line: 'A repository with no remote: its commits exist only on this Mac.',
    example: 'e.g. lose the disk, lose the history — connect a remote to keep a copy.'
  },
  conflict: {
    line: 'Two changes to the same lines that git cannot combine on its own.',
    example: 'e.g. you and an agent both rewrote the same paragraph of BACKLOG.md.'
  },
  publish: {
    line: 'Push a branch to the remote for the first time, so it exists there and follows it.',
    example: 'e.g. publish agent/t-197 — origin gets the branch and the commits on it.'
  },
  abort: {
    line: 'Stop a half-done operation and put the repository back exactly as it was before it.',
    example: 'e.g. abort a rebase with a conflict — your branch and files are as they were.'
  },
  squash: {
    line: 'Land a branch as one new commit on main holding all its changes; its own commits stay off main.',
    example: 'e.g. an agent’s 6 commits on t-197 land as one commit “T-197 Fix login”.'
  },
  'in-progress': {
    line: 'Work that has not landed on main yet: worktrees, your branches, and branches on the remote.',
    example: 'e.g. an agent’s worktree 3 commits ahead, or a colleague’s origin/fix-typo.'
  }
}

/** The hover lines for a term: its line, then its example. */
export function glossaryLines(term: GlossaryTerm): string[] {
  const e = GIT_GLOSSARY[term]
  return [e.line, e.example]
}
