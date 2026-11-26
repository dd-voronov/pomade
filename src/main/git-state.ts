// Pomade — E-036: the git-state service (main process). Owns which repos exist in the workspace and
// each repo's status, and hands out one typed `GitSnapshot` (shared/git-state.ts). The renderer
// reads it over IPC and the `git:state` broadcast; the Host API's `git.read` methods serve apps the
// renderer's copy of the same snapshot. Discovery and the per-repo read are git-core's
// (`git-core/repo-state.ts`, shared with the `pomade-git` command); this service decides when
// they run.
//
//   Remotes     cached per repo: read when a repo is first seen, on every full refresh (discovery,
//               window focus) and when its `.git/config` changes — a working-file refresh reuses
//               the cache.
//   Freshness   the platform watcher's taps (fs-watch.ts — no watcher of its own): a working-file
//               change refreshes its repo; a git-metadata change (`.git/index`, `HEAD`, `refs/…`,
//               `config`) refreshes that repo; a `.git` appearing or vanishing re-runs discovery. Plus a full
//               refresh on window focus, which covers repos outside every watched tree root.
//               Changes coalesce in a window (the first event starts the clock), runs never
//               overlap, and a change during a run schedules exactly one follow-up run.

import { app } from 'electron'

import { EV } from '@shared/ipc-api'
import { isWithin, type GitRemote, type GitSnapshot, type RepoState } from '@shared/git-state'

import { discoverRepos, readRemotes, readRepoState } from '../git-core/repo-state'
import { configStore, onWorkspaceReady, onWorkspaceTeardown } from './config-store'
import { tapGitMetaChanges, tapWorkspaceChanges, type RawWorkspaceChange } from './fs-watch'
import { safeBroadcast } from './windows'

export {
  DISCOVERY_MAX_DEPTH,
  GIT_READ_ENV,
  discoverRepos,
  gitDirOf,
  operationOf,
  readRemotes,
  readRepoState,
  runGit,
  runGitBuffer
} from '../git-core/repo-state'

/** Coalescing window for change-driven refreshes. */
const REFRESH_WINDOW_MS = 250
/** Minimum spacing of focus-driven full refreshes. */
const FOCUS_REFRESH_MIN_MS = 3_000
const STATUS_CONCURRENCY = 4

export class GitStateService {
  private states = new Map<string, RepoState>()
  /** Each repo's remotes, cached (`Remotes` above); a repo without an entry is read next run. */
  private remotes = new Map<string, GitRemote[]>()
  private roots: string[] = []
  private rootAbs: string | null = null
  private started = false
  /** Someone asked for git state: keep the service running across workspace switches. */
  private wanted = false
  private ready: Promise<void> | null = null
  private pendingRepos = new Set<string>()
  private pendingDiscover = false
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private untaps: (() => void)[] = []
  private lastFullRefresh = 0
  private listeners = new Set<(snapshot: GitSnapshot) => void>()

  /** The current snapshot (repos sorted by root). Empty before the first discovery. */
  snapshot(): GitSnapshot {
    return { repos: this.roots.map((r) => this.states.get(r)).filter((s): s is RepoState => !!s) }
  }

  /** The snapshot once the first discovery + status pass has finished. Starts the service on
   *  first use: nothing walks or runs git until someone asks for git state. */
  async current(): Promise<GitSnapshot> {
    this.wanted = true
    this.start()
    await this.ready
    return this.snapshot()
  }

  /** True when `root` is a discovered repo root (callers pass renderer-supplied roots). */
  async hasRepo(root: string): Promise<boolean> {
    await this.current()
    return this.roots.includes(root)
  }

  /** Nearest repo root holding `path`, or null when no repo does. */
  repoFor(path: string): string | null {
    let best: string | null = null
    for (const r of this.roots) if (isWithin(path, r) && (best === null || r.length > best.length)) best = r
    return best
  }

  /** Be told about every new snapshot. Returns unsubscribe. */
  subscribe(fn: (snapshot: GitSnapshot) => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** Refresh the repo holding `path` now-ish (after an operation Pomade itself ran). */
  refreshPath(path: string): void {
    const root = this.repoFor(path)
    if (root !== null) this.schedule([root], false)
  }

  /** One repo's state read now, not the cached snapshot (E-039: an operation's preview and its
   *  pre-run check). Null when `root` is not a discovered repo. */
  async freshState(root: string): Promise<RepoState | null> {
    await this.current()
    const rootAbs = this.rootAbs
    if (!rootAbs || !this.roots.includes(root)) return null
    return readRepoState(rootAbs, root, this.roots, readRemotes(rootAbs, root))
  }

  /** Refresh one repo now-ish, its remotes re-read (after an operation Pomade itself ran). */
  refreshRepo(root: string): void {
    this.remotes.delete(root)
    this.schedule([root], false)
  }

  /** Re-run discovery now-ish (a repository was created). */
  rediscover(): void {
    this.schedule([], true)
  }

  /** Re-discover and refresh every repo (window focus). Throttled: flipping between apps does not
   *  re-run status on every repo each time. */
  refreshAll(): void {
    if (!this.started) return
    const now = Date.now()
    if (now - this.lastFullRefresh < FOCUS_REFRESH_MIN_MS) return
    this.lastFullRefresh = now
    this.schedule(this.roots, true)
  }

  private start(): void {
    if (this.started) return
    const root = configStore.getRoot()
    if (!root) return
    this.started = true
    this.rootAbs = root
    this.untaps.push(
      tapWorkspaceChanges((c) => this.onWorkingChange(c)),
      tapGitMetaChanges((c) => this.onMetaChange(c))
    )
    this.pendingDiscover = true
    this.lastFullRefresh = Date.now()
    this.ready = this.flush()
  }

  /** Drop everything (workspace teardown). */
  stop(): void {
    for (const u of this.untaps) u()
    this.untaps = []
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.states.clear()
    this.remotes.clear()
    this.roots = []
    this.pendingRepos.clear()
    this.pendingDiscover = false
    this.rootAbs = null
    this.ready = null
    this.started = false
  }

  /** After a workspace switch: start over against the new root if git state was in use. */
  restart(): void {
    if (!this.wanted) return
    this.stop()
    this.start()
  }

  private onWorkingChange(c: RawWorkspaceChange): void {
    // A repo folder (or one of its ancestors) renamed or deleted: discovery decides what is left.
    if (c.event === 'rename' && this.roots.some((r) => r !== '' && isWithin(r, c.path))) {
      this.schedule([], true)
      return
    }
    const root = this.repoFor(c.path)
    if (root === null) return
    // Inside a directory git already reports as ignored: nothing git reports can change.
    const state = this.states.get(root)
    if (state?.ignored.some((g) => g.dir && c.path !== g.path && isWithin(c.path, g.path))) return
    this.schedule([root], false)
  }

  private onMetaChange(c: RawWorkspaceChange): void {
    const m = /^(?:(.*?)\/)?\.git(\/|$)/.exec(c.path)
    if (!m) return
    const repoDir = m[1] ?? ''
    const isGitEntry = m[2] === ''
    if (isGitEntry || !this.roots.includes(repoDir)) this.schedule([], true)
    else {
      if (c.path.endsWith('/.git/config') || c.path === '.git/config') this.remotes.delete(repoDir)
      this.schedule([repoDir], false)
    }
  }

  private schedule(roots: readonly string[], discover: boolean): void {
    for (const r of roots) this.pendingRepos.add(r)
    if (discover) this.pendingDiscover = true
    if (this.timer || !this.started) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, REFRESH_WINDOW_MS)
  }

  private async flush(): Promise<void> {
    if (this.running) {
      // One follow-up run after the current one picks up whatever is pending by then.
      await this.running
      if (this.pendingRepos.size === 0 && !this.pendingDiscover) return
      return this.flush()
    }
    const rootAbs = this.rootAbs
    if (!rootAbs) return
    const discover = this.pendingDiscover
    const repos = new Set(this.pendingRepos)
    this.pendingDiscover = false
    this.pendingRepos.clear()
    this.running = (async () => {
      if (discover) {
        const found = await discoverRepos(rootAbs)
        if (this.rootAbs !== rootAbs) return
        for (const r of found) if (!this.states.has(r)) repos.add(r)
        // Nesting changed for a repo whose child appeared or vanished: refresh its parent too.
        const before = new Set(this.roots)
        for (const r of [...found.filter((f) => !before.has(f)), ...this.roots.filter((r) => !found.includes(r))]) {
          for (const p of found) if (p !== r && isWithin(r, p)) repos.add(p)
        }
        for (const r of this.roots) {
          if (found.includes(r)) continue
          this.states.delete(r)
          this.remotes.delete(r)
        }
        this.roots = found
      }
      const todo = [...repos].filter((r) => this.roots.includes(r))
      for (let i = 0; i < todo.length; i += STATUS_CONCURRENCY) {
        const batch = todo.slice(i, i + STATUS_CONCURRENCY)
        const states = await Promise.all(
          batch.map(async (r) => {
            // A full refresh re-reads every remote; otherwise only a repo without a cached entry.
            const cached = discover ? undefined : this.remotes.get(r)
            const remotes = cached ? Promise.resolve(cached) : readRemotes(rootAbs, r)
            return { state: await readRepoState(rootAbs, r, this.roots, remotes), remotes: await remotes }
          })
        )
        if (this.rootAbs !== rootAbs) return
        for (const { state, remotes } of states) {
          this.states.set(state.root, state)
          this.remotes.set(state.root, remotes)
        }
      }
      if (discover || todo.length > 0) this.emit()
    })()
    try {
      await this.running
    } finally {
      this.running = null
    }
    if (this.pendingRepos.size > 0 || this.pendingDiscover) this.schedule([], false)
  }

  private emit(): void {
    const snap = this.snapshot()
    safeBroadcast(EV.gitState, snap)
    for (const fn of [...this.listeners]) fn(snap)
  }
}

export const gitState = new GitStateService()

/** Wire the service's lifecycle: workspace switch and window focus. */
export function registerGitState(): void {
  onWorkspaceTeardown(() => gitState.stop())
  onWorkspaceReady(() => gitState.restart())
  app.on('browser-window-focus', () => gitState.refreshAll())
}
