import { describe, expect, it } from 'vitest'

import { editorSearchKeymap } from './cm-search-keys'

describe('editorSearchKeymap', () => {
  const keys = editorSearchKeymap.map((b) => b.key)
  it('binds neither Cmd+G nor Cmd+Shift+G', () => {
    expect(keys.filter((k) => k === 'Mod-g' || k === 'Mod-Shift-g' || k === 'Shift-Mod-g')).toEqual([])
  })
  it('keeps Cmd+F and the rest of the search keys', () => {
    expect(keys).toEqual(expect.arrayContaining(['Mod-f', 'Escape', 'Mod-Shift-l', 'Mod-Alt-g', 'Mod-d']))
  })
})
