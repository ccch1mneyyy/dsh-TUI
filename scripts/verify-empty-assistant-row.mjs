/**
 * Channel-level regression for the bare-`●` transcript row: an assistant
 * step that emits only reasoning (then straight to tool calls) used to leave
 * an empty assistant row behind, which rendered as a `●` bullet with no
 * content right after the thinking block folded.
 *
 * - reasoning-only assistant/message creates NO assistant row (the empty
 *   `●` culprit); the reasoning row itself is kept
 * - a non-streaming assistant/message with text still lands its assistant row
 * - text deltas followed by assistant/message still settle the streamed row
 *
 * Run with plain node against the compiled lib: `node scripts/verify-empty-assistant-row.mjs`
 */
import { createChannel } from '../lib/types/dsh-adapter/channel.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const handlers = new Map()
const ctx = {
  on(event, handler) {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
  get() {
    return undefined
  },
  logger: { warn() {} },
}
const agent = {
  id: 'a1',
  status: 'idle',
  session: { id: 's1', seq: 0, events: [] },
  ctx: { on: () => () => {} },
  followup() {},
  steer() {},
}
const channel = createChannel(ctx, agent, {
  model: 'deepseek-chat',
  cwd: '/tmp',
  provider: 'deepseek',
  activity: false,
})
const emit = event => {
  const handler = handlers.get('session/event')
  if (handler) handler(agent.session, event)
}

emit({
  type: 'user/message',
  seq: 1,
  data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] },
})

// Step 1: reasoning-only assistant step (thinking, then straight to tools).
emit({
  type: 'assistant/chunk',
  seq: 2,
  data: { turn: 1, step: 0, chunk: { type: 'reasoning-delta', text: '先想想' } },
})
emit({
  type: 'assistant/message',
  seq: 3,
  data: { message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } },
})

check(
  'reasoning-only step leaves no assistant row',
  channel.rows.every(row => row.kind !== 'assistant'),
  JSON.stringify(channel.rows.map(row => row.kind)),
)
check(
  'reasoning row kept',
  channel.rows.some(row => row.kind === 'reasoning' && row.text === '先想想'),
)

// Step 2: non-streaming text message (provider without chunk deltas).
emit({
  type: 'assistant/message',
  seq: 4,
  data: { message: { content: [{ type: 'text', text: '答复全文' }] } },
})
const settled = channel.rows.filter(row => row.kind === 'assistant').at(-1)
check(
  'non-streaming text still lands its assistant row',
  settled?.text === '答复全文' && settled.streaming === false,
  JSON.stringify(settled),
)

// Step 3: streamed text deltas settled by the final assistant/message.
emit({
  type: 'assistant/chunk',
  seq: 5,
  data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '流式' } },
})
emit({
  type: 'assistant/chunk',
  seq: 6,
  data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '文本' } },
})
emit({
  type: 'assistant/message',
  seq: 7,
  data: { message: { content: [{ type: 'text', text: '流式文本' }] } },
})
const streamed = channel.rows.filter(row => row.kind === 'assistant').at(-1)
check(
  'streamed row settles with full text',
  streamed?.text === '流式文本' && streamed.streaming === false,
  JSON.stringify(streamed),
)

check(
  'no empty-text assistant rows anywhere',
  channel.rows.every(row => row.kind !== 'assistant' || row.text !== ''),
)

process.exit(failed > 0 ? 1 : 0)
