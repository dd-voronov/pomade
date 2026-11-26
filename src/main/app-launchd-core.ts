// Pomade — E-028 always-on backends, the pure part: where login items go, their labels, and the
// launchd plist (docs/HOST-API.md §2 "Backends").

import { TEST_LABEL_PREFIX, type Flavor } from './app-commands-core'
import { refusedUnderTest } from './owner-paths'

export interface LaunchdConfig {
  /** Where Pomade writes its login items' plists. */
  agentsDir: string
  /** Every label Pomade writes starts with this; Pomade manages only plists with it. */
  labelPrefix: string
}

/**
 * Where always-on backends go: `~/Library/LaunchAgents` with Pomade's own label prefix (stable and
 * dev differ). Under test only with both hooks set, a prefix starting with `TEST_LABEL_PREFIX` and
 * a folder that is not the Owner's real one (`owner-paths.ts`); otherwise null — always-on backends are off.
 */
export function resolveLaunchd(env: Readonly<Record<string, string | undefined>>, flavor: Flavor, home: string): LaunchdConfig | null {
  const dir = env.POMADE_LAUNCH_AGENTS?.trim()
  const prefix = env.POMADE_LAUNCHD_PREFIX?.trim()
  if (env.NODE_ENV === 'test') {
    return dir && prefix && prefix.startsWith(TEST_LABEL_PREFIX) && !refusedUnderTest(env, 'POMADE_LAUNCH_AGENTS', dir, home)
      ? { agentsDir: dir, labelPrefix: prefix }
      : null
  }
  return {
    agentsDir: dir || `${home}/Library/LaunchAgents`,
    labelPrefix: prefix || (flavor === 'stable' ? 'io.github.dd-voronov.pomade.app.' : 'io.github.dd-voronov.pomade-dev.app.')
  }
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export interface PlistSpec {
  label: string
  program: string[]
  workingDirectory: string
  env: Record<string, string>
  log: string
}

/**
 * The login item: started at login (`RunAtLoad`), restarted by launchd when it crashes but not when
 * it exits cleanly (`KeepAlive.SuccessfulExit = false`), at most every 10 s, in the user's GUI
 * session; stdout and stderr to the app's backend log.
 */
export function plistText(spec: PlistSpec): string {
  const str = (v: string): string => `<string>${xml(v)}</string>`
  const env = Object.keys(spec.env)
    .sort()
    .map((k) => `      <key>${xml(k)}</key>\n      ${str(spec.env[k])}`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    ${str(spec.label)}
    <key>ProgramArguments</key>
    <array>
${spec.program.map((p) => `      ${str(p)}`).join('\n')}
    </array>
    <key>WorkingDirectory</key>
    ${str(spec.workingDirectory)}
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>StandardOutPath</key>
    ${str(spec.log)}
    <key>StandardErrorPath</key>
    ${str(spec.log)}
  </dict>
</plist>
`
}
