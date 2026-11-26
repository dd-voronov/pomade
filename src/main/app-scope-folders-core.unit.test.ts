import { describe, expect, it } from 'vitest'

import { SCOPE_FOLDERS_MAX } from 'pomade-kit/protocol'

import { foldersOf, removedApps, withFolder, withoutApps, withoutFolder } from './app-scope-folders-core'

const LIST = [
  { appId: 'planner', path: 'Pomade-Notes/alpha' },
  { appId: 'runner', path: '/Users/me/jobs' },
  { appId: 'planner', path: '/Users/me/notes' }
]

describe('app scope folders', () => {
  it("lists one app's folders in the order added", () => {
    expect(foldersOf(LIST, 'planner')).toEqual(['Pomade-Notes/alpha', '/Users/me/notes'])
    expect(foldersOf(LIST, 'other')).toEqual([])
  })

  it('adds at the end; the same folder again changes nothing; another app may hold the same path', () => {
    expect(withFolder(LIST, 'planner', 'X')).toEqual([...LIST, { appId: 'planner', path: 'X' }])
    expect(withFolder(LIST, 'planner', '/Users/me/notes')).toBe('unchanged')
    expect(withFolder(LIST, 'runner', 'Pomade-Notes/alpha')).toEqual([...LIST, { appId: 'runner', path: 'Pomade-Notes/alpha' }])
  })

  it(`an app keeps at most ${SCOPE_FOLDERS_MAX} per project; others are not counted`, () => {
    const full = Array.from({ length: SCOPE_FOLDERS_MAX }, (_, i) => ({ appId: 'planner', path: `F${i}` }))
    expect(withFolder(full, 'planner', 'one-more')).toBe('full')
    expect(withFolder(full, 'planner', 'F0')).toBe('unchanged')
    expect(withFolder(full, 'runner', 'F0')).toHaveLength(SCOPE_FOLDERS_MAX + 1)
  })

  it("removes only the app's own folder; an unknown one changes nothing", () => {
    expect(withoutFolder(LIST, 'planner', 'Pomade-Notes/alpha')).toEqual([LIST[1], LIST[2]])
    expect(withoutFolder(LIST, 'runner', 'Pomade-Notes/alpha')).toBe('unchanged')
    expect(withoutFolder([], 'planner', 'x')).toBe('unchanged')
  })

  it("drops every folder of the given apps", () => {
    expect(withoutApps(LIST, new Set(['planner']))).toEqual([LIST[1]])
    expect(withoutApps(LIST, new Set(['other']))).toBe('unchanged')
  })

  it('the folders go for an app the user removed that is not hosted again', () => {
    expect([...removedApps({ planner: '1.0.0', runner: '0.3.0' }, ['runner', 'hello'])]).toEqual(['planner'])
    expect([...removedApps({}, ['hello'])]).toEqual([])
  })
})
