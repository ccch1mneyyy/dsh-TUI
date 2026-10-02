/** Same-session model selection and first-prompt title eligibility.
 * Run: node --import tsx/esm scripts/verify-session-title-lineage.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const testHome = mkdtempSync(join(tmpdir(), 'dshtui-model-selection-'))
process.env.HOME = testHome
process.env.USERPROFILE = testHome
process.env.DSH_TUI_LANG = 'en'
const { createChannel } = await import('../src/dsh-adapter/channel.js')

for (const prompted of [false, true]) {
  const handlers = new Map<string, Function>()
  const events = prompted ? [{ seq: 0, time: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } }] : []
  let lastConfig = { provider: 'p', model: 'a', reasoningEffort: 'high' }
  const header = { id: 'session', ...(prompted ? { parentSession: 'existing-parent' } : {}) }
  const session = { id: 'session', seq: events.length, events, header, requestHeader: () => ({ config: lastConfig }) }
  const agent = { id: 'session', status: 'idle', options: { provider: 'p', model: 'a' }, session,
    ctx: { on(name: string, fn: Function) { handlers.set(name, fn); return () => handlers.delete(name) } },
    followup() {}, steer() {}, inbox: { remove: () => true } }
  let creates = 0
  const ctx = { on: () => () => {}, logger: { warn() {} }, get(name: string) {
    if (name === 'agents') return { create() { creates++; throw new Error('model switch must not create an agent') } }
    if (name === 'llm') return { listProviders: () => [{ id: 'p' }], listModels: async () => ['a', 'b'].map(id => ({ id, provider: 'p', name: id })) }
  } }
  const channel = createChannel(ctx as never, agent as never, { model: 'a', provider: 'p', cwd: '/tmp/demo', activity: false })
  const before = channel.rows
  for (const model of ['b', 'a']) {
    assert.equal(await channel.switchModel('p', model), true)
    assert.equal(channel.sessionId, 'session')
    assert.equal(channel.agentId, 'session')
    assert.equal(session.header, header)
    assert.equal(session.events, events)
    assert.equal(channel.rows, before, 'switch preserves transcript projection')
    const assembly = await handlers.get('system-prompt/assemble')!({}, {}, async () => ({ variables: { model: 'a', provider: 'p' } }))
    const request = await handlers.get('agent/request')!({}, async () => lastConfig)
    assert.equal(assembly.variables.model, model)
    assert.equal(request.model, model)
    assert.equal(request.reasoningEffort, undefined, 'old model effort cannot leak')
    const input = { role: 'user', content: [] }
    const decision = await handlers.get('agent/pre-step')!({ agent, messages: [input], signal: new AbortController().signal, step: 1 }, async () => ({ kind: 'accept', messages: [input] }))
    assert.equal(decision.messages.at(-1).source.kind, 'model-selection')
    lastConfig = request
  }
  assert.equal(creates, 0)
  assert.equal(await channel.switchModel('p', 'a'), true)
  assert.equal(await channel.switchModel('p', 'missing'), false)
  assert.equal(channel.model, 'a')
  channel.releaseContributions()
}
const { createModelSwitchAction } = await import('../src/dsh-adapter/channel/model-switch.js')
{
  let generation = 0
  let active = true
  let resolveCatalog!: (models: readonly { id: string }[]) => void
  const state = { provider: 'p', model: 'a', working: false, emit() {} }
  const selection = { current: undefined, assembled: undefined }
  const switchModel = createModelSwitchAction({ get: () => ({ listModels: () => new Promise(resolve => { resolveCatalog = resolve }) }) } as never, state as never, {
    owner: { current: () => active },
    binding: { capture: () => ({ generation }), isCurrent: capture => capture.generation === generation } as never,
    selection, settleCompaction: async () => {}, applyPreferredEffort: async () => {}, dropModelCompletion() {}, notify() {},
  })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const stale = switchModel('p', 'b')
  await tick()
  assert.equal(await switchModel('p', 'a'), true, 'same-route choice cancels pending selection')
  resolveCatalog([{ id: 'b' }])
  assert.equal(await stale, false)
  assert.equal(state.model, 'a')
  const rebound = switchModel('p', 'b')
  await tick()
  generation++
  resolveCatalog([{ id: 'b' }])
  assert.equal(await rebound, false, 'replaced binding cannot be changed by old catalog read')
  const revoked = switchModel('p', 'b')
  await tick()
  active = false
  resolveCatalog([{ id: 'b' }])
  assert.equal(await revoked, false)
  assert.equal(state.model, 'a')
}
console.log('verify:session-title-lineage OK (same identity, title eligibility, A→B→A, routing, effort, notice, invalid route)')
