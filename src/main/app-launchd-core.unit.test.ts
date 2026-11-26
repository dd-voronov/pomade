import { describe, expect, it } from 'vitest'

import { plistText, resolveLaunchd } from './app-launchd-core'

describe('where login items go', () => {
  it('stable and dev have their own labels; off under test without both test hooks', () => {
    expect(resolveLaunchd({}, 'stable', '/Users/u')).toEqual({
      agentsDir: '/Users/u/Library/LaunchAgents',
      labelPrefix: 'io.github.dd-voronov.pomade.app.'
    })
    expect(resolveLaunchd({}, 'dev', '/Users/u')?.labelPrefix).toBe('io.github.dd-voronov.pomade-dev.app.')
    expect(resolveLaunchd({ NODE_ENV: 'test' }, 'dev', '/u')).toBeNull()
    expect(resolveLaunchd({ NODE_ENV: 'test', POMADE_LAUNCH_AGENTS: '/t' }, 'dev', '/u')).toBeNull()
    expect(resolveLaunchd({ NODE_ENV: 'test', POMADE_LAUNCH_AGENTS: '/t', POMADE_LAUNCHD_PREFIX: 'io.github.dd-voronov.pomade.app.' }, 'dev', '/u')).toBeNull()
    expect(
      resolveLaunchd({ NODE_ENV: 'test', POMADE_LAUNCH_AGENTS: '/t', POMADE_LAUNCHD_PREFIX: 'io.github.dd-voronov.pomade.test.x1.' }, 'dev', '/u')
    ).toEqual({ agentsDir: '/t', labelPrefix: 'io.github.dd-voronov.pomade.test.x1.' })
    expect(
      resolveLaunchd({ NODE_ENV: 'test', POMADE_LAUNCH_AGENTS: '/u/Library/LaunchAgents', POMADE_LAUNCHD_PREFIX: 'io.github.dd-voronov.pomade.test.x1.' }, 'dev', '/u')
    ).toBeNull()
  })
})

describe('plist', () => {
  const text = plistText({
    label: 'io.github.dd-voronov.pomade.app.pomade-runner',
    program: ['/Applications/Pomade.app/Contents/MacOS/Pomade', '/u/apps/pomade-runner/keeper.js'],
    workingDirectory: '/u/apps/pomade-runner',
    env: { ELECTRON_RUN_AS_NODE: '1', POMADE_APP_ID: 'pomade-runner', Z: 'a<b&"c"' },
    log: '/u/app-logs/pomade-runner/backend.log'
  })

  it('starts at login and is kept alive after a crash, not after a clean exit', () => {
    expect(text).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
    expect(text).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/)
    expect(text).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/)
  })

  it('runs the entry with Pomade runtime from the app folder, its env escaped', () => {
    expect(text).toContain('<string>/Applications/Pomade.app/Contents/MacOS/Pomade</string>\n      <string>/u/apps/pomade-runner/keeper.js</string>')
    expect(text).toContain('<key>WorkingDirectory</key>\n    <string>/u/apps/pomade-runner</string>')
    expect(text).toContain('<key>Z</key>\n      <string>a&lt;b&amp;&quot;c&quot;</string>')
    expect(text).toContain('<key>StandardErrorPath</key>\n    <string>/u/app-logs/pomade-runner/backend.log</string>')
  })
})
