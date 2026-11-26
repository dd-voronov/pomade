// E-028 caller backend: once connected, calls the test app's API through Pomade's broker
// (backend → Pomade → the test app's backend) and records the answer — or the error code — in its
// own app state for the spec. Retries until the test app's backend serves.
import { stayConnected } from 'pomade-kit/node'

const keeper = stayConnected(
  {},
  {
    onConnect(host) {
      const attempt = async () => {
        try {
          const value = await host.apps.call('e028-test', 'echo', { n: 42 })
          await host.state.set('call', { ok: true, value })
        } catch (err) {
          await host.state.set('call', { ok: false, code: err.code ?? String(err) })
          setTimeout(() => void attempt(), 200)
        }
      }
      void attempt()
    }
  }
)

process.on('SIGTERM', () => {
  keeper.stop()
  process.exit(0)
})
