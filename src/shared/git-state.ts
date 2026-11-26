// Pomade — E-036: the git-state model shared by main (which produces it) and the renderer (which
// draws it in the tree and the Projects panel). Pure: no I/O, no Electron, no React. The Host API serves
// apps the same snapshot (`git.read`, renderer/modules/apps/app-git.ts).
//
//   parseStatusV2(stdout, repoRoot)   `git status --porcelain=v2 -z --branch` → one repo's state
//   parseRemotes(stdout)              `git config -z --get-regexp ^remote\..*\.url$` → the remotes
//   pickRemoteUrl(remotes, upstream)  the repo's remote URL (null = local only)
//   scopeRepoChanges(repo, nested)    drop a repo's entries that belong to a nested repo
//   buildGitTreeIndex(snapshot)       per-path lookups for the file tree (letters, dots, ghosts)
//   summarizeScope(snapshot, root)    the Projects panel's "● uncommitted ↑ unpushed" for a project
//   reposInScope(snapshot, root)      the repos the Git panel lists for a Projects panel selection
//
// Every path in this module is workspace-relative POSIX ('' = the workspace root).

/** What the tree shows for a path. `new` covers untracked and newly added files alike; staged and
 *  unstaged edits are both `modified` (the tree makes no staged/unstaged distinction). */
export type GitFileStatus = 'modified' | 'new' | 'conflict' | 'renamed' | 'deleted'

export interface GitFileChange {
  path: string
  status: GitFileStatus
  /** `renamed` only: the path it was renamed from. */
  from?: string
  /** An untracked directory reported as one entry: everything inside it is `new`. */
  dir?: true
  /** What of the change is staged (in the index, ready for the next commit): `all` — the file on
   *  disk is what is staged; `part` — staged, and edited again since. Absent: nothing staged. */
  staged?: 'all' | 'part'
}

/** A git operation stopped half-way in a repo (git's own state files say so). */
export type RepoOperation = 'rebase' | 'merge' | 'cherry-pick' | 'revert'

export interface GitIgnoredEntry {
  path: string
  /** An ignored directory: everything inside it is ignored. */
  dir?: true
}

export interface RepoState {
  /** The repo's working-tree root ('' = the workspace root itself). */
  root: string
  /** The folder name (`git-base`, `Knowledge`, `Pomade`) — never a generic label. */
  name: string
  /** The working-tree root as an absolute path. */
  absPath: string
  /** The remote's URL (`pickRemoteUrl`); null when the repo has no remote — local only. */
  remoteUrl: string | null
  /** Current branch; null when detached or unborn without a name. */
  branch: string | null
  /** The commit HEAD points at (full oid); null before the first commit. The Git panel reloads
   *  History when it moves. */
  head: string | null
  /** The upstream (`origin/main`); null when the branch tracks nothing. */
  upstream: string | null
  /** Commits on the branch not on its upstream. 0 when there is no upstream. */
  ahead: number
  /** Commits on the upstream not on the branch. 0 when there is no upstream. */
  behind: number
  /** False until the repo has its first commit (no committed version of anything exists). */
  hasCommits: boolean
  /** Uncommitted entries, nearest-repo scoped (a nested repo's files never appear here). */
  changes: GitFileChange[]
  ignored: GitIgnoredEntry[]
  /** Ignored folders that hold a nested repo. Not in `ignored` (the tree must not dim the nested
   *  repo's files); the Git panel reads them to keep this repo out of a project inside them. */
  ignoredHolders: string[]
  /** A rebase, merge, cherry-pick or revert stopped half-way (a conflict); absent when none. */
  operation?: RepoOperation
  /** Set when `git status` failed for this repo; the other fields are then empty. */
  error?: string
}

export interface GitSnapshot {
  /** Every discovered repo, sorted by root. */
  repos: RepoState[]
}

export const EMPTY_GIT_SNAPSHOT: GitSnapshot = { repos: [] }

/** A file's version in the last commit (`HEAD`) — what a deleted file's ghost row opens. */
export type CommittedFile =
  | { kind: 'text'; content: string; commit: string }
  | { kind: 'binary'; size: number; commit: string }

/** The arguments the producer passes to `git status` (cwd = the repo root). Exported so the
 *  parser's tests and the service can never disagree about the format. */
export const STATUS_ARGS: readonly string[] = [
  '--no-optional-locks',
  'status',
  '--porcelain=v2',
  '-z',
  '--branch',
  '--renames',
  '--untracked-files=normal',
  '--ignored=matching'
]

/** The arguments that list a repo's remote URLs (cwd = the repo root). Exit code 1 = no remote. */
export const REMOTES_ARGS: readonly string[] = ['config', '-z', '--get-regexp', '^remote\\..*\\.url$']

export interface GitRemote {
  name: string
  url: string
}

/** Parse `git config -z --get-regexp` output (`remote.<name>.url\n<url>\0` records), in config
 *  order. A remote with several `url` lines keeps its first. */
export function parseRemotes(stdout: string): GitRemote[] {
  const out: GitRemote[] = []
  for (const rec of stdout.split('\0')) {
    const nl = rec.indexOf('\n')
    if (nl < 0) continue
    const key = rec.slice(0, nl)
    const m = /^remote\.(.+)\.url$/.exec(key)
    if (!m || out.some((r) => r.name === m[1])) continue
    out.push({ name: m[1], url: rec.slice(nl + 1) })
  }
  return out
}

/** The repo's remote URL: its upstream's remote (`origin/main` → `origin`; the longest remote
 *  name that prefixes the upstream wins), else `origin`, else the first remote. Null = no remote. */
export function pickRemoteUrl(remotes: readonly GitRemote[], upstream: string | null): string | null {
  if (upstream !== null) {
    let best: GitRemote | null = null
    for (const r of remotes) {
      if (upstream.startsWith(`${r.name}/`) && (best === null || r.name.length > best.name.length)) best = r
    }
    if (best) return best.url
  }
  return (remotes.find((r) => r.name === 'origin') ?? remotes[0])?.url ?? null
}

export function joinRel(base: string, rel: string): string {
  if (!base) return rel
  if (!rel) return base
  return `${base}/${rel}`
}

/** True when `path` is `base` or lies inside it. */
export function isWithin(path: string, base: string): boolean {
  return base === '' || path === base || path.startsWith(`${base}/`)
}

export function parentPath(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

export function baseName(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}

function trimSlash(p: string): { path: string; dir: boolean } {
  return p.endsWith('/') ? { path: p.slice(0, -1), dir: true } : { path: p, dir: false }
}

/** Split `count` space-separated fields off the front of `line`; the remainder (which may itself
 *  contain spaces — it is the path) is the last element. */
function fields(line: string, count: number): string[] | null {
  const out: string[] = []
  let rest = line
  for (let i = 0; i < count; i++) {
    const sp = rest.indexOf(' ')
    if (sp < 0) return null
    out.push(rest.slice(0, sp))
    rest = rest.slice(sp + 1)
  }
  out.push(rest)
  return out
}

/** What of an entry is staged, from its XY: X is the index side, Y the working tree. */
function stagedOf(xy: string): 'all' | 'part' | undefined {
  if (xy[0] === '.') return undefined
  return xy[1] === '.' ? 'all' : 'part'
}

function ordinaryStatus(xy: string): GitFileStatus {
  const x = xy[0]
  const y = xy[1]
  if (x === 'A') return 'new'
  if (x === 'D' || y === 'D') return 'deleted'
  return 'modified'
}

export interface ParsedStatus {
  branch: string | null
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  hasCommits: boolean
  changes: GitFileChange[]
  ignored: GitIgnoredEntry[]
}

/** Parse `git status --porcelain=v2 -z --branch` output. `repoRoot` (ws-relative) prefixes every
 *  path so the result is workspace-relative. Unknown records are skipped, never thrown on. */
export function parseStatusV2(stdout: string, repoRoot: string): ParsedStatus {
  const out: ParsedStatus = {
    branch: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    hasCommits: true,
    changes: [],
    ignored: []
  }
  const records = stdout.split('\0')
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (!rec) continue
    const kind = rec[0]
    if (kind === '#') {
      const [, key, ...rest] = rec.split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') {
        out.hasCommits = value !== '(initial)'
        out.head = out.hasCommits ? value : null
      }
      else if (key === 'branch.head') out.branch = value === '(detached)' ? null : value
      else if (key === 'branch.upstream') out.upstream = value
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) {
          out.ahead = Number(m[1])
          out.behind = Number(m[2])
        }
      }
      continue
    }
    if (kind === '1') {
      const f = fields(rec, 8)
      if (!f) continue
      const staged = stagedOf(f[1])
      out.changes.push({ path: joinRel(repoRoot, f[8]), status: ordinaryStatus(f[1]), ...(staged ? { staged } : {}) })
      continue
    }
    if (kind === '2') {
      const f = fields(rec, 9)
      if (!f) continue
      // -z: the original path is the NEXT record.
      const from = records[i + 1] ?? ''
      i += 1
      const copied = f[8].startsWith('C')
      const staged = stagedOf(f[1])
      out.changes.push({
        ...(copied
          ? { path: joinRel(repoRoot, f[9]), status: 'new' as const }
          : { path: joinRel(repoRoot, f[9]), status: 'renamed' as const, from: joinRel(repoRoot, from) }),
        ...(staged ? { staged } : {})
      })
      continue
    }
    if (kind === 'u') {
      const f = fields(rec, 10)
      if (!f) continue
      out.changes.push({ path: joinRel(repoRoot, f[10]), status: 'conflict' })
      continue
    }
    if (kind === '?' || kind === '!') {
      const { path, dir } = trimSlash(rec.slice(2))
      const wsPath = joinRel(repoRoot, path)
      if (kind === '?') out.changes.push(dir ? { path: wsPath, status: 'new', dir: true } : { path: wsPath, status: 'new' })
      else out.ignored.push(dir ? { path: wsPath, dir: true } : { path: wsPath })
    }
  }
  return out
}

/** Nearest-repo scoping for one repo's entries: an entry at or inside a nested repo root belongs
 *  to that nested repo, never to this one. An ignored directory that holds a nested repo is
 *  dropped too (dimming it would dim another repo's live files). Untracked directories that hold
 *  a nested repo are returned in `expand` — the producer re-lists them file by file (`-uall`,
 *  bounded to those directories), because the collapsed entry would otherwise claim the nested
 *  repo's files. */
export function scopeRepoChanges(
  parsed: Pick<ParsedStatus, 'changes' | 'ignored'>,
  nestedRoots: readonly string[]
): { changes: GitFileChange[]; ignored: GitIgnoredEntry[]; ignoredHolders: string[]; expand: string[] } {
  const insideNested = (p: string): boolean => nestedRoots.some((n) => isWithin(p, n))
  const holdsNested = (p: string): boolean => nestedRoots.some((n) => isWithin(n, p))
  const changes: GitFileChange[] = []
  const expand: string[] = []
  for (const c of parsed.changes) {
    if (insideNested(c.path)) continue
    if (c.dir && holdsNested(c.path)) {
      expand.push(c.path)
      continue
    }
    changes.push(c)
  }
  const ignored = parsed.ignored.filter((g) => !insideNested(g.path) && !(g.dir && holdsNested(g.path)))
  const ignoredHolders = parsed.ignored.filter((g) => g.dir && !insideNested(g.path) && holdsNested(g.path)).map((g) => g.path)
  return { changes, ignored, ignoredHolders, expand }
}

// ─── Renderer-side lookups ────────────────────────────────────────────────────

/** A row the tree draws for a path that no longer exists on disk. */
export interface GhostEntry {
  name: string
  path: string
  kind: 'file' | 'dir'
}

export interface GitTreeIndex {
  /** Status of an exact path, inherited from an untracked ancestor directory up to (not across)
   *  the nearest repo root. Null when clean or unknown. */
  statusOf(path: string): GitFileChange | null
  /** True when anything inside the directory changed (for the folder dot). */
  hasChangesInside(dir: string): boolean
  /** True when git ignores the path (itself or an ignored ancestor within the same repo). */
  isIgnored(path: string): boolean
  /** Deleted entries whose parent is `dir`: files and, for deleted folders, ghost folders. The
   *  tree shows the ones not present on disk. */
  ghostsIn(dir: string): GhostEntry[]
}

const STATUS_RANK: Record<GitFileStatus, number> = {
  conflict: 5,
  new: 4,
  renamed: 3,
  modified: 2,
  deleted: 1
}

export function buildGitTreeIndex(snapshot: GitSnapshot): GitTreeIndex {
  const exact = new Map<string, GitFileChange>()
  const untrackedDirs = new Set<string>()
  const dirty = new Set<string>()
  const ignoredExact = new Set<string>()
  const ignoredDirs = new Set<string>()
  const ghosts = new Map<string, Map<string, GhostEntry>>()
  const repoRoots = new Set(snapshot.repos.map((r) => r.root))

  const addGhost = (dir: string, entry: GhostEntry): void => {
    let m = ghosts.get(dir)
    if (!m) {
      m = new Map()
      ghosts.set(dir, m)
    }
    if (!m.has(entry.name)) m.set(entry.name, entry)
  }

  for (const repo of snapshot.repos) {
    for (const c of repo.changes) {
      const prev = exact.get(c.path)
      // A path can appear twice (deleted in the index, re-created untracked): the stronger wins.
      if (!prev || STATUS_RANK[c.status] > STATUS_RANK[prev.status]) exact.set(c.path, c)
      if (c.dir) untrackedDirs.add(c.path)
      for (let p = parentPath(c.path); ; p = parentPath(p)) {
        dirty.add(p)
        if (p === '') break
      }
      if (c.status === 'deleted') {
        addGhost(parentPath(c.path), { name: baseName(c.path), path: c.path, kind: 'file' })
        // Every ancestor below the repo root may itself be gone: offer it as a ghost folder; the
        // tree drops the ones that still exist on disk.
        for (let d = parentPath(c.path); d !== '' && d !== repo.root; d = parentPath(d)) {
          addGhost(parentPath(d), { name: baseName(d), path: d, kind: 'dir' })
        }
      }
    }
    for (const g of repo.ignored) {
      if (g.dir) ignoredDirs.add(g.path)
      else ignoredExact.add(g.path)
    }
  }

  /** Walk `path`'s ancestors (nearest first), stopping at the nearest repo root. */
  const someAncestor = (path: string, test: (dir: string) => boolean): boolean => {
    if (repoRoots.has(path)) return false
    for (let p = parentPath(path); ; p = parentPath(p)) {
      if (test(p)) return true
      if (repoRoots.has(p) || p === '') return false
    }
  }

  return {
    statusOf(path) {
      const hit = exact.get(path)
      if (hit) return hit
      if (untrackedDirs.size === 0) return null
      let found: string | null = null
      someAncestor(path, (d) => {
        if (untrackedDirs.has(d)) found = d
        return found !== null
      })
      return found !== null ? { path, status: 'new' } : null
    },
    hasChangesInside(dir) {
      return dirty.has(dir)
    },
    isIgnored(path) {
      if (ignoredExact.has(path) || ignoredDirs.has(path)) return true
      if (ignoredDirs.size === 0) return false
      return someAncestor(path, (d) => ignoredDirs.has(d))
    },
    ghostsIn(dir) {
      const m = ghosts.get(dir)
      return m ? [...m.values()] : []
    }
  }
}

/** The repo that owns `path`: the deepest discovered root that holds it (a nested repo wins over
 *  its enclosing one). Null for a path in no repo — including an absolute (outside-workspace)
 *  path and the empty Untitled path. */
export function repoOfPath(snapshot: GitSnapshot, path: string): RepoState | null {
  if (!path || path.startsWith('/')) return null
  let best: RepoState | null = null
  for (const r of snapshot.repos) {
    if (r.root !== path && isWithin(path, r.root) && (!best || r.root.length > best.root.length)) best = r
  }
  return best
}

// ─── Projects panel summaries ────────────────────────────────────────────────────────

export interface RepoSummary {
  name: string
  root: string
  uncommitted: number
  /** Null when the repo's branch has no upstream (nothing to be "unpushed" against). */
  unpushed: number | null
}

export interface ScopeSummary {
  uncommitted: number
  unpushed: number
  /** The repos that contribute, in root order. */
  repos: RepoSummary[]
}

/** The repo that encloses a project folder: the deepest repo holding `scopeRoot` when the folder is
 *  not itself a repo root. Null for the Workspace project (`scopeRoot === null`), for a repo root, for a
 *  folder in no repo, and for a folder that repo ignores (an ignored entry at or above it, or an
 *  ignored folder above it that holds nested repos) — an ignored folder has nothing of the repo in it. */
function enclosingRepoOf(snapshot: GitSnapshot, scopeRoot: string | null): RepoState | null {
  if (scopeRoot === null || snapshot.repos.some((r) => r.root === scopeRoot)) return null
  let enclosing: RepoState | null = null
  for (const r of snapshot.repos) {
    if (isWithin(scopeRoot, r.root) && (!enclosing || r.root.length > enclosing.root.length)) enclosing = r
  }
  if (enclosing === null) return null
  const ignored =
    enclosing.ignored.some((g) => g.path === scopeRoot || (g.dir === true && isWithin(scopeRoot, g.path))) ||
    enclosing.ignoredHolders.some((d) => isWithin(scopeRoot, d))
  return ignored ? null : enclosing
}

/** The Projects panel badge for a scope. `scopeRoot === null` is the Workspace row: every repo, summed.
 *  A project scope counts the uncommitted entries under its root (whichever repo holds them) and
 *  the unpushed commits of the repos at or under its root plus the repo that encloses it
 *  (`enclosingRepoOf`). */
export function summarizeScope(snapshot: GitSnapshot, scopeRoot: string | null): ScopeSummary {
  const enclosing = enclosingRepoOf(snapshot, scopeRoot)
  const repos: RepoSummary[] = []
  for (const repo of snapshot.repos) {
    const inScope = scopeRoot === null || isWithin(repo.root, scopeRoot) || repo === enclosing
    const uncommitted =
      scopeRoot === null
        ? repo.changes.length
        : repo.changes.filter((c) => isWithin(c.path, scopeRoot) || (c.dir === true && isWithin(scopeRoot, c.path)))
            .length
    if (!inScope && uncommitted === 0) continue
    const unpushed = repo.upstream === null ? null : inScope ? repo.ahead : 0
    repos.push({ name: repo.name, root: repo.root, uncommitted, unpushed })
  }
  return {
    uncommitted: repos.reduce((n, r) => n + r.uncommitted, 0),
    unpushed: repos.reduce((n, r) => n + (r.unpushed ?? 0), 0),
    repos
  }
}

// ─── Git panel scope ──────────────────────────────────────────────────────────

/** The repos the Git panel lists for a Projects panel selection. `scopeRoot === null` is the Workspace project:
 *  every repo. A project lists the repos at or under its root; a project folder that is not
 *  itself a repo also lists the repo that encloses it — unless that repo ignores the folder (a
 *  parent repo that ignores `Projects/` has nothing of the project in it). Root order. */
export function reposInScope(snapshot: GitSnapshot, scopeRoot: string | null): RepoState[] {
  if (scopeRoot === null) return snapshot.repos
  const enclosing = enclosingRepoOf(snapshot, scopeRoot)
  return snapshot.repos.filter((r) => isWithin(r.root, scopeRoot) || r === enclosing)
}
