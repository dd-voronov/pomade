---
doc: docs/modules/projects/icons.md
audience: engineers, product
holds: workspace, group and project icons — the three-source picker (Icons, Emoji, Image), sizes per tier, storage and precedence
kind: reference
---

# Icons — workspace, group, and project identity

**Module:** `projects` · **UI:** the Icon field in the group/project dialogs + the `Workspace icon`
dialog · **Code:** `src/renderer/modules/projects-panel/{IconPicker.tsx,icon-library.tsx,emoji-data.ts,IconGlyph.tsx,projects-panel-parts.tsx}`,
`src/main/fs-service.ts` (`fs.pickImage`) · **e2e:** `projects-panel-identity.spec.ts`, `icon-library.spec.ts`

## What it does

Everything in the Projects panel carries an icon, sized by its place in the hierarchy: the
**workspace** (48 px chip on the pinned row), **groups** (40/32/24/16 px by nesting depth), and
**projects** (16 px). Each is chosen in the same three-mode picker; unset falls back to a
default glyph (💠 workspace, 📁 group, 📄 project).

## The three-mode picker

A mode switcher — **Icons | Emoji | Image** — with a live preview and a `Clear icon` button. The
three sources are mutually exclusive (picking one clears the others); the picker opens on
whatever mode the current icon uses.

- **Icons** — a searchable predefined library, two sections:
  - *Use cases* — 10 hand-made monochrome glyphs (Music, Film-making, Software engineering,
    Money management, Games, Knowledge management, Writing, Translation, Gym / health, Personal
    life management);
  - *Brands* — 19 marks: 13 from the `simple-icons` set (YouTube, Instagram, Telegram, Spotify,
    Obsidian, Notion, Apple, Android, Google Translate, X, Pinterest, Airbnb, McDonald's) plus
    6 hand-made in the same style for brands that set has dropped (LinkedIn, Slack, Microsoft,
    MS Office, Amazon, Minecraft).

  Library glyphs are vectors tinted by the theme, so they stay crisp at every tier including the
  collapsed rail.
- **Emoji** — the full emoji set from `emojibase-data` (about 1,900 glyphs; skin-tone variants
  collapsed, modifier components excluded) in 9 categories — Smileys, People, Animals & nature,
  Food & drink, Travel & places, Activities, Objects, Symbols, Flags — with keyword search. Native
  glyphs, no external picker.
- **Image** — any png, jpg, gif, webp, svg or bmp file, chosen with a native dialog
  (`fs.pickImage`, no workspace constraint). The file is **always copied** into
  `.pomade/assets/<id>.<ext>`, so the config survives moving or deleting the original and stays
  portable; the stored value is that workspace-relative path. Re-picking a file already under
  `.pomade/assets/` makes no second copy.

## Where each icon is set

- **Project / group** — the Icon field in their New and Edit dialogs (kebab ▸ Edit).
- **Workspace** — click the icon on the Workspace row, or right-click the row ▸
  `Change icon…`; the `Workspace icon` dialog holds only the picker.

## Boundaries worth knowing

- A library icon is stored in the same `icon` field as an emoji, as a stable `lib:` id, so
  re-sourcing a brand mark cannot break saved configs. An image lives in `image` (projects and groups)
  or `identity.image` (workspace); the renderer shows `icon` first, then the image,
  then the default glyph.
- Clicking the currently-selected library/emoji cell deselects it (back to the default glyph).
- Rendered sizes are fixed by tier — the icon you pick is the identity, not the size.

Tickets: E-010, E-017.
