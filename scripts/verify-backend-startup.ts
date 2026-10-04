/** Generic backend boot against the real mount ledger and a fake backend.
 * Run: node --import tsx/esm scripts/verify-backend-startup.ts
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { AgentBackend, BackendSessionPrefs, OpenTarget } from '../src/agent/backend.js'
import type { AgentSession } from '../src/agent/session.js'
import type { AgentEvent } from '../src/agent/events.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-backend-startup-'))
process.env.HOME = home
process.env.USERPROFILE = home
delete process.env.DSH_TUI_RESUME_SESSION
const { openBackendStartup } = await import('../src/dsh-adapter/backends.js')
const { ownMounts, publishMounts, readSessionOwners } = await import('../src/sessionMounts.js')
const dir = join(home, '.dsh-tui')
const ledger = join(dir, 'session-mounts.json')
mkdirSync(dir, { recursive: true })
const ctx = new Context()
const opened: OpenTarget[] = []
const used: string[] = []
let lastSession: string | undefined = 'remembered'
let disposed = 0
let history: () => Promise<readonly AgentEvent[]> = async () => []
const prefs: BackendSessionPrefs = {
  lastSession: () => lastSession,
  setLastSession: id => { lastSession = id },
  touch: id => { used.push(id) },
  forget: id => { if (lastSession === id) lastSession = undefined },
}
const backend: AgentBackend = {
  id: 'fake',
  descriptor: { label: 'Fake', vendor: 'Test' },
  detect: async () => ({ installed: true }),
  launch: { sessionPrefs: () => prefs, resumeCommand: id => `fake --resume ${id}` },
  open: async target => {
    opened.push(target)
    if (target.kind === 'resume' && target.sessionId === 'unknown') {
      publishMounts([])
      assert.ok(ownMounts().includes('fake:unknown'), 'reservation survives publication while opening')
      throw new Error('unknown session')
    }
    const session = {
      ref: { backendId: 'fake', sessionId: target.kind === 'resume' ? target.sessionId : 'new' },
      cwd: home,
      status: 'idle' as const,
      capabilities: {},
      history: () => history(),
      subscribe: () => () => undefined,
      submit: async () => ({ accepted: true }),
      removePending: () => false,
      cancel: async () => ({ stillQueued: [], outcome: 'confirmed' as const }),
      dispose: async () => { disposed += 1 },
    }
    return session satisfies AgentSession
  },
}
const start = (argv: readonly string[]) => openBackendStartup(ctx, backend, { cwd: home, stderr: () => undefined, argv })
try {
  writeFileSync(ledger, JSON.stringify({ version: 1, owners: [{ pid: process.ppid, startedAt: Date.now(), sessionIds: ['fake:occupied'] }] }))
  await assert.rejects(start(['--resume', 'occupied']), /cannot resume Fake session.*occupied/)
  assert.equal(opened.length, 0, 'occupied resume opens neither resumed nor fresh session')
  console.log('PASS occupied resume refuses before opening')

  await assert.rejects(start(['--resume', 'unknown']), /unknown session.*no fresh session was started/)
  assert.deepEqual(opened.map(target => target.kind), ['resume'])
  assert.ok(!ownMounts().includes('fake:unknown'), 'failed open abandons reservation')
  assert.ok(!readSessionOwners().has('fake:unknown'), 'failed open releases ledger claim')
  console.log('PASS unknown resume abandons reservation without creating')

  writeFileSync(ledger, JSON.stringify({ version: 1, owners: [] }))
  const created = await start([])
  assert.equal(created.session.ref.sessionId, 'new')
  assert.equal(opened.at(-1)?.kind, 'create')
  assert.ok(readSessionOwners().has('fake:new'), 'create publishes its fresh session reservation')
  await created.session.dispose()
  console.log('PASS create tolerates unavailable announcement ledger')

  rmSync(ledger)
  const seed: readonly AgentEvent[] = []
  history = async () => {
    publishMounts([])
    assert.ok(ownMounts().includes('fake:remembered'), 'resume reservation lasts through history')
    return seed
  }
  const resumed = await start(['--resume'])
  assert.equal(resumed.initialHistory, seed)
  assert.equal(lastSession, 'remembered')
  assert.deepEqual(used, ['remembered'])
  assert.equal(resumed.resumeCommand('remembered'), 'fake --resume remembered')
  await resumed.session.dispose()
  console.log('PASS remembered resume reads history and persists last use')

  history = async () => { throw new Error('history unreadable') }
  const before = disposed
  await assert.rejects(start(['--resume', 'fake:broken']), /history unreadable.*no fresh session was started/)
  assert.equal(disposed, before + 1, 'history failure disposes opened handle')
  assert.ok(!readSessionOwners().has('fake:broken'), 'history failure releases reservation')
  assert.deepEqual(opened.map(target => target.kind), ['resume', 'create', 'resume', 'resume'])
  console.log('PASS history failure disposes session and abandons reservation')
  console.log('ALL PASS backend startup')
} finally {
  publishMounts([])
  rmSync(home, { recursive: true, force: true })
}
