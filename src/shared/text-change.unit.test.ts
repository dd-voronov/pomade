import { describe, expect, it } from 'vitest'

import { minimalChange } from './text-change'

const apply = (s: string, c: ReturnType<typeof minimalChange>): string => (c ? s.slice(0, c.from) + c.insert + s.slice(c.to) : s)

describe('minimalChange', () => {
  const cases: [string, string][] = [
    ['abc', 'abc'],
    ['', 'x'],
    ['x', ''],
    ['hello world', 'hello brave world'],
    ['para one\npara two\n', 'para one\npara 2\n'],
    ['aaaa', 'aaa'],
    ['abab', 'ab'],
    ['start', 'restart'],
    ['emoji 😀 here', 'emoji 😃 here'],
    ['😀', '😃'],
    ['a😀b', 'a😀😀b']
  ]
  it.each(cases)('%j → %j applies exactly', (a, b) => {
    const c = minimalChange(a, b)
    expect(apply(a, c)).toBe(b)
    if (a === b) expect(c).toBeNull()
  })

  it('replaces only the middle', () => {
    expect(minimalChange('hello world', 'hello brave world')).toEqual({ from: 6, to: 6, insert: 'brave ' })
    expect(minimalChange('line 1\nline 2\nline 3', 'line 1\nLINE 2\nline 3')).toEqual({ from: 7, to: 11, insert: 'LINE' })
  })

  it('never cuts a surrogate pair', () => {
    const c = minimalChange('😀', '😃')!
    expect(c.from).toBe(0)
    expect(c.to).toBe(2)
  })
})
