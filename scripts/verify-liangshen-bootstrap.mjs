import assert from 'node:assert/strict'
import { apply } from '../presets/liangshen/tool-bootstrap.mjs'

const listeners = {}
const ctx = {
  on(event, callback) {
    listeners[event] = callback
  },
  logger: { warn() {} },
}

apply(ctx, {
  bootstrapTools: ['bash', 'str_replace_editor'],
  promoteOn: 'tool-call',
  includeSubagents: true,
  suppressedContextSources: ['agent-instructions', 'skill-catalog'],
})

const tools = [
  { name: 'bash' },
  { name: 'str_replace_editor' },
  { name: 'read' },
  { name: 'write' },
  { name: 'glob' },
  { name: 'ask_user_question' },
  { name: 'web_search' },
]

const assemble = (id, events, delegationDepth = 0) => listeners['system-prompt/assemble'](
  undefined,
  { agent: { session: { id, events, header: { delegationDepth } } } },
  async () => ({ sections: [], contexts: [], tools, variables: {} }),
)

assert.deepEqual(
  (await assemble('fresh', [])).tools.map(tool => tool.name),
  ['bash', 'str_replace_editor'],
)

assert.deepEqual(
  (await assemble('reply-only', [{ type: 'assistant/message', seq: 1, data: {} }])).tools.map(tool => tool.name),
  ['bash', 'str_replace_editor'],
)

assert.equal(
  (await assemble('promoted', [{ type: 'tool/call', seq: 1, data: { name: 'bash' } }])).tools,
  tools,
)

assert.deepEqual(
  (await assemble('subagent-fresh', [], 1)).tools.map(tool => tool.name),
  ['bash', 'str_replace_editor'],
)
assert.equal(
  (await assemble('subagent-promoted', [{ type: 'tool/call', seq: 1, data: { name: 'bash' } }], 1)).tools,
  tools,
)

const compactedEvents = [
  { type: 'tool/call', seq: 1, data: { name: 'bash' } },
  { type: 'compaction/end', seq: 2, data: {} },
]
assert.deepEqual(
  (await assemble('compacted', compactedEvents)).tools.map(tool => tool.name),
  ['bash', 'str_replace_editor'],
)

listeners['session/event'](
  { id: 'compacted', events: compactedEvents, header: {} },
  { type: 'tool/call', seq: 3, data: { name: 'str_replace_editor' } },
)
assert.equal((await assemble('compacted', compactedEvents)).tools, tools)

console.log('liangshen bootstrap verified (root/subagent anchors, tool-call promotion, full catalog, compaction re-anchor)')
