/**
 * Channel-level verification of the post-compaction behaviour (real Channel
 * via createChannel + fake ctx/agent, plain node against the compiled lib):
 *
 * - the compaction checkpoint renders a `Conversation compacted` Divider plus
 *   a `compact` summary row (defaults FOLDED in the transcript)
 * - the context accounting (tokens.input, contextSegments, lastUsage) resets
 *   immediately, so the status bar drops without waiting for the next
 *   request's usage event
 * - MessageList renders the folded summary as one line and the full text
 *   once expanded (Ctrl+O / message-selection Enter)
 *
 * Run with plain node against the compiled lib: `node scripts/verify-compact.mjs`
 */
import { createChannel } from '../lib/types/channel.js'
import React from 'react'
import { render } from '../lib/types/ui.js'
import { MessageList } from '../lib/types/components/MessageList.js'
import { Writable, PassThrough } from 'node:stream'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const toPlain = s =>
  s
    .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
    .replace(/\x1b\[[0-9;?>:]*[a-zA-Z]/g, '')
    .replace(/\x1b\]9;[^\x07]*\x07/g, '')

const sleep = ms => new Promise(r => setTimeout(r, ms))

const est = text => Math.ceil(text.length / 4)

// ---- channel-level: seed a pre-compact context, then compact it
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
  // bindAgent 挂 installModelSelection 需要 agent.ctx 提供"可订阅、返回
  // 解除函数"的最小面（0.3.6 Shift+Tab 推理等级）。
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
const emit = (event) => {
  const handler = handlers.get('session/event')
  if (handler) handler(agent.session, event)
}

const SYSTEM = 'SYSTEM-PROMPT-ABCDEFGH'
const USER_TEXT = 'user question here'
const ASSISTANT_TEXT = 'assistant answer text'
const SUMMARY = 'Summary of the entire conversation history up to this point.'
const LONG_SUMMARY = '这是一个很长的压缩摘要，用来验证折叠后预览会被截断，不会把全文都显示在一行里。'.repeat(3)

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

// The compaction checkpoint (dsh-compact's COMPACT_CHECKPOINT_SOURCE).
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
check('checkpoint renders notice row', noticeRow?.kind === 'notice' && noticeRow?.text === 'Conversation compacted', JSON.stringify(noticeRow))
check('checkpoint renders compact row with full summary', compactRow?.kind === 'compact' && compactRow?.text === SUMMARY, JSON.stringify(compactRow))

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

// A second compaction with an EMPTY summary: no summary row, prompt cleared.
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

// ---- render-level: folded by default, full text when expanded
function makeStreams() {
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdout.frames.push(String(chunk))
      cb()
    },
  })
  stdout.columns = 100
  stdout.rows = 30
  stdout.isTTY = true
  stdout.frames = []
  const stderr = new Writable({ write(_c, _e, cb) { cb() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  return { stdout, stderr, stdin }
}

const listProps = (expanded) => ({
  rows: [
    { id: 1, kind: 'notice', text: 'Conversation compacted' },
    { id: 2, kind: 'compact', text: LONG_SUMMARY },
  ],
  expanded,
  expandedRows: new Set(),
  selectedId: null,
  onToggleRow() {},
  model: 'deepseek-chat',
  showAll: true,
  onToggleAll() {},
  onLoadOlder() {},
})

{
  const { stdout, stderr, stdin } = makeStreams()
  const instance = await render(
    React.createElement(MessageList, listProps(false)),
    { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(200)
  const frame = toPlain(stdout.frames.at(-1) ?? '')
  check('folded summary shows the fold line', frame.includes('摘要已折叠'), '')
  check('folded summary hides the full text', !frame.includes(LONG_SUMMARY), '')
  instance.unmount()
}

{
  const { stdout, stderr, stdin } = makeStreams()
  const instance = await render(
    React.createElement(MessageList, listProps(true)),
    { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(200)
  // Terminal wrap inserts newlines mid-string, so flatten before matching.
  const frame = toPlain(stdout.frames.at(-1) ?? '').replace(/\n/g, '')
  check('expanded summary shows the full text', frame.includes('压缩摘要'), '')
  check('expanded summary hides the fold line', !frame.includes('摘要已折叠'), '')
  instance.unmount()
}

process.exit(failed)
