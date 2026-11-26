// Pomade e2e — E-041: fixture repos for branches and worktrees, on top of E-039's git-ops fixture
// (temp dirs, local bare remotes, isolated git config — never a real repo, never the network).
//
//   Projects/alpha   main (pushed) with, not on main:
//                      agent/t1   in a worktree OUTSIDE the repo (scratch/agent-wt), 2 commits —
//                                 an agent's worktree
//                      feature    2 commits; its intro.md conflicts with main's
//                      stale      1 commit, 1 behind main (Rebase onto main)
//                    and, pushed from the second clone only (alpha has not fetched it):
//                      origin/colleague   3 commits — someone else's branch
//   Apps/gamma       a github.com remote: feature-x, "published" (its tracking ref set by hand)
//
// Check out to a worktree makes its folders under `worktrees` (POMADE_WORKTREES_DIR).

import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'

import { createGitOpsFixture, write, type GitOpsFixture } from './git-ops-repos'

export interface BranchFixture extends GitOpsFixture {
  /** The agent-like worktree (agent/t1). */
  agentWt: string
  /** Where Check out to a worktree puts folders. */
  worktrees: string
}

export async function createBranchFixture(): Promise<BranchFixture> {
  const fx = await createGitOpsFixture()
  let tick = 0
  // Strictly increasing commit dates: last activity orders rows deterministically.
  const g = (cwd: string, ...args: string[]): string => {
    tick++
    const date = `${1_800_000_000 + tick * 60} +0000`
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: join(fx.scratch, 'gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date
      }
    })
  }
  const commit = async (cwd: string, file: string, content: string, message: string): Promise<void> => {
    await write(join(cwd, file), content)
    g(cwd, 'add', '-A')
    g(cwd, 'commit', '-q', '-m', message)
  }
  const { alpha, other, gamma } = fx
  const agentWt = join(fx.scratch, 'agent-wt')

  await commit(alpha, 'intro.md', '# Intro\n\nThe first line.\n', 'Alpha: intro')
  g(alpha, 'push', '-q', 'origin', 'main')

  // Branches off main, oldest activity first: stale, feature, the agent's worktree.
  g(alpha, 'switch', '-q', '-c', 'stale')
  await commit(alpha, 'stale.md', '# Stale\n', 'Stale: add page')
  g(alpha, 'switch', '-q', 'main')
  g(alpha, 'switch', '-q', '-c', 'feature')
  await commit(alpha, 'intro.md', '# Intro\n\nThe feature’s first line.\n', 'Feature: rewrite intro')
  await commit(alpha, 'feature.md', '# Feature\n', 'Feature: add page')
  g(alpha, 'switch', '-q', 'main')
  g(alpha, 'worktree', 'add', '-q', '-b', 'agent/t1', agentWt)
  await commit(agentWt, 'agent.md', '# Agent\n', 'Agent: add notes')
  await commit(agentWt, 'agent.md', '# Agent\n\nMore notes.\n', 'Agent: expand notes')

  // main moves on: intro.md now conflicts with feature's.
  await commit(alpha, 'intro.md', '# Intro\n\nMain’s first line.\n', 'Main: rewrite intro')
  g(alpha, 'push', '-q', 'origin', 'main')

  // Someone else pushes a branch from the second clone (behind main by 2).
  g(other, 'switch', '-q', '-c', 'colleague')
  for (const n of [1, 2, 3]) await commit(other, `colleague-${n}.md`, `# Colleague ${n}\n`, `Colleague: page ${n}`)
  g(other, 'push', '-q', '-u', 'origin', 'colleague')

  // gamma (github.com): a published branch, its tracking ref set by hand (nothing is fetched).
  g(gamma, 'switch', '-q', '-c', 'feature-x')
  await commit(gamma, 'x.md', '# X\n', 'Gamma: x')
  g(gamma, 'update-ref', 'refs/remotes/origin/feature-x', 'HEAD')
  g(gamma, 'config', 'branch.feature-x.remote', 'origin')
  g(gamma, 'config', 'branch.feature-x.merge', 'refs/heads/feature-x')
  g(gamma, 'switch', '-q', 'main')

  const worktrees = join(fx.scratch, 'worktrees')
  // git names worktrees by their real path (/private/var/…, not /var/…).
  return { ...fx, agentWt: realpathSync(agentWt), worktrees, env: { ...fx.env, POMADE_WORKTREES_DIR: worktrees } }
}
