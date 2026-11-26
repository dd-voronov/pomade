// E-028 test always-on backend (a launchd login item in the spec, with a test label). Stays
// connected to Pomade while it runs (serves `ping`) and keeps running when Pomade quits. It reports
// to `<POMADE_HOME>/e028-always.json` — its pid, whether it is connected, and the Pomade it
// launched — and launches Pomade when `<POMADE_HOME>/launch-request` appears.
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { launchPomade, pomadeHome, stayConnected } from 'pomade-kit/node'

const home = pomadeHome()
const report = { pid: process.pid, connected: false, connections: 0, launched: null }
const write = () => writeFileSync(join(home, 'e028-always.json'), JSON.stringify(report))
write()

const keeper = stayConnected(
  { minDelayMs: 100, maxDelayMs: 300 },
  {
    onConnect(host) {
      report.connected = true
      report.connections += 1
      write()
      // Pomade may go before it answers (it quits right after the connect): the call then rejects,
      // and the next connection serves again — an unhandled rejection would crash the backend.
      host.api.serve({ ping: () => ({ pong: process.pid }) }).catch(() => undefined)
    },
    onDisconnect() {
      report.connected = false
      write()
    }
  }
)

setInterval(() => {
  const request = join(home, 'launch-request')
  if (!existsSync(request)) return
  rmSync(request, { force: true })
  void launchPomade({ readyTimeoutMs: 60000 }).then((r) => {
    report.launched = r.status === 'connected' ? { launched: r.launched, pid: r.pid ?? null } : { error: r.status }
    if (r.status === 'connected') r.host.close()
    write()
  })
}, 200)

process.on('SIGTERM', () => {
  keeper.stop()
  process.exit(0)
})
