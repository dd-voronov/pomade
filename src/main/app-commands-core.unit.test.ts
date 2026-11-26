import { describe, expect, it } from 'vitest'

import { SHIM_MARKER, launchSpec, resolvePomadeHome, shimText, terminalEnv } from './app-commands-core'

describe('Pomade home', () => {
  it('stable ~/.pomade, dev ~/.pomade-dev; POMADE_HOME wins; off under test without it', () => {
    expect(resolvePomadeHome({}, 'stable', '/Users/u')).toBe('/Users/u/.pomade')
    expect(resolvePomadeHome({}, 'dev', '/Users/u')).toBe('/Users/u/.pomade-dev')
    expect(resolvePomadeHome({ POMADE_HOME: '/t/h' }, 'stable', '/Users/u')).toBe('/t/h')
    expect(resolvePomadeHome({ NODE_ENV: 'test' }, 'dev', '/Users/u')).toBeNull()
    expect(resolvePomadeHome({ NODE_ENV: 'test', POMADE_HOME: '/t/h' }, 'dev', '/Users/u')).toBe('/t/h')
    expect(resolvePomadeHome({ NODE_ENV: 'test', POMADE_HOME: '/Users/u/.pomade' }, 'dev', '/Users/u')).toBeNull()
    expect(resolvePomadeHome({ NODE_ENV: 'test', POMADE_HOME: '/Users/u/.pomade-dev' }, 'dev', '/Users/u')).toBeNull()
    expect(resolvePomadeHome({ NODE_ENV: 'test', POMADE_HOME: '/Users/u/.pomade-e2e-x' }, 'dev', '/Users/u')).toBe('/Users/u/.pomade-e2e-x')
  })
})

describe('shims', () => {
  it('set the identity and exec the program with the arguments', () => {
    const text = shimText({ label: 'x1 (app x1)', env: { A: "it's", B: '/p q' }, argv: ['/bin/node', '/app/cli.js'] })
    expect(text.split('\n')).toEqual([
      '#!/bin/sh',
      `${SHIM_MARKER} — x1 (app x1). Written by Pomade; rewritten whenever its apps change.`,
      `A='it'\\''s' B='/p q' exec '/bin/node' '/app/cli.js' "$@"`,
      ''
    ])
  })
})

describe('launch record and terminal env', () => {
  it('a packaged Pomade opens its bundle; a dev one reruns itself with its POMADE_* env', () => {
    expect(launchSpec('/Applications/Pomade.app/Contents/MacOS/Pomade', ['x'], {}, true)).toEqual({
      argv: ['/usr/bin/open', '-a', '/Applications/Pomade.app'],
      env: {}
    })
    expect(
      launchSpec(
        '/e/Electron',
        ['/e/Electron', '-r', '/pw/loader.js', '--inspect=0', '--remote-debugging-port=0', '/out/main/index.js'],
        { POMADE_HOME: '/h', NODE_ENV: 'test', HOME: '/u' },
        false
      )
    ).toEqual({ argv: ['/e/Electron', '/out/main/index.js'], env: { POMADE_HOME: '/h', NODE_ENV: 'test' } })
    expect(launchSpec('/e/Electron', ['/e/Electron', '.'], {}, false).argv).toEqual(['/e/Electron', '.'])
  })

  it("terminals get the command folder first on PATH, the home and the workspace", () => {
    expect(terminalEnv('/usr/bin', '/h', '/ws')).toEqual({ PATH: '/h/bin:/usr/bin', POMADE_HOME: '/h', POMADE_WORKSPACE: '/ws' })
    expect(terminalEnv(undefined, '/h', null)).toEqual({ PATH: '/h/bin', POMADE_HOME: '/h' })
    expect(terminalEnv('/usr/bin', null, '/ws')).toEqual({ POMADE_WORKSPACE: '/ws' })
  })
})
