---
doc: docs/contracts/ipc-workspace-and-files.md
audience: engineers
holds: the workspace, state, workspaceUi and fs IPC namespaces — workspace root and config, per-project state, file reads/writes/copies, the outside-workspace doors, watchers, the name and frontmatter indexes
kind: reference
---

# IPC: workspace, state, workspaceUi, fs

All paths are **workspace-relative** and escape-guarded in main (`fs-shared.ts#abs` rejects a path
that resolves outside the root) unless the method says *absolute*. The `…Outside` doors are the only
channels that touch a path outside the workspace; each requires an absolute path (`requireAbs`), so
a relative `../` can never be laundered through them.

## `workspace` — the root and `workspace.json`

```ts
pick(): Promise<string | null>
get(): Promise<{ root: string | null; config: WorkspaceConfig }>
saveConfig(config: WorkspaceConfig): Promise<void>
pickRoot(): Promise<string | null>
change(root: string): Promise<{ root: string | null; config: WorkspaceConfig }>
```

- The root: `POMADE_WORKSPACE` wins, else `app.json`'s `workspaceRoot`. Setting a root bootstraps
  `.pomade/` with a `.gitignore` holding `state/`.
- `pick` — a native folder dialog that **commits** the choice (first run). `pickRoot` — an
  unconstrained folder dialog that only **returns** the path. `change(root)` commits a switch:
  `flushPendingWrites()` → the `config-store.onWorkspaceTeardown` hooks (kill every PTY, stop the
  tree and open-doc watchers, drop the name index, stop git state and local history, end app
  frames' watches, clear the bus's sticky `pomade.ready`) → set, bootstrap and persist the root →
  the `onWorkspaceReady` hooks (warm the name index, scrollback GC, restart git state, local
  history and with-Pomade backends, refresh commands) → the new `get()`. `pick` fires the ready
  hooks too. The caller flushes the old workspace's renderer state first (`workspace-store.changeWorkspace`,
  [stores](./stores.md)). A workspace switch and a project deletion are the only paths that kill PTYs.
- `saveConfig` — fire-and-forget into main's debounced, atomic writer (`DEBOUNCE_MS` 500,
  coalesced per file; `flushPendingWrites()` on quit and switch).

## `state` — `.pomade/state/<projectId>.json`

```ts
load(projectId: string): Promise<ProjectState | null>
save(projectId: string, state: Partial<ProjectState>): Promise<void>
remove(projectId: string): Promise<void>
```

- `save` merges the partial over main's cached copy (seeded by `load`), then schedules the debounced
  write — each renderer store sends only the fields it owns. `load` defaults `mounts` and
  `collapsedRoots` to `[]`.
- `remove` deletes the file on project teardown: the id must match `^[A-Za-z0-9_-]{1,128}$`
  (one path segment), a missing file resolves, and any queued or in-flight debounced write to that
  path is cancelled and its cache entry dropped, so a save scheduled by the teardown's own tab
  closes cannot resurrect it.

## `workspaceUi` — `.pomade/state/workspace-ui.json`

```ts
load(): Promise<WorkspaceUiState>          // defaults filled; no workspace ⇒ empty state
save(patch: Partial<WorkspaceUiState>): Promise<void>   // merged in main over the last-known state
```

## `fs` — reading and writing

```ts
tree(rootRel: string, depth?: number, opts?: { includeIgnored?: boolean }): Promise<FileNode>
read(rel: string): Promise<string>
write(rel: string, content: string, opts?: { exclusive?: boolean }): Promise<WriteFileResult>
createFile(rel: string): Promise<void>
createDir(rel: string): Promise<void>
exists(rel: string): Promise<boolean>
stat(rel: string): Promise<FileStat>
readDataUrl(rel: string): Promise<string>
copyDir(srcRel: string, destRel: string): Promise<void>
type WriteFileResult = { ok: true } | { ok: false; code: 'EEXIST' }
```

- `tree` — depth-bounded walk. Entries matching `WorkspaceConfig.fileTree.ignore`, and the
  local-history stores matched by workspace-relative path (`isLocalHistoryStorePath`:
  `Apps/Pomade/local-history`, `Apps/Pomade/dev/local-history` — never a folder merely named so), are
  omitted, or with `includeIgnored` returned with `ignored: true`. A folder listed in
  `fileTree.unwatched` is listed as usual, with `unwatched: true`; the renderer re-reads it (and
  anything inside it) on every expand, since no `fs:changed` names it. A symlink is detected by `lstat`
  (`symlink: true`, `broken: true` when its target is missing); `kind` is the target's. A symlinked
  directory is walked only when it is the explicit root of the call, never followed deeper.
- `write` creates parent folders. With `exclusive` the write uses `wx` and a collision resolves
  `{ ok: false, code: 'EEXIST' }`; every other failure rejects. `createFile` refuses to clobber
  (`wx`); `createDir` is recursive.
- `stat` — `size`, `mtimeMs`, `isFile` from `stat` (the target), `isSymbolicLink` from a parallel
  `lstat` (the path itself); rejects when the path is absent.
- `copyDir` — project templates.

## `fs` — file management

```ts
duplicate(srcRel: string): Promise<string>               // "<name> copy.<ext>", then " copy 2", …
copyTo(srcRel: string, destDirRel: string): Promise<string>
rename(srcRel: string, destRel: string): Promise<string>
move(srcRel: string, destRel: string, opts?: { onCollision?: 'rename' | 'overwrite' }): Promise<string>
copy(srcRel: string, destRel: string): Promise<string>
trash(rel: string): Promise<void>
linkTarget(rel: string): Promise<LinkTarget>
```

- Every method returns the new workspace-relative path.
- **Collision rules.** `duplicate`, `copyTo` and `copy` are collision-safe: an existing name becomes
  `"<stem> copy<ext>"` / `"<stem> copy N<ext>"` (a folder's whole name is the stem). `rename` and
  `move` refuse an existing destination (message contains `already exists`); a no-op to the same
  path is allowed. `move` with `onCollision: 'rename'` takes the collision-safe name;
  `'overwrite'` replaces a destination **file** with a source **file**, the displaced file going to
  the OS trash, and refuses when either side is a folder. `move` and `copy` refuse a folder into
  itself or a descendant (`Cannot move a folder into itself`).
- `trash` — `shell.trashItem`; nothing is ever `rm`-ed.
- `linkTarget` — `targetAbs` is the realpath of the final target; a broken link returns
  `exists: false` with the `readlink` text resolved against the link's folder; `targetRel` is
  workspace-relative when the target is inside the workspace, else `null`.
- In-workspace and outside doors share the absolute-path cores (`moveEntryCore`, `copyEntryCore`,
  `copyFileSafeCore`), so their collision, self-descendant and trash semantics are identical.

## `fs` — outside-workspace doors

```ts
readOutside(absPath: string): Promise<string>
writeOutside(absPath: string, content: string): Promise<void>
statOutside(absPath: string): Promise<FileStat>
treeOutside(absPath: string, depth: number): Promise<FileNode>      // FileNode.paths are absolute
watchOutside(absPath: string): Promise<void>
unwatchOutside(absPath: string): Promise<void>
createFileOutside(absPath: string): Promise<void>                   // refuses to clobber
createDirOutside(absPath: string): Promise<void>                    // recursive, idempotent
renameOutside(absPath: string, newName: string): Promise<string>    // sibling rename, collision-refusing
duplicateOutside(absPath: string): Promise<string>                  // files only
moveOutside(srcAbs: string, destAbs: string, opts?: { onCollision?: 'rename' | 'overwrite' }): Promise<string>
copyOutside(srcAbs: string, destAbs: string): Promise<string>
trashOutside(absPath: string): Promise<void>
```

- An outside doc is a `DocTab` whose `path` is absolute (a workspace-relative path never starts with
  `/`). The renderer routes a node or doc to the outside door by `path.startsWith('/')`.
- `treeOutside` uses the index ignore set (`INDEX_IGNORE_NAMES`) and rejects when the root is gone
  (the tree's "missing" state).
- Outside paths are **tree-display only**: no name index, no frontmatter index, no git discovery.
- Each method is a separate door so it can be reasoned about and disabled independently; there is
  no main-side mount allowlist.

## `fs` — watchers

```ts
watch(rootRel: string): Promise<void>          // → EV 'fs:changed' FsChangedEvent { root: rootRel, changes }
unwatch(rootRel: string): Promise<void>
onChanged(cb: (e: FsChangedEvent) => void): () => void
watchDocs(paths: string[]): Promise<void>      // → EV 'fs:doc-changed' (path); see documents.md
onDocChanged(cb: (path: string) => void): () => void
```

- **One native recursive `fs.watch` per watched root** (FSEvents: one descriptor whatever the tree
  size). Per-directory watchers are forbidden. Events are filtered by `WATCH_IGNORE_NAMES`
  (`shared/ignore-names.ts`, broader than the tree's display list) and, by workspace-relative path,
  by the skipped paths (`main/skipped-paths.ts#isSkippedRel`: the local-history stores plus the live
  `fileTree.unwatched` list, `shared/skipped-paths.ts#isSkippedPath`) — a write there reaches no tap
  (git state and git metadata, app watches, local history) and no `fs:changed` — and batched per root
  (`shared/change-batch.ts`): the batch closes 180 ms after its last event and never later than
  `BATCH_MAX_WAIT_MS` (1 s) after its first, so a file written continuously cannot hold it off.
- `fs:changed` carries the batch: each changed path (`FsChange`, workspace-relative, absolute under
  an outside mount) with whether it exists when the batch closes. `changes` is `null` when the
  paths are unknown — an event without a path, more than `BATCH_MAX_PATHS` (1000) paths, or an
  outside root's own appearance or removal — and the consumer re-reads everything under `root`.
  Consumers decide by existence, never by the native event kind: macOS reports a plain write as a
  rename. The file tree re-reads a loaded folder only when a path's existence contradicts its
  listing (an entry appeared, disappeared or was renamed); a write to a listed file, or to a name
  the tree hides (an ignored item while ignored items are hidden), reads nothing.
- An in-workspace entry has two kinds of holders: the file tree (`watch` / `unwatch`, idempotent per
  root) and hosted-app `files.watch` holds (counted). The descriptor closes when neither holds it;
  only a tree-held entry broadcasts `fs:changed`. Taps (`tapWorkspaceChanges`, `tapGitMetaChanges`)
  feed app watches and the git-state service from the same descriptors.
- `watchOutside(abs)` opens a recursive watch on the root plus a **non-recursive** watch on its
  nearest existing ancestor (the root's own creation, deletion and rename); events arrive on the
  same `fs:changed`, keyed by the absolute root. Idempotent.
- `watchDocs` is independent of the tree watchers: the open-doc watcher of
  [documents](./documents.md).

## `fs` — pickers

```ts
pickPath(opts?: { directory?: boolean; defaultRel?: string; image?: boolean }): Promise<string | null>
pickImage(): Promise<string | null>
```

`pickPath` refuses a selection outside the workspace. `pickImage` is unconstrained: an image inside
the workspace returns its path; one outside is copied to `.pomade/assets/<16 hex>.<ext>` and the
copy's path returned. `POMADE_PICK_PATH` stubs the dialog ([test-hooks](./test-hooks.md)).

## `fs` — indexes

```ts
frontmatterIndex(): Promise<FrontmatterIndex>
probePath(input: string, baseAbs?: string): Promise<PathProbe | null>
findByName(name: string, projectRootAbs?: string): Promise<string[]>
findByStem(word: string, projectRootAbs?: string): Promise<string[]>
findDirsBySuffix(token: string, projectRootAbs?: string): Promise<string[]>
findFilesBySuffix(token: string, projectRootAbs?: string): Promise<string[]>
```

- `frontmatterIndex` — key frequencies, and per key value frequencies, over every workspace `.md`
  file's leading `---` block; bounded walk over `INDEX_IGNORE_NAMES`; cached per run and workspace
  root. A stale answer is acceptable (suggestions only).
- `probePath` — resolves one token (absolute, `~/…`, or relative to `baseAbs`) and stats it; accepts
  targets **outside** the workspace (read-only). `null` = nothing there. `abs` is the realpath,
  `isSymbolicLink` is one `lstat` of the raw path.
- The four `find*` methods read **one name index**: files and directories keyed by lowercased
  basename and by lowercased basename-minus-extension. Built eagerly when a root is set
  (`warmNameIndex()` at boot and on switch), kept fresh by one index-owned recursive watcher
  (dirty folders, 200 ms debounce, re-read only those) plus a full rebuild every 5 minutes; if the
  watcher fails it degrades to lazy build with a 30 s TTL. Walk ignores = the workspace's ignored items plus
  `INDEX_IGNORE_NAMES`, plus the skipped paths — local-history stores and unwatched folders — by
  path (`walkWorkspace`'s `workspaceRoot`, `isSkippedAbs`; the index watcher and reconcile too, and
  the frontmatter index walk). config-store sets the unwatched list at activation and on every
  `workspace.saveConfig`; a folder entering or leaving it marks its parent dirty, so the index purges
  or walks it in at once. Matching is case-insensitive (`toLowerCase()`, no locale collation); results
  are ranked exact-case first, then inside `projectRootAbs`, then walk order (stable), and capped at
  20 (`FIND_BY_NAME_MAX`; the stored bucket holds 40). Zero results ⇒ not a link; one ⇒ open; many ⇒
  the picker.
  - `findByName` — basename match. `findByStem` — stem match, then files named exactly `word`.
  - `findDirsBySuffix` — directories whose path ends with the token's full trailing segments.
    `findFilesBySuffix` — files likewise, matched on whole segments (`docs-reviewed/x.md` never
    matches `session-docs-reviewed/x.md`); a trailing slash returns none.
- Main diagnostics only: `globalThis.__pomadeNameIndex` (`builds`, `patches`, `watching`,
  `lastBuildMs`, `files`, `dirs`) and `globalThis.__pomadeNameIndexRewalk()`.

Tickets: E-004, E-006, E-008, E-012, E-014, E-016, E-020, E-021, E-026, T-019, T-091, T-102, T-131, T-133, T-156, T-188.
