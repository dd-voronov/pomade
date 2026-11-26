// Runner (test) backend — a stand-in for pomade-runner's published API (docs/HOST-API.md §4
// "Platform reads of app APIs"): `jobs.forRepo` answers the jobs that target a repo. `alpha` has
// one Commit & push job; `gamma` is never answered (Runner not responding); any other repo has
// none. The fixture is dev-linked from the repo, so `pomade-kit/node` resolves from its
// node_modules.
//
// A spec steers it with `<userData>/runner-ctl.json` (read every 100 ms; absent = serve at once,
// alpha's job as above): `serving: false` holds `api.serve` back until it turns true; `alpha`
// replaces alpha's job (an object, or null = none); a higher `changed` publishes `jobs.changed`; a higher `ran` publishes
// `runs.changed`.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { stayConnected } from 'pomade-kit/node'

const ALPHA_JOB = {
  id: 'alpha-twice-daily',
  name: 'Alpha twice daily',
  operation: 'commit-push',
  schedule: '13:00, 20:00',
  nextRun: '2026-11-12T13:00:00.000Z',
  lastResult: { status: 'done', at: '2026-11-11T13:00:00.000Z' },
  route: 'jobs/alpha-twice-daily'
}

const keyFile = process.env.POMADE_APP_KEY_FILE
const ctlFile = keyFile ? join(dirname(dirname(keyFile)), 'runner-ctl.json') : null

function control() {
  try {
    return ctlFile ? JSON.parse(readFileSync(ctlFile, 'utf8')) : {}
  } catch {
    return {}
  }
}

let host = null
let serving = false
let changed = control().changed ?? 0
let ran = control().ran ?? 0

function serveNow() {
  if (serving || !host) return
  serving = true
  // A connection that closes before Pomade answers rejects the call; the next one serves again.
  host.api
    .serve({
      'jobs.forRepo': (params) => {
        const name = params?.repo?.name
        if (name === 'gamma') return new Promise(() => undefined)
        const alpha = 'alpha' in control() ? control().alpha : ALPHA_JOB
        return { jobs: name === 'alpha' && alpha && typeof params?.repo?.path === 'string' ? [alpha] : [] }
      }
    })
    .catch(() => undefined)
}

const keeper = stayConnected(
  {},
  {
    onConnect(h) {
      host = h
      serving = false
      if (control().serving !== false) serveNow()
    }
  }
)

const poll = setInterval(() => {
  const c = control()
  if (c.serving !== false) serveNow()
  if (host && typeof c.changed === 'number' && c.changed > changed) {
    changed = c.changed
    void host.events.publish('jobs.changed', null)
  }
  if (host && typeof c.ran === 'number' && c.ran > ran) {
    ran = c.ran
    void host.events.publish('runs.changed', null)
  }
}, 100)

process.on('SIGTERM', () => {
  clearInterval(poll)
  keeper.stop()
  process.exit(0)
})
