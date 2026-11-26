// Pomade — E-040: the conflict model, shared by main (which reads a stopped rebase and a conflicted
// file's versions) and the conflict tab (which combines them). Pure: no I/O, no Electron, no React;
// pinned by git-conflict.unit.test.ts.
//
// Words: during a rebase git calls the branch being built on "ours" and the commit being replayed
// "theirs" — the reverse of what a person means. Pomade never shows git's words: **theirs** is what
// your commits are being put on top of (main, origin/main), **yours** is your commit being replayed.
//
//   parseMerged(text, markerSize)   `git merge-file -p --diff3` output → segments
//   conflictCount(segments)          how many conflicts a file has
//   resultText(segments, picks)      the combined file from each conflict's result
//   takeInto(pick, side, text)       a "take" arrow: put a side into a conflict's result

/** One side of a conflicted file (git's index stage): its text, or why there is none. */
export type ConflictSide =
  | { kind: 'text'; text: string }
  /** The side has no such file (deleted there, or never added). */
  | { kind: 'absent' }
  | { kind: 'binary'; size: number }
  | { kind: 'too-big'; size: number }

/** A stretch of the combined file: the same on both sides (or combined by git on its own), or a
 *  conflict with both sides and the version they started from (`base`). */
export type ConflictSegment =
  | { kind: 'same'; text: string }
  | { kind: 'conflict'; theirs: string; base: string; yours: string }

export interface ConflictFile {
  /** ws-relative. */
  path: string
  theirs: ConflictSide
  base: ConflictSide
  yours: ConflictSide
  /** Line by line, when both sides are text (an absent base counts as empty). Null: the file is
   *  combined whole — one side or the other (a deleted side, a binary or too-big file). */
  segments: ConflictSegment[] | null
}

/** A stopped rebase, or a merge stopped on a conflict (E-041: a branch landing on main), as the
 *  conflict tab shows it. In a merge, **theirs** is main (git's stage 2) and **yours** the branch
 *  being landed (stage 3), the same sides as in a rebase. */
export interface RebaseState {
  kind: 'rebase' | 'merge'
  repo: string
  /** The branch being rebased (`feature`) or landed; null when the rebase started from a detached
   *  HEAD (or a merge's branch is not known). */
  branch: string | null
  /** What your commits go on top of (`main`, `origin/main`, or a short hash); a merge: the branch
   *  it lands on. */
  onto: string
  /** The commit being replayed now: yours (a merge: the landed branch's tip). Null between commits. */
  commit: { hash: string; subject: string } | null
  /** Which of how many commits is being replayed (1-based). */
  step: number
  total: number
  /** Files with a conflict still open (ws-relative, sorted). */
  conflicts: string[]
  /** Pomade started this rebase and holds a record of the state before it — Abort is then checked
   *  against it. */
  recorded: boolean
}

/** How a conflicted file is resolved: the combined text, or one side whole (an absent side
 *  deletes the file). */
export type ConflictResolution = { kind: 'text'; content: string } | { kind: 'take'; side: 'theirs' | 'yours' }

/** The marker size Pomade asks `git merge-file` for: long enough that a line of the file itself is
 *  never read as a marker. */
export const CONFLICT_MARKER_SIZE = 31

/** Either side over this size is combined whole (the editor's own cap). */
export const CONFLICT_MAX_BYTES = 2 * 1024 * 1024

function isMarker(line: string, ch: string, size: number): boolean {
  if (line.length < size) return false
  for (let i = 0; i < size; i++) if (line[i] !== ch) return false
  return line.length === size || line[size] === ' ' || line[size] === '\n' || line[size] === '\r'
}

/** Parse `git merge-file -p --diff3 --marker-size=<size>` output (current = theirs, other = yours)
 *  into segments. Lines keep their own endings. Unbalanced markers (never from git) leave the rest
 *  as one `same` segment, so nothing is ever dropped. */
export function parseMerged(text: string, markerSize = CONFLICT_MARKER_SIZE): ConflictSegment[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const out: ConflictSegment[] = []
  let same = ''
  let i = 0
  const flush = (): void => {
    if (same) out.push({ kind: 'same', text: same })
    same = ''
  }
  while (i < lines.length) {
    const line = lines[i]
    if (!isMarker(line, '<', markerSize)) {
      same += line
      i++
      continue
    }
    // <<<<<<< theirs  |||||||  base  =======  yours >>>>>>>
    let j = i + 1
    let theirs = ''
    let base = ''
    let yours = ''
    let part: 'theirs' | 'base' | 'yours' = 'theirs'
    let closed = false
    for (; j < lines.length; j++) {
      const l = lines[j]
      if (part === 'theirs' && isMarker(l, '|', markerSize)) part = 'base'
      else if ((part === 'theirs' || part === 'base') && isMarker(l, '=', markerSize)) part = 'yours'
      else if (part === 'yours' && isMarker(l, '>', markerSize)) {
        closed = true
        break
      } else if (part === 'theirs') theirs += l
      else if (part === 'base') base += l
      else yours += l
    }
    if (!closed) {
      same += lines.slice(i).join('')
      break
    }
    flush()
    out.push({ kind: 'conflict', theirs, base, yours })
    i = j + 1
  }
  flush()
  return out
}

export function conflictCount(segments: readonly ConflictSegment[]): number {
  return segments.reduce((n, s) => n + (s.kind === 'conflict' ? 1 : 0), 0)
}

/** A conflict's result as the tab holds it: the text, and whether the person decided it (took a
 *  side or typed) — an undecided conflict keeps "Mark resolved" off. */
export interface ConflictPick {
  text: string
  decided: boolean
}

export const UNDECIDED: ConflictPick = { text: '', decided: false }

/** A "take" arrow: the side's text goes into the result — replacing it while undecided, after it
 *  once something is there (take theirs, then yours = both, in that order). */
export function takeInto(pick: ConflictPick, sideText: string): ConflictPick {
  if (!pick.decided || pick.text === '') return { text: sideText, decided: true }
  const sep = pick.text.endsWith('\n') || sideText === '' ? '' : '\n'
  return { text: `${pick.text}${sep}${sideText}`, decided: true }
}

/** The combined file: the same stretches as they are, each conflict replaced by its result.
 *  `picks[i]` is the i-th conflict's. */
export function resultText(segments: readonly ConflictSegment[], picks: readonly ConflictPick[]): string {
  let k = 0
  let out = ''
  for (const s of segments) {
    if (s.kind === 'same') out += s.text
    else {
      const p = picks[k++]
      let t = p?.text ?? ''
      // A conflict ends on a line end; a typed result that lost it would glue the next line on.
      if (t && !t.endsWith('\n') && (s.theirs.endsWith('\n') || s.yours.endsWith('\n'))) t += '\n'
      out += t
    }
  }
  return out
}

/** A todo line that replays a commit (`label`, `reset`, `exec`… do not). */
const COMMIT_STEP = /^(pick|p|reword|r|edit|e|squash|s|fixup|f|merge|m)\s/

function commitSteps(text: string | null): number {
  return (text ?? '').split('\n').filter((l) => COMMIT_STEP.test(l.trim())).length
}

/** Read git's rebase state files: the branch (`head-name`), `onto`, and which commit of how many
 *  is being replayed — from the `done` and `git-rebase-todo` lists (`--rebase-merges` adds label
 *  and reset steps that replay nothing), else the apply backend's `next` / `last`. Pure over the
 *  files' text; missing files are null. */
export function parseRebaseFiles(files: {
  headName: string | null
  onto: string | null
  done?: string | null
  todo?: string | null
  next?: string | null
  last?: string | null
}): { branch: string | null; onto: string | null; step: number; total: number } {
  const head = files.headName?.trim() ?? ''
  const branch = head.startsWith('refs/heads/') ? head.slice('refs/heads/'.length) : null
  let step: number
  let total: number
  if (files.done != null || files.todo != null) {
    step = commitSteps(files.done ?? null)
    total = step + commitSteps(files.todo ?? null)
  } else {
    step = Number(files.next?.trim()) || 0
    total = Number(files.last?.trim()) || 0
  }
  return { branch, onto: files.onto?.trim() || null, step, total: Math.max(total, step) }
}
