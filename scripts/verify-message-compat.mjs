/**
 * V3/V4 message projection through a real Channel: live/replay, call-ID pairing,
 * presenters, errors, folding, goal/todo cards, export, subagents and compact checkpoints.
 * Run after compile: node scripts/verify-message-compat.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-messages-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_HOME = home
const { createChannel } = await import('../lib/types/dsh-adapter/channel.js')
const { SubagentActivityStore } = await import('../lib/types/dsh-adapter/subagents.js')
const { extractEntries } = await import('../lib/types/dsh-adapter/sessionTree.js')
const { harnessToolResultView, toolErrorText } = await import('../lib/types/dsh-adapter/channel/transcript.js')

function result(api, callId, text, isError = false) {
  const content = [{ type: 'text', text }]
  return {
    id: `result-${callId}`, role: 'tool', source: { kind: 'tool', callId },
    ...(api === 'v4'
      ? { toolCallId: callId, content, isError }
      : { content: [{ type: 'tool-result', toolCallId: callId, content, isError }] }),
  }
}

try {
  for (const api of ['v3', 'v4']) {
    for (const mode of ['live', 'replay']) {
      const raw = [
        { type: 'tool/call', data: { callId: 'one', name: 'read_file', arguments: '{"path":"a"}' } },
        { type: 'tool/call', data: { callId: 'two', name: 'read_file', arguments: '{"path":"b"}' } },
        // Out-of-order results must still answer the matching card.
        { type: 'tool/result', data: { message: result(api, 'two', 'second result'), meta: { path: 'b' } } },
        { type: 'tool/result', data: { message: result(api, 'one', 'permission denied', true) } },
        { type: 'tool/call', data: { callId: 'three', name: 'read_file', arguments: '{}' } },
        { type: 'tool/result', data: { message: result(api, 'three', 'detail', true), error: { name: 'ToolError', code: 'DENIED' } } },
        { type: 'user/message', data: {
          id: 'compact', role: 'user', content: [{ type: 'text', text: 'Durable summary' }],
          source: api === 'v4' ? { kind: 'compact-checkpoint', compactionId: 'compact-1' } : { kind: 'plugin', plugin: 'compact' },
        } },
      ]
      const events = raw.map((event, seq) => ({ ...event, seq, time: 1000 + seq }))
      const handlers = new Map()
      const presented = []
      const ctx = {
        on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
        get(name) {
          return name === 'tools' ? { get: () => ({ presentResult(args, payload) {
            presented.push({ args, payload })
            return { card: 'generic', content: payload.content }
          } }) } : undefined
        },
        logger: { warn() {} },
      }
      const log = mode === 'replay' ? [...events] : []
      const agent = {
        id: 'message-agent', status: 'idle', ctx: { on: () => () => {} },
        session: { id: 'message-session', get seq() { return log.length }, snapshotEvents: () => log },
      }
      const channel = createChannel(ctx, agent, { cwd: home, model: 'test', provider: 'test', activity: false })
      try {
        if (mode === 'live') for (const event of events) {
          log.push(event)
          handlers.get('session/event')(agent.session, event)
        }
        const cards = channel.rows.filter(row => row.kind === 'tool').map(row => row.tool)
        assert.deepEqual(cards.map(card => card.status), ['error', 'ok', 'error'], `${api}/${mode}: statuses`)
        assert.equal(cards[0].errorText, 'permission denied')
        assert.equal(cards[1].resultFull, 'second result')
        assert.equal(cards[2].errorText, 'ToolError: DENIED — detail')
        assert.equal(channel.activeToolCount, 0)
        assert.deepEqual(presented, [{ args: { path: 'b' }, payload: {
          content: [{ type: 'text', text: 'second result' }], isError: false, meta: { path: 'b' },
        } }])
        assert.equal(channel.rows.find(row => row.kind === 'compact')?.text, 'Durable summary')
        assert.equal(extractEntries('s', events).find(entry => entry.kind === 'compact')?.text, 'Durable summary')
        assert.deepEqual(extractEntries('s', events).filter(entry => entry.kind === 'tool').map(entry => entry.toolStatus),
          ['error', 'ok', 'error'], `${api}/${mode}: tree failure status follows the message payload`)
        const exported = channel.exportSession()
        assert.ok(exported)
        const markdown = readFileSync(exported, 'utf8')
        for (const text of ['second result', 'permission denied', 'detail']) assert.ok(markdown.includes(text))

        // Cross the real channel's retained-row limit, then restore through
        // loadOlder. Failure semantics and success-only presenters must agree
        // with the initial projection for both message formats and entry paths.
        const expectedPresentations = [...presented]
        for (let index = 0; index < 605; index++) {
          const event = { seq: log.length, time: 2000 + index, type: 'user/message', data: {
            id: `padding-${index}`, role: 'user', source: { kind: 'user' },
            content: [{ type: 'text', text: `prompt ${index}` }],
          } }
          log.push(event)
          handlers.get('session/event')(agent.session, event)
        }
        assert.ok(channel.rows.filter(row => row.kind === 'tool').every(row => row.folded))
        assert.ok(channel.loadOlder() > 0)
        const restored = channel.rows.filter(row => row.kind === 'tool')
        assert.ok(restored.every(row => !row.folded))
        assert.deepEqual(restored.map(row => row.tool.status), ['error', 'ok', 'error'], `${api}/${mode}: restored statuses`)
        assert.equal(restored[0].tool.errorText, 'permission denied')
        assert.equal(restored[0].tool.resultFull, undefined)
        assert.equal(restored[0].tool.resultView, undefined)
        assert.equal(restored[1].tool.resultFull, 'second result')
        assert.equal(restored[2].tool.errorText, 'ToolError: DENIED — detail')
        assert.equal(restored[2].tool.resultView, undefined)
        assert.deepEqual(presented, [...expectedPresentations, ...expectedPresentations], 'only successful results reach the presenter on restore')
      } finally { channel.releaseContributions() }

      const subagents = new SubagentActivityStore()
      subagents.onSpawned('child')
      for (const event of events) subagents.onSessionEvent('child', event)
      const calls = subagents.get('child').toolCalls
      assert.equal(calls[0].status, 'failed')
      assert.equal(calls[0].error, 'permission denied')
      assert.equal(calls[1].resultPreview, 'second result')
    }
    const goal = harnessToolResultView('goal', { message: result(api, 'g', '{"goal":{"objective":"Ship","phase":"active"}}') })
    assert.match(goal.content[0].text, /Ship/)
    const todos = harnessToolResultView('todo', { message: result(api, 't', '{"todos":[{"content":"Verify","status":"in_progress"}]}') })
    assert.match(todos.content[1].text, /Verify/)
    assert.equal(toolErrorText({ data: { message: result(api, 'e', 'explanation', true) } }), 'explanation')
  }
  console.log('PASS: V3/V4 messages in live/replay/folded projections, export, subagents and compact checkpoints')
} finally { rmSync(home, { recursive: true, force: true }) }
