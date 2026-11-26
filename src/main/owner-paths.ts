// Pomade — the Owner's real places outside the workspace (docs/PLATFORM.md "Storage outside the
// workspace") and the test guard that keeps a test run out of them. A test run (`NODE_ENV=test`)
// takes its home, user data folder, shell rc and LaunchAgents folder from the test hooks; a hook
// that names the Owner's real place — inherited from a Pomade terminal, or passed by mistake — is
// refused: logged, and nothing is used instead. Shared by the main process and `bin/pomade`
// (src/cli), which runs this file under Node's type stripping: erasable TypeScript, node: built-ins
// only, no Electron, no relative imports.

import { join, resolve } from 'node:path'

type Env = Readonly<Record<string, string | undefined>>

/** The shell startup files a real shell reads from the home folder. */
const RC_FILES = ['.zprofile', '.zshrc', '.zshenv', '.zlogin', '.bash_profile', '.bashrc', '.profile']

/** Is `path` one of the Owner's real places: at or inside `~/.pomade`, `~/.pomade-dev`,
 *  `~/Library/Application Support/Pomade*` or `~/Library/LaunchAgents`, a shell rc file in the
 *  home folder (`~/.zprofile`, `~/.zshrc`, …), or `$ZDOTDIR/.zprofile`. Case-insensitive, as
 *  APFS is. */
export function isOwnersPath(path: string, env: Env, home: string): boolean {
  const p = resolve(path).toLowerCase()
  const h = resolve(home).toLowerCase()
  const within = (root: string): boolean => p === root || p.startsWith(`${root}/`)
  if (within(join(h, '.pomade')) || within(join(h, '.pomade-dev'))) return true
  if (within(join(h, 'library', 'launchagents'))) return true
  const appSupport = join(h, 'library', 'application support')
  if (p.startsWith(`${appSupport}/pomade`)) return true
  if (RC_FILES.some((rc) => p === join(h, rc))) return true
  const zdotdir = env.ZDOTDIR?.trim()
  return !!zdotdir && p === join(resolve(zdotdir), '.zprofile').toLowerCase()
}

/** Under test, whether `path` (a test hook's value, named by `what`) must be refused because it is
 *  the Owner's real place; logs the refusal. Outside a test run nothing is refused. */
export function refusedUnderTest(env: Env, what: string, path: string, home: string): boolean {
  if (env.NODE_ENV !== 'test' || !isOwnersPath(path, env, home)) return false
  console.error(`Pomade (test run): refused ${what} ${path} — it is the Owner's real one; using none.`)
  return true
}

/** The rc file that holds the PATH line (`shell-path-line.ts`): `${ZDOTDIR:-$HOME}/.zprofile`
 *  (login shells); in a test run only `POMADE_SHELL_RC`, and never a real rc file — null otherwise. */
export function resolveShellRc(env: Env, home: string): string | null {
  const override = env.POMADE_SHELL_RC
  if (env.NODE_ENV === 'test') {
    return override && override.trim() && !refusedUnderTest(env, 'POMADE_SHELL_RC', override, home) ? override : null
  }
  if (override && override.trim()) return override
  return join(env.ZDOTDIR || home, '.zprofile')
}
