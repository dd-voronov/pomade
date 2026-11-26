---
doc: docs/modules/editor/unsaved-recovery.md
audience: engineers, product
holds: unsaved-doc recovery — recovery copies, the "Recovered unsaved edits" banner, discarded drafts and their 7-day retention
kind: reference
---

# Unsaved-doc recovery — recovery copies and discarded drafts

**Module:** `editor` · **UI:** the banner "Recovered unsaved edits from 14:32." (Compare / Discard / Dismiss),
discarded-draft rows in Document history · **Code:** `src/renderer/modules/editor/useRecovery.ts` (copies and
drafts for one pane, quit flush), `useDocFile.ts` (restore at load), `DocNotices.tsx` (banner),
`src/main/recovery-store.ts` (store, prune), `src/shared/recovery.ts` (types, keys, verdicts, TTL),
`stores/tabs-store.ts` (discard guard registry) · **e2e:** `rule8-recovery.spec.ts`,
`quit-dirty-docs.spec.ts`

## What it does

Pomade never autosaves a doc, so unsaved edits are protected another way: every dirty buffer, Untitled docs
included, is copied to Pomade's user data a moment after typing stops. After a crash, force quit, reload or
kernel panic the tab reopens with the recovered buffer in place, marked dirty, under a banner. A discard
never destroys the edits either: the last unsaved state is kept as a discarded draft for 7 days. Nothing is
written into the workspace or into git.

## Recovery copies

- **Where and when.** `<userData>/recovery/buffers/<key>.json`, one `RecoveryRecord` per dirty buffer, written
  `RECOVERY_DEBOUNCE_MS` (2 s) after typing stops. Writes are atomic (tmp + rename) and ordered per key.
- **Key.** Workspace + doc path, or `untitled:<tabId>` for an Untitled doc (`recoveryKey` in `recovery.ts`);
  two workspaces never share a copy, and a version tab's copy is keyed by its tab (path `''`).
- **Content.** The buffer, title, time, an editing-stretch id, and the doc's **sync point** (the disk state
  the edits were made against; none for Untitled).
- **Lifecycle.** The copy is deleted when the buffer becomes clean (save, reload, edits undone) and is moved
  when an in-app rename, move or Save As retargets the tab. The quit handshake flushes every pending copy
  (`flushAllRecovery`) before main's teardown starts, so a crash during quit still finds the latest edits.
- **Rendered edits** reach the buffer through a debounce; the copy and every buffer read flush it first.

## Restoring

At load, a doc asks the store for its copy (`recovery.get`). Three outcomes:

- The copy equals the file: nothing to recover; the copy is removed.
- The copy differs and the file's bytes still match the copy's sync point (or the doc is Untitled, or the file
  is gone): the buffer is restored dirty and the banner **"Recovered unsaved edits from 14:32."** shows (a copy
  from another day adds the date, "Nov 8, 14:32"). Buttons: **Compare** (the quick peek on Saved ↔ Unsaved,
  see [diff-view](../git/diff-view.md)), **Discard** (tooltip "Revert to the saved version; your edits are kept
  as a discarded draft"; reloads the disk version), **Dismiss**. Keep working, or Cmd+S.
- The copy differs and the file's bytes changed since the copy was taken: the buffer is restored, the copy's
  sync point is kept so the save conflict guard holds, and the amber banner shows instead
  ([external-changes.md](./external-changes.md)).

An Untitled doc reopens as Untitled with its content. Recovery is best effort: a failure to read it never
prevents the doc from opening from disk. A copy whose tab was never persisted (a crash within the state-save
debounce of opening it) stays in user data until it is restored into its doc.

## Discarded drafts

These each keep the last unsaved state as a draft, then revert or close the buffer:

- **Discard** in the close guard;
- **Discard all changes** in the quit flow;
- the recovery banner's **Discard**;
- **Use disk version** in the disk ↔ my edits comparison;
- a version tab replacing a document that local history does not keep;
- a Git panel discard (the file's content, and its staged version when different).

Drafts live in `<userData>/recovery/drafts/`, **one per editing stretch** (dirty → clean; discarding the same
stretch twice overwrites), for `DRAFT_TTL_MS` (**7 days**); a launch-time prune (`pruneDrafts`) deletes
expired and unreadable ones across every workspace. Drafts have no UI of their own: they appear in Document
History's DISCARDED group, restorable and comparable ([Document history](../git/document-history.md)).
`window.pomade.recovery.drafts(path?)` lists the current workspace's, newest first.

## Boundaries worth knowing

- Two dirty tabs on the same file (one per project) share one recovery copy: the last one typed in wins.

Tickets: E-035, E-038, E-039, T-187, T-226.
