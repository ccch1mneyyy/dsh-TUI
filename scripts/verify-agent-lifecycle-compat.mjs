/**
 * Real 0.1.7 Agent/Session/JSONL lifecycle through the TUI channel. Only the
 * model transport is scripted; no network, credentials, or user state.
 * Run after build: node scripts/verify-agent-lifecycle-compat.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { settled } from './lib/term-test.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-lifecycle-'))
process.env.HOME = root
process.env.USERPROFILE = root
process.env.DSH_HOME = join(root, 'home')
const { createChannel } = await import('../lib/types/dsh-adapter/channel.js')
const firstStream = Promise.withResolvers()
const hangingStream = Promise.withResolvers()
let requests = 0
let toolRuns = 0

function* text(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

class ScriptedAdapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    requests++
    if (requests === 1) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'first reply' }
      await firstStream.promise
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'first reply' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } else if (requests === 2) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-983', name: 'echo', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else if (requests === 3) {
      yield* text('after tool')
    } else if (requests === 4) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial reply' }
      const abort = () => hangingStream.reject(new Error('aborted'))
      options.signal.addEventListener('abort', abort, { once: true })
      if (options.signal.aborted) abort()
      try { await hangingStream.promise }
      finally { options.signal.removeEventListener('abort', abort) }
    } else {
      throw new Error(`unexpected model request ${requests}`)
    }
  }
}

const ctx = new Context()
let channel
try {
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) {
    await ctx.plugin(plugin)
  }
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter())
  ctx.tools.register(defineContentToolFixture({
    name: 'echo', description: 'local regression fixture', parameters: {},
    async execute() { toolRuns++; return [{ type: 'text', text: 'tool output' }] },
  }))
  const handle = await ctx.agents.create({
    sessionId: 'lifecycle-983', cwd: root, agentOptions: { provider: 'scripted', model: 'scripted' },
  })
  channel = createChannel(ctx, handle.agent, {
    handle, cwd: root, provider: 'scripted', model: 'scripted', activity: false,
  })
  channel.submit('first prompt')
  assert.ok(await settled(() => channel.rows.some(row => row.text === 'first reply')), 'stream reaches the channel before completion')
  assert.equal(channel.working, true)
  firstStream.resolve()
  assert.ok(await settled(() => !channel.working && channel.pending.length === 0))
  channel.submit('tool prompt')
  assert.ok(await settled(() => requests === 3 && !channel.working))
  assert.equal(toolRuns, 1)
  const tool = channel.rows.find(row => row.tool?.callId === 'call-983')
  assert.ok(tool, 'tool call retains its upstream call id')
  assert.equal(tool.tool.resultFull, 'tool output', 'V4 tool output is visible')
  channel.submit('cancel prompt')
  assert.ok(await settled(() => channel.rows.some(row => row.text === 'partial reply')))
  channel.cancel()
  assert.ok(await settled(() => !channel.working), 'cancel drains the real agent')
  const originalId = channel.agentId
  const target = channel.rows.find(row => row.kind === 'user' && row.text === 'tool prompt')
  assert.ok(target)
  assert.equal(await channel.rewindTo(target), 'tool prompt')
  assert.notEqual(channel.agentId, originalId)
  assert.ok(channel.rows.some(row => row.text === 'first reply'))
  assert.ok(!channel.rows.some(row => row.text === 'after tool'))
  assert.equal(await channel.newSession(), true)
  assert.equal(channel.rows.some(row => row.kind === 'user'), false)
  const resumed = await channel.resumeTo(originalId)
  assert.equal(resumed.ok, true, JSON.stringify(resumed))
  assert.ok(channel.rows.some(row => row.text === 'after tool'), 'resume replays persisted V4 messages')
  assert.equal(requests, 4, 'rewind/new/resume do not replay claimed prompts into the model')
  // Keep the real registry entry and JSONL writer alive while disposal drains.
  // Agent View must wait, then resume from disk rather than adopt that dying Agent.
  const retiring = await ctx.agents.create({ sessionId: 'retiring-view', cwd: root })
  retiring.agent.session.append('session/title', { title: 'Retiring session', messageSeqs: [], source: { kind: 'user' } })
  const close = Promise.withResolvers()
  const enteredClose = Promise.withResolvers()
  let closed = false
  const delayedHandle = { agent: retiring.agent, async dispose() {
    enteredClose.resolve()
    await close.promise
    await retiring.dispose()
    closed = true
  } }
  const switching = createChannel(ctx, retiring.agent, {
    handle: delayedHandle, cwd: root, provider: 'scripted', model: 'scripted', activity: false,
  })
  try {
    assert.equal(await switching.newSession(), true)
    await enteredClose.promise
    let attached = false
    const attachment = switching.attachToAgent('retiring-view').then(result => { attached = true; return result })
    await setImmediate() // Drain runnable continuations while close is explicitly gated.
    assert.equal(closed, false)
    assert.equal(attached, false, 'Agent View must not report success before the target has closed')
    close.resolve()
    const attachedResult = await attachment
    assert.equal(attachedResult.ok, true, JSON.stringify(attachedResult))
    assert.equal(closed, true)
    const restored = ctx.agents.get('retiring-view')
    assert.ok(restored, 'attach registers the restored Agent')
    assert.notEqual(restored, retiring.agent, 'attach resumes a fresh Agent after close')
    assert.equal(switching.agentId, String(restored.session.id), 'the restored Agent is attached to the channel')
  } finally {
    close.resolve()
    switching.releaseContributions()
  }
  console.log('agent lifecycle OK (real async factory, streaming, tool, cancel, rewind, new, JSONL resume)')
} finally {
  firstStream.resolve()
  hangingStream.resolve()
  channel?.releaseContributions()
  await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
}
