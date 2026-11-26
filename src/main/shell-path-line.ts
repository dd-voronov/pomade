// Pomade — E-028 the PATH line (docs/HOST-API.md §2 "Commands"): one marked line in the user's
// login-shell rc file (`${ZDOTDIR:-$HOME}/.zprofile`, `owner-paths.ts#resolveShellRc`) that puts a Pomade's command folder on PATH
// for shells Pomade did not start. Pomade never writes it on its own: it is added and removed only
// by an explicit action — Settings ▸ General ▸ "Commands in other terminals", or
// `pomade path install` / `remove`. Shared by the main process and `bin/pomade` (src/cli), which runs
// this file under Node's type stripping: erasable TypeScript, node: built-ins only, no Electron, no
// relative imports.

import { promises as fs } from 'node:fs'

/** The trailing comment that marks Pomade's line in a shell rc file. */
export const RC_MARKER = '# Pomade: its commands on PATH — delete this line to remove them'

/** Single-quote for sh. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** The line: the command folder on PATH, stepping aside where `POMADE_HOME` is already set
 *  (Pomade's own terminals get the folder through their environment). */
export function rcLine(binDir: string): string {
  return `[ -n "$POMADE_HOME" ] || export PATH=${shQuote(binDir)}":$PATH" ${RC_MARKER}`
}

/** `text` with exactly one Pomade line for `binDir` (replacing any other Pomade line in place, else
 *  appended). Unchanged text means nothing to write. */
export function withRcLine(text: string, binDir: string): string {
  const line = rcLine(binDir)
  const lines = text.split('\n')
  const at = lines.findIndex((l) => l.includes(RC_MARKER))
  if (at !== -1) {
    return lines
      .flatMap((l, i) => (i === at ? [line] : l.includes(RC_MARKER) ? [] : [l]))
      .join('\n')
  }
  const sep = text === '' || text.endsWith('\n') ? '' : '\n'
  return `${text}${sep}${line}\n`
}

/** `text` without Pomade's line. */
export function withoutRcLine(text: string): string {
  return text
    .split('\n')
    .filter((l) => !l.includes(RC_MARKER))
    .join('\n')
}

/** The folder the Pomade line in `text` puts on PATH; null when there is no line, '' when the
 *  marked line was edited past recognition. */
export function rcLineTarget(text: string): string | null {
  const line = text.split('\n').find((l) => l.includes(RC_MARKER))
  if (line === undefined) return null
  const m = /export PATH='((?:[^']|'\\'')*)'":\$PATH"/.exec(line)
  return m ? m[1].replace(/'\\''/g, "'") : ''
}

/** Where the line goes and what it says now. `lineTarget === binDir` means it is installed for
 *  this Pomade; another folder means another Pomade (stable vs dev) installed its own. */
export interface PathLineState {
  rcFile: string
  binDir: string
  lineTarget: string | null
}

async function readRc(rcFile: string): Promise<string> {
  try {
    return await fs.readFile(rcFile, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

export async function readPathLine(rcFile: string, binDir: string): Promise<PathLineState> {
  return { rcFile, binDir, lineTarget: rcLineTarget(await readRc(rcFile)) }
}

/** Add (or repoint) the line for `binDir`; written only when the text changes. */
export async function installPathLine(rcFile: string, binDir: string): Promise<PathLineState> {
  const current = await readRc(rcFile)
  const next = withRcLine(current, binDir)
  if (next !== current) await fs.writeFile(rcFile, next)
  return { rcFile, binDir, lineTarget: rcLineTarget(next) }
}

/** Remove Pomade's line, whichever folder it names; the rest of the file is left as it was. */
export async function removePathLine(rcFile: string, binDir: string): Promise<PathLineState> {
  const current = await readRc(rcFile)
  const next = withoutRcLine(current)
  if (next !== current) await fs.writeFile(rcFile, next)
  return { rcFile, binDir, lineTarget: null }
}
