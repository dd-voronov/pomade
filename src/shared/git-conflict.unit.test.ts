import { describe, expect, it } from 'vitest'

import { UNDECIDED, conflictCount, parseMerged, parseRebaseFiles, resultText, takeInto } from './git-conflict'

const M = (ch: string, label = ''): string => `${ch.repeat(31)}${label ? ` ${label}` : ''}\n`

describe('parseMerged', () => {
  it('splits git merge-file --diff3 output into same stretches and conflicts', () => {
    const text = `intro\n${M('<', 'theirs')}their line\n${M('|', 'base')}old line\n${M('=')}your line\nyour second\n${M('>', 'yours')}outro\n`
    expect(parseMerged(text)).toEqual([
      { kind: 'same', text: 'intro\n' },
      { kind: 'conflict', theirs: 'their line\n', base: 'old line\n', yours: 'your line\nyour second\n' },
      { kind: 'same', text: 'outro\n' }
    ])
  })
  it('never reads a line of the file as a marker (short markers are content)', () => {
    const text = `<<<<<<< not a marker\n=======\n>>>>>>> still content\n`
    expect(parseMerged(text)).toEqual([{ kind: 'same', text }])
  })
  it('keeps an empty side, two conflicts in a row, and a last line without its line end', () => {
    const text = `${M('<', 'theirs')}${M('|', 'base')}gone\n${M('=')}kept\n${M('>', 'yours')}${M('<', 'theirs')}a\n${M('|', 'base')}${M('=')}b\n${M('>', 'yours')}tail`
    const segs = parseMerged(text)
    expect(segs).toEqual([
      { kind: 'conflict', theirs: '', base: 'gone\n', yours: 'kept\n' },
      { kind: 'conflict', theirs: 'a\n', base: '', yours: 'b\n' },
      { kind: 'same', text: 'tail' }
    ])
    expect(conflictCount(segs)).toBe(2)
  })
  it('leaves unbalanced markers as text — nothing is dropped', () => {
    const text = `a\n${M('<', 'theirs')}b\n${M('=')}c\n`
    expect(parseMerged(text)).toEqual([{ kind: 'same', text }])
  })
})

describe('take arrows and the result', () => {
  const segs = parseMerged(`top\n${M('<', 'theirs')}T\n${M('|', 'base')}B\n${M('=')}Y\n${M('>', 'yours')}end\n`)
  it('a take replaces an undecided result, a second take adds after it (both, in click order)', () => {
    const theirs = takeInto(UNDECIDED, 'T\n')
    expect(theirs).toEqual({ text: 'T\n', decided: true })
    expect(takeInto(theirs, 'Y\n')).toEqual({ text: 'T\nY\n', decided: true })
    expect(takeInto({ text: 'typed', decided: true }, 'Y\n')).toEqual({ text: 'typed\nY\n', decided: true })
  })
  it('joins the same stretches with each conflict’s result', () => {
    expect(resultText(segs, [{ text: 'Y\n', decided: true }])).toBe('top\nY\nend\n')
    // A typed result that lost its line end does not glue the next line on.
    expect(resultText(segs, [{ text: 'mine', decided: true }])).toBe('top\nmine\nend\n')
    // An emptied result drops the lines.
    expect(resultText(segs, [{ text: '', decided: true }])).toBe('top\nend\n')
  })
})

describe('parseRebaseFiles', () => {
  it('counts only the steps that replay a commit (--rebase-merges adds label / reset steps)', () => {
    expect(
      parseRebaseFiles({
        headName: 'refs/heads/feature\n',
        onto: 'abc\n',
        done: 'label onto\nreset onto\npick 111 First\npick 222 Second\n',
        todo: '# comment\npick 333 Third\nexec make\n'
      })
    ).toEqual({ branch: 'feature', onto: 'abc', step: 2, total: 3 })
  })
  it('the apply backend’s next / last; a detached rebase; missing files', () => {
    expect(parseRebaseFiles({ headName: 'refs/heads/x', onto: 'o', next: '1\n', last: '2\n' })).toMatchObject({ step: 1, total: 2 })
    expect(parseRebaseFiles({ headName: 'detached HEAD', onto: null })).toEqual({ branch: null, onto: null, step: 0, total: 0 })
  })
})
