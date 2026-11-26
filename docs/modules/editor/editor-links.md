---
doc: docs/modules/editor/editor-links.md
audience: engineers, product
holds: Cmd+click links in the editor — plain paths and URLs, [[wikilinks]], markdown links; resolution, routing, the ambiguity picker, the Live link popover and image chip
kind: reference
---

# Editor links — Cmd+click to open paths, wikilinks, markdown links and URLs

**Module:** `editor` (shares `terminal`) · **UI:** an underline under a link while Cmd is held; the
"N files named …" picker; the Live "Link URL" popover · **Code:** `src/renderer/modules/editor/editor-links.ts`
(scanner glue, href normalization, resolution), `cm-editor-links.ts` (Raw + Live engine),
`pm-editor-links.ts` (Rendered engine), `useEditorLinkNav.ts` (resolution bases, picker state),
`EditorLinkPicker.tsx`, `LiveEditor.tsx` (popover), `useDocActions.ts` (`handleOpenTarget`), and the
terminal stack it reuses: `src/renderer/modules/terminal/term-links.ts` (scanner),
`term-link-open.ts` (resolver and router) · **e2e:** `editor-links.spec.ts`, `editor-live-links.spec.ts`,
`editor-links.unit.test.ts`

## What it does

The editor opens links the way the terminal does ([file-and-url-links.md](../terminal/file-and-url-links.md)):
hold **Cmd** and the links on the line under the pointer underline; **Cmd+click** opens one. A plain click
never navigates: it only places the caret (in Live, a plain click on a link's text opens the URL popover
instead, below). Only links that resolve to something that exists are underlined: a dead path, a missing
markdown target or a prose word that merely looks like a file never is. The same layer runs in Raw, Live and
Rendered; Raw and Live share one CodeMirror extension, Rendered has a ProseMirror twin.

## Link kinds

Three kinds sit side by side on a line (`scanLineRegions`); wikilink and markdown-link spans mask the plain
scanner so one link is never detected twice.

- **Plain paths and URLs**: the terminal scanner verbatim (workspace-relative paths, `./` and `../`
  paths, absolute and `~/` paths, bare filenames, extension-less stems, `http(s)` URLs, with an optional
  `:line`).
- **`[[wikilinks]]`**: Obsidian semantics. `|alias` and `#heading` are stripped and the target is reduced to
  its basename; an extension-less target means a markdown file (stem lookup); no minimum length.
- **Markdown `[text](href)` links** (images `![…]` excluded): the destination is explicit and never guessed
  at. `http(s)` is a URL; `file://` is its decoded absolute path (a remote host is not a file link); any
  other scheme (`mailto:`, `obsidian:`) and a bare `#anchor` are not file links; otherwise `?query` and
  `#fragment` are dropped and percent-escapes decoded (`my%20note.md` names `my note.md`). A relative path
  resolves against the **doc's own folder** only, with no project or workspace fallback; `/abs` and `~/…`
  stand alone. In Rendered the link text is never read as a path: `[guide docs](x.md)` opens `x.md`.

## Resolution and routing

Plain paths and wikilinks resolve through the terminal resolver against three bases read fresh at each
hover or click (`useEditorLinkNav.ts`): the doc's own folder, the project root, the workspace root; an
unsaved Untitled doc uses the project root, an outside-workspace doc its own absolute folder. Results are
cached (positive about 5 s, negative about 30 s).

Resolved links route exactly like terminal links (`routeProbe` in `term-link-open.ts`):

| Target | Action |
|---|---|
| URL | default browser |
| file in the active project | doc tab, revealed in the file tree |
| file elsewhere in the workspace | doc tab here with the orange "Outside this project" mark |
| file outside the workspace | doc tab keyed on the absolute path, red "Outside the workspace" mark |
| image or binary inside the workspace | Reveal in Finder |
| image or binary outside the workspace | doc tab showing the refusal panel with Reveal in Finder |
| folder in the active project | reveal in the tree |
| any other folder | Reveal in Finder |

A `:line` suffix jumps to that line ([editing-modes.md](./editing-modes.md), reading position).

**Ambiguity.** A wikilink basename or bare name that exists in several places opens a menu instead of
guessing: header "N files named “name”", one row per file (name and folder). The pick opens that file through
the same router. Esc closes it.

## Cost model

Scanning is scoped to the one line under the pointer; the layer is inert while Cmd is up (no scan, no probe);
a document edit clears the underline; Cmd released, the pointer leaving, or the window blurring clears it
too. A Cmd+click on a link-shaped token that was never hovered resolves on the spot, then routes.

## Live view: popover and image chip

In Live a plain click on a markdown link's text opens the **Link URL** popover (edit the URL, Enter applies,
**Open** opens it, Esc cancels; see [live-view.md](./live-view.md)); **Cmd+click** skips it and opens the
destination. **Open** and a clicked `🖼 filename` image chip route through `handleOpenTarget`: `http(s)` to the
browser; a local path (resolved against the doc's folder, `file://` accepted, an absolute path inside the
workspace made workspace-relative) as its own doc tab, which for an image shows the type refusal panel.

## Test hook

`window.__pomadeEditorLinkResolve[tabId](text)` answers whether a line of text holds a link that resolves in
that doc's context; specs use it for the no-dead-links rule.

Tickets: T-184, T-198, E-020.
