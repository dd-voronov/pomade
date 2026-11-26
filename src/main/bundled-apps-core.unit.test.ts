import { describe, expect, it } from 'vitest'

import { bundledNotice, compareVersions, outsideNotices, outsidePathsToShow, planBundledInstall } from './bundled-apps-core'

const BUNDLE = [
  { id: 'pomade-board', version: '0.2.0' },
  { id: 'pomade-planner', version: '0.2.0' }
]

describe('planBundledInstall', () => {
  it('absent → install', () => {
    expect(planBundledInstall(BUNDLE, new Map(), {})).toEqual([
      { id: 'pomade-board', action: 'install', version: '0.2.0' },
      { id: 'pomade-planner', action: 'install', version: '0.2.0' }
    ])
  })

  it('older → update; no readable version → update', () => {
    const installed = new Map<string, string | null>([
      ['pomade-board', '0.1.9'],
      ['pomade-planner', null]
    ])
    expect(planBundledInstall(BUNDLE, installed, {})).toEqual([
      { id: 'pomade-board', action: 'update', version: '0.2.0', from: '0.1.9' },
      { id: 'pomade-planner', action: 'update', version: '0.2.0', from: null }
    ])
  })

  it('newer by hand → keep; the same → keep', () => {
    const installed = new Map<string, string | null>([
      ['pomade-board', '0.3.0-dev.1'],
      ['pomade-planner', '0.2.0']
    ])
    expect(planBundledInstall(BUNDLE, installed, {})).toEqual([
      { id: 'pomade-board', action: 'keep' },
      { id: 'pomade-planner', action: 'keep' }
    ])
  })

  it('removed by the user → skip, while the bundled build is not newer than the one removed', () => {
    expect(planBundledInstall(BUNDLE, new Map(), { 'pomade-board': '0.2.0', 'pomade-planner': '0.3.0' })).toEqual([
      { id: 'pomade-board', action: 'skip-removed' },
      { id: 'pomade-planner', action: 'skip-removed' }
    ])
    // A later release with a newer build puts it back.
    expect(planBundledInstall(BUNDLE, new Map(), { 'pomade-board': '0.1.0' })[0]).toEqual({
      id: 'pomade-board',
      action: 'install',
      version: '0.2.0'
    })
  })

  it('apps not bundled are left alone', () => {
    const installed = new Map<string, string | null>([['pomade-runner', '0.1.0']])
    expect(planBundledInstall([], installed, {})).toEqual([])
  })
})

describe('compareVersions', () => {
  it('orders by semver precedence', () => {
    const sorted = ['1.0.0', '0.10.0', '0.2.0', '1.0.0-rc.1', '1.0.0-alpha', '1.0.0-alpha.2', '1.0.0-alpha.beta', '0.2.0+build.5']
    sorted.sort(compareVersions)
    expect(sorted).toEqual(['0.2.0', '0.2.0+build.5', '0.10.0', '1.0.0-alpha', '1.0.0-alpha.2', '1.0.0-alpha.beta', '1.0.0-rc.1', '1.0.0'])
    expect(compareVersions('0.2.0', '0.2.0+other')).toBe(0)
    expect(compareVersions('garbage', '0.0.1')).toBe(-1)
  })
})

describe('bundledNotice', () => {
  const names = new Map([
    ['pomade-board', 'Board'],
    ['pomade-planner', 'Planner']
  ])

  it('nothing installed or updated → no notice', () => {
    expect(bundledNotice([{ id: 'pomade-board', action: 'keep' }, { id: 'pomade-planner', action: 'skip-removed' }], names)).toBeNull()
  })

  it('lists what was installed and updated', () => {
    expect(bundledNotice([{ id: 'pomade-planner', action: 'install', version: '0.2.0' }], names)).toEqual({
      title: 'An app installed with Pomade',
      body: 'Installed: Planner 0.2.0'
    })
    expect(
      bundledNotice(
        [
          { id: 'pomade-planner', action: 'install', version: '0.2.0' },
          { id: 'pomade-board', action: 'update', version: '0.2.0', from: '0.1.0' }
        ],
        names
      )
    ).toEqual({ title: '2 apps installed or updated with Pomade', body: 'Installed: Planner 0.2.0\nUpdated: Board 0.1.0 → 0.2.0' })
    expect(bundledNotice([{ id: 'pomade-board', action: 'update', version: '0.2.0', from: null }], names)).toEqual({
      title: 'An app updated with Pomade',
      body: 'Updated: Board 0.2.0'
    })
  })
})

describe('paths outside the workspace in the notice', () => {
  const names = new Map([
    ['pomade-agents', 'Agents'],
    ['pomade-runner', 'Runner']
  ])

  it('an install shows every path; an update only the ones the installed build did not declare; keep none', () => {
    const paths = ['~/.claude/', '~/.codex/', '~/.zshrc']
    expect(outsidePathsToShow({ id: 'a', action: 'install', version: '1.0.0' }, paths, [])).toEqual(paths)
    expect(outsidePathsToShow({ id: 'a', action: 'update', version: '1.1.0', from: '1.0.0' }, paths, ['~/.claude/', '~/.zshrc'])).toEqual(['~/.codex/'])
    expect(outsidePathsToShow({ id: 'a', action: 'update', version: '1.1.0', from: '1.0.0' }, paths, paths)).toEqual([])
    expect(outsidePathsToShow({ id: 'a', action: 'keep' }, paths, [])).toEqual([])
  })

  it('one notice per app with paths to show: the app in the title, the paths in the body', () => {
    const steps = [
      { id: 'pomade-agents', action: 'install', version: '0.3.0' },
      { id: 'pomade-runner', action: 'update', version: '0.2.0', from: '0.1.0' },
      { id: 'pomade-board', action: 'keep' }
    ] as const
    const outside = new Map([
      ['pomade-agents', ['~/.claude/', '~/.codex/']],
      ['pomade-runner', ['~/.zshrc']],
      ['pomade-board', ['~/x/']]
    ])
    expect(outsideNotices(steps, names, outside)).toEqual([
      { title: 'Outside the workspace', body: 'Agents uses ~/.claude/, ~/.codex/' },
      { title: 'Outside the workspace', body: 'Runner now also uses ~/.zshrc' }
    ])
    expect(outsideNotices(steps, names, new Map([['pomade-agents', []]]))).toEqual([])
  })
})
