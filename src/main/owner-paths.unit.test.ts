import { afterEach, describe, expect, it, vi } from 'vitest'

import { isOwnersPath, refusedUnderTest, resolveShellRc } from './owner-paths'

const HOME = '/Users/u'

afterEach(() => vi.restoreAllMocks())

describe("the Owner's real places", () => {
  it.each([
    '/Users/u/.pomade',
    '/Users/u/.pomade/bin',
    '/Users/u/.pomade-dev',
    '/Users/u/.pomade-dev/worktrees/x',
    '/Users/u/Library/Application Support/Pomade',
    '/Users/u/Library/Application Support/pomade-dev',
    '/Users/u/Library/Application Support/Pomade/run',
    '/Users/u/library/application support/POMADE',
    '/Users/u/Library/LaunchAgents',
    '/Users/u/.zprofile',
    '/Users/u/.zshrc',
    '/Users/u/.pomade/../.pomade/bin'
  ])('%s is real', (path) => {
    expect(isOwnersPath(path, {}, HOME)).toBe(true)
  })

  it('$ZDOTDIR/.zprofile is real', () => {
    expect(isOwnersPath('/z/.zprofile', { ZDOTDIR: '/z' }, HOME)).toBe(true)
    expect(isOwnersPath('/z/.zprofile', {}, HOME)).toBe(false)
  })

  it.each([
    '/var/folders/x/T/pomade-ud-abc',
    '/var/folders/x/T/pomade-cmd-abc/home/.pomade-e2e',
    '/var/folders/x/T/pomade-cmd-abc/home/.zprofile',
    '/Users/u/.pomade-e2e-ud-abc',
    '/Users/u/.pomade-t105-abc',
    '/Users/u/Library/Application Support/Other',
    '/Users/u/notes.txt'
  ])('%s is not', (path) => {
    expect(isOwnersPath(path, {}, HOME)).toBe(false)
  })
})

describe('the test guard', () => {
  it('refuses a real place only under test, and logs it', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(refusedUnderTest({}, 'POMADE_HOME', '/Users/u/.pomade', HOME)).toBe(false)
    expect(refusedUnderTest({ NODE_ENV: 'test' }, 'POMADE_HOME', '/tmp/h', HOME)).toBe(false)
    expect(log).not.toHaveBeenCalled()
    expect(refusedUnderTest({ NODE_ENV: 'test' }, 'POMADE_HOME', '/Users/u/.pomade', HOME)).toBe(true)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('refused POMADE_HOME /Users/u/.pomade'))
  })
})

describe('rc file', () => {
  it('is ~/.zprofile (ZDOTDIR wins); under test only POMADE_SHELL_RC, never a real rc file', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(resolveShellRc({}, HOME)).toBe('/Users/u/.zprofile')
    expect(resolveShellRc({ ZDOTDIR: '/z' }, HOME)).toBe('/z/.zprofile')
    expect(resolveShellRc({ POMADE_SHELL_RC: '/t/.zprofile' }, HOME)).toBe('/t/.zprofile')
    expect(resolveShellRc({ NODE_ENV: 'test' }, HOME)).toBeNull()
    expect(resolveShellRc({ NODE_ENV: 'test', POMADE_SHELL_RC: '/t/.zprofile' }, HOME)).toBe('/t/.zprofile')
    expect(resolveShellRc({ NODE_ENV: 'test', POMADE_SHELL_RC: '/Users/u/.zprofile' }, HOME)).toBeNull()
    expect(resolveShellRc({ NODE_ENV: 'test', ZDOTDIR: '/z', POMADE_SHELL_RC: '/z/.zprofile' }, HOME)).toBeNull()
  })
})
