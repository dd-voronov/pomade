// Pomade — E-028 commands on PATH, the pure part (docs/HOST-API.md §2 "Commands"): where this
// Pomade's home is, what a command shim says, the launch record, and what Pomade's own terminals get
// in their environment. No fs, no Electron — `app-commands.ts` does the writing; the shell-rc PATH
// line is `shell-path-line.ts`.

import { join } from 'node:path'

import { HOME_FILES, POMADE_ENV, type LaunchSpec } from 'pomade-kit/protocol'

import { refusedUnderTest } from './owner-paths'
import { shQuote } from './shell-path-line'

/** Every file Pomade writes into its command folder starts with this line after the shebang;
 *  Pomade removes only files that carry it. */
export const SHIM_MARKER = '# Pomade command shim'

/** The prefix a test run's launchd labels must use (docs/contracts/test-hooks.md). */
export const TEST_LABEL_PREFIX = 'io.github.dd-voronov.pomade.test.'

/** Which Pomade this is, for its home and labels. */
export type Flavor = 'stable' | 'dev'

/**
 * This Pomade's home (command folder, workspace pointer, host record): `POMADE_HOME`, else
 * `~/.pomade` for the stable (packaged) Pomade and `~/.pomade-dev` for a dev one — so a dev Pomade
 * never shadows the stable one's commands. Under test only `POMADE_HOME`, and never the Owner's
 * real home (`owner-paths.ts`); otherwise null (off).
 */
export function resolvePomadeHome(env: Readonly<Record<string, string | undefined>>, flavor: Flavor, home: string): string | null {
  const override = env[POMADE_ENV.home]?.trim() ? env[POMADE_ENV.home] : undefined
  if (env.NODE_ENV === 'test') return override && !refusedUnderTest(env, POMADE_ENV.home, override, home) ? override : null
  if (override) return override
  return join(home, flavor === 'stable' ? '.pomade' : '.pomade-dev')
}

export interface ShimSpec {
  /** What the comment says it runs: `pomade-planner (app pomade-planner)`. */
  label: string
  /** Environment set for the command. */
  env: Record<string, string>
  /** The program and its fixed arguments. */
  argv: string[]
}

/** A command shim: sets the command's identity, then execs the program with the user's arguments. */
export function shimText(spec: ShimSpec): string {
  const assigns = Object.entries(spec.env)
    .map(([k, v]) => `${k}=${shQuote(v)}`)
    .join(' ')
  return [
    '#!/bin/sh',
    `${SHIM_MARKER} — ${spec.label}. Written by Pomade; rewritten whenever its apps change.`,
    `${assigns} exec ${spec.argv.map(shQuote).join(' ')} "$@"`,
    ''
  ].join('\n')
}

/** The app's own arguments (the app folder or entry): a debugger's or a test harness's switches
 *  (`--inspect=0`, `--remote-debugging-port=0`, `-r <preload>`) are not replayed. */
export function appArgs(args: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-r' || a === '--require') i++
    else if (!a.startsWith('-')) out.push(a)
  }
  return out
}

/** How to start this Pomade again: a packaged one through LaunchServices (`open -a` its bundle); a
 *  dev or test one as this very process was started, with its POMADE_* / NODE_ENV environment. */
export function launchSpec(
  execPath: string,
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  packaged: boolean
): LaunchSpec {
  if (packaged) {
    const at = execPath.indexOf('.app/')
    return { argv: ['/usr/bin/open', '-a', at === -1 ? execPath : execPath.slice(0, at + 4)], env: {} }
  }
  const keep: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && (k.startsWith('POMADE_') || k === 'NODE_ENV')) keep[k] = v
  }
  return { argv: [execPath, ...appArgs(argv.slice(1))], env: keep }
}

/** What Pomade's own terminals add to their environment: the command folder first on PATH, the
 *  home (so the rc line steps aside) and the workspace root. */
export function terminalEnv(path: string | undefined, home: string | null, root: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (home) {
    const bin = join(home, HOME_FILES.bin)
    out.PATH = path ? `${bin}:${path}` : bin
    out[POMADE_ENV.home] = home
  }
  if (root) out[POMADE_ENV.workspace] = root
  return out
}
