import { describe, expect, it } from 'vitest'

import type { FileNode } from '@shared/types'

import { foldersToReread, skipListFolders } from './tree-refresh'

const file = (path: string): FileNode => ({ name: path.slice(path.lastIndexOf('/') + 1), path, kind: 'file' })
const dir = (path: string): FileNode => ({ ...file(path), kind: 'dir' })

const loaded: Record<string, FileNode[]> = {
  p: [dir('p/busy'), dir('p/calm'), file('p/README.md')],
  'p/busy': [file('p/busy/agent.log')],
  'p/calm': [file('p/calm/old.md'), dir('p/calm/sub')],
  'p/calm/sub': [file('p/calm/sub/x.md')],
  '/out/m': [file('/out/m/a.md')]
}
const roots = ['p', '/out/m']
const reread = (changes: { path: string; exists: boolean }[]): string[] =>
  [...foldersToReread(changes, loaded, roots)].sort()

describe('foldersToReread', () => {
  it('a write to a listed file re-reads nothing', () => {
    expect(reread([{ path: 'p/busy/agent.log', exists: true }])).toEqual([])
    expect(reread([{ path: '/out/m/a.md', exists: true }])).toEqual([])
  })

  it('an entry that appeared re-reads its folder', () => {
    expect(reread([{ path: 'p/calm/new.md', exists: true }])).toEqual(['p/calm'])
    expect(reread([{ path: '/out/m/b.md', exists: true }])).toEqual(['/out/m'])
  })

  it('an entry that disappeared re-reads its folder', () => {
    expect(reread([{ path: 'p/calm/old.md', exists: false }])).toEqual(['p/calm'])
  })

  it('a rename re-reads the folders on both sides', () => {
    expect(
      reread([
        { path: 'p/calm/old.md', exists: false },
        { path: 'p/busy/old.md', exists: true }
      ])
    ).toEqual(['p/busy', 'p/calm'])
  })

  it('a vanished folder re-reads its parent and every loaded folder under it', () => {
    expect(reread([{ path: 'p/calm', exists: false }])).toEqual(['p', 'p/calm', 'p/calm/sub'])
  })

  it('a path whose folder is not loaded, or that came and went, re-reads nothing', () => {
    expect(reread([{ path: 'p/busy/deep/x.md', exists: true }])).toEqual([])
    expect(reread([{ path: 'p/calm/tmp.swp', exists: false }])).toEqual([])
  })

  it('a root or an ancestor of a root re-reads the root', () => {
    expect(reread([{ path: '/out/m', exists: false }])).toEqual(['/out/m'])
    expect(reread([{ path: '/out', exists: true }])).toEqual(['/out/m'])
  })

  it('a path the tree hides agrees with the listing whether it exists or not', () => {
    const hidden = (path: string): boolean => path.endsWith('/.DS_Store') || path.endsWith('/build.log')
    const run = (changes: { path: string; exists: boolean }[]): string[] =>
      [...foldersToReread(changes, loaded, roots, hidden)].sort()
    expect(run([{ path: 'p/busy/build.log', exists: true }])).toEqual([])
    expect(run([{ path: 'p/calm/.DS_Store', exists: false }])).toEqual([])
    expect(run([{ path: 'p/calm/new.md', exists: true }])).toEqual(['p/calm'])
  })
})

describe('skipListFolders', () => {
  it('picks the loaded folders inside a skip-list folder, measured from their root', () => {
    const folders = [
      'p',
      'p/src',
      'p/node_modules',
      'p/node_modules/pkg/lib',
      'p/dist',
      'p/distant',
      '/out/m',
      '/out/m/dist'
    ]
    expect(skipListFolders(folders, ['p', '/out/m'])).toEqual([
      'p/node_modules',
      'p/node_modules/pkg/lib',
      'p/dist',
      '/out/m/dist'
    ])
  })

  it('the workspace root is the empty path; a root itself is never one', () => {
    expect(skipListFolders(['', 'node_modules', 'a/out', 'a/b', '/x/dist'], [''])).toEqual(['node_modules', 'a/out'])
    expect(skipListFolders(['node_modules/pkg', 'node_modules/pkg/dist'], ['', 'node_modules/pkg'])).toEqual([
      'node_modules/pkg/dist'
    ])
  })
})
