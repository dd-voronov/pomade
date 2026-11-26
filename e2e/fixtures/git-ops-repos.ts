// Pomade e2e — E-039: fixture repos for operations that CHANGE a repository. Every mutating git
// command runs here, in temp dirs, against local bare remotes — never a real repo, never the network.
// Git config is isolated: the app and the fixture builder both read `gitconfig` from this fixture
// (GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM), so the user's own config neither helps nor breaks a test.
//
//   Projects/alpha   pushed to a bare remote (`remote`), with a second clone (`other`) that pushes
//                    behind alpha's back; `*.log` ignored, an ignored debug.log present
//   Projects/beta    local only (no remote)
//   Apps/gamma       a remote on github.com over ssh — the app's GIT_SSH_COMMAND is a fake ssh that
//                    refuses like GitHub does; its tracking ref is set by hand (nothing is fetched)

import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { createFixtureWorkspace, type Fixture } from './workspace'
import { tempDir } from './temp'

export interface GitOpsFixture extends Fixture {
  alpha: string
  beta: string
  gamma: string
  remote: string
  other: string
  /** A second, empty bare repo (Connect remote). */
  spare: string
  /** The temp dir holding gitconfig, the fake ssh and the bare repos. */
  scratch: string
  /** The env the app is launched with. */
  env: Record<string, string>
  cleanupGit: () => Promise<void>
}

/** `git` with this fixture's isolated config (identity included unless `identity` is false). */
export function gitIn(scratch: string, cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  })
}

/** The GitHub refusal a real `ssh` prints for an unknown key; git adds its own lines after it. */
export const FAKE_SSH = `#!/bin/sh
echo "git@github.com: Permission denied (publickey)." >&2
exit 255
`

export async function write(path: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content)
}

export async function createGitOpsFixture(opts: { identity?: boolean } = {}): Promise<GitOpsFixture> {
  const identity = opts.identity !== false
  const fixture = await createFixtureWorkspace()
  const root = fixture.workspaceRoot
  const scratch = await tempDir('pomade-gitops-')
  const remote = join(scratch, 'alpha-remote.git')
  const spare = join(scratch, 'spare-remote.git')
  const other = join(scratch, 'other')
  const alpha = join(root, 'Projects/alpha')
  const beta = join(root, 'Projects/beta')
  const gamma = join(root, 'Apps/gamma')
  // The builder always has an identity; the app gets one only when `identity`.
  await write(join(scratch, 'gitconfig'), '[user]\n\tname = Pomade Test\n\temail = t@pomade.test\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n')
  await write(join(scratch, 'app-gitconfig'), `${identity ? '[user]\n\tname = Pomade Test\n\temail = t@pomade.test\n' : ''}[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n`)
  await write(join(scratch, 'fake-ssh'), FAKE_SSH)
  await fs.chmod(join(scratch, 'fake-ssh'), 0o755)
  const g = (cwd: string, ...args: string[]): string => gitIn(scratch, cwd, ...args)

  // alpha: pushed to a bare remote; a second clone can push behind its back.
  g(scratch, 'init', '-q', '--bare', '-b', 'main', remote)
  g(scratch, 'init', '-q', '--bare', '-b', 'main', spare)
  await write(join(alpha, '.gitignore'), '*.log\n')
  await write(join(alpha, 'debug.log'), 'ignored, never touched\n')
  g(alpha, 'init', '-q', '-b', 'main')
  g(alpha, 'add', '-A')
  g(alpha, 'commit', '-q', '-m', 'Alpha: start')
  g(alpha, 'remote', 'add', 'origin', remote)
  g(alpha, 'push', '-q', '-u', 'origin', 'main')
  g(scratch, 'clone', '-q', remote, other)

  // beta: local only.
  g(beta, 'init', '-q', '-b', 'main')
  g(beta, 'add', '-A')
  g(beta, 'commit', '-q', '-m', 'Beta: start')

  // gamma: an ssh remote on github.com, as if pushed once (the tracking ref set by hand).
  g(gamma, 'init', '-q', '-b', 'main')
  g(gamma, 'add', '-A')
  g(gamma, 'commit', '-q', '-m', 'Gamma: start')
  g(gamma, 'remote', 'add', 'origin', 'git@github.com:pomade-test/gamma.git')
  g(gamma, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  g(gamma, 'config', 'branch.main.remote', 'origin')
  g(gamma, 'config', 'branch.main.merge', 'refs/heads/main')

  return {
    ...fixture,
    alpha,
    beta,
    gamma,
    remote,
    other,
    spare,
    scratch,
    env: {
      GIT_CONFIG_GLOBAL: join(scratch, 'app-gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_SSH_COMMAND: join(scratch, 'fake-ssh')
    },
    cleanupGit: async () => {
      await fixture.cleanup()
      await rm(scratch, { recursive: true, force: true })
    }
  }
}
