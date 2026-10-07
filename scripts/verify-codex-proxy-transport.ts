/** Real child-process WebSocket framing for the native daemon proxy.
 * No Codex executable, credentials, TCP listener or model calls are used.
 * Run: node --import tsx/esm scripts/verify-codex-proxy-transport.ts */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnTransport, type TransportExit } from '../src/backends/codex/rpc/transport.js'
import { settled } from './lib/term-test.mjs'

const dir = mkdtempSync(join(tmpdir(), 'codex-proxy-transport-'))
const require = createRequire(import.meta.url)
writeFileSync(join(dir, 'app-server'), `
const { createServer } = require('node:http')
const { Duplex } = require('node:stream')
const { WebSocketServer } = require(${JSON.stringify(require.resolve('ws'))})
const server = createServer({ noDelay: false })
const peers = new WebSocketServer({ noServer: true, perMessageDeflate: false })
server.on('upgrade', (request, socket, head) => {
  if (process.env.REJECT_UPGRADE === '1') {
    socket.end('HTTP/1.1 403 Forbidden\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n')
    return
  }
  peers.handleUpgrade(request, socket, head, peer => {
    peer.on('message', data => {
      const message = JSON.parse(data.toString('utf8'))
      if (message.method === 'exit') process.exit(7)
      const reply = Buffer.from(JSON.stringify({ id: message.id, result: message.params }))
      const split = Math.floor(reply.length / 2)
      peer.send(reply.subarray(0, split), { binary: false, fin: false })
      peer.send(reply.subarray(split), { binary: false, fin: true })
    })
    peer.on('close', () => process.exit(0))
  })
})
server.emit('connection', Duplex.from({ readable: process.stdin, writable: process.stdout }))
process.stdin.on('end', () => process.exit(0))
`)
let passed = 0
const check = (label: string, ok: boolean): void => { assert.ok(ok, label); passed += 1; console.log('PASS ' + label) }
const run = (reject = false) => {
  const rows: { id: number; result: { text: string } }[] = []
  const stderr: string[] = []
  let exit: TransportExit | undefined
  let exits = 0
  const transport = spawnTransport({
    executable: process.execPath, args: ['app-server', 'proxy'], cwd: dir,
    env: { PATH: process.env.PATH ?? '', ...(reject ? { REJECT_UPGRADE: '1' } : {}) },
    onLine: line => rows.push(JSON.parse(line)),
    onStderr: line => stderr.push(line),
    onExit: info => { exit = info; exits += 1 },
  })
  return { transport, rows, stderr, get exit() { return exit }, get exits() { return exits } }
}
const open: ReturnType<typeof run>[] = []
try {
  const connected = run()
  open.push(connected)
  const text = '汉🙂e\u0301'.repeat(32_768) + '\nend'
  connected.transport.write(JSON.stringify({ id: 1, method: 'echo', params: { text } }))
  connected.transport.write(JSON.stringify({ id: 2, method: 'echo', params: { text: 'second' } }))
  connected.transport.write(JSON.stringify({ id: 3, method: 'echo', params: { text: 'third' } }))
  check('writes queued before the WebSocket upgrade arrive in order', await settled(() => connected.rows.length === 3) && connected.rows.map(row => row.id).join(',') === '1,2,3')
  check('fragmented large Unicode frames preserve JSON text', connected.rows[0]?.result.text === text && connected.rows[1]?.result.text === 'second')
  check('normal proxy traffic emits no diagnostics', connected.stderr.length === 0)
  await connected.transport.close()
  await connected.transport.close()
  check('closing only the proxy reports one clean child exit', connected.exit?.code === 0 && connected.exits === 1)

  const rejected = run(true)
  open.push(rejected)
  rejected.transport.write(JSON.stringify({ id: 1, method: 'echo', params: { text: 'unreachable' } }))
  check('rejected upgrade closes the child and reports a diagnostic', await settled(() => rejected.exit !== undefined) && rejected.rows.length === 0 && rejected.stderr.includes('dsh-tui: Codex daemon proxy connection failed'))
  await rejected.transport.close()
  check('failed proxy exit is reported once', rejected.exits === 1)

  const crashed = run()
  open.push(crashed)
  crashed.transport.write(JSON.stringify({ id: 1, method: 'exit', params: {} }))
  check('unexpected child exit preserves its exit code', await settled(() => crashed.exit !== undefined) && crashed.exit?.code === 7 && crashed.exits === 1)
  await crashed.transport.close()
  console.log('\nverify-codex-proxy-transport OK (' + passed + ' checks)')
} finally {
  for (const connection of open) await connection.transport.close()
  rmSync(dir, { recursive: true, force: true })
}
