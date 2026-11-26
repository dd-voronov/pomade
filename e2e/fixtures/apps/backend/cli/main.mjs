// E-028 test app command `e028-test`:
//   e028-test echo <text>  — asks the app's API (its backend) through Pomade; prints the answer as JSON
//   e028-test workspace    — prints the workspace root, Pomade running or not
//   e028-test state        — prints its state folder (POMADE_APP_STATE) and whether it exists
// With Pomade closed `echo` prints `not running` and the workspace, and exits 3.
import { existsSync } from 'node:fs'

import { appStateDir, connectSocket, resolveWorkspace } from 'pomade-kit/node'

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'workspace') {
  console.log(resolveWorkspace() ?? '(none)')
} else if (cmd === 'state') {
  const dir = appStateDir()
  console.log(`${dir ?? '(none)'} ${dir !== null && existsSync(dir) ? 'exists' : 'missing'}`)
} else if (cmd === 'echo') {
  const r = await connectSocket()
  if (r.status !== 'connected') {
    console.log(`not running: ${r.status === 'rejected' ? r.reason : r.reason}; workspace ${resolveWorkspace() ?? '(none)'}`)
    process.exitCode = 3
  } else {
    try {
      console.log(JSON.stringify(await r.host.apps.call('e028-test', 'echo', { text: rest.join(' ') })))
    } catch (err) {
      console.log(`error: ${err.code}`)
      process.exitCode = 2
    } finally {
      r.host.close()
    }
  }
} else {
  console.error('usage: e028-test echo <text> | workspace | state')
  process.exitCode = 1
}
