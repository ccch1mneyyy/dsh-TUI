// Maintainer probe, not a regression test and not part of CI.
//
// Permission-bridge probe: drives the real Claude Code CLI through
// @anthropic-ai/claude-agent-sdk with an instrumented `canUseTool` and
// records, per scenario, the order of `system/session_state_changed` frames
// relative to the callback, the callback's option bag (field presence and
// suggestion shapes only — paths are reduced to their basename), and what the
// CLI does when the prompt is withdrawn.
//
// Prerequisites:
//   - `@anthropic-ai/claude-agent-sdk@0.3.287` resolvable from this file
//     (the repo devDependency after `pnpm install`);
//   - a local `claude` CLI; set CLAUDE_CODE_EXECUTABLE to its path, or leave
//     it unset to use the SDK's bundled binary;
//   - valid Claude credentials. A full run costs ~10 haiku turns.
// Usage: node scripts/probes/claude-sdk-probe-permissions.mjs <output-dir> [scenario…]
//   → <output-dir>/permissions.jsonl (one summary line per scenario) and a
//     printed digest. Output holds no token material and no absolute paths.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
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
if (!root) {
  console.error('usage: node claude-sdk-probe-permissions.mjs <output-dir> [scenario…]')
  process.exit(2)
}
const only = new Set(process.argv.slice(3))
fs.mkdirSync(root, { recursive: true })
const out = fs.createWriteStream(path.join(root, 'permissions.jsonl'))

function childEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key === 'CLAUDECODE' || key === 'CLAUDE_CODE_ENTRYPOINT' || key === 'CLAUDE_CODE_SESSION_ID' || key.startsWith('CLAUDE_CODE_MESSAGING_')) continue
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
    return {
      next: () => {
        if (this.q.length) return Promise.resolve({ value: this.q.shift(), done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise(r => this.w.push(r))
      },
    }
  }
}

/** Reduce a path-like string to its basename (no real paths in the output). */
const base = value => typeof value === 'string' && value.includes('/') ? `…/${path.basename(value)}` : value

/** Shape of one suggestion, paths reduced. */
function suggestionShape(s) {
  if (s === null || typeof s !== 'object') return s
  return {
    type: s.type,
    destination: s.destination,
    ...(s.behavior === undefined ? {} : { behavior: s.behavior }),
    ...(s.mode === undefined ? {} : { mode: s.mode }),
    ...(Array.isArray(s.rules) ? { rules: s.rules.map(r => ({ toolName: r.toolName, ruleContent: base(r.ruleContent) })) } : {}),
    ...(Array.isArray(s.directories) ? { directories: s.directories.map(base) } : {}),
  }
}

/** The option bag, reduced to presence + shapes. */
function optionShape(toolName, input, o) {
  return {
    toolName,
    inputKeys: Object.keys(input ?? {}),
    requestId: typeof o.requestId === 'string' ? 'string' : typeof o.requestId,
    toolUseID: typeof o.toolUseID === 'string' ? 'string' : typeof o.toolUseID,
    agentID: o.agentID === undefined ? undefined : 'present',
    title: o.title === undefined ? undefined : base(o.title).replace(/\/[^\s]+/gu, '…'),
    displayName: o.displayName,
    description: o.description === undefined ? undefined : 'present',
    decisionReason: o.decisionReason === undefined ? undefined : String(o.decisionReason).slice(0, 80),
    blockedPath: o.blockedPath === undefined ? undefined : base(o.blockedPath),
    defaultToNo: o.defaultToNo,
    suppressAlwaysAllowRule: o.suppressAlwaysAllowRule,
    matchedAskRule: o.matchedAskRule === undefined ? undefined : 'present',
    mcpServer: o.mcpServer === undefined ? undefined : 'present',
    requiresUserInteraction: o.requiresUserInteraction,
    suggestions: Array.isArray(o.suggestions) ? o.suggestions.map(suggestionShape) : undefined,
    otherKeys: Object.keys(o).filter(k => !['signal', 'suggestions', 'blockedPath', 'decisionReason', 'title', 'displayName', 'description', 'defaultToNo', 'suppressAlwaysAllowRule', 'toolUseID', 'agentID', 'requestId', 'matchedAskRule', 'mcpServer', 'requiresUserInteraction'].includes(k)),
  }
}

async function scenario(name, { permissionMode = 'default', decide, run }) {
  const cwd = path.join(root, `project-${name}`)
  fs.rmSync(cwd, { recursive: true, force: true })
  fs.mkdirSync(cwd, { recursive: true })
  fs.writeFileSync(path.join(cwd, 'README.md'), '# Probe project\n')
  const t0 = Date.now()
  const ms = () => Date.now() - t0
  const timeline = []
  const calls = []
  const seen = []
  const waiters = []
  const inbox = new Inbox()
  const note = (entry) => timeline.push({ ms: ms(), ...entry })
  const q = query({
    prompt: inbox,
    options: {
      cwd,
      sessionId: randomUUID(),
      model: 'haiku',
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      tools: { type: 'preset', preset: 'claude_code' },
      permissionMode,
      includePartialMessages: true,
      forwardSubagentText: true,
      perTaskStopAffordance: true,
      enableFileCheckpointing: true,
      env: childEnv(),
      stderr: () => {},
      ...(process.env.CLAUDE_CODE_EXECUTABLE ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE } : {}),
      canUseTool: (toolName, input, options) => {
        const call = { index: calls.length, toolName, toolUseID: options.toolUseID, requestId: options.requestId, input, options, shape: optionShape(toolName, input, options), at: ms(), abortedAt: undefined }
        calls.push(call)
        note({ ev: 'canUseTool', index: call.index, tool: toolName, pendingBefore: calls.filter(c => c.settledAt === undefined).length - 1 })
        options.signal.addEventListener('abort', () => { call.abortedAt = ms(); note({ ev: 'signal-abort', index: call.index }) }, { once: true })
        return Promise.resolve(decide(call, { q, ms, note })).then(result => {
          call.settledAt = ms()
          if (result !== null && result !== undefined) note({ ev: 'answered', index: call.index, behavior: result.behavior })
          return result
        })
      },
    },
  })
  const consumer = (async () => {
    try {
      for await (const msg of q) {
        seen.push(msg)
        if (msg.type === 'system' && msg.subtype === 'session_state_changed') note({ ev: `state:${msg.state}` })
        if (msg.type === 'system' && msg.subtype === 'status' && msg.permissionMode !== undefined) note({ ev: `status-mode:${msg.permissionMode}` })
        if (msg.type === 'system' && msg.subtype === 'permission_denied') note({ ev: 'permission_denied', reasonType: msg.decision_reason_type })
        if (msg.type === 'result') note({ ev: 'result', subtype: msg.subtype, terminal: msg.terminal_reason, denials: (msg.permission_denials ?? []).length })
        if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
          for (const block of msg.message.content) {
            if (block?.type !== 'tool_result') continue
            const text = typeof block.content === 'string' ? block.content : (block.content ?? []).map(b => b?.text ?? '').join('')
            note({ ev: 'tool_result', isError: block.is_error === true, text: text.slice(0, 160).replace(/\/[^\s"']+/gu, '…') })
          }
        }
        if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
          for (const block of msg.message.content) if (block?.type === 'tool_use') note({ ev: 'tool_use', name: block.name, parent: msg.parent_tool_use_id === null ? undefined : 'subagent' })
        }
        for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg) }
      }
      note({ ev: 'stream-end' })
    } catch (error) {
      note({ ev: 'stream-error', message: String(error?.message ?? error).slice(0, 120) })
    }
  })()
  const waitFor = (pred, timeoutMs = 120000) => {
    const hit = seen.find(pred)
    if (hit) return Promise.resolve(hit)
    return new Promise((resolve, reject) => {
      const w = { pred, resolve }
      waiters.push(w)
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error(`${name}: timed out`)) } }, timeoutMs).unref()
    })
  }
  const send = text => inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid: randomUUID() })
  const results = n => waitFor(() => seen.filter(m => m.type === 'result').length >= n)
  let failure
  try {
    await q.initializationResult()
    await run({ send, results, waitFor, q, calls, cwd, note })
    await new Promise(r => setTimeout(r, 1200))
  } catch (error) {
    failure = String(error?.message ?? error)
  } finally {
    inbox.close()
    try { q.close() } catch {}
    await Promise.race([consumer, new Promise(r => setTimeout(r, 5000))])
  }
  const summary = {
    scenario: name,
    failure,
    calls: calls.map(c => ({ ...c.shape, at: c.at, settledAt: c.settledAt, abortedAt: c.abortedAt })),
    distinctRequestIds: new Set(calls.map(c => c.requestId)).size,
    timeline,
    files: fs.readdirSync(cwd).filter(f => f !== 'README.md'),
  }
  out.write(JSON.stringify(summary) + '\n')
  console.log(`\n== ${name}${failure ? ` (FAILED: ${failure})` : ''}`)
  for (const entry of timeline) console.log(`  ${String(entry.ms).padStart(6)}ms ${JSON.stringify({ ...entry, ms: undefined })}`)
  for (const call of summary.calls) console.log(`  call ${JSON.stringify(call)}`)
  console.log(`  distinct requestIds: ${summary.distinctRequestIds}; files: ${summary.files.join(', ') || '-'}`)
}

const allowOnce = call => ({ behavior: 'allow', updatedInput: call.input, toolUseID: call.toolUseID })
const sleep = ms => new Promise(r => setTimeout(r, ms))

const SCENARIOS = {
  // requires_action ordering vs canUseTool; allow-always persistence.
  'ask-write-always': {
    decide: call => ({
      behavior: 'allow',
      updatedInput: call.input,
      updatedPermissions: call.options.suggestions ?? [],
      toolUseID: call.toolUseID,
      decisionClassification: 'user_permanent',
    }),
    run: async ({ send, results }) => {
      send('Use the Write tool to create probe.txt containing exactly: one. Reply done.')
      await results(1)
      send('Use the Write tool to create probe2.txt containing exactly: two. Reply done.')
      await results(2)
    },
  },
  // Withdrawal: interrupt() while the prompt is pending.
  'interrupt-pending': {
    decide: (call, { q, note }) => new Promise(resolve => {
      call.options.signal.addEventListener('abort', () => resolve({ behavior: 'deny', message: 'withdrawn', toolUseID: call.toolUseID }), { once: true })
      setTimeout(() => { note({ ev: 'interrupt()' }); void q.interrupt().then(r => note({ ev: 'interrupt-receipt', receipt: r === undefined ? 'undefined' : Object.keys(r) })) }, 500)
    }),
    run: async ({ send, results }) => {
      send('Use the Write tool to create pending.txt containing exactly: x. Reply done.')
      await results(1)
    },
  },
  // Withdrawal: close() while the prompt is pending.
  'close-pending': {
    decide: (call, { q, note }) => new Promise(resolve => {
      call.options.signal.addEventListener('abort', () => resolve({ behavior: 'deny', message: 'closed', toolUseID: call.toolUseID }), { once: true })
      setTimeout(() => { note({ ev: 'close()' }); q.close() }, 500)
    }),
    run: async ({ send, waitFor }) => {
      send('Use the Write tool to create closed.txt containing exactly: x. Reply done.')
      await waitFor(() => false, 6000).catch(() => {})
    },
  },
  // Two parallel tool calls needing approval: FIFO? concurrent callbacks?
  'parallel': {
    decide: async call => { await sleep(1500); return allowOnce(call) },
    run: async ({ send, results }) => {
      send('In ONE response, call the Write tool twice in parallel (two tool_use blocks in the same message): a.txt containing a, and b.txt containing b. Then reply done.')
      await results(1)
    },
  },
  // A subagent's tool asking: does agentID arrive?
  'subagent': {
    decide: call => allowOnce(call),
    run: async ({ send, results, waitFor }) => {
      send('Use the Agent tool with subagent_type "general-purpose" and this prompt: "Use the Write tool to create sub.txt containing exactly: sub. Reply done." Wait for it to finish (do not run it in the background), then reply done.')
      await results(1)
      // An async launch reports back later through a task notification turn.
      await waitFor(m => m.type === 'system' && m.subtype === 'task_notification', 90000).catch(() => {})
      await results(2).catch(() => {})
    },
  },
  // AskUserQuestion input shape and the answer format the tool accepts.
  'ask-question': {
    decide: call => {
      if (call.toolName !== 'AskUserQuestion') return allowOnce(call)
      const questions = Array.isArray(call.input.questions) ? call.input.questions : []
      const answers = Object.fromEntries(questions.map(q => [q.question, q.options?.[1]?.label ?? q.options?.[0]?.label ?? 'x']))
      return { behavior: 'allow', updatedInput: { ...call.input, answers }, toolUseID: call.toolUseID }
    },
    run: async ({ send, results }) => {
      send('Use the AskUserQuestion tool to ask me one question: which color I prefer, with the options red and blue. Then tell me my answer in one short sentence.')
      await results(1)
    },
  },
  // ExitPlanMode in plan mode: input shape, and approve → setMode acceptEdits.
  'plan-exit': {
    permissionMode: 'plan',
    decide: call => {
      if (call.toolName === 'ExitPlanMode') {
        return { behavior: 'allow', updatedInput: call.input, updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], toolUseID: call.toolUseID }
      }
      return allowOnce(call)
    },
    run: async ({ send, results }) => {
      send('Make a one-step plan to create plan.txt containing exactly: planned. Present it with the ExitPlanMode tool. Once approved, create the file with the Write tool and reply done.')
      await results(1)
    },
  },
}

for (const [name, spec] of Object.entries(SCENARIOS)) {
  if (only.size > 0 && !only.has(name)) continue
  await scenario(name, spec)
}
out.end()
process.exit(0)
