import { describe, expect, it } from 'vitest'

import { normalizeHref, scanLineRegions, type LineLinkRegion } from './editor-links'

/** Compact view of a region: the href for a markdown link, `cand:<target>` for a scanned token. */
function show(text: string, r: LineLinkRegion): string {
  const span = text.slice(r.from, r.to)
  return 'href' in r ? `md:${r.href}@${span}` : `cand:${r.candidate.target}@${span}`
}
const regions = (text: string): string[] => scanLineRegions(text).map((r) => show(text, r))
/** Same, minus extension-less prose-word STEM candidates (`Open`, `also` …) — those exist by design
 *  (they underline only if a file by that name exists) and would only be noise in these asserts. */
const nonStem = (text: string): string[] =>
  scanLineRegions(text)
    .filter((r) => 'href' in r || r.candidate.kind !== 'stem' || text.startsWith('[[', r.from))
    .map((r) => show(text, r))

describe('normalizeHref', () => {
  it('passes http(s) through as a URL', () => {
    expect(normalizeHref('https://example.com/a?b=1#c')).toEqual({ kind: 'url', url: 'https://example.com/a?b=1#c' })
  })
  it('keeps relative paths as written, minus query/fragment, percent-decoded', () => {
    expect(normalizeHref('../../jobs/x/match.md')).toEqual({ kind: 'path', path: '../../jobs/x/match.md' })
    expect(normalizeHref('notes/my%20note.md#Section')).toEqual({ kind: 'path', path: 'notes/my note.md' })
    expect(normalizeHref('a.md?raw=1')).toEqual({ kind: 'path', path: 'a.md' })
  })
  it('unwraps <…> destinations (which may hold spaces)', () => {
    expect(normalizeHref('<my note.md>')).toEqual({ kind: 'path', path: 'my note.md' })
  })
  it('turns file:// into its decoded absolute path; a remote host is not local', () => {
    expect(normalizeHref('file:///Users/me/My%20Docs/x.md')).toEqual({ kind: 'path', path: '/Users/me/My Docs/x.md' })
    expect(normalizeHref('file://localhost/tmp/x.md')).toEqual({ kind: 'path', path: '/tmp/x.md' })
    expect(normalizeHref('file://server/share/x.md')).toBeNull()
  })
  it('rejects pure anchors, empty hrefs and other schemes', () => {
    expect(normalizeHref('#heading')).toBeNull()
    expect(normalizeHref('')).toBeNull()
    expect(normalizeHref('mailto:a@b.c')).toBeNull()
    expect(normalizeHref('obsidian://open?vault=x')).toBeNull()
  })
  it('keeps a literal % that is not an escape', () => {
    expect(normalizeHref('100%done.md')).toEqual({ kind: 'path', path: '100%done.md' })
  })
})

describe('scanLineRegions — markdown links next to the plain detector', () => {
  it('a markdown link is ONE region carrying its href; the plain scanner never sees the href', () => {
    const t = '1. **[ElevenLabs PM](../../jobs/x/match.md)** (86) — see'
    expect(regions(t)).toEqual(['md:../../jobs/x/match.md@[ElevenLabs PM](../../jobs/x/match.md)'])
  })
  it('a guessable word in link TEXT is owned by the link, not guessed', () => {
    const t = 'See [guide docs](https://example.com/x) here.'
    const link = { from: t.indexOf('['), to: t.indexOf(')') + 1 }
    const inside = scanLineRegions(t).filter((r) => r.from < link.to && r.to > link.from)
    expect(inside.map((r) => show(t, r))).toEqual(['md:https://example.com/x@[guide docs](https://example.com/x)'])
  })
  it('links and guessed paths on the same line both detect, independently', () => {
    const t = 'Open [the plan](plan.md) and also notes/todo.md, then [[guide]].'
    expect(nonStem(t).sort()).toEqual(
      [
        'cand:guide@[[guide]]',
        'cand:notes/todo.md@notes/todo.md',
        'md:plan.md@[the plan](plan.md)'
      ].sort()
    )
  })
  it('several links on one line, a title, <…> and balanced parens', () => {
    const t = '[a](a.md) > [b](<b c.md>) > [d](d_(1).md "Title")'
    expect(regions(t)).toEqual(['md:a.md@[a](a.md)', 'md:<b c.md>@[b](<b c.md>)', 'md:d_(1).md@[d](d_(1).md "Title")'])
  })
  it('an image is not a markdown-link region (its path stays with the plain detector)', () => {
    expect(regions('![alt](pic.png)')).toEqual(['cand:pic.png@pic.png'])
  })
  it('an empty destination produces no region', () => {
    expect(regions('[x]()')).toEqual([])
  })
})
