// E-028 test app backend: stays connected to Pomade over the Host API socket with pomade-kit's
// client, serves the app's API (`echo`, `slow` — never answers, `fail`), and records itself in the
// app state (pid, connection count, its POMADE_APP_STATE), which the spec reads from
// <userData>/app-state/e028-test/state.json. The fixture is dev-linked from the repo, so
// `pomade-kit/node` resolves from the repo's node_modules.
import { stayConnected } from 'pomade-kit/node'
import { HostError } from 'pomade-kit/sdk'

let connections = 0
const keeper = stayConnected(
  {},
  {
    onConnect(host) {
      connections += 1
      // A connection that closes before Pomade answers rejects the calls; the next one serves again.
      host.api
        .serve({
          echo: (params, { from }) => ({ echo: params, from, pid: process.pid }),
          slow: () => new Promise(() => undefined),
          fail: () => {
            throw new HostError('not-found', 'nothing here')
          }
        })
        .then(() =>
          host.state.set('backend', { pid: process.pid, connections, surface: host.welcome.surface, appState: process.env.POMADE_APP_STATE ?? null })
        )
        .catch(() => undefined)
    }
  }
)

process.on('SIGTERM', () => {
  keeper.stop()
  process.exit(0)
})
