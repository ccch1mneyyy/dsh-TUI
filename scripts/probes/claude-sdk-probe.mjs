// Maintainer probe — NOT a regression test, NOT part of CI.
//
// Drives the real Claude Code CLI through @anthropic-ai/claude-agent-sdk and
// records every observed message shape, so the Claude backend contract in
// docs/agent-backend-design.md is written from behaviour, not guesses.
//
// Prerequisites (see docs/agent-backend-design.md 附录 A):
//   - a directory with `@anthropic-ai/claude-agent-sdk@0.3.287` installed
//     (`npm i --ignore-scripts @anthropic-ai/claude-agent-sdk@0.3.287`); copy
//     this file next to its node_modules and run it from there;
//   - a local `claude` CLI; adjust `pathToClaudeCodeExecutable` below or drop
//     the option to use the SDK's bundled binary;
//   - valid Claude credentials. The run costs a few haiku turns of real usage.
// Usage: node <this file> <output-dir>   → <output-dir>/trace*.jsonl
//
// Minimal runtime probe: drive one streaming-input Claude Agent SDK session
// against the locally installed Claude Code CLI and record every message
// shape (truncated) so the backend contract is written from observed
// behavior, not guesses. Output: trace.jsonl + summary on stdout.
import { query, listSessions, getSessionInfo, getSessionMessages, listSubagents, getSubagentMessages } from '@anthropic-ai/claude-agent-sdk'
import fs from 'node:fs'
import path from 'node:path'

const root = process.argv[2]
const cwd = path.join(root, 'project')
fs.mkdirSync(cwd, { recursive: true })
fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# probe project\nWhen the user asks for the codeword, answer with exactly one word: PINEAPPLE\n')
const trace = fs.createWriteStream(path.join(root, 'trace.jsonl'))
const t0 = Date.now()
const log = (kind, obj) => trace.write(JSON.stringify({ ms: Date.now() - t0, kind, ...obj }) + '\n')

const shrink = (o, d = 0) => {
  if (typeof o === 'string') return o.length > 240 ? o.slice(0, 240) + `…(+${o.length - 240})` : o
  if (Array.isArray(o)) return o.slice(0, 8).map(x => shrink(x, d + 1)).concat(o.length > 8 ? [`…(+${o.length - 8})`] : [])
  if (o && typeof o === 'object') {
    if (d > 6) return '…'
    const r = {}
    for (const [k, v] of Object.entries(o)) {
      if (k === 'signal') continue
      if (k === 'email') { r[k] = '<redacted>'; continue }
      r[k] = shrink(v, d + 1)
    }
    return r
  }
  return o
}

class Inbox {
  constructor() { this.q = []; this.w = []; this.closed = false }
  push(v) { const w = this.w.shift(); if (w) w({ value: v, done: false }); else this.q.push(v) }
  close() { this.closed = true; for (const w of this.w) w({ value: undefined, done: true }); this.w = [] }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.q.length) return Promise.resolve({ value: this.q.shift(), done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise(r => this.w.push(r))
      },
      return: () => { this.close(); return Promise.resolve({ value: undefined, done: true }) },
    }
  }
}

const env = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'dsh-tui-probe/0.0.0' }
delete env.CLAUDECODE
delete env.CLAUDE_CODE_ENTRYPOINT

const inbox = new Inbox()
let turn = 0
const userUuids = []
const send = (text) => {
  turn += 1
  const uuid = crypto.randomUUID()
  userUuids.push(uuid)
  log('send', { turn, text, uuid })
  inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '', uuid })
}

const permissionCalls = []
const q = query({
  prompt: inbox,
  options: {
    cwd,
    model: 'haiku',
    includePartialMessages: true,
    permissionMode: 'default',
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    pathToClaudeCodeExecutable: '/home/coder/.local/bin/claude',
    env,
    enableFileCheckpointing: true,
    perTaskStopAffordance: true,
    stderr: d => log('stderr', { data: d.slice(0, 400) }),
    canUseTool: async (toolName, input, opts) => {
      permissionCalls.push(toolName)
      log('can_use_tool', { toolName, input: shrink(input), opts: shrink(opts) })
      return { behavior: 'allow' }
    },
    hooks: {
      PreToolUse: [{ hooks: [async (inp, id) => { log('hook', { event: inp.hook_event_name, tool: inp.tool_name, tool_use_id: id, keys: Object.keys(inp) }); return { continue: true } }] }],
      Stop: [{ hooks: [async (inp) => { log('hook', { event: 'Stop', keys: Object.keys(inp), bg: inp.background_tasks }); return { continue: true } }] }],
      SubagentStop: [{ hooks: [async (inp) => { log('hook', { event: 'SubagentStop', agent_id: inp.agent_id, agent_type: inp.agent_type, path: inp.agent_transcript_path }); return { continue: true } }] }],
      SessionStart: [{ hooks: [async (inp) => { log('hook', { event: 'SessionStart', source: inp.source, keys: Object.keys(inp) }); return { continue: true } }] }],
    },
  },
})

const phases = [
  { name: 'claudemd', text: 'What is the codeword? Answer with just the word.' },
  { name: 'write-read', text: "Use the Write tool to create a file named hello.txt (in the current directory) with content 'hi'. Then use the Read tool to read it back. Then reply exactly: done" },
  { name: 'subagent', text: 'Use the Agent tool with subagent_type "Explore" and prompt "List the files in the current directory and report their names." Then reply with the file names in one line.' },
  { name: 'background', text: "Run the shell command `sleep 12 && echo finished` using the Bash tool with run_in_background set to true, then immediately reply exactly: started" },
  { name: 'interrupt', text: 'Count from 1 to 400, one number per line, no other text.' },
  { name: 'acceptEdits', text: "Use the Write tool to create a file named second.txt with content 'two', then reply exactly: ok" },
]
let phase = -1
let sessionId
let interruptSent = false
let streamDeltas = 0
const counts = {}
const next = async () => {
  phase += 1
  if (phase === 5) {
    log('control', { call: 'setPermissionMode', mode: 'acceptEdits' })
    await q.setPermissionMode('acceptEdits')
  }
  if (phase >= phases.length) {
    // let background task notification arrive before closing
    log('phase', { name: 'await-task-notification', waitMs: 15000 })
    await new Promise(r => setTimeout(r, 15000))
    inbox.close()
    return
  }
  log('phase', { name: phases[phase].name })
  streamDeltas = 0
  interruptSent = false
  send(phases[phase].text)
}

const watchdog = setTimeout(() => { log('watchdog', {}); try { q.close() } catch {} ; process.exit(2) }, 420_000)
watchdog.unref()

void next()
try {
  for await (const m of q) {
    const key = m.type + (m.subtype ? '/' + m.subtype : '') + (m.type === 'stream_event' ? ':' + m.event?.type + (m.event?.delta?.type ? ':' + m.event.delta.type : '') + (m.event?.content_block?.type ? ':' + m.event.content_block.type : '') : '')
    counts[key] = (counts[key] || 0) + 1
    sessionId ??= m.session_id
    const firstOfKind = counts[key] === 1
    if (firstOfKind || m.type === 'result' || (m.type === 'system' && m.subtype !== 'init') || m.type === 'assistant' || m.type === 'user' || m.type === 'tool_progress' || m.type === 'rate_limit_event') {
      log('msg', { key, first: firstOfKind, msg: shrink(m) })
    }
    if (m.type === 'stream_event' && m.event?.type === 'content_block_delta') {
      streamDeltas += 1
      if (phases[phase]?.name === 'interrupt' && streamDeltas === 4 && !interruptSent) {
        interruptSent = true
        log('control', { call: 'interrupt' })
        q.interrupt().then(r => log('control-result', { call: 'interrupt', result: shrink(r) })).catch(e => log('control-error', { call: 'interrupt', error: String(e) }))
      }
    }
    if (m.type === 'result') {
      log('result', { phase: phases[phase]?.name, subtype: m.subtype, is_error: m.is_error, stop_reason: m.stop_reason, num_turns: m.num_turns, cost: m.total_cost_usd, usage: shrink(m.usage), modelUsage: shrink(m.modelUsage), permission_denials: m.permission_denials, errors: m.errors, result: shrink(m.result) })
      if (phases[phase]?.name === 'claudemd') {
        try {
          const init = await q.initializationResult(); log('control-result', { call: 'initializationResult', keys: Object.keys(init), result: shrink({ ...init, commands: (init.commands || []).slice(0, 5), models: (init.models || []).slice(0, 3) }) })
          const cmds = await q.supportedCommands(); log('control-result', { call: 'supportedCommands', count: cmds.length, builtin: cmds.filter(c => c.builtin).length, names: cmds.map(c => c.name + (c.builtin ? '*' : '')).join(' ') })
          const models = await q.supportedModels(); log('control-result', { call: 'supportedModels', result: shrink(models) })
          const agents = await q.supportedAgents(); log('control-result', { call: 'supportedAgents', result: shrink(agents) })
          const mcp = await q.mcpServerStatus(); log('control-result', { call: 'mcpServerStatus', result: shrink(mcp) })
          const ctxu = await q.getContextUsage({ detail: 'summary' }); log('control-result', { call: 'getContextUsage', result: shrink(ctxu) })
          const acct = await q.accountInfo(); log('control-result', { call: 'accountInfo', result: shrink(acct) })
        } catch (e) { log('control-error', { error: String(e) }) }
      }
      if (phases[phase]?.name === 'acceptEdits') {
        try {
          const rw = await q.rewindFiles(userUuids[1], { dryRun: true }); log('control-result', { call: 'rewindFiles(dryRun)', target: userUuids[1], result: shrink(rw) })
        } catch (e) { log('control-error', { call: 'rewindFiles', error: String(e) }) }
      }
      await next()
    }
  }
} catch (e) {
  log('loop-error', { error: String(e), stack: String(e?.stack).slice(0, 600) })
}
log('loop-end', { counts, permissionCalls })

// --- session store APIs ---
const time = async (label, fn) => { const s = Date.now(); try { const r = await fn(); log('store', { label, ms: Date.now() - s, result: shrink(r) }); return r } catch (e) { log('store-error', { label, ms: Date.now() - s, error: String(e) }); return undefined } }
const ls = await time('listSessions(dir)', () => listSessions({ dir: cwd }))
const all = await time('listSessions(all)', async () => { const r = await listSessions(); return { count: r.length, sample: r.slice(0, 2) } })
await time('listSessions(all) warm', async () => { const r = await listSessions(); return { count: r.length } })
if (sessionId) {
  await time('getSessionInfo', () => getSessionInfo(sessionId, { dir: cwd }))
  const msgs = await time('getSessionMessages', async () => { const r = await getSessionMessages(sessionId, { dir: cwd }); const kinds = {}; for (const m of r) { const c = m.message?.content; const k = m.type + '[' + (Array.isArray(c) ? c.map(b => b.type).join('+') : typeof c) + ']' + (m.parent_tool_use_id ? '@sub' : ''); kinds[k] = (kinds[k] || 0) + 1 } return { count: r.length, kinds, first: r[0], sampleAssistant: r.find(m => m.type === 'assistant'), sampleSystem: r.find(m => m.type === 'system') } })
  const subs = await time('listSubagents', () => listSubagents(sessionId, { dir: cwd }))
  if (subs && subs[0]) await time('getSubagentMessages', async () => { const r = await getSubagentMessages(sessionId, subs[0], { dir: cwd }); return { count: r.length, first: r[0], parent_agent_ids: [...new Set(r.map(m => m.parent_agent_id))] } })
}
trace.end()
console.log(JSON.stringify({ sessionId, counts, permissionCalls }, null, 2))
