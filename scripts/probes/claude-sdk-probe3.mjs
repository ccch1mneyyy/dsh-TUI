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
//   - a local `claude` CLI; set CLAUDE_CODE_EXECUTABLE to its path, or leave
//     it unset to use the SDK's bundled binary;
//   - valid Claude credentials. The run costs a few haiku turns of real usage.
// Usage: node <this file> <output-dir>   → <output-dir>/trace3.jsonl
//
// Probe 3 (design §8.8 P2-1 / P3-1 / P3-3, plus the P3-2 method listing):
//   - every `command_lifecycle` frame with its timing relative to the per-turn
//     `system/init`, `system/status`, first `stream_event` and `result`;
//   - whether `system/session_state_changed` appears once
//     CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1 is set, and where it lands
//     relative to `result`;
//   - the delivery semantics of `priority:'next'` and `priority:'now'` sent
//     mid-turn, both while text streams and while a foreground Bash tool runs.
// A summary keyed by command uuid is printed at the end; the trace keeps
// every non-delta message (truncated) for anything the summary misses.
import { query } from '@anthropic-ai/claude-agent-sdk'
import fs from 'node:fs'
import path from 'node:path'

// Maintainer cost rule (2026-10-02): every real-CLI run uses haiku only —
// never sonnet or opus. The query pins `model: 'haiku'` and this guard
// refuses to run when the environment would point the alias elsewhere.
for (const name of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) {
  const value = process.env[name]
  if (value !== undefined && value !== '' && !/haiku/iu.test(value)) {
    console.error(`refusing to run: ${name}=${value} — real-CLI runs use haiku only`)
    process.exit(2)
  }
}

const root = process.argv[2]
if (!root) {
  console.error('usage: node probe3.mjs <output-dir>')
  process.exit(2)
}
const cwd = path.join(root, 'project3')
fs.mkdirSync(cwd, { recursive: true })
const trace = fs.createWriteStream(path.join(root, 'trace3.jsonl'))
const t0 = Date.now()
const now = () => Date.now() - t0
const log = (kind, obj) => trace.write(JSON.stringify({ ms: now(), kind, ...obj }) + '\n')

const shrink = (o, d = 0) => {
  if (typeof o === 'string') return o.length > 240 ? o.slice(0, 240) + `…(+${o.length - 240})` : o
  if (Array.isArray(o)) return o.slice(0, 8).map(x => shrink(x, d + 1)).concat(o.length > 8 ? [`…(+${o.length - 8})`] : [])
  if (o && typeof o === 'object') {
    if (d > 6) return '…'
    const r = {}
    for (const [k, v] of Object.entries(o)) {
      if (k === 'signal') continue
      if (k === 'email' || k === 'organization') { r[k] = '<redacted>'; continue }
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

// The TUI may itself run inside a Claude Code terminal; the child must not
// inherit that session's identity or messaging socket (design §4.3 env row).
const env = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'dsh-tui-probe/0.0.0', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' }
for (const key of Object.keys(env)) {
  if (key === 'CLAUDECODE' || key === 'CLAUDE_CODE_ENTRYPOINT' || key === 'CLAUDE_CODE_SESSION_ID' || key.startsWith('CLAUDE_CODE_MESSAGING_')) delete env[key]
}

const inbox = new Inbox()
// Per command uuid: label, priority, send time and every lifecycle state seen.
const commands = new Map()
const send = (label, text, priority) => {
  const uuid = crypto.randomUUID()
  commands.set(uuid, { label, priority: priority ?? null, sentMs: now(), states: [] })
  log('send', { label, text, uuid, priority: priority ?? null })
  inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '', uuid, ...(priority ? { priority } : {}) })
  return uuid
}

const q = query({
  prompt: inbox,
  options: {
    cwd,
    model: 'haiku',
    includePartialMessages: true,
    permissionMode: 'default',
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    ...(process.env.CLAUDE_CODE_EXECUTABLE ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE } : {}),
    env,
    stderr: d => log('stderr', { data: d.slice(0, 400) }),
    canUseTool: async (toolName, input, opts) => {
      log('can_use_tool', { toolName, input: shrink(input), toolUseID: opts.toolUseID })
      return { behavior: 'allow', updatedInput: input }
    },
  },
})

// P3-2: does the runtime Query object carry undeclared queue controls?
{
  const names = new Set()
  for (let p = q; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const n of Object.getOwnPropertyNames(p)) if (typeof q[n] === 'function') names.add(n)
  }
  log('query-methods', { names: [...names].sort() })
}

const COUNT = 'Count from 1 to 300, one number per line, no other text.'
const TOOLS = 'Use the Bash tool to run `sleep 8 && echo FIRST`. After it finishes, use the Bash tool again to run `echo SECOND`. Then reply exactly: TOOLS-DONE'
// Each phase sends one prompt; `inject` decides when to push the mid-turn
// message (returns true once it has fired).
const phases = [
  { name: 'baseline', text: 'Reply with exactly: ONE' },
  { name: 'next-stream', text: COUNT, inject: s => s.textDeltas >= 15 && (send('next-stream:inject', 'Stop counting and reply exactly: NEXT-OK', 'next'), true) },
  { name: 'now-stream', text: COUNT, inject: s => s.textDeltas >= 15 && (send('now-stream:inject', 'Stop counting and reply exactly: NOW-OK', 'now'), true) },
  { name: 'next-tool', text: TOOLS, inject: s => s.toolStartedMs !== undefined && now() - s.toolStartedMs > 1500 && (send('next-tool:inject', 'Also add the word NEXT-TOOL-OK at the end of your final reply.', 'next'), true) },
  { name: 'now-tool', text: TOOLS, inject: s => s.toolStartedMs !== undefined && now() - s.toolStartedMs > 1500 && (send('now-tool:inject', 'Stop what you are doing and reply exactly: NOW-TOOL-OK', 'now'), true) },
]

let phase = -1
let state
let lastMsgMs = 0
let phaseTimer
const startPhase = () => {
  phase += 1
  if (phase >= phases.length) {
    log('phase', { name: 'done' })
    clearInterval(phaseTimer)
    inbox.close()
    return
  }
  state = { textDeltas: 0, results: 0, injected: false, toolStartedMs: undefined, startedMs: now() }
  log('phase', { name: phases[phase].name })
  send(phases[phase].name, phases[phase].text)
}
// A phase is over once it produced a result and the stream has been quiet
// for 6s — a `next`/`now` message may open a second turn right after the
// first result, so "first result" alone would cut the observation short.
const scheduleAdvance = () => {
  clearInterval(phaseTimer)
  phaseTimer = setInterval(() => {
    // A foreground tool can run for seconds without any frame arriving.
    if (phases[phase]?.inject && !state.injected) state.injected = phases[phase].inject(state) === true
    if (state.results > 0 && now() - lastMsgMs > 6000) {
      startPhase()
    } else if (now() - state.startedMs > 150_000) {
      log('phase-timeout', { name: phases[phase].name })
      startPhase()
    }
  }, 250)
}

const watchdog = setTimeout(() => { log('watchdog', {}); try { q.close() } catch {} process.exit(2) }, 600_000)
watchdog.unref()

startPhase()
scheduleAdvance()
// Per turn (keyed by the order system/init arrives) first-sighting times.
const counts = {}
let firstStreamPending = true
try {
  for await (const m of q) {
    lastMsgMs = now()
    const key = m.type + (m.subtype ? '/' + m.subtype : '') + (m.type === 'stream_event' ? ':' + m.event?.type + (m.event?.delta?.type ? ':' + m.event.delta.type : '') : '')
    counts[key] = (counts[key] || 0) + 1
    const name = phases[phase]?.name
    if (m.type === 'command_lifecycle') {
      const entry = commands.get(m.command_uuid)
      if (entry) entry.states.push({ state: m.state, ms: lastMsgMs })
    }
    if (m.type === 'system' && m.subtype === 'init') firstStreamPending = true
    const isDelta = m.type === 'stream_event' && m.event?.type === 'content_block_delta'
    if (isDelta && m.event.delta?.type === 'text_delta') state.textDeltas += 1
    if (m.type === 'stream_event' && m.event?.type === 'content_block_start' && m.event.content_block?.type === 'tool_use' && state.toolStartedMs === undefined) state.toolStartedMs = lastMsgMs
    if (m.type === 'stream_event' && firstStreamPending) {
      firstStreamPending = false
      log('first-stream', { phase: name, event: m.event?.type })
    }
    if (!isDelta || counts[key] === 1) log('msg', { phase: name, key, msg: shrink(m) })
    if (phases[phase]?.inject && !state.injected) state.injected = phases[phase].inject(state) === true
    if (m.type === 'result') {
      state.results += 1
      log('result', { phase: name, subtype: m.subtype, is_error: m.is_error, terminal_reason: m.terminal_reason, num_turns: m.num_turns, origin: m.origin, user_message_uuid: m.user_message_uuid, user_message_uuids: m.user_message_uuids, errors: m.errors, result: shrink(m.result) })
    }
  }
} catch (e) {
  log('loop-error', { error: String(e), stack: String(e?.stack).slice(0, 600) })
}
clearInterval(phaseTimer)
const summary = [...commands.entries()].map(([uuid, c]) => ({ uuid, label: c.label, priority: c.priority, sentMs: c.sentMs, states: c.states.map(s => `${s.state}@+${s.ms - c.sentMs}`) }))
log('summary', { counts, commands: summary })
trace.end()
console.log(JSON.stringify({ counts, commands: summary }, null, 2))
