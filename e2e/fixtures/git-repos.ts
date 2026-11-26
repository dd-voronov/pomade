// Pomade e2e — E-037: a fixture workspace shaped like the real one for the Git panel and the
// comparison tab. On top of `createFixtureWorkspace`:
//   <root>                 a repo with NO remote (Local only); ignores Projects/ and .pomade/
//   Projects/alpha         a repo pushed to a local bare remote: a squash-style commit (rename +
//                          delete + markdown body), a --no-ff merge of a two-commit branch, then
//                          one local commit (↑1) and one commit fetched from the remote (↓1);
//                          uncommitted: a modified markdown doc (frontmatter, wikilinks, inline
//                          markup), a new file, a deleted file and a staged rename
//   Projects/beta/one      a repo with 60 first-parent commits (History paging)
//   Projects/beta/two      a small repo
// Project Alpha (one repo) opens straight into its repo view; project Beta (two repos) lists them.

import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './workspace'
import { tempDir } from './temp'

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

export function commitAt(cwd: string, date: string, ...args: string[]): void {
  execFileSync('git', ['commit', '-q', ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
  })
}

export function configRepo(dir: string): void {
  git(dir, 'config', 'user.email', 't@pomade.test')
  git(dir, 'config', 'user.name', 'Pomade Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
}

export async function write(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content, 'utf8')
}

export const BACKLOG_V1 = `---
title: Backlog
status: active
tags: [pomade, git]
---

# Backlog

See [[VISION]] and [[docs/ARCHITECTURE|the architecture]].

## Now

- **T-197** terminal Cmd+click fix
- *T-198* markdown file links with \`code\`

## Later

Paragraph one stays the same.
`

export const BACKLOG_V2 = BACKLOG_V1.replace('- *T-198* markdown file links with `code`', '- *T-198* markdown file links with `code` — landed')

export const BACKLOG_WORKING = BACKLOG_V2.replace('Paragraph one stays the same.', 'Paragraph one was rewritten by an agent.').replace(
  '- **T-197** terminal Cmd+click fix',
  '- **T-197** terminal Cmd+click fix (verified)'
)

export const SQUASH_MESSAGE = `T-198: markdown file links

Squash of the T-198 branch.

- **Links** open in the editor
- \`[[wikilinks]]\` resolve by basename
- [ ] follow-up: anchors

See https://example.com/t-198 for the ticket.`

export const MERGE_MESSAGE = `Merge T-197: terminal Cmd+click fix

Two commits from the agent's branch.`

export interface GitFixture extends Fixture {
  alpha: string
  remote: string
  other: string
  cleanupGit: () => Promise<void>
}

export async function createGitFixture(): Promise<GitFixture> {
  const fixture = await createFixtureWorkspace()
  const root = fixture.workspaceRoot
  const alpha = join(root, 'Projects/alpha')
  const remote = await tempDir('pomade-remote-')
  const other = await tempDir('pomade-other-')

  // ── alpha, pushed to a bare remote ──
  git(remote, 'init', '-q', '--bare', '-b', 'main')
  await write(join(alpha, 'docs/BACKLOG.md'), BACKLOG_V1)
  await write(join(alpha, 'old-links.md'), '# Links\n\nOld link notes.\n')
  await write(join(alpha, 'obsolete.md'), 'obsolete\n')
  await write(join(alpha, 'keep.md'), 'keep\n')
  git(alpha, 'init', '-q', '-b', 'main')
  configRepo(alpha)
  git(alpha, 'add', '-A')
  commitAt(alpha, '2026-10-10T09:00:00', '-m', 'Initial import')

  // A squash-style commit: one commit with a summary body, a rename and a deletion.
  await write(join(alpha, 'docs/BACKLOG.md'), BACKLOG_V2)
  git(alpha, 'mv', 'old-links.md', 'links.md')
  git(alpha, 'rm', '-q', 'obsolete.md')
  git(alpha, 'add', '-A')
  commitAt(alpha, '2026-10-12T14:03:00', '-m', SQUASH_MESSAGE)

  // A --no-ff merge of a two-commit branch.
  git(alpha, 'checkout', '-q', '-b', 'agent/t-197')
  await write(join(alpha, 'terminal.md'), 'Cmd+click opens files.\n')
  git(alpha, 'add', '-A')
  commitAt(alpha, '2026-10-13T10:00:00', '-m', 'wip: cmd+click handler')
  await fs.appendFile(join(alpha, 'terminal.md'), 'Also folders.\n')
  git(alpha, 'add', '-A')
  commitAt(alpha, '2026-10-13T11:00:00', '-m', 'fix lint')
  git(alpha, 'checkout', '-q', 'main')
  commitAt(alpha, '2026-10-14T09:00:00', '--allow-empty', '-m', 'Bump version')
  execFileSync('git', ['merge', '-q', '--no-ff', 'agent/t-197', '-m', MERGE_MESSAGE], {
    cwd: alpha,
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-15T12:00:00', GIT_COMMITTER_DATE: '2026-10-15T12:00:00' }
  })
  git(alpha, 'branch', '-q', '-D', 'agent/t-197')
  git(alpha, 'remote', 'add', 'origin', remote)
  git(alpha, 'push', '-q', '-u', 'origin', 'main')

  // ↓1: someone else pushes; alpha fetches. ↑1: a local commit not pushed.
  git(other, 'clone', '-q', remote, '.')
  configRepo(other)
  await write(join(other, 'remote-only.md'), 'from elsewhere\n')
  git(other, 'add', '-A')
  commitAt(other, '2026-10-16T08:00:00', '-m', 'Remote work')
  git(other, 'push', '-q', 'origin', 'main')
  git(alpha, 'fetch', '-q', 'origin')
  await write(join(alpha, 'local.md'), 'local only\n')
  git(alpha, 'add', 'local.md')
  commitAt(alpha, '2026-10-17T08:00:00', '-m', 'Local work, not pushed')

  // Uncommitted: modified doc, new file, deleted file, staged rename.
  await write(join(alpha, 'docs/BACKLOG.md'), BACKLOG_WORKING)
  await write(join(alpha, 'draft.md'), '# Draft\n\nNot committed yet.\n')
  await fs.rm(join(alpha, 'keep.md'))
  git(alpha, 'mv', 'terminal.md', 'terminal-links.md')

  // ── Projects/beta: two repos, the first with a long first-parent line ──
  const one = join(root, 'Projects/beta/one')
  await write(join(one, 'log.md'), '0\n')
  git(one, 'init', '-q', '-b', 'main')
  configRepo(one)
  git(one, 'add', '-A')
  commitAt(one, '2026-09-01T09:00:00', '-m', 'one: commit 0')
  for (let i = 1; i < 60; i++) {
    await fs.appendFile(join(one, 'log.md'), `${i}\n`)
    git(one, 'add', '-A')
    const day = String(1 + Math.floor(i / 3)).padStart(2, '0')
    commitAt(one, `2026-09-${day}T${String(9 + (i % 3)).padStart(2, '0')}:00:00`, '-m', `one: commit ${i}`)
  }
  const two = join(root, 'Projects/beta/two')
  await write(join(two, 'notes.md'), 'two\n')
  git(two, 'init', '-q', '-b', 'main')
  configRepo(two)
  git(two, 'add', '-A')
  commitAt(two, '2026-09-02T09:00:00', '-m', 'two: start')

  // ── the workspace root: Local only, ignores Projects/ ──
  await write(join(root, '.gitignore'), '.pomade/\nnode_modules/\nProjects/\n')
  git(root, 'init', '-q', '-b', 'main')
  configRepo(root)
  git(root, 'add', '-A')
  commitAt(root, '2026-09-01T08:00:00', '-m', 'Workspace v1')
  await fs.appendFile(join(root, 'todo.txt'), 'second todo\n')

  return {
    ...fixture,
    alpha,
    remote,
    other,
    cleanupGit: async () => {
      await fixture.cleanup()
      await rm(remote, { recursive: true, force: true })
      await rm(other, { recursive: true, force: true })
    }
  }
}
