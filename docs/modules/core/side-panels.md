---
doc: docs/modules/core/side-panels.md
audience: engineers, product
holds: the icon strip and the side panel — icons, panels, icon actions, badges, collapse and width, per-project selection; how it is built
kind: reference
---

# Side panels — the icon strip and the side panel

**Module:** `core` · **UI:** the icon strip and the side panel, between the Projects panel and the main area · **Code:**
`src/renderer/modules/side-panels/` (`IconStrip.tsx`, `SidePanel.tsx`, `shown-panel.ts`, `strip-model.ts`,
`builtin-panels.tsx`, `app-panel-routes.ts`), `src/renderer/modules/apps/` (`AppIcon.tsx`, `backend-status.ts`, `open-app.ts`),
`src/main/app-icon-tint.ts`, `src/renderer/stores/side-panel-store.ts`, badges in
`src/renderer/stores/marks-store.ts` (app badges set from `src/renderer/stores/apps-store.ts`) · **unit:** `strip-model.unit.test.ts`,
`backend-status.unit.test.ts`, `app-icon-tint.unit.test.ts` · **e2e:** `side-panels.spec.ts`, `layout.spec.ts`,
`git-panel.spec.ts`, `app-backend-tooltip.spec.ts`, `app-keyed-tabs.spec.ts` (the kind's icon), `app-tab-set-route.spec.ts` (icon-tab click), `app-panel-show.spec.ts` (an app brings its panel forward) ·
**Contract:** [HOST-API](../../HOST-API.md) §1 `strip`, §3 `welcome`, §4 `strip`, §4 `panel`

## What it does

Left of the main area sit the **icon strip** (`IconStrip`, aria `Icon strip`) and the **side panel**
(`SidePanel`). The strip is always visible — with the side panel expanded or collapsed — and holds Pomade's own panels first
(Files, Git, Notices), then every available app's icons in manifest order (apps by name). An
unavailable app contributes none. One icon's panel fills the side panel;
which one is remembered per project. Panels never add tabs: the main-area tab strip changes
only when an icon's action opens a tab.

## Icons and their actions

Each icon does one of three things on click (`clickOutcome`):

| Action | Click | Selected look |
|---|---|---|
| `panel` | fills the side panel; expands it when collapsed | yes |
| `tab` | opens the app's tab for this icon in the active project, or focuses it if open; the side panel stays as it is | never |
| `both` | the two at once: the tab on the icon's `route`, the panel on its `panelRoute` (else `route`) | yes |

The selected panel icon has the active background and a short accent bar on the strip's left
edge. Hovering an icon shows its title, plus "Opens in a tab" / "Opens a tab and the panel" for
the other two actions, and for an app with a backend the "Background: …" lines
([app backends](./app-backends.md) "Backends that run with Pomade") — with an amber dot on the icon's
corner while the backend is stopped or restarting. An icon wears its manifest image, else the app's icon, else the generic
app glyph. A tab opened from an icon takes the icon's title and image, and keeps the icon id
(`AppTab.icon`), so a second click focuses it instead of opening another — only focuses: when the app moved that tab
to another route itself (`tabs.setRoute`) the click leaves it there ([app hosting](./app-hosting.md)
"Opening an app at a route"); a tab opened from the
new-tab menu is a separate tab (no icon, the app's default view). A keyed tab an app opens for
itself belongs to no strip icon: it shows its app tab kind's image (`HostedApp.tabKinds`), else the app's.

**Icon colour.** An app icon that is a one-colour SVG (`currentColor`, the HOST-API §1 rule, or
any single fixed colour) is drawn by Pomade: a CSS mask of the image filled with the button's
`currentColor` (`AppIcon`, `.tinted`), the same 18px box as a built-in glyph. It is therefore
exactly as Files and Git are — `--text-muted` idle, `--text` on hover and when selected, the same
colour transition — and in the tab strip and the new-tab menu it takes the surrounding text
colour. Main decides per image when it scans the app (`isTintableIcon`, `src/main/app-icon-tint.ts`:
an `.svg` with at most one paint colour and no gradient, pattern or embedded image) and reports
it as `iconTint`. Any other image — a raster, a multi-colour SVG — is shown as it is, untinted,
because a mask would flatten it into a single-colour silhouette.

**Tab titles follow the manifest.** An app tab's title is its icon's title (the app's name for an
icon-less tab, its kind's title else the app's name for a keyed tab) until the user renames the tab
(`AppTab.renamed`) or, for a tab the app titled itself (`title`, `tabs.setTitle`; `AppTab.appTitled`),
for good. A reinstall or relink that
renames an icon, or the app, retitles its open tabs in every project, restored ones included
(`startAppTabTitles`); an icon the manifest no longer declares leaves its tab's title as it was.

**Many icons:** the icon list scrolls inside the strip (no visible bar); the strip's width never
changes.

## Panels

- **Files** is the file tree, unchanged (see [the tree](../filetree/the-tree.md)), and the
  default panel.
- An **app panel** is the app's UI in an `<iframe>` on the `panel` surface, under a header with
  the icon's title and a collapse button. Its `welcome` tells it the surface, icon and route
  (HOST-API §3). It mounts the first time it is shown — or, for an app that starts on launch,
  hidden at launch ([app hosting](./app-hosting.md)) — and then stays mounted — across panel
  switches, project switches and side panel collapse — so the app keeps its state and keeps
  receiving `project.changed` while hidden. A missing or broken app shows the "App unavailable"
  card in the panel.

  An app can also bring its own panel forward itself (`panel.show`, from any of its frames, shown or
  hidden): the active project's selection becomes that icon's panel and a collapsed side panel
  expands — a click on the icon minus its tab, so an icon with action `both` opens no tab. Keyboard
  focus does not move. The call may name a route: the panel frame is at it afterwards (a mounted frame
  hears `route.changed`, a frame the call mounts opens at it), recorded per icon in
  `app-panel-routes.ts` and kept for the run; after a restart the panel opens at its icon's
  `panelRoute` (else `route`) ([app hosting](./app-hosting.md) "Showing the app's own side panel").
  The selection it makes is persisted like a click's.
- **Git** is the [Git panel](../git/git-panel.md): repos, uncommitted changes and landed history for
  the Projects panel selection. Like Files it is mounted for the life of the side panel and hidden, never
  unmounted.
- **Notices** is the notices list ([notices](./notices.md) "The Notices panel"), mounted
  the same way.

A reveal in the tree (go-to-path, symlink popover, "Reveal in tree", an app's `files.reveal`)
brings Files forward — expanding a collapsed side panel first when the reveal is an app's
([workspace data API](./workspace-data-api.md) "Revealing a path in the Files panel").

## Badges

An app sets a count badge on any of its own icons with `strip.setBadge { icon, count, urgent? }`
from any of its frames or its backend; `count: 0` clears it. The badge sits on the icon's top-right
corner: an accent chip, **red when urgent** (grey when quiet, which only the Notices icon uses),
capped at `99+`; the icon's accessible name gains the count ("Planner (3)").
Badges are runtime-only: an app that reloads (update, relink) or becomes unavailable starts
badge-less and sets them again when it runs. Every icon — Files, Git, Notices and app icons — draws
its badge from the same marks ([notices](./notices.md) "Marks and badges"): the
Notices icon counts unread notices; Pomade's own producers mark Files and Git the same way.

## Collapse and width

**Cmd+Shift+B** (View ▸ Toggle Side Panel; main matches it on the physical key, before any page or
app frame sees it), the `«` in the Files, Git, Notices or app-panel header ("Collapse side panel"),
or the `»` at the bottom of the collapsed strip ("Expand side panel") toggle the side panel. Collapsed, only the strip remains
(`LAYOUT_LIMITS.stripWidth`, 44 px). Expanded, the side panel takes the
stored file-tree width beside the strip; the divider resizes the panel. Collapsing is a pure width change — panes,
terminals and app frames are untouched.

## Persistence

The selected icon is `sidePanel` in `.pomade/state/<projectId>.json` (`'files'`, `'git'`, `'notices'`
or `app:<appId>/<iconId>`). Until a project's selection has loaded the side panel shows Files. A stored
icon that is gone or tab-only shows Files without being rewritten, so a dev app that is briefly
down gets its panel back when it returns. The side panel's width
and collapse are layout settings in `.pomade/state/view.json`.

## Boundaries worth knowing

- Panels are global per window (one frame per icon, following the active project), not one per
  project.
- An app cannot badge an icon it does not declare (`invalid-params`), and a badge needs a running
  session of the app (a frame or its backend).

Tickets: E-045, T-244, T-268, T-269, T-275, T-325.
