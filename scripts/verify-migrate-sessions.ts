/** Nonempty SQLite -> official format migration -> V3 JSONL round trip.
 * Run: node --import tsx/esm scripts/verify-migrate-sessions.ts
 * Uses disposable databases only; no credentials or live sessions.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionPersistence, { Context as LegacyContext, SessionStore, Session as LegacySession } from '../vendor/sqlite-island/index.js'
import { settled } from './lib/term-test.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-migrate-test-'))
const from = join(root, 'source.sqlite')
const to = join(root, 'sessions')
const run = (args: string[] = [], expectedExit = 0) => {
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', 'scripts/migrate-sessions-to-jsonl.mts', '--from', from, '--to', to, ...args], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, HOME: root, USERPROFILE: root, DSH_HOME: join(root, 'home') },
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, expectedExit, result.stdout + result.stderr)
  return result.stdout + result.stderr
}
try {
  assert.match(run(['--dry-run']), /nothing to migrate/)
  const ctx = new LegacyContext()
  const sessions = ctx.plugin(SessionStore)
  const plugin = ctx.plugin(SqliteSessionPersistence, { path: from })
  let sourceEvents: readonly unknown[] = []
  try {
    assert.ok(await settled(() => ctx.get('sessionPersistence') !== undefined))
    const s = LegacySession.create('source' as never, [], { id: 'source' as never, version: 0, createdAt: 1, cwd: root, agentPreset: 'liangshen' })
    s.append('turn/start', { turn: 1 })
    s.append('step/start', { turn: 1, step: 1 })
    s.append('user/message', { id: 'user-message', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'migrate this question' }] } as never, { surfaceOp: 'append' })
    s.append('assistant/message', { turn: 1, step: 1, message: {
      id: 'assistant-message', role: 'assistant', content: [{ type: 'text', text: 'retained answer' }],
      source: { kind: 'model', provider: 'deepseek', model: 'model' },
    } } as never, { surfaceOp: 'append' })
    s.append('step/end', { turn: 1, step: 1 })
    s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    sourceEvents = s.events
    await ctx.sessionPersistence.create(s.header)
    await ctx.sessionPersistence.append(s.id, s.events)
    const child = LegacySession.create('fork' as never, s.events, {
      ...s.header, id: 'fork' as never, parentSession: s.id, seedLength: s.events.length,
    })
    await ctx.sessionPersistence.create(child.header)
    await ctx.sessionPersistence.append(child.id, child.events)
  } finally { await plugin.dispose(); await sessions.dispose() }
  const before = readFileSync(from)
  assert.match(run(['--dry-run']), /2 migrated, 0 skipped.*0 failed/)
  assert.equal(existsSync(to), false, 'dry-run must not create a destination')
  assert.deepEqual(readFileSync(from), before, 'dry-run leaves the original database byte-identical')
  assert.match(run(), /2 migrated, 0 skipped.*0 failed/)
  assert.deepEqual(readFileSync(from), before, 'migration leaves the original database byte-identical')
  assert.match(run(), /0 migrated, 2 skipped.*0 failed/)

  const dst = new Context()
  const dstPlugin = dst.plugin(JsonlSessionPersistence, { root: to })
  try {
    assert.ok(await settled(() => dst.get('sessionPersistence') !== undefined))
    assert.equal((await dst.sessionPersistence.list()).length, 2)
    for (const id of ['source', 'fork']) {
      const handle = await dst.sessionPersistence.open(SessionId(id), 'read')
      try {
        assert.equal(handle.header.version, 3)
        assert.equal(handle.header.agentPreset, 'liangshen')
        const { events, eventState } = await handle.read()
        const restored = Session.fromRestore(handle.id, events, handle.header, handle.inheritedEventCount, eventState)
        assert.deepEqual(restored.deriveMessages().map(message => message.content[0]?.type === 'text' ? message.content[0].text : ''), [
          'migrate this question', 'retained answer',
        ])
        if (id === 'fork') assert.ok(handle.inheritedEventCount > 0)
        assert.ok(events.length >= sourceEvents.length)
      } finally { await handle.close() }
    }
  } finally { await dstPlugin.dispose() }
  const unsupportedCtx = new LegacyContext()
  const unsupportedSessions = unsupportedCtx.plugin(SessionStore)
  const unsupportedPlugin = unsupportedCtx.plugin(SqliteSessionPersistence, { path: from })
  try {
    assert.ok(await settled(() => unsupportedCtx.get('sessionPersistence') !== undefined))
    const unsupported = LegacySession.create('unsupported' as never)
    unsupported.append('user/message', { id: 'early-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'before first step' }] } as never, { surfaceOp: 'append' })
    await unsupportedCtx.sessionPersistence.create(unsupported.header)
    await unsupportedCtx.sessionPersistence.append(unsupported.id, unsupported.events)
  } finally { await unsupportedPlugin.dispose(); await unsupportedSessions.dispose() }
  const unsupportedBefore = readFileSync(from)
  const refused = run([], 1)
  assert.match(refused, /0 migrated, 2 skipped.*1 failed/)
  assert.match(refused, /cannot acquire a system head/)
  assert.deepEqual(readFileSync(from), unsupportedBefore, 'unsupported migration leaves original data intact')
  console.log('PASS nonempty SQLite migration, fork lineage, dry-run, source preservation and repeat invocation')
} finally { rmSync(root, { recursive: true, force: true }) }
