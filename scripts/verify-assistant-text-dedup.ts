/**
 * Regression: repeated/overlapping stream events must produce one assistant
 * row with one copy of the text. Covers reconnect/proxy event delivery where
 * a delta or sealed assistant message may arrive more than once.
 *
 * Run with: node --import tsx/esm scripts/verify-assistant-text-dedup.ts
 */
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createChannel } from '../src/dsh-adapter/channel.js'

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const root = new Context()
let scope: ReturnType<typeof createScope>
const session = { id: 'assistant-dedup-session', seq: 0, events: [], header: {} }
const agent = {
  id: 'assistant-dedup-agent',
  status: 'idle',
  options: {},
  get ctx() { return scope.ctx },
  session,
  followup() {},
  steer() {},
  inbox: { remove() {} },
} as never
scope = createScope(root, agent)

const channel = createChannel(root as never, agent, {
  provider: 'test',
  model: 'test-model',
  cwd: '/tmp',
  activity: false,
})

const emit = (event: object): void => {
  root.emit('session/event', session as never, event as never)
}

emit({
  type: 'assistant/chunk',
  seq: 1,
  time: 1,
  data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '前两个成功了，glob' } },
})
emit({
  type: 'assistant/chunk',
  seq: 2,
  time: 2,
  data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'glob 那个超时了' } },
})
// Exact redelivery of the same durable event.
emit({
  type: 'assistant/chunk',
  seq: 2,
  time: 2,
  data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'glob 那个超时了' } },
})

const expected = '前两个成功了，glob 那个超时了'
let assistantRows = channel.rows.filter(row => row.kind === 'assistant')
check('overlapping/repeated deltas keep one assistant row', assistantRows.length === 1, `rows=${assistantRows.length}`)
check('overlapping delta prefix appears once', assistantRows[0]?.text === expected, assistantRows[0]?.text ?? '<missing>')

const sealed = {
  type: 'assistant/message',
  seq: 3,
  time: 3,
  data: {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: expected }] },
  },
}
emit(sealed)
emit(sealed)

assistantRows = channel.rows.filter(row => row.kind === 'assistant')
check('duplicate sealed message reuses the streaming row', assistantRows.length === 1, `rows=${assistantRows.length}`)
check('sealed text remains canonical', assistantRows[0]?.text === expected, assistantRows[0]?.text ?? '<missing>')
check('sealed row is no longer streaming', assistantRows[0]?.streaming !== true)

process.exit(failed === 0 ? 0 : 1)
