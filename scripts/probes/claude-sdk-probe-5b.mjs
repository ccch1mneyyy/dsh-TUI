// Maintainer probe, not a regression test and not part of CI.
//
// Two probes for session reset and side queries:
//
//  reset  — `/clear` sent as input is a local command of the CLI (no model
//           call, nothing billed): records the `conversation_reset` frame
//           (trigger, new_conversation_id vs session_id) and the session id
//           the frames carry after it, for a second `/clear` too, plus the
//           transcript files the project directory holds afterwards.
//  side   — the `/recap` / `/btw` side query: one turn that reads a file (so
//           the history holds a tool call), then
//           `query({prompt, options:{resume, forkSession:true,
//           persistSession:false, tools:[], maxTurns:1, model}})`; records
//           whether it answers (a history with tool calls and no tools),
//           its latency and cost, and whether any transcript file was
//           written by it (files before / after). 2 haiku turns.
//
// Every session it creates lives in a fresh temp cwd; the finally block
// deletes the sessions (SDK `deleteSession`) and the temp directory.
//
// Prerequisites: `@anthropic-ai/claude-agent-sdk@0.3.287` resolvable from
// this file; a local `claude` CLI (CLAUDE_CODE_EXECUTABLE, else the SDK's
// bundled binary); valid Claude credentials for `side`.
// Usage: node scripts/probes/claude-sdk-probe-5b.mjs [reset] [side]
// Output: a JSON digest on stdout (no token material, temp paths reduced).
import { deleteSession, listSessions, query } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Real-CLI runs use haiku only.
for (const name of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) {
  const value = process.env[name]
  if (value !== undefined && value !== '' && !/haiku/iu.test(value)) {
    console.error(`refusing to run: ${name}=${value} — real-CLI runs use haiku only`)
    process.exit(2)
  }
}

const only = new Set(process.argv.slice(2))
const wants = name => only.size === 0 || only.has(name)

/** The child environment the backend builds (nested-session variables scrubbed). */
function childEnv() {
  const drop = new Set(['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_PID', 'AI_AGENT', 'TRACEPARENT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_EFFORT', 'CLAUDE_CODE_INVOKED_SKILLS'])
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || drop.has(key) || key.startsWith('CLAUDE_CODE_MESSAGING_')) continue
    env[key] = value
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'dsh-tui/probe'
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1'
  return env
}

class Inbox {
  constructor() { this.q = []; this.w = []; this.closed = false }
  push(v) { const w = this.w.shift(); if (w) w({ value: v, done: false }); else this.q.push(v) }
  close() { this.closed = true; for (const w of this.w.splice(0)) w({ value: undefined, done: true }) }
  [Symbol.asyncIterator]() {
    return { next: () => this.q.length ? Promise.resolve({ value: this.q.shift(), done: false }) : this.closed ? Promise.resolve({ value: undefined, done: true }) : new Promise(r => this.w.push(r)) }
  }
}

const executable = process.env.CLAUDE_CODE_EXECUTABLE
const common = cwd => ({
  cwd,
  env: childEnv(),
  settingSources: ['user', 'project', 'local'],
  systemPrompt: { type: 'preset', preset: 'claude_code' },
  ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
  stderr: () => undefined,
})

/** Transcript files under every project directory naming this cwd. */
function transcriptFiles(cwd) {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects')
  const tag = path.basename(cwd)
  const files = []
  for (const dir of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    if (!dir.includes(tag)) continue
    for (const entry of fs.readdirSync(path.join(root, dir))) if (entry.endsWith('.jsonl')) files.push(entry)
  }
  return files.sort()
}

const user = (text, uuid = randomUUID()) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '', uuid })

/** Pull messages until `stop(message)` or the deadline. */
async function until(iterator, stop, ms, seen) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const next = await Promise.race([iterator.next(), new Promise(resolve => setTimeout(() => resolve({ timeout: true }), Math.max(1, deadline - Date.now())))])
    if (next.timeout || next.done) return undefined
    seen.push(next.value)
    if (stop(next.value)) return next.value
  }
  return undefined
}

const digest = {}
const created = []
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tui-probe-5b-'))
try {
  if (wants('reset')) {
    const cwd = fs.mkdtempSync(path.join(temp, 'reset-'))
    const sessionId = randomUUID()
    created.push({ sessionId, cwd })
    const inbox = new Inbox()
    const q = query({ prompt: inbox, options: { ...common(cwd), sessionId, model: 'haiku' } })
    const it = q[Symbol.asyncIterator]()
    const seen = []
    await q.initializationResult()
    inbox.push(user('/clear'))
    const first = await until(it, m => m.type === 'conversation_reset', 30_000, seen)
    inbox.push(user('/clear'))
    const second = await until(it, m => m.type === 'conversation_reset', 30_000, seen)
    inbox.close()
    q.close()
    for (const frame of [first, second]) if (typeof frame?.new_conversation_id === 'string') created.push({ sessionId: frame.new_conversation_id, cwd })
    // Every id a frame names, in order of appearance: S0 = ours, then A, B, …
    const names = new Map([[sessionId, 'S0']])
    const id = value => {
      if (typeof value !== 'string') return undefined
      if (!names.has(value)) names.set(value, String.fromCharCode(64 + names.size))
      return names.get(value)
    }
    for (const m of seen) for (const value of [m.session_id, m.new_conversation_id]) if (typeof value === 'string' && value !== sessionId) created.push({ sessionId: value, cwd })
    digest.reset = {
      frames: seen.map(m => ({ type: m.type, ...(m.subtype ? { subtype: m.subtype } : {}), session: id(m.session_id), ...(m.type === 'conversation_reset' ? { trigger: m.trigger, newConversation: id(m.new_conversation_id), userMessageUuid: typeof m.user_message_uuid === 'string' } : {}) })),
      transcripts: transcriptFiles(cwd).map(file => id(file.replace(/\.jsonl$/u, ''))),
    }
  }

  if (wants('side')) {
    const cwd = fs.mkdtempSync(path.join(temp, 'side-'))
    fs.writeFileSync(path.join(cwd, 'note.txt'), 'Pineapple is the codeword.\n')
    const sessionId = randomUUID()
    created.push({ sessionId, cwd })
    const inbox = new Inbox()
    const q = query({ prompt: inbox, options: { ...common(cwd), sessionId, permissionMode: 'default', canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }), model: 'haiku' } })
    const it = q[Symbol.asyncIterator]()
    const seen = []
    await q.initializationResult()
    inbox.push(user('Use the Read tool to read note.txt, then reply with only its first word.'))
    const main = await until(it, m => m.type === 'result', 120_000, seen)
    inbox.close()
    q.close()
    const before = transcriptFiles(cwd)
    const started = Date.now()
    const sideSeen = []
    const side = query({
      prompt: 'In one short sentence: what did the file say? Answer from the conversation only.',
      options: { ...common(cwd), resume: sessionId, forkSession: true, persistSession: false, tools: [], maxTurns: 1, model: 'haiku' },
    })
    let text = ''
    let result
    try {
      for await (const message of side) {
        sideSeen.push(message)
        if (message.type === 'assistant') for (const block of message.message?.content ?? []) if (block.type === 'text') text += block.text
        if (message.type === 'result') { result = message; break }
      }
    } finally {
      side.close()
    }
    const after = transcriptFiles(cwd)
    digest.side = {
      main: { subtype: main?.subtype, isError: main?.is_error, toolCalls: seen.filter(m => m.type === 'assistant').flatMap(m => m.message?.content ?? []).filter(b => b.type === 'tool_use').map(b => b.name) },
      sideQuery: {
        ms: Date.now() - started,
        subtype: result?.subtype,
        isError: result?.is_error,
        costUsd: result?.total_cost_usd,
        numTurns: result?.num_turns,
        answered: text.trim() !== '',
        mentionsCodeword: /pineapple/iu.test(text),
        sessionIdIsOriginal: result?.session_id === sessionId,
        types: [...new Set(sideSeen.map(m => m.subtype ? `${m.type}/${m.subtype}` : m.type))],
      },
      transcriptsBefore: before.length,
      transcriptsAfter: after.length,
      newTranscripts: after.filter(file => !before.includes(file)).length,
    }
    for (const file of after) if (!before.includes(file)) created.push({ sessionId: file.replace(/\.jsonl$/u, ''), cwd })
  }
} finally {
  for (const { sessionId, cwd } of created) {
    try { await deleteSession(sessionId, { dir: cwd }) } catch { /* never written */ }
  }
  const leftovers = []
  for (const cwd of new Set(created.map(entry => entry.cwd))) {
    let listed = []
    try { listed = await listSessions({ dir: cwd, includeProgrammatic: true }) } catch { /* none */ }
    // Whatever the store still lists under a probe cwd is the probe's own.
    for (const info of listed) {
      try { await deleteSession(info.sessionId, { dir: cwd }) } catch { leftovers.push(info.sessionId) }
    }
  }
  digest.cleanup = { deleted: created.length, leftovers: [...new Set(leftovers)].length }
  // The CLI also leaves the (now empty) project directory, with a `memory/`
  // folder: remove every project directory named after a probe cwd.
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects')
  const tag = path.basename(temp)
  for (const dir of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
    if (dir.includes(tag)) fs.rmSync(path.join(projects, dir), { recursive: true, force: true })
  }
  fs.rmSync(temp, { recursive: true, force: true })
  console.log(JSON.stringify(digest, null, 2))
}
