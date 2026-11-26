import { describe, expect, it } from 'vitest'

import { isInFolders, isSkippedPath, normalizeUnwatchedFolder } from './skipped-paths'

describe('isInFolders', () => {
  it('matches a listed folder and what is inside it, by whole path segments', () => {
    const folders = ['logs', 'Projects/x/exports']
    for (const p of ['logs', 'logs/a.log', 'logs/deep/b.log', 'Projects/x/exports', 'Projects/x/exports/1.csv']) {
      expect(isInFolders(p, folders), p).toBe(true)
    }
    for (const p of ['', 'logs.md', 'logsx/a', 'Projects/x', 'Projects/x/exports2/a', 'a/logs/b', 'Projects/y/exports']) {
      expect(isInFolders(p, folders), p).toBe(false)
    }
  })

  it('matches nothing when the list is empty', () => {
    expect(isInFolders('logs', [])).toBe(false)
  })
})

describe('isSkippedPath', () => {
  it('is the local-history stores plus the unwatched folders', () => {
    expect(isSkippedPath('Apps/Pomade/local-history/blobs/x.txt', [])).toBe(true)
    expect(isSkippedPath('Apps/Pomade/dev/local-history', [])).toBe(true)
    expect(isSkippedPath('logs/a.log', ['logs'])).toBe(true)
    expect(isSkippedPath('logs/a.log', [])).toBe(false)
    expect(isSkippedPath('docs/a.md', ['logs'])).toBe(false)
  })
})

describe('normalizeUnwatchedFolder', () => {
  it('keeps a workspace-relative folder, tidied', () => {
    expect(normalizeUnwatchedFolder('logs')).toBe('logs')
    expect(normalizeUnwatchedFolder('  Projects/x/exports/  ')).toBe('Projects/x/exports')
    expect(normalizeUnwatchedFolder('./logs')).toBe('logs')
    expect(normalizeUnwatchedFolder('a//b/./c')).toBe('a/b/c')
    expect(normalizeUnwatchedFolder('a\\b')).toBe('a/b')
  })

  it('refuses what cannot be a folder inside the workspace', () => {
    for (const raw of ['', '   ', '.', './', '/abs/logs', 'C:\\logs', '../outside', 'a/../../b', 'a/..']) {
      expect(normalizeUnwatchedFolder(raw), raw).toBeNull()
    }
  })
})
