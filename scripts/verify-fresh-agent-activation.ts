/**
 * Host-owned agent creation must not inherit its triggering row's activation.
 * Real DSH services, factory, events and JSONL; no model request or user state.
 * The observer models dsh-ops' lazy root observers on agent/created (#1976).
 * Nested plugin activations must retain every root-capability guard.
 * Run: node --import tsx/esm scripts/verify-fresh-agent-activation.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as PersistenceModule from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'fresh-agent-activation-')))
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
process.env.HOME = scratch
process.env.USERPROFILE = scratch
const { compositionRoot } = await import('../src/dsh-adapter/host-access.js')
const { createFreshAgent } = await import('../src/dsh-adapter/fresh-agent.js')
const Persistence = 'default' in PersistenceModule ? PersistenceModule.default : PersistenceModule
let modelRequests = 0
let refused = 0
class Adapter extends LlmAdapter {
  async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  async *stream() { modelRequests++; throw new Error('this check must not request a model') }
}
function guards(root: Context): void {
  for (const operation of [
    () => root.events.on('activation/escape', () => {}),
    () => root.events.once('activation/escape', () => {}),
    () => root.effect(() => {}),
    () => root.inject([], () => {}),
    () => root.reflect.set('activationEscape', true),
    () => root.fiber.restart(),
  ]) {
    assert.throws(operation, /is unavailable from a plugin activation/)
    refused++
  }
}

try {
  for (const persisted of [true, false]) {
    const root = new Context()
    let rowFailure: unknown
    let seen = 0
    try {
      for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, NativeToolExecutor, AgentRegistry]) await root.plugin(plugin)
      if (persisted) await root.plugin(Persistence, { root: join(scratch, 'sessions'), compression: 'none' })
      await root.plugin(AgentLoop, { agents: [] })
      root.llm.registerAdapter(['fixture'], new Adapter())
      const observer = await root.plugin({
        name: 'existing-host-observer',
        apply(ctx: Context) {
          ctx.on('agent/created', () => {
            const stop = root.events.on('activation/notice', () => { seen++ })
            ctx.effect(() => stop)
          })
        },
      })
      const row = root.plugin({
        name: 'fresh-agent-owner',
        inject: persisted ? ['agents', 'sessions', 'sessionPersistence'] : ['agents', 'sessions'],
        async apply(ctx: Context) {
          try {
            compositionRoot(ctx)
            guards(root)
            const handle = await createFreshAgent(ctx, ctx.agents, {
              sessionId: SessionId(persisted ? 'persisted-activation' : 'plain-activation'),
              meta: { cwd: scratch },
              agentOptions: { provider: 'fixture', model: 'fixture' },
              setup: async agentCtx => {
                let nestedFailure: unknown
                let stale: Promise<void> | undefined
                const release = Promise.withResolvers<void>()
                const nested = agentCtx.plugin({
                  name: 'nested-preset-activation',
                  async apply() {
                    try {
                      guards(root)
                      await Promise.resolve()
                      guards(root)
                      stale = release.promise.then(() => { guards(root) })
                    } catch (error) { nestedFailure = error; throw error }
                  },
                })
                await nested
                assert.equal(nestedFailure, undefined)
                await nested.dispose()
                release.resolve()
                await stale
              },
            })
            guards(root)
            assert.equal(ctx.agents.get(handle.agent.session.id), handle.agent)
            root.events.emit('activation/notice')
            assert.equal(seen, 1, 'the lazy Host observer is actually registered')
            await handle.dispose()
            assert.equal(ctx.agents.get(handle.agent.session.id), undefined)
            await assert.rejects(createFreshAgent(ctx, ctx.agents, {
              sessionId: SessionId(persisted ? 'persisted-failed' : 'plain-failed'),
              agentOptions: { provider: 'fixture', model: 'fixture' },
              setup: async () => { throw new Error('setup failed on purpose') },
            }), /setup failed on purpose/)
            guards(root)
          } catch (error) { rowFailure = error; throw error }
        },
      })
      await row
      assert.equal(rowFailure, undefined)
      root.events.emit('activation/notice')
      assert.equal(seen, 2, 'the Host observer has its own lifetime')
      await observer.dispose()
      root.events.emit('activation/notice')
      assert.equal(seen, 2, 'unloading its owner disposes the root observer')
      await row.dispose()
      console.log(`PASS ${persisted ? 'JSONL' : 'unpersisted'} Host create, nested/stale guards, failure restoration and observer disposal`)
    } finally { await root.fiber.dispose() }
  }
  assert.equal(modelRequests, 0)
  assert.equal(refused, 72)
  console.log(`fresh agent activation OK (${refused} root-capability refusals, no model requests)`)
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  assert.equal(dirname(scratch), realpathSync(tmpdir()))
  assert.ok(basename(scratch).startsWith('fresh-agent-activation-'))
  rmSync(scratch, { recursive: true, force: true })
}
