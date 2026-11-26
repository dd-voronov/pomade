// Pomade — the Host API's filesystem error mapping (docs/HOST-API.md §3 error codes), shared by
// every method module: a CallError carries a protocol error code, `absOf` is the `ws-path`
// escape guard mapped onto `outside-workspace`, and the real-path guards: `requireRealAllowed`
// (writes: neither outside the workspace nor inside its `.pomade` folder by way of a symlink) and
// `requireNotPomadeFolder` (reads: not inside `.pomade` by way of a symlink).

import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, relative } from 'node:path'

import { isPomadeFolderPath, pomadeFolderMessage, type ErrorPayload } from 'pomade-kit/protocol'

import { abs, requireRoot, toRel } from './ws-path'

export class CallError extends Error {
  constructor(
    readonly code: ErrorPayload['code'],
    message: string
  ) {
    super(message)
  }
}

export function fsError(err: unknown, rel: string): CallError {
  const e = err as NodeJS.ErrnoException
  if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return new CallError('not-found', `${JSON.stringify(rel)} does not exist`)
  if (e?.code === 'EEXIST') return new CallError('already-exists', `${JSON.stringify(rel)} already exists`)
  return new CallError('io-error', e?.message ?? String(err))
}

/** `abs()` with its escape refusal mapped onto the protocol (the path was already normalized,
 *  so this is the second, filesystem-level guard). */
export function absOf(rel: string): string {
  try {
    return abs(rel)
  } catch (err) {
    const msg = (err as Error).message
    if (msg.startsWith('Path escapes')) throw new CallError('outside-workspace', msg)
    throw new CallError('io-error', msg)
  }
}

/** Where `absPath` really is, relative to the workspace's real root (`toRel` form): the real path
 *  of `absPath`, or — while it does not exist — of its nearest existing ancestor. Null when it is
 *  outside the workspace. */
async function realRel(absPath: string, rel: string): Promise<string | null> {
  const root = await fs.realpath(requireRoot())
  for (let probe = absPath; ; probe = dirname(probe)) {
    let real: string
    try {
      real = await fs.realpath(probe)
    } catch (err) {
      if (dirname(probe) === probe) throw fsError(err, rel)
      continue
    }
    const r = relative(root, real)
    return r.startsWith('..') || isAbsolute(r) ? null : toRel(root, real)
  }
}

/** Throw unless `absPath`'s real path (its nearest existing ancestor's while it does not exist)
 *  lies inside the workspace's real root (`outside-workspace`) and outside the workspace's
 *  `.pomade` folder (`capability-denied`). */
export async function requireRealAllowed(absPath: string, rel: string): Promise<void> {
  const r = await realRel(absPath, rel)
  if (r === null) throw new CallError('outside-workspace', `${JSON.stringify(rel)} resolves outside the workspace`)
  if (isPomadeFolderPath(r)) throw new CallError('capability-denied', pomadeFolderMessage(rel))
}

/** True when `absPath` exists and really lies at or inside the workspace's `.pomade` folder. */
export async function isRealPomadeFolder(absPath: string): Promise<boolean> {
  try {
    const root = await fs.realpath(requireRoot())
    return isPomadeFolderPath(toRel(root, await fs.realpath(absPath)))
  } catch {
    return false
  }
}

/** Throw `capability-denied` when `absPath` exists and really lies at or inside the workspace's
 *  `.pomade` folder — the read-side check (reads may follow a link outside the workspace). */
export async function requireNotPomadeFolder(absPath: string, rel: string): Promise<void> {
  if (await isRealPomadeFolder(absPath)) throw new CallError('capability-denied', pomadeFolderMessage(rel))
}
