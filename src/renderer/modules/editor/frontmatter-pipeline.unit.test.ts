// The editor's frontmatter pipeline end to end: a document's bytes are normalized (doc-io), split
// into block + body, edited by pomade-kit's block core as the properties panel does, re-joined
// and reconstructed. The block core itself is tested by pomade-kit's suite; this covers the
// editor's own steps around it.

import { addProperty, parseFrontmatter, removeProperty, setListValue, setScalarValue } from 'pomade-kit/frontmatter'
import { readFrontmatter } from 'pomade-kit/protocol'
import { describe, expect, it } from 'vitest'

import { normalize, reconstruct, splitFrontmatter } from './doc-io'

/** Apply one block edit to a document the way EditorPane does. */
function editDoc(raw: string, edit: (block: string) => string): string {
  const n = normalize(raw)
  const { frontmatter, body } = splitFrontmatter(n.text)
  return reconstruct(edit(frontmatter) + body, n)
}

const TICKET = [
  '---',
  'id: T-201',
  'status: planned # set by triage',
  'created: 2026-11-09',
  'tags: [platform, kit]',
  'parked: false',
  '---',
  '',
  '# Title',
  '',
  'Body.',
  ''
].join('\n')

describe('editor frontmatter pipeline', () => {
  it('types the rows of a ticket', () => {
    const parsed = parseFrontmatter(splitFrontmatter(TICKET).frontmatter)
    expect(parsed.ok).toBe(true)
    expect(parsed.rows.map((r) => [r.key, r.type])).toEqual([
      ['id', 'string'],
      ['status', 'string'],
      ['created', 'date'],
      ['tags', 'list'],
      ['parked', 'boolean']
    ])
  })

  it('changes only the edited line of a CRLF document, keeping its line endings', () => {
    const crlf = TICKET.replace(/\n/g, '\r\n')
    const out = editDoc(crlf, (b) => setScalarValue(b, 'status', 'done'))
    expect(out).toBe(crlf.replace('status: planned # set by triage', 'status: done # set by triage'))
  })

  it('keeps the body byte-identical through list edits and appended keys', () => {
    let out = editDoc(TICKET, (b) => setListValue(b, 'tags', ['platform', 'kit', 'e2e']))
    out = editDoc(out, (b) => addProperty(b, 'owner', 'alex'))
    expect(out).toBe(TICKET.replace('tags: [platform, kit]', 'tags: [platform, kit, e2e]').replace('parked: false\n', 'parked: false\nowner: alex\n'))
  })

  it('drops the block and its blank line when the last property is removed', () => {
    const doc = '---\nid: X\n---\n\n# Title\n'
    expect(editDoc(doc, (b) => removeProperty(b, 'id'))).toBe('# Title\n')
  })

  // A value with a control character (a pasted tab, a stray escape or bell) is written
  // double-quoted, so the document still parses and reads the value back unchanged.
  it.each([
    ['tab', 'a\tb'],
    ['line feed', 'a\nb'],
    ['bell', 'done\u0007'],
    ['escape', '\u001b[31mred'],
    ['DEL', 'a\u007fb']
  ])('a %s in a property value is written quoted and the doc still parses', (_name, value) => {
    for (const raw of [TICKET, TICKET.replace(/\n/g, '\r\n')]) {
      const out = editDoc(raw, (b) =>
        addProperty(setListValue(setScalarValue(b, 'status', value), 'tags', ['kit', value]), 'note', value)
      )
      expect(out.split(/\r?\n/)).toContain(`status: ${JSON.stringify(value)} # set by triage`)
      const read = readFrontmatter(out.replace(/\r\n/g, '\n'))
      expect('frontmatter' in read && read.frontmatter).toMatchObject({
        id: 'T-201',
        status: value,
        tags: ['kit', value],
        note: value
      })
      expect(out.endsWith(raw.slice(raw.indexOf('# Title')))).toBe(true)
    }
  })
})
