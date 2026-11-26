// Agents (test) — a stand-in for pomade-agents (E-033): it serves the roster Pomade's "+" menu
// reads (`roster.list`), lists the agent tabs with their sessions and live states, and re-lists on
// every `agentTab.changed`. Each row can be focused, named or marked unnamed; a closed tab's
// session can be resumed; a button launches Claude with a prompt — enough to try the API by hand.
// It also answers Pomade's session questions (E-043): `sessions.forRepo` from `sessions` (the
// RepoSession records a spec sets; those whose start folder is at or below `folder` and, with
// `branch`, on that branch) and `sessions.liveIn` from `live` (the LiveSession records a spec sets;
// those at or below `folder`). Either list `null` = answer an error.
// Plain JS, raw postMessage protocol, no kit. `window.__agents` is the e2e surface: `roster` (what
// `roster.list` answers; `null` = answer an error, so Pomade keeps its own roster; a spec sets it),
// `sessions`, `live`, `silent` (true = never answer, to play "not responding"), `events`,
// `requests` (with their params), and a raw `call(method, params)`.
;(function () {
  'use strict'

  var state = {
    status: 'connecting',
    welcome: null,
    route: '',
    roster: null,
    sessions: null,
    live: null,
    closed: [],
    silent: false,
    tabs: [],
    events: [],
    requests: [],
    call: call
  }
  window.__agents = state

  var host = window.parent !== window ? window.parent : null
  var seq = 0
  var pending = {}

  function send(msg) {
    msg.channel = 'pomade'
    if (host) host.postMessage(msg, '*')
  }

  function call(method, params) {
    var id = String(++seq)
    return new Promise(function (resolve) {
      pending[id] = resolve
      send({ type: 'call', id: id, method: method, params: params })
    })
  }

  function button(label, onClick) {
    var b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.addEventListener('click', onClick)
    return b
  }

  function row(cells, actions) {
    var tr = document.createElement('tr')
    cells.forEach(function (c) {
      var td = document.createElement('td')
      td.textContent = c
      tr.appendChild(td)
    })
    var td = document.createElement('td')
    td.className = 'actions'
    actions.forEach(function (b) {
      td.appendChild(b)
    })
    tr.appendChild(td)
    return tr
  }

  function inside(path, folder) {
    return path === folder || path.indexOf(folder + '/') === 0
  }

  function answer(method, params) {
    if (method === 'roster.list') return state.roster === null ? null : { agents: state.roster }
    if (method === 'sessions.forRepo') {
      if (state.sessions === null) return null
      return {
        sessions: state.sessions.filter(function (s) {
          return inside(s.cwd, params.folder) && (params.branch === undefined || s.branch === params.branch)
        })
      }
    }
    if (method === 'sessions.liveIn') {
      if (state.live === null) return null
      var here = state.live.filter(function (s) {
        return inside(s.cwd, params.folder)
      })
      return { live: here.length > 0, sessions: here }
    }
    return undefined
  }

  function report(res) {
    document.getElementById('result').textContent = res.ok ? '' : res.error.code + ': ' + res.error.message
  }

  function render() {
    var status = document.getElementById('status')
    status.dataset.state = state.status
    status.textContent = state.status === 'connected' ? 'Connected' : state.status
    document.getElementById('route').textContent = 'Route: "' + state.route + '"'
    var body = document.querySelector('#tabs tbody')
    body.textContent = ''
    state.tabs.forEach(function (t) {
      body.appendChild(
        row(
          [t.agentId, t.title + (t.unnamed ? ' (unnamed)' : ''), t.sessionId ? t.sessionId.slice(0, 8) : '—', t.state],
          [
            button('Focus', function () {
              call('agentTabs.focus', { tabId: t.tabId }).then(report)
            }),
            button('Name it', function () {
              call('agentTabs.setTitle', { tabId: t.tabId, title: 'Named by the app' }).then(report)
            }),
            button('Mark unnamed', function () {
              call('agentTabs.setTitle', { tabId: t.tabId, title: null }).then(report)
            })
          ]
        )
      )
    })
    var closed = document.querySelector('#closed tbody')
    closed.textContent = ''
    state.closed.forEach(function (t) {
      closed.appendChild(
        row([t.agentId, t.title, t.sessionId.slice(0, 8)], [
          button('Resume', function () {
            call('agentTabs.resume', { agentId: t.agentId, sessionId: t.sessionId, projectId: t.projectId }).then(report)
          })
        ])
      )
    })
  }

  function list() {
    return call('agentTabs.list', {}).then(function (res) {
      if (res.ok) state.tabs = res.value.tabs
      render()
    })
  }

  window.addEventListener('message', function (e) {
    if (!host || e.source !== host) return
    var msg = e.data
    if (!msg || msg.channel !== 'pomade') return
    if (msg.type === 'welcome') {
      clearInterval(helloTimer)
      if (state.welcome) return
      state.welcome = msg
      state.route = msg.route
      state.status = 'connected'
      Promise.all([
        call('api.serve', {}),
        call('events.subscribe', { name: 'agentTab.changed' }),
        call('events.subscribe', { name: 'agentTab.exited' })
      ]).then(list)
    } else if (msg.type === 'result') {
      var resolve = pending[msg.id]
      delete pending[msg.id]
      if (resolve) resolve(msg.ok ? { ok: true, value: msg.value } : { ok: false, error: msg.error })
    } else if (msg.type === 'event') {
      state.events.push({ name: msg.name, payload: msg.payload })
      if (msg.name === 'route.changed') {
        state.route = msg.payload.route
        render()
      } else if (msg.name === 'agentTab.changed') {
        var t = msg.payload.tab
        if (msg.payload.changes.indexOf('closed') >= 0 && t.sessionId) {
          state.closed = [t].concat(state.closed.filter(function (c) { return c.sessionId !== t.sessionId })).slice(0, 5)
        }
        list()
      }
    } else if (msg.type === 'request') {
      state.requests.push({ from: msg.from, method: msg.method, params: msg.params })
      if (state.silent) return
      var value = answer(msg.method, msg.params || {})
      if (value === undefined) send({ type: 'response', id: msg.id, ok: false, error: { code: 'unknown-method', message: msg.method } })
      else if (value === null) send({ type: 'response', id: msg.id, ok: false, error: { code: 'app-error', message: 'nothing set for ' + msg.method } })
      else send({ type: 'response', id: msg.id, ok: true, value: value })
    }
  })

  window.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || !(e.metaKey || e.ctrlKey)) return
    if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt') return
    send({ type: 'key', key: e.key, code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey })
  })

  document.getElementById('launch').addEventListener('click', function () {
    call('agentTabs.launch', { agentId: 'claude', prompt: 'Say hello in one word.' }).then(report)
  })

  function hello() {
    send({ type: 'hello', hostApi: 0 })
  }
  var helloTimer = setInterval(hello, 150)
  hello()
  render()
})()
