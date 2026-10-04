// Maintainer probe, not a regression test and not part of CI.
//
// Drives the real Claude Code CLI through @anthropic-ai/claude-agent-sdk and
// records every observed message shape, so the Claude backend contract in
// docs/agent-backend-design.md is written from behaviour, not guesses.
//
// Prerequisites:
//   - a directory with `@anthropic-ai/claude-agent-sdk@0.3.287` installed
//     (`npm i --ignore-scripts @anthropic-ai/claude-agent-sdk@0.3.287`); copy
//     this file next to its node_modules and run it from there;
//   - the SDK's bundled CLI, or a local one named by CLAUDE_CODE_EXECUTABLE;
//   - valid Claude credentials. The run costs a few haiku turns of real usage.
// Usage: node <this file> <output-dir>   → <output-dir>/trace*.jsonl
//
// Probe 2: permission edge cases (AskUserQuestion via canUseTool, deny,
// pending-permission + interrupt → signal?), omitted permissionMode, thinking
// text visibility (haiku only), /compact as prompt, fork + resume replay shape,
// and startup latency. Output: trace2.jsonl.
import { query, getSessionMessages, forkSession, getSessionInfo } from '@anthropic-ai/claude-agent-sdk'
import fs from 'node:fs'
import path from 'node:path'

// Real-CLI runs use haiku only, never sonnet or opus. The query pins
// `model: 'haiku'` and this guard refuses to run when the environment would
// point the alias elsewhere.
for (const name of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) {
  const value = process.env[name]
  if (value !== undefined && value !== '' && !/haiku/iu.test(value)) {
    console.error(`refusing to run: ${name}=${value} — real-CLI runs use haiku only`)
    process.exit(2)
  }
}

const root = process.argv[2]
const cwd = path.join(root, 'project')
fs.mkdirSync(cwd, { recursive: true })
fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# probe project\nWhen the user asks for the codeword, answer with exactly one word: PINEAPPLE\n')
const trace = fs.createWriteStream(path.join(root, 'trace2.jsonl'))
const t0 = Date.now()
const log = (kind, obj) => trace.write(JSON.stringify({ ms: Date.now() - t0, kind, ...obj }) + '\n')
const shrink = (o, d = 0) => {
  if (typeof o === 'string') return o.length > 300 ? o.slice(0, 300) + `…(+${o.length - 300})` : o
  if (Array.isArray(o)) return o.slice(0, 10).map(x => shrink(x, d + 1)).concat(o.length > 10 ? [`…(+${o.length - 10})`] : [])
  if (o && typeof o === 'object') { if (d > 6) return '…'; const r = {}; for (const [k, v] of Object.entries(o)) { if (k === 'signal') continue; if (k === 'email') { r[k] = '<redacted>'; continue } r[k] = shrink(v, d + 1) } return r }
  return o
}
class Inbox {
  constructor() { this.q = []; this.w = []; this.closed = false }
  push(v) { const w = this.w.shift(); if (w) w({ value: v, done: false }); else this.q.push(v) }
  close() { this.closed = true; for (const w of this.w) w({ value: undefined, done: true }); this.w = [] }
  [Symbol.asyncIterator]() { return { next: () => { if (this.q.length) return Promise.resolve({ value: this.q.shift(), done: false }); if (this.closed) return Promise.resolve({ value: undefined, done: true }); return new Promise(r => this.w.push(r)) }, return: () => { this.close(); return Promise.resolve({ value: undefined, done: true }) } } }
}
const env = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'dsh-tui-probe/0.0.0' }
delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT

const runSession = async (label, options, phases, hooks = {}) => {
  const inbox = new Inbox()
  const sendUuids = []
  const send = (text) => { const uuid = crypto.randomUUID(); sendUuids.push(uuid); log('send', { label, text, uuid }); inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '', uuid }) }
  const started = Date.now()
  let firstInitMs
  const q = query({ prompt: inbox, options: { cwd, includePartialMessages: true, ...(process.env.CLAUDE_CODE_EXECUTABLE ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE } : {}), env, stderr: d => log('stderr', { label, data: d.slice(0, 400) }), ...options, model: 'haiku', canUseTool: (toolName, input, opts) => hooks.canUseTool ? hooks.canUseTool(toolName, input, opts, q) : Promise.resolve({ behavior: 'allow' }) } })
  let phase = -1
  let turnMsgs = 0
  const counts = {}
  const next = async () => {
    phase += 1
    if (phases[phase]?.before) await phases[phase].before(q)
    if (phase >= phases.length) { inbox.close(); return }
    log('phase', { label, name: phases[phase].name })
    turnMsgs = 0
    send(phases[phase].text)
  }
  void next()
  try {
    for await (const m of q) {
      const key = m.type + (m.subtype ? '/' + m.subtype : '') + (m.type === 'stream_event' ? ':' + m.event?.type + (m.event?.delta?.type ? ':' + m.event.delta.type : '') + (m.event?.content_block?.type ? ':' + m.event.content_block.type : '') : '')
      counts[key] = (counts[key] || 0) + 1
      turnMsgs += 1
      if (m.type === 'system' && m.subtype === 'init' && firstInitMs === undefined) { firstInitMs = Date.now() - started; log('latency', { label, msToInit: firstInitMs, permissionMode: m.permissionMode, model: m.model, apiKeySource: m.apiKeySource }) }
      const interesting = m.type === 'result' || (m.type === 'system' && !['status', 'thinking_tokens', 'init'].includes(m.subtype)) || m.type === 'assistant' || m.type === 'user' || m.type === 'conversation_reset' || (m.type === 'stream_event' && m.event?.delta?.type === 'thinking_delta' && m.event.delta.thinking) || (m.type === 'stream_event' && m.event?.type === 'message_start')
      if (interesting || counts[key] === 1) log('msg', { label, phase: phases[phase]?.name, key, first: counts[key] === 1, msg: shrink(m) })
      if (phases[phase]?.onMessage) await phases[phase].onMessage(m, q)
      if (m.type === 'result') {
        log('result', { label, phase: phases[phase]?.name, subtype: m.subtype, is_error: m.is_error, terminal_reason: m.terminal_reason, num_turns: m.num_turns, turnMsgs, permission_denials: m.permission_denials, errors: m.errors, result: shrink(m.result), origin: m.origin, user_message_uuid: m.user_message_uuid })
        if (phases[phase]?.after) await phases[phase].after(q)
        await next()
      }
    }
  } catch (e) { log('loop-error', { label, error: String(e), stack: String(e?.stack).slice(0, 500) }) }
  log('session-end', { label, counts })
  return sendUuids
}

// ---- Session A ----
let pendingAsk
const canUseTool = async (toolName, input, opts, q) => {
  log('can_use_tool', { toolName, input: shrink(input), opts: shrink(opts) })
  if (toolName === 'AskUserQuestion') {
    const questions = input.questions || []
    const answers = {}
    for (const qq of questions) answers[qq.question] = (qq.options?.[0]?.label) ?? 'Tea'
    return { behavior: 'allow', updatedInput: { ...input, answers } }
  }
  if (toolName === 'Bash' && typeof input.command === 'string' && input.command.includes('rm -rf')) {
    return { behavior: 'deny', message: 'Denied by dsh-tui probe policy' }
  }
  if (toolName === 'Bash' && typeof input.command === 'string' && input.command.includes('touch /tmp/probe-marker')) {
    // Hold the ask, interrupt the turn, and watch the signal.
    return new Promise((resolve) => {
      let aborted = false
      opts.signal.addEventListener('abort', () => { aborted = true; log('permission-signal', { toolName, aborted: true, reason: String(opts.signal.reason) }) })
      setTimeout(() => { log('control', { call: 'interrupt(while permission pending)' }); q.interrupt().then(r => log('control-result', { call: 'interrupt', result: shrink(r) })).catch(e => log('control-error', { call: 'interrupt', error: String(e) })) }, 400)
      setTimeout(() => { log('permission-resolve', { toolName, abortedBeforeResolve: aborted }); resolve({ behavior: 'deny', message: 'late deny after interrupt' }) }, 2500)
    })
  }
  return { behavior: 'allow' }
}

const sidsA = await (async () => {
  let sid
  const uuids = await runSession('A', { title: 'dsh-tui probe 2' }, [
    { name: 'omitted-mode-codeword', text: 'What is the codeword? Answer with just the word.', onMessage: async (m) => { sid ??= m.session_id } },
    { name: 'ask-user-question', text: 'Use the AskUserQuestion tool to ask me whether I prefer Tea or Coffee (options: Tea, Coffee). After I answer, reply with exactly: you chose <answer>' },
    { name: 'deny', text: 'Run the shell command `rm -rf /tmp/probe-nonexistent-dir-xyz` with the Bash tool, then reply exactly: attempted' },
    { name: 'pending-interrupt', text: 'Run the shell command `touch /tmp/probe-marker-1` with the Bash tool, then reply exactly: touched' },
    { name: 'haiku-thinking', text: 'Think step by step about why the sky is blue, then answer in one sentence.' },
    { name: 'compact', text: '/compact' },
    { name: 'after-compact', text: 'What is the codeword? Answer with just the word.' },
  ], { canUseTool })
  return { sid, uuids }
})()
log('sessionA', { sid: sidsA.sid })

// ---- post-session store reads ----
const time = async (label, fn) => { const s = Date.now(); try { const r = await fn(); log('store', { label, ms: Date.now() - s, result: shrink(r) }); return r } catch (e) { log('store-error', { label, ms: Date.now() - s, error: String(e) }); return undefined } }
const sid = sidsA.sid
await time('getSessionInfo(A)', () => getSessionInfo(sid, { dir: cwd }))
await time('getSessionMessages(A, includeSystemMessages)', async () => { const r = await getSessionMessages(sid, { dir: cwd, includeSystemMessages: true }); const kinds = {}; for (const m of r) { const c = m.message?.content; const k = m.type + '[' + (Array.isArray(c) ? c.map(b => b.type).join('+') : typeof c) + ']'; kinds[k] = (kinds[k] || 0) + 1 } return { count: r.length, kinds, systemSamples: r.filter(m => m.type === 'system').slice(0, 3), lastTwo: r.slice(-2) } })
const forked = await time('forkSession(A)', () => forkSession(sid, { dir: cwd, title: 'probe fork' }))

// ---- Session B: resume the fork ----
if (forked?.sessionId) {
  await runSession('B', { resume: forked.sessionId }, [
    { name: 'resume-replay', text: 'What was the very first question I asked you in this conversation? Answer briefly.' },
  ])
}
trace.end()
console.log('done', JSON.stringify({ sid, forked }))
