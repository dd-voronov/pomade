'use strict'
// E-034 e2e — asks the terminal "where is the cursor?" and "what are you?" once it is told to
// (`q`), and logs every byte it reads (JSON lines, $PROBE_LOG): the spec counts the answers that
// reached it — exactly one of each, the keeper's.
const fs = require('fs')
const log = (d) => fs.appendFileSync(process.env.PROBE_LOG, JSON.stringify(d) + '\n')
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdout.write('probe ready\r\n')
process.stdin.on('data', (d) => {
  log(d)
  if (d.includes('q')) process.stdout.write('asking\r\n\x1b[6n\x1b[c')
})
