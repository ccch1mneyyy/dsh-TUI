import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import xterm from '@xterm/headless'
import { startPreview, parseMessage } from './server.mjs'
import { settled, viewportLines } from '../lib/term-test.mjs'
import { createDemoChannel } from './demo-channel.mjs'
import { CHANNEL_UI_EFFECTS, CHANNEL_UI_PROPERTIES } from '../../lib/types/adapter/channel/ui-policy.js'

const { Terminal } = xterm

test('demo explicitly implements the UI contract without catch-all methods', () => {
  const channel = createDemoChannel()
  for (const name of Object.keys(CHANNEL_UI_EFFECTS)) assert.equal(typeof channel[name], 'function', name)
  for (const name of CHANNEL_UI_PROPERTIES) assert.ok(name in channel, name)
})

test('terminal protocol rejects malformed, oversized and unbounded input', () => {
  assert.deepEqual(parseMessage('{"type":"resize","cols":100,"rows":32}'), { type: 'resize', cols: 100, rows: 32 })
  assert.deepEqual(parseMessage('{"type":"input","data":"hi"}'), { type: 'input', data: 'hi' })
  for (const message of ['null', '{}', '{"type":"resize","cols":9999,"rows":40}', '{"type":"exec","command":"whoami"}',
    JSON.stringify({ type: 'input', data: 'x'.repeat(4097) })]) {
    assert.throws(() => parseMessage(message))
  }
})

test('real renderer streams, accepts input, resizes and releases its session', { timeout: 40000 }, async t => {
  const preview = await startPreview({ port: 0 })
  t.after(() => preview.close())
  const response = await fetch(preview.url)
  assert.equal(response.status, 200)
  const cookie = response.headers.get('set-cookie').split(';')[0]
  for (const path of ['/app.mjs', '/xterm.js', '/xterm.css', '/fit.js', '/icons.js', '/logo.svg']) {
    assert.equal((await fetch(`${preview.url}${path}`)).status, 200, path)
  }
  assert.equal((await fetch(`${preview.url}/package.json`)).status, 404)
  const rejected = new WebSocket(preview.url.replace('http', 'ws') + '/terminal', {
    headers: { Origin: 'https://untrusted.example', Cookie: cookie },
  })
  const rejectedError = once(rejected, 'error')
  assert.match((await rejectedError)[0].message, /403/)
  const term = new Terminal({ cols: 100, rows: 32, allowProposedApi: true })
  t.after(() => term.dispose())
  const ws = new WebSocket(preview.url.replace('http', 'ws') + '/terminal', {
    headers: { Origin: preview.url, Cookie: cookie },
  })
  t.after(() => ws.terminate())
  let ready = false
  let error = ''
  ws.on('message', (data, binary) => {
    if (binary) term.write(data.toString())
    else {
      const message = JSON.parse(data.toString())
      if (message.type === 'size-request') ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 32 }))
      if (message.type === 'ready') ready = true
      if (message.error) error = message.error
    }
  })
  await once(ws, 'open')
  assert.ok(await settled(() => ready || Boolean(error), { timeoutMs: 20000 }), 'runtime startup timeout')
  assert.equal(error, '', error)
  assert.equal(ready, true)
  const text = () => viewportLines(term).join('\n')
  const send = data => ws.send(JSON.stringify({ type: 'input', data }))
  send('Inspect demo project')
  assert.ok(await settled(() => text().includes('Inspect demo project')), text())
  send('\r')
  assert.ok(await settled(() => text().includes('Preview result'), { timeoutMs: 12000 }), text() + error)
  assert.ok(await settled(() => text().includes('temporary demo session'), { timeoutMs: 8000 }), text())
  term.resize(50, 28)
  ws.send(JSON.stringify({ type: 'resize', cols: 50, rows: 28 }))
  assert.ok(await settled(() => text().includes('demo session')), text())
  send('/vim')
  assert.ok(await settled(() => text().includes('/vim')), text())
  send('\r')
  assert.ok(await settled(() => /vim|Vim|NORMAL|INSERT/.test(text())), text())
  ws.close()
  assert.ok(await settled(() => preview.sessions.size === 0, { timeoutMs: 8000 }), 'session leaked after disconnect')
})
