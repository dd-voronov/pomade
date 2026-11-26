---
doc: docs/modules/tabs/tab-details.md
audience: engineers, product
holds: the Tab details popup — a tab's raw persisted JSON, editable; save semantics, validation, why edits stick
kind: reference
---

# Tab details — the raw-JSON admin/debug popup

**Module:** `tabs` · **Trigger:** per-tab right-click → **Show tab details** (`menu-tab-details`,
every kind) · **Code:** `src/renderer/layout/TabDetails.tsx` + `TabDetails.module.css`,
`src/renderer/layout/TabContextMenu.tsx` (menu item), `src/renderer/layout/TabStrip.tsx` (wiring),
`src/shared/types.ts` (allowlist + field-type map) · **e2e:** `tab-details.spec.ts`

## What it does

A dev/admin window into what Pomade actually stores about a tab — captured session id, saved last
command, cwd, bind state, colors, dirty flag, etc. — **and** the ability to fix it by hand. The
motivating case is a wrong/missing `resumeSessionId` that could otherwise only be repaired by
editing the per-project state file blind.

The popup (a modal over the shared `Modal` scrim, titled `Tab details`, testid `tab-details`;
footer buttons `Cancel` and `Save`) shows the tab's **raw persisted JSON**: the exact `Tab` object
(any of the nine kinds) as it sits in `ProjectState.openTabs`, pretty-printed 2-space in a monospace
**editable** textarea (`tab-details-textarea`). For a doc tab that includes its saved reading
position (`viewport`) and, on a version tab, its `version`. It renders from the **live** tabs-store —
the `.pomade/state/<projectId>.json` file is only that store's write-behind mirror, so the popup
always shows the current truth, not a stale file. Only the tab's own object is shown (never
`reopenStack` or other project state). A line under the title says the JSON is raw, editing is
state-only, and deleting a key clears the field.

The item sits in its **own separated section at the bottom** of the per-tab context menu, offered
on every kind. If the tab closes while the popup is open, the popup closes.

## Save semantics

Save is deliberately **state-only** — it patches the store via `tabs-store.updateTab` (so
persistence and re-render follow the normal path) and takes **no side actions**: no relaunch, no
rebind, no validation calls. Edited values take effect wherever the app naturally consumes them —
the strip repaints the title immediately (it renders from the store); `resumeSessionId` is read at
the next revive/relaunch.

- **Changed-fields-only.** The object is snapshotted when the popup opens; Save parses the edited
  text and applies **only the keys that differ** from that snapshot. A concurrent self-update to an
  untouched field therefore survives, and on a field that was both edited *and* concurrently
  updated the manual edit wins.
- **Deleting a key clears the field.** A key present in the open-time snapshot but absent in the
  edited text is a deletion → applied as `undefined`. `updateTab`'s spread merge sets the key to
  `undefined`; `config-store.saveState` replaces the whole `openTabs` array and `JSON.stringify`
  drops undefined keys, so the field leaves the file. Consumers already treat *absent* as *cleared*
  (`!tab.resumeSessionId`, `!tab.lastExec`, an absent `color`/`renamed`), so a deletion behaves
  exactly like the field never having been set.
- **Validation** — the parsed object is checked against a per-kind **allowlist + field-type map**
  co-located with the Tab types in `src/shared/types.ts` (`TAB_FIELD_ALLOWLIST`, `TAB_FIELD_TYPES`, one entry per kind; terminal and agent share the
  `TerminalTab` surface; each map is `satisfies Record<keyof ...Tab, TabFieldType>`, so a field added
  to a tab interface without a map entry fails typecheck). Value types are `string`, `boolean` or a
  plain JSON `object` (a `null` or an array is rejected for it). Any of these **rejects**, keeping the popup open with the text intact and
  showing the error (`tab-details-error`):
  - invalid JSON (the parse message);
  - an unknown key (names the allowed keys for the kind — guards a silent typo like
    `resumeSesionId`);
  - a wrong type for a known key (names the field and the expected type, e.g. a string
    for the boolean `dirty`);
  - a JSON value that is not an object;
  - a changed **or removed** `id`/`kind` (`TAB_IMMUTABLE_FIELDS` — panes, PTYs, and scrollback
    snapshots key off `id`, and a mid-life `kind` change is meaningless).

  A successful Save closes the popup. Esc and a scrim click cancel (shared `Modal` conventions).

- **Changed-underneath hint** (`tab-details-hint`): if the underlying tab object changes while the
  popup is open (a store update), a subtle hint appears. It is **view-only awareness** — the
  textarea is never reloaded and Save is never blocked (the diff still runs against the open-time
  snapshot, so edits win on the fields the user touched).

## Why edits stick

Nothing re-asserts a *stale cached value* over a manual edit, while a genuinely **new** session id
still overwrites (the desired self-update). Every `TerminalTab` field writer in `terminals-store`
(`handleSessionId`, `handleCwd`, `handleExec`, `handleAgentStart`, `handleAgentExit`, `reviveTab`,
`relaunch`) is **event-driven and change-gated**:

- they fire only on a genuine live signal — a session id adopted by `session-watcher.adopt`
  (itself guarded by `if (term.sessionId === sessionId) return`), a `cd`/first-prompt marker, a
  real `preexec`, an agent lifecycle edge, or a project-open revive;
- each guards `if (tab.<field> === new) return` and `status === 'live'`.

There is **no periodic or cached re-broadcast**: with no bind window open, main never re-emits its
cached `sessionId`; the marker scanner runs only on live `pty.onData`, never on the `pty.replay`
that repaints a re-attaching pane; and a **dead** tab's fields are frozen by the `status === 'live'`
guards. So a hand-edited value is never overwritten by a stale one, and a new session started in
the tab (`/clear` + a fresh prompt → a new transcript in the bind window) captures and overwrites
normally. The stickiness is inherent to the design; no extra guard exists for it.

## Tests

`tab-details.spec.ts` — 7 tests covering: the menu item on all three kinds (as the last item)
plus the exact JSON content and Esc/scrim cancel; a title edit repainting the strip and reaching
the state file; changed-fields-only (a concurrent edit to an existing field and an added field both
survive Save); key deletion clearing store + file; all five reject paths; the changed-underneath
hint without a reload; and the live-agent stickiness proof (edit `resumeSessionId`, confirm it
holds, then a new session re-captures). The three load-bearing slices (changed-fields-only, the
immutable guard, the unknown-key allowlist) are revert-proven.

Tickets: T-150, T-185, T-226.
