// Hello — Pomade's own Host API conformance fixture (docs/HOST-API.md). Plain JS, no build, no
// kit: it speaks the raw postMessage protocol. It shows the surface / strip icon / route it was
// opened for (one bundle serves its tab and its side panels — E-029), lists the active project's `roadmap` folder
// (recursive, with frontmatter), re-lists on `project.changed` and `files.changed`, forwards
// unhandled Cmd/Ctrl keys (and, as an overlay, a plain Escape), follows `route.changed`, and shows
// "no Pomade host" when nobody answers within 1500 ms. Opened as an overlay (its quick-add
// shortcut, or its tab's / panel's "Quick add…" button — `overlay.open`) it shows one input
// instead: Enter stores the text in the app state and closes.
// `window.__hello` is the e2e surface: live state plus a raw `call(method, params)`. After an
// `api.serve` call it answers every broker request with an echo (E-028).
;(function () {
  'use strict'

  var FOLDER = 'roadmap'
  var HANDSHAKE_TIMEOUT_MS = 1500
  var HELLO_RETRY_MS = 150

  var state = {
    // Unique per document load: survives only as long as this JS context does.
    mark: Math.random().toString(36).slice(2),
    status: 'connecting',
    welcome: null,
    // The route rendered now: the welcome's, then every route.changed.
    route: null,
    project: null,
    rows: [],
    events: [],
    lastError: null,
    // E-028 — broker requests this frame answered (it echoes each one).
    requests: [],
    // T-270 — the outcome of the last Copy click: "copied" or the error's name.
    copyResult: null,
    call: call
  }
  window.__hello = state

  var host = window.parent !== window ? window.parent : null
  var seq = 0
  var pending = {}
  var watchId = null

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

  function setStatus(s, text) {
    state.status = s
    var el = document.getElementById('status')
    el.dataset.state = s
    el.textContent = text
  }

  function folderPath() {
    var root = state.project ? state.project.root : ''
    return root ? root + '/' + FOLDER : FOLDER
  }

  function render() {
    var w = state.welcome
    document.getElementById('surface').textContent = w
      ? 'Surface: ' + w.surface + (w.icon ? ' · icon ' + w.icon : '') + (w.key ? ' · key ' + w.key : '') +
        (w.kind ? ' · kind ' + w.kind : '') + ' · route "' + state.route + '"'
      : ''
    document.getElementById('project').textContent = state.project
      ? 'Project: ' + state.project.name + ' (' + state.project.kind + ')'
      : ''
    document.getElementById('folder').textContent = 'Folder: ' + folderPath()
    var body = document.querySelector('#rows tbody')
    body.textContent = ''
    state.rows.forEach(function (r) {
      var tr = document.createElement('tr')
      tr.dataset.path = r.path
      var cells = [r.path]
      if (r.error) cells.push(r.error, '', '')
      else cells.push(r.id || '', r.title || '', r.status || '')
      cells.forEach(function (c, i) {
        var td = document.createElement('td')
        td.textContent = c
        if (r.error && i === 1) {
          td.className = 'error'
          td.colSpan = 3
        }
        if (!(r.error && i > 1)) tr.appendChild(td)
      })
      body.appendChild(tr)
    })
  }

  function list() {
    return call('files.readFolder', { path: folderPath(), recursive: true, frontmatter: true }).then(function (res) {
      if (!res.ok) {
        state.lastError = res.error
        state.rows = []
        render()
        return
      }
      state.rows = res.value.entries
        .filter(function (e) {
          return e.kind === 'file' && /\.md$/.test(e.name)
        })
        .map(function (e) {
          var fm = e.frontmatter || {}
          return {
            path: e.path,
            id: fm.id,
            title: fm.title,
            status: fm.status,
            error: e.frontmatterError || null
          }
        })
      render()
    })
  }

  function rewatch() {
    var unwatch = watchId ? call('files.unwatch', { watchId: watchId }) : Promise.resolve()
    watchId = null
    return unwatch
      .then(function () {
        return call('files.watch', { path: folderPath(), recursive: true })
      })
      .then(function (res) {
        if (res.ok) watchId = res.value.watchId
      })
  }

  function onHostMessage(e) {
    if (!host || e.source !== host) return
    var msg = e.data
    if (!msg || msg.channel !== 'pomade') return
    if (msg.type === 'welcome') {
      clearInterval(helloTimer)
      clearTimeout(standaloneTimer)
      if (state.welcome) return
      state.welcome = msg
      state.route = msg.route
      state.project = msg.project
      setStatus('connected', 'Connected to Pomade ' + msg.pomadeVersion)
      if (msg.surface === 'overlay') quickAdd()
      else {
        document.getElementById('open-overlay').hidden = false
        list().then(rewatch)
      }
    } else if (msg.type === 'reject') {
      clearInterval(helloTimer)
      clearTimeout(standaloneTimer)
      setStatus('rejected', msg.reason === 'needs-newer-pomade' ? 'Needs a newer Pomade' : 'Needs an update')
    } else if (msg.type === 'result') {
      var resolve = pending[msg.id]
      delete pending[msg.id]
      if (resolve) resolve(msg)
    } else if (msg.type === 'event') {
      state.events.push({ name: msg.name, payload: msg.payload })
      if (msg.name === 'route.changed') {
        state.route = msg.payload.route
        render()
      } else if (msg.name === 'project.changed') {
        state.project = msg.payload
        list().then(rewatch)
      } else if (msg.name === 'files.changed' && msg.payload.watchId === watchId) {
        list()
      }
    } else if (msg.type === 'request') {
      // E-028 — a broker request (after `api.serve`): echo it back, recorded for the spec.
      state.requests.push({ from: msg.from, method: msg.method, params: msg.params })
      send({ type: 'response', id: msg.id, ok: true, value: { echo: msg.params, from: msg.from, method: msg.method, surface: state.welcome && state.welcome.surface } })
    }
  }

  // The overlay: one input. Enter → `state.set('quick-add', text)`, then `overlay.close`.
  function quickAdd() {
    document.body.className = 'overlay'
    var form = document.getElementById('quick-add')
    var input = form.querySelector('input')
    form.hidden = false
    form.addEventListener('submit', function (e) {
      e.preventDefault()
      call('state.set', { key: 'quick-add', value: input.value }).then(function () {
        return call('overlay.close')
      })
    })
    input.focus()
  }

  window.addEventListener('message', onHostMessage)

  // T-236 — the same overlay as the quick-add shortcut, opened from this tab or panel frame. Focus
  // moving into the overlay's frame clears this frame's focused element; when Pomade gives focus
  // back to this frame (the overlay closed), the button is focused again — as pomade-kit's
  // `host.overlay.open` does.
  document.getElementById('open-overlay').addEventListener('click', function () {
    var before = document.activeElement
    call('overlay.open', { route: 'quick-add' }).then(function (res) {
      state.lastOverlayOpen = res
      if (!res.ok || !before || before === document.body) return
      window.addEventListener(
        'focus',
        function () {
          var now = document.activeElement
          if (before.isConnected && (!now || now === document.body)) before.focus({ preventScroll: true })
        },
        { once: true }
      )
    })
  })

  // T-270 — Copy writes this frame's surface and route to the clipboard (a user gesture).
  function copy() {
    var w = state.welcome
    var text = 'hello:' + (w ? w.surface : 'none') + ':' + state.route
    state.copyResult = null
    return navigator.clipboard.writeText(text).then(
      function () {
        state.copyResult = 'copied'
      },
      function (err) {
        state.copyResult = String((err && err.name) || err)
      }
    )
  }
  document.getElementById('copy').addEventListener('click', copy)
  document.getElementById('quick-add-copy').addEventListener('click', copy)

  // Forward Cmd/Ctrl shortcuts this app did not handle, so Pomade's own keep working.
  window.addEventListener('keydown', function (e) {
    var overlayEscape =
      state.welcome && state.welcome.surface === 'overlay' && e.key === 'Escape' &&
      !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
    if (e.defaultPrevented || !(e.metaKey || e.ctrlKey || overlayEscape)) return
    if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt') return
    send({
      type: 'key',
      key: e.key,
      code: e.code,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey
    })
  })

  function hello() {
    send({ type: 'hello', hostApi: 0 })
  }
  var helloTimer = setInterval(hello, HELLO_RETRY_MS)
  var standaloneTimer = setTimeout(function () {
    clearInterval(helloTimer)
    if (!state.welcome) setStatus('standalone', 'Running standalone — no Pomade host')
  }, HANDSHAKE_TIMEOUT_MS)
  hello()
  render()
})()
