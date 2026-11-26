// Pomade — E-037: the git-history model shared by main (which runs `git log` / `git show`) and the
// renderer (the Git panel's History, the commit-details tab). Pure: no I/O.
//
//   LOG_FORMAT + parseLog(stdout)            `git log --format=LOG_FORMAT` → CommitSummary[]
//   parseCommitHeader(stdout)                `git show -s --format=DETAILS_FORMAT` → the header
//   parseCommitFiles(nameStatus, numstat)    two `git diff-tree -z` outputs → CommitFile[]
//   FILE_LOG_FORMAT + parseFileLog(stdout)   `git log --follow --name-status -z` → FileCommit[] (one
//                                            file's history, with the file's path at each commit)
//   remoteLabel(url)                         `git@github.com:a/b.git` → `github.com/a/b`
//   relativeTime / commitDateLabel           "3 h ago", "Oct 12"
//
// Commit paths are repo-relative POSIX (the renderer joins the repo root for workspace paths).

/** One commit as a History row shows it. */
export interface CommitSummary {
  hash: string
  /** Parent hashes in order; 2+ = a merge (the first parent is the branch it landed on). */
  parents: string[]
  author: string
  authorEmail: string
  /** Author date, ms since the epoch. */
  date: number
  subject: string
  /** E-042 — the `Pomade-Job:` trailer: the Runner job that made this commit (History rows only). */
  job?: string
}

/** One page of a log. `more` = there are older commits past this page. */
export interface LogPage {
  commits: CommitSummary[]
  more: boolean
}

/** What a commit did to a file. Copies read as added; type changes as modified. */
export type CommitFileStatus = 'added' | 'modified' | 'deleted' | 'renamed'

export interface CommitFile {
  /** Repo-relative path in the commit (the new name for a rename). */
  path: string
  status: CommitFileStatus
  /** `renamed` only: the path before. */
  from?: string
  /** Lines added / removed; null for a binary file. */
  added: number | null
  removed: number | null
}

export interface CommitDetails extends CommitSummary {
  /** The full message: subject, blank line, body — as written. */
  message: string
  /** Files changed against the first parent (what this commit brought to its branch). */
  files: CommitFile[]
  /** Set when the file list was cut at `COMMIT_FILES_LIMIT`: the real count. */
  totalFiles?: number
}

/** A commit that touched one file, with where the file was at that commit (renames followed). */
export interface FileCommit extends CommitSummary {
  /** Repo-relative path of the file at this commit (the new name for the commit that renamed it). */
  path: string
}

/** One page of a file's history; `more` = there are older commits past this page. */
export interface FileLogPage {
  commits: FileCommit[]
  more: boolean
  /** Set when the file was moved without git knowing (a plain rename in the tree or Finder): the
   *  committed path whose history this is, found by content. Repo-relative from main's reader,
   *  ws-relative over IPC. */
  renamedFrom?: string
}

/** A moved file counts as the same file when at least this much of its text is unchanged — git's
 *  own rename threshold. */
export const RENAME_SIMILARITY = 0.5

/** The cap on a commit's listed files. */
export const COMMIT_FILES_LIMIT = 2000
/** A History page. */
export const LOG_PAGE_SIZE = 50
/** The cap on a merge's inner commits listed under its row. */
export const MERGE_INNER_LIMIT = 200
/** The cap on the commits the Not pushed group lists. */
export const UNPUSHED_LIMIT = 200

const US = '\x1f'
const RS = '\x1e'

/** Hash, parents, author, email, author date (unix s), subject, the `Pomade-Job:` trailer's value
 *  (shared/git-runs.ts `JOB_TRAILER`) — unit-separated, record-ended. */
export const LOG_FORMAT = `--format=%H${US}%P${US}%an${US}%ae${US}%at${US}%s${US}%(trailers:key=Pomade-Job,valueonly,separator=%x1d)${RS}`
/** LOG_FORMAT's header plus the raw message (`%B`) last, so it may hold anything but RS. */
export const DETAILS_FORMAT = `--format=%H${US}%P${US}%an${US}%ae${US}%at${US}%s${US}%B${RS}`

/** LOG_FORMAT's fields, RS-led instead of RS-ended: with `--name-status -z` the changed path
 *  follows the header, so a record runs from one RS to the next. */
export const FILE_LOG_FORMAT = `--format=${RS}%H${US}%P${US}%an${US}%ae${US}%at${US}%s`

function summaryFrom(f: string[]): CommitSummary | null {
  const [hash, parents, author, authorEmail, at, subject] = f
  if (!hash || !/^[0-9a-f]{7,64}$/.test(hash)) return null
  return {
    hash,
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    author: author ?? '',
    authorEmail: authorEmail ?? '',
    date: Number(at) * 1000 || 0,
    subject: subject ?? ''
  }
}

/** Parse `git log LOG_FORMAT` output. Malformed records are skipped. */
export function parseLog(stdout: string): CommitSummary[] {
  const out: CommitSummary[] = []
  for (const rec of stdout.split(RS)) {
    const trimmed = rec.replace(/^\n+/, '')
    if (!trimmed) continue
    const f = trimmed.split(US)
    const c = summaryFrom(f)
    if (!c) continue
    const job = (f[6] ?? '').split('\x1d')[0].trim()
    out.push(job ? { ...c, job } : c)
  }
  return out
}

/** Parse `git show -s DETAILS_FORMAT` output: the summary and the full message (trailing
 *  newlines trimmed). Null when malformed. */
export function parseCommitHeader(stdout: string): (CommitSummary & { message: string }) | null {
  const rec = stdout.split(RS)[0]?.replace(/^\n+/, '') ?? ''
  const f = rec.split(US)
  const c = summaryFrom(f)
  if (!c) return null
  return { ...c, message: f.slice(6).join(US).replace(/\s+$/, '') }
}

/** Parse `git log --follow --name-status -z FILE_LOG_FORMAT -- <path>` output, newest first. Each
 *  commit's `path` is the file's path in that commit; a commit with no listed file (a merge git
 *  simplified away) keeps the path the newer commits carried. A rename moves the path back to the
 *  old name for every older commit. `startPath` is the path asked for. */
export function parseFileLog(stdout: string, startPath: string): FileCommit[] {
  const out: FileCommit[] = []
  let current = startPath
  for (const seg of stdout.split(RS)) {
    if (!seg) continue
    const nul = seg.indexOf('\0')
    const c = summaryFrom((nul < 0 ? seg : seg.slice(0, nul)).split(US))
    if (!c) continue
    let path = current
    let before = current
    const tokens = nul < 0 ? [] : seg.slice(nul + 1).split('\0')
    for (let i = 0; i < tokens.length; i++) {
      const letter = tokens[i].replace(/^\n+/, '')
      if (!/^[ACDMRTUX]\d*$/.test(letter)) continue
      const twoPaths = letter[0] === 'R' || letter[0] === 'C'
      const from = twoPaths ? tokens[i + 1] : undefined
      const to = (twoPaths ? tokens[i + 2] : tokens[i + 1]) ?? ''
      if (to) {
        path = to
        before = from ?? to
      }
      break
    }
    out.push({ ...c, path })
    current = before
  }
  return out
}

/** How much of two texts is the same, 0..1: twice the shared lines over both line counts (lines
 *  matched as a multiset, order ignored). Identical texts are 1, unrelated ones near 0. */
export function textSimilarity(a: string, b: string): number {
  if (a === b) return 1
  const la = a.split('\n')
  const lb = b.split('\n')
  const counts = new Map<string, number>()
  for (const l of la) counts.set(l, (counts.get(l) ?? 0) + 1)
  let shared = 0
  for (const l of lb) {
    const n = counts.get(l)
    if (n) {
      shared++
      counts.set(l, n - 1)
    }
  }
  return (2 * shared) / (la.length + lb.length)
}

function statusOf(letter: string): CommitFileStatus {
  switch (letter[0]) {
    case 'A':
    case 'C':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    default:
      return 'modified'
  }
}

/** Join `git diff-tree -r -z -M --name-status` and `… --numstat` outputs into one list, in the
 *  name-status order. Renames: name-status `R<score>\0old\0new\0`, numstat `a\td\t\0old\0new\0`.
 *  Binary files count as `-\t-` (null counts). */
export function parseCommitFiles(nameStatus: string, numstat: string): CommitFile[] {
  const counts = new Map<string, { added: number | null; removed: number | null }>()
  const n = numstat.split('\0')
  for (let i = 0; i < n.length; i++) {
    const rec = n[i]
    if (!rec) continue
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(rec)
    if (!m) continue
    let path = m[3]
    if (path === '') {
      // A rename: the old and new paths follow as their own records.
      path = n[i + 2] ?? ''
      i += 2
    }
    counts.set(path, { added: m[1] === '-' ? null : Number(m[1]), removed: m[2] === '-' ? null : Number(m[2]) })
  }
  const out: CommitFile[] = []
  const s = nameStatus.split('\0')
  for (let i = 0; i < s.length; i++) {
    const letter = s[i]
    if (!letter || !/^[ACDMRTUX]\d*$/.test(letter)) continue
    const status = statusOf(letter)
    const twoPaths = letter[0] === 'R' || letter[0] === 'C'
    const from = twoPaths ? (s[i + 1] ?? '') : undefined
    const path = (twoPaths ? s[i + 2] : s[i + 1]) ?? ''
    i += twoPaths ? 2 : 1
    if (!path) continue
    const c = counts.get(path) ?? { added: null, removed: null }
    out.push(status === 'renamed' ? { path, status, from, ...c } : { path, status, ...c })
  }
  return out
}

/** The remote as a repo row shows it: host/owner/name for URLs (`github.com/dd-voronov/pomade`),
 *  the path itself for a local remote. Credentials in a URL are never shown. */
export function remoteLabel(url: string): string {
  const u = url.trim()
  const strip = (p: string): string => p.replace(/\/+$/, '').replace(/\.git$/, '')
  // scp-like: git@github.com:owner/name.git
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(u)
  if (scp) return strip(`${scp[1]}/${scp[2].replace(/^\/+/, '')}`)
  const proto = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/]+)(\/.*)?$/i.exec(u)
  if (proto && !/^file:/i.test(u)) return strip(`${proto[1]}${proto[2] ?? ''}`)
  return strip(u.replace(/^file:\/\//i, ''))
}

/** True for a merge commit (2+ parents): its History row expands to the commits it brought in. */
export function isMerge(c: Pick<CommitSummary, 'parents'>): boolean {
  return c.parents.length > 1
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A date as a short label: `Oct 12`, with the year when it is not `now`'s (`Oct 12, 2025`). */
export function commitDateLabel(ms: number, now: number): string {
  const d = new Date(ms)
  const label = `${MONTHS[d.getMonth()]} ${d.getDate()}`
  return d.getFullYear() === new Date(now).getFullYear() ? label : `${label}, ${d.getFullYear()}`
}

/** A full timestamp: `Oct 12, 2026, 14:03`. */
export function commitTimestamp(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${hh}:${mm}`
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** How long ago, for a History row: `just now`, `12 min ago`, `3 h ago` (same day), `yesterday`,
 *  `4 days ago` (within a week), then the date label. A future date (clock skew) is `just now`. */
export function relativeTime(ms: number, now: number): string {
  const diff = now - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000)
  if (days <= 0) return `${Math.floor(diff / 3_600_000)} h ago`
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return commitDateLabel(ms, now)
}
