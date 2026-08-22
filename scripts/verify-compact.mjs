/**
 * Channel-level verification of the post-compaction behaviour (real Channel
 * via createChannel + fake ctx/agent, plain node against the compiled lib):
 *
 * - the compaction checkpoint adds the notice and compact summary rows
 * - context accounting resets immediately to system + summary
 * - an empty summary clears the prompt segment without adding a summary row
 *
 * Rendering assertions belong to the focused TUI tests; this gate keeps the
 * business projection and accounting contract independent of the renderer.
 *
 * Run with plain node against the compiled lib: `node scripts/verify-compact.mjs`
 */
import { createChannel } from '../lib/types/dsh-adapter/channel.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const est = text => Math.ceil(text.length / 4)

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

const SYSTEM = 'SYSTEM-PROMPT-ABCDEFGH'
const USER_TEXT = 'user question here'
const ASSISTANT_TEXT = 'assistant answer text'
const SUMMARY = 'Summary of the entire conversation history up to this point.'

emit({ type: 'request/context', seq: 1, data: { contextWindow: 100000 } })
emit({ type: 'request/header', seq: 2, data: { header: { system: SYSTEM } } })
emit({ type: 'user/message', seq: 3, data: { source: { kind: 'user' }, content: [{ type: 'text', text: USER_TEXT }] } })
emit({
  type: 'assistant/message',
  seq: 4,
  data: {
    message: { content: [{ type: 'text', text: ASSISTANT_TEXT }] },
    usage: { inputTokens: 5000, outputTokens: 100, cacheReadTokens: 3000, cacheWriteTokens: 0 },
  },
})

check('pre-compact tokens.input accumulated', channel.tokens.input === 5000, String(channel.tokens.input))
check('pre-compact lastUsage set', channel.lastUsage?.input === 5000, JSON.stringify(channel.lastUsage))
const sysEst = est(SYSTEM)
const promptEst = est(USER_TEXT)
const assistantEst = est(ASSISTANT_TEXT)
check(
  'pre-compact segments populated',
  channel.contextSegments.system === sysEst &&
    channel.contextSegments.prompt === promptEst &&
    channel.contextSegments.assistant === assistantEst,
  JSON.stringify(channel.contextSegments),
)

emit({
  type: 'user/message',
  seq: 5,
  data: {
    source: { kind: 'plugin', plugin: 'compact' },
    content: [{ type: 'text', text: SUMMARY }],
  },
})

const rows = channel.rows
const compactRow = rows[rows.length - 1]
const noticeRow = rows[rows.length - 2]
check('checkpoint adds notice row', noticeRow?.kind === 'notice' && noticeRow?.text === 'Conversation compacted', JSON.stringify(noticeRow))
check('checkpoint adds compact row with full summary', compactRow?.kind === 'compact' && compactRow?.text === SUMMARY, JSON.stringify(compactRow))

const summaryEst = est(SUMMARY)
check(
  'segments reset to system + summary',
  channel.contextSegments.system === sysEst &&
    channel.contextSegments.prompt === summaryEst &&
    channel.contextSegments.assistant === 0 &&
    channel.contextSegments.thinking === 0 &&
    channel.contextSegments.tools === 0,
  JSON.stringify(channel.contextSegments),
)
check(
  'lastUsage refreshed to current context estimate',
  channel.lastUsage?.input === sysEst + summaryEst &&
    channel.lastUsage?.output === 0 &&
    channel.lastUsage?.cacheRead === 0,
  JSON.stringify(channel.lastUsage),
)
check(
  'tokens.input dropped by the removed history',
  channel.tokens.input === 5000 - (promptEst + assistantEst) + summaryEst,
  String(channel.tokens.input),
)

emit({
  type: 'user/message',
  seq: 6,
  data: { source: { kind: 'plugin', plugin: 'compact' }, content: [] },
})
const rows2 = channel.rows
check('empty summary adds no compact row', rows2[rows2.length - 1]?.kind === 'notice', JSON.stringify(rows2[rows2.length - 1]))
check(
  'empty summary clears the prompt segment',
  channel.contextSegments.prompt === 0 && channel.lastUsage?.input === sysEst,
  JSON.stringify(channel.lastUsage),
)

process.exit(failed)
