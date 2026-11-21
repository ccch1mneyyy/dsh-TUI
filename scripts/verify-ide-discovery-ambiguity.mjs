/** #1913: two equally matching IDE windows must not be guessed by port order.
 * Real authenticated loopback WebSocket servers and private lock files.
 * Run after compile: node scripts/verify-ide-discovery-ambiguity.mjs
 */
import fakeHome from './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocketServer } from 'ws'
import { IdeChannel, ideLockDir } from '../lib/types/dsh-adapter/ide-channel.js'
import { createChannel } from '../lib/types/dsh-adapter/channel.js'
import { setLang, t } from '../lib/types/i18n.js'

let failures = 0
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failures++ }
const root = await mkdtemp(join(tmpdir(), 'ide-window-ambiguity-'))
const cwd = join(root, 'workspace'); await mkdir(cwd)
const originalEnv = [process.env.DSH_TUI_IDE_PORT, process.env.DSH_TUI_IDE_TOKEN]
delete process.env.DSH_TUI_IDE_PORT
delete process.env.DSH_TUI_IDE_TOKEN
async function waitFor(ready) {
  const end = Date.now() + 5000
  while (!ready() && Date.now() < end) await delay(20) // 固定窗:pacing Observe actual local socket messages within a bounded fixture deadline.
  return ready()
}
async function server(label, folders) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', maxPayload: 4096 })
  await new Promise((ok, fail) => { wss.once('listening', ok); wss.once('error', fail) })
  let hellos = 0
  wss.on('connection', socket => {
    socket.on('error', () => {})
    socket.on('message', data => {
      const message = JSON.parse(String(data))
      if (message.method !== 'ide/hello') return
      hellos++
      if (message.params?.token !== `test-${label}`) { socket.close(); return }
      socket.send(JSON.stringify({ method: 'ide/hello_ack', params: { protocolVersion: 2, workspaceFolders: folders } }))
      socket.send(JSON.stringify({ method: 'selection_changed', params: { path: `${label}.ts`, startLine: 0, endLine: 0, isEmpty: false, text: `SYNTHETIC_WINDOW_${label}`, documentVersion: 1 } }))
    })
  })
  const address = wss.address(); assert.ok(address && typeof address === 'object')
  return { port: address.port, token: `test-${label}`, folders, hellos: () => hellos,
    async close() { for (const socket of wss.clients) socket.terminate(); await new Promise(resolve => wss.close(resolve)) } }
}
const servers = []
async function locks(name, entries) {
  const dir = join(root, name); await mkdir(dir)
  for (let i = 0; i < entries.length; i++) {
    const { target, token = target.token } = entries[i]
    await writeFile(join(dir, `${target.port}-${i}.lock`), JSON.stringify({ port: target.port, token, workspaceFolders: target.folders, pid: process.pid }))
  }
  return dir
}
try {
  const a = await server('A', [cwd]); servers.push(a)
  const b = await server('B', [cwd]); servers.push(b)
  const broadA = await server('BROAD_A', [root]); servers.push(broadA)
  const broadB = await server('BROAD_B', [root]); servers.push(broadB)
  const tied = await locks('tied', [{ target: a }, { target: b }])
  {
    const ch = new IdeChannel()
    try {
      await ch.start({}, join(root, 'missing'), cwd)
      check('absent IDE stays silently disconnected without ambiguity', !ch.connected && !ch.ambiguous)
    } finally { ch.stop() }
  }
  {
    const ch = new IdeChannel(), before = a.hellos() + b.hellos()
    let selections = 0; ch.onSelection(() => selections++)
    try {
      await ch.start({}, tied, cwd)
      if (ch.connected) await waitFor(() => ch.selection !== undefined)
      check('equal workspace candidates leave the channel disconnected', !ch.connected)
      check('equal workspace candidates receive no hello or token', a.hellos() + b.hellos() === before)
      check('no other window selection is cached or delivered', ch.selection === undefined && selections === 0)
      check('ambiguous discovery is distinguishable from an absent IDE', ch.ambiguous === true)
    } finally { ch.stop() }
    check('stop clears the ambiguity diagnostic', !ch.ambiguous)
  }
  {
    const ch = new IdeChannel(), aBefore = a.hellos(), bBefore = b.hellos()
    try {
      await ch.start({ DSH_TUI_IDE_PORT: String(b.port), DSH_TUI_IDE_TOKEN: b.token }, tied, cwd)
      check('explicit env still connects the intended window among tied locks', ch.connected && await waitFor(() => ch.selection?.text === 'SYNTHETIC_WINDOW_B'))
      check('explicit env does not contact the other window', a.hellos() === aBefore && b.hellos() === bBefore + 1)
      check('successful explicit connection has no ambiguity warning', !ch.ambiguous)
    } finally { ch.stop() }
  }
  {
    const ch = new IdeChannel(), aBefore = a.hellos(), bBefore = b.hellos()
    try {
      await ch.start({ DSH_TUI_IDE_PORT: String(b.port), DSH_TUI_IDE_TOKEN: 'test-wrong' }, tied, cwd)
      check('failed explicit auth cannot fall through to tied windows', !ch.connected)
      check('failed explicit auth sends only its explicit hello', a.hellos() === aBefore && b.hellos() === bBefore + 1)
      check('failed explicit auth never acquires a foreign selection', ch.selection === undefined)
    } finally { ch.stop() }
  }
  {
    const single = await locks('single', [{ target: a }]), ch = new IdeChannel()
    try {
      await ch.start({}, single, cwd)
      check('one matching window retains automatic discovery', ch.connected && await waitFor(() => ch.selection?.text === 'SYNTHETIC_WINDOW_A'))
    } finally { ch.stop() }
  }
  {
    const dir = await locks('rebind', [{ target: a }, { target: b }]), ch = new IdeChannel()
    try {
      await ch.start({}, dir, cwd)
      check('rebind fixture starts ambiguous', ch.ambiguous && !ch.connected)
      await rm(join(dir, `${b.port}-1.lock`))
      await ch.rebind(cwd)
      check('rebind clears ambiguity and recovers a unique matching window', ch.connected && !ch.ambiguous && await waitFor(() => ch.selection?.text === 'SYNTHETIC_WINDOW_A'))
      await ch.rebind(join(root, 'other-workspace'))
      check('unmatched workspace rebind clears old selection and stays silent', !ch.connected && !ch.ambiguous && ch.selection === undefined)
    } finally { ch.stop() }
  }
  {
    const dir = await locks('specific', [{ target: broadA }, { target: a }]), ch = new IdeChannel(), broadBefore = broadA.hellos()
    try {
      await ch.start({}, dir, cwd)
      check('one most-specific workspace still wins over a broader root', ch.connected && await waitFor(() => ch.selection?.text === 'SYNTHETIC_WINDOW_A'))
      check('a less-specific candidate is not dialed after success', broadA.hellos() === broadBefore)
    } finally { ch.stop() }
  }
  {
    const dir = await locks('duplicates', [{ target: a }, { target: a }]), ch = new IdeChannel(), before = a.hellos()
    try {
      await ch.start({}, dir, cwd)
      check('duplicate advertisements of the same port/token remain one target', ch.connected && !ch.ambiguous && a.hellos() === before + 1)
    } finally { ch.stop() }
  }
  {
    const dir = await locks('tied-fallback', [{ target: a, token: 'test-stale' }, { target: broadA }, { target: broadB }]), ch = new IdeChannel()
    const before = broadA.hellos() + broadB.hellos()
    try {
      await ch.start({}, dir, cwd)
      check('failed unique candidate cannot fall through into a tied broader group', !ch.connected)
      check('a tied fallback group receives no hello', broadA.hellos() + broadB.hellos() === before)
    } finally { ch.stop() }
  }
  // The production channel must explain the refusal without a UI component
  // owning discovery, and disposed construction must never publish a notice.
  const privateLocks = ideLockDir(); await mkdir(privateLocks, { recursive: true })
  for (const target of [a, b]) await writeFile(join(privateLocks, `${target.port}.lock`), JSON.stringify({ port: target.port, token: target.token, workspaceFolders: [cwd], pid: process.pid }))
  const makeChannel = () => createChannel({ on: () => () => {}, get: () => undefined, logger: { warn() {}, info() {}, debug() {} } },
    { id: 'ide-ambiguity-fixture', status: 'idle', session: { id: 'ide-ambiguity-fixture', seq: 0, events: [] }, ctx: { on: () => () => {} }, followup() {}, steer() {}, cancel() {} },
    { model: 'fixture', provider: '', cwd, activity: false })
  for (const lang of ['zh', 'en']) {
    setLang(lang)
    const channel = makeChannel()
    try {
      await waitFor(() => channel.notifications.length > 0 || channel.selection !== undefined)
      check(`${lang} production channel publishes the actionable ambiguity notice`, channel.notifications.some(n => n.text === t('ide-discovery-ambiguous')))
      const report = channel.rows.filter(row => row.kind === 'local-output')
      check(`${lang} production channel provides complete cause and recovery`, report.length === 2 && report[1].text === t('ide-discovery-ambiguous-recovery'))
      check(`${lang} production channel contains no foreign selection`, channel.selection === undefined)
    } finally { channel.releaseContributions() }
  }
  {
    const channel = makeChannel(); channel.releaseContributions()
    await new Promise(resolve => setImmediate(resolve))
    check('disposed channel construction never publishes a late notice', channel.notifications.length === 0 && channel.rows.length === 0)
  }
} finally {
  for (const [index, key] of ['DSH_TUI_IDE_PORT', 'DSH_TUI_IDE_TOKEN'].entries()) {
    if (originalEnv[index] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[index]
  }
  for (const fixture of servers.reverse()) await fixture.close()
  for (const path of [root, fakeHome]) { assert.ok(resolve(path).startsWith(resolve(tmpdir()) + sep)); await rm(path, { recursive: true, force: true }) }
}
console.log(`verify-ide-discovery-ambiguity: ${failures} failure(s)`)
if (failures) process.exitCode = 1
