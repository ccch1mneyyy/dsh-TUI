// Maintainer probe — NOT a regression test, NOT part of CI.
//
// Records COMPLETE (untruncated) Claude Agent SDK message sequences for the
// translator fixtures in scripts/fixtures/claude/ (docs/agent-backend-design.md
// §8.3). Each scenario runs one fresh streaming-input session in its own
// throwaway project directory with the backend's Fidelity Profile options,
// and writes `<output-dir>/<scenario>.raw.jsonl`:
//
//   {"t":ms,"dir":"in","placement":"turn|steer|followup|now","msg":<SDKUserMessage>}
//   {"t":ms,"dir":"out","msg":<every SDK message, verbatim>}
//   {"t":ms,"dir":"ctl","action":"interrupt","cancelQueued":bool,"receipt":…}
//   {"t":ms,"dir":"perm","toolName":…,"toolUseID":…,"decision":"allow|deny"}
//
// Raw files contain real paths, ids and account-adjacent fields: NEVER commit
// them. Run scripts/fixtures/claude/redact.mjs over the directory and commit
// only its output.
//
// Prerequisites:
//   - `@anthropic-ai/claude-agent-sdk@0.3.287` resolvable from this file
//     (the repo devDependency after `pnpm install`);
//   - a local `claude` CLI; set CLAUDE_CODE_EXECUTABLE to its path, or leave
//     it unset to use the SDK's bundled binary;
//   - valid Claude credentials. A full run costs ~15 haiku turns.
// Usage: node scripts/probes/claude-sdk-record.mjs <output-dir> [scenario…]
import { query } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
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
  console.error('usage: node claude-sdk-record.mjs <output-dir> [scenario…]')
  process.exit(2)
}
const only = new Set(process.argv.slice(3))
fs.mkdirSync(root, { recursive: true })

const DENY = 'dsh-tui: interactive approvals arrive in the next phase'

/** The backend's child environment (design §4.3), minus parent-session vars. */
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

/** One recorded session. `permission` decides every canUseTool prompt. */
async function record(name, { permissionMode = 'default', permission = 'allow', run }) {
  const cwd = path.join(root, `project-${name}`)
  fs.rmSync(cwd, { recursive: true, force: true })
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'README.md'), '# Fixture project\n\nA tiny project for recording Claude SDK fixtures.\n')
  fs.writeFileSync(path.join(cwd, 'src', 'app.js'), 'export function greet(name) {\n  return `hello ${name}`\n}\n')
  const file = fs.createWriteStream(path.join(root, `${name}.raw.jsonl`))
  const t0 = Date.now()
  const write = obj => file.write(JSON.stringify({ t: Date.now() - t0, ...obj }) + '\n')
  const inbox = new Inbox()
  const seen = []
  const waiters = []
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
      extraArgs: { 'replay-user-messages': null },
      env: childEnv(),
      stderr: () => {},
      ...(process.env.CLAUDE_CODE_EXECUTABLE ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE } : {}),
      canUseTool: async (toolName, input, options) => {
        const decision = permission === 'deny' ? 'deny' : 'allow'
        write({ dir: 'perm', toolName, toolUseID: options.toolUseID, decision })
        return decision === 'deny'
          ? { behavior: 'deny', message: DENY, toolUseID: options.toolUseID }
          : { behavior: 'allow', updatedInput: input, toolUseID: options.toolUseID }
      },
    },
  })
  const consumer = (async () => {
    for await (const msg of q) {
      write({ dir: 'out', msg })
      seen.push(msg)
      for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg) }
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
  const send = (text, placement = 'turn') => {
    const priority = placement === 'steer' ? 'next' : placement === 'now' ? 'now' : placement === 'followup' ? 'later' : undefined
    const msg = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid: randomUUID(), ...(priority ? { priority } : {}) }
    write({ dir: 'in', placement, msg })
    inbox.push(msg)
    return msg.uuid
  }
  const results = n => waitFor(() => seen.filter(m => m.type === 'result').length >= n)
  const interrupt = async (cancelQueued = false) => {
    const receipt = await q.interrupt(cancelQueued ? { cancelQueued: true } : undefined)
    write({ dir: 'ctl', action: 'interrupt', cancelQueued, receipt: receipt ?? null })
  }
  try {
    await q.initializationResult()
    await run({ send, waitFor, results, interrupt, seen })
    // Let trailing frames (lifecycle `completed`, `idle`) land.
    await new Promise(r => setTimeout(r, 1500))
  } finally {
    inbox.close()
    q.close()
    await Promise.race([consumer.catch(() => {}), new Promise(r => setTimeout(r, 5000))])
    await new Promise(r => file.end(r))
  }
  console.log(`recorded ${name}: ${seen.length} messages`)
}

const firstTextDelta = m => m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta'

const SCENARIOS = {
  'simple-text': {
    run: async ({ send, results }) => { send('Reply with exactly: hello fixture'); await results(1) },
  },
  'thinking-tokens': {
    run: async ({ send, results }) => { send('Think it through, then answer with just the number: what is 17 * 23?'); await results(1) },
  },
  'tool-read': {
    run: async ({ send, results }) => { send('Use the Read tool to read README.md, then tell me its first line.'); await results(1) },
  },
  'write-edit': {
    permissionMode: 'acceptEdits',
    run: async ({ send, results }) => {
      send('Use the Write tool to create notes.txt containing exactly the line: alpha. Then use the Edit tool to change alpha to beta. Reply done.')
      await results(1)
    },
  },
  'bash': {
    run: async ({ send, results }) => {
      send('Use the Bash tool to run `echo fixture-ok`, then use the Bash tool to run `ls /definitely-missing-dir`. Report both outcomes in one short sentence.')
      await results(1)
    },
  },
  'interrupt-now': {
    run: async ({ send, waitFor, results }) => {
      send('Count from 1 to 200, one number per line, no other text.')
      await waitFor(firstTextDelta)
      send('Stop. Reply with exactly: NOW-OK', 'now')
      await results(2)
    },
  },
  'interrupt-cancel': {
    run: async ({ send, waitFor, results, interrupt }) => {
      send('Count from 1 to 200, one number per line, no other text.')
      await waitFor(firstTextDelta)
      await interrupt()
      await results(1)
    },
  },
  'fold-in-next': {
    run: async ({ send, waitFor, results }) => {
      send('Use the Bash tool to run `sleep 4 && echo slept`, then summarize the output in one sentence.')
      await waitFor(m => m.type === 'assistant' && m.message?.content?.some(b => b.type === 'tool_use'))
      send('Also end your reply with the word NEXT-OK.', 'steer')
      await results(1)
    },
  },
  'compaction': {
    run: async ({ send, results }) => {
      send('Remember the word pineapple. Reply with exactly: ok')
      await results(1)
      send('/compact')
      await results(2)
    },
  },
  'permission-deny': {
    permission: 'deny',
    run: async ({ send, results }) => {
      send('Use the Write tool to create denied.txt containing x. If it is refused, reply with exactly: refused')
      await results(1)
    },
  },
  'partial-text': {
    run: async ({ send, results }) => { send('Write a five-line poem about the sea, one line per sentence, no title.'); await results(1) },
  },
  // Two tool calls in ONE API message: the CLI drains the first result while
  // the message still streams the second call (the attempt must stay open).
  'parallel-tool': {
    run: async ({ send, results }) => {
      send('In ONE response, call the Read tool twice in parallel (two tool_use blocks in the same message): README.md and src/app.js. Then tell me the first line of each in one sentence.')
      await results(1)
    },
  },
  'permission-allow': {
    permission: 'allow',
    run: async ({ send, results }) => {
      send('Use the Write tool to create allowed.txt containing exactly: ok. Then reply with exactly: written')
      await results(1)
    },
  },
  // A foreground subagent: its messages carry `parent_tool_use_id` (text is
  // forwarded with forwardSubagentText) and must stay off the main transcript.
  'subagent': {
    run: async ({ send, results }) => {
      send('Use the Agent tool with subagent_type "general-purpose" and the prompt "Read README.md with the Read tool and report its first line." Wait for it (do not run it in the background), then reply with its report in one sentence.')
      await results(1)
    },
  },
  'background-bash': {
    run: async ({ send, waitFor, results }) => {
      send('Use the Bash tool with run_in_background set to true to run `sleep 3; echo bg-done`. Then reply with exactly: started')
      await results(1)
      await waitFor(m => m.type === 'system' && m.subtype === 'task_notification', 60000)
      // The CLI usually opens a notification turn to report the finished task.
      await results(2).catch(() => {})
    },
  },
}

for (const [name, scenario] of Object.entries(SCENARIOS)) {
  if (only.size > 0 && !only.has(name)) continue
  try {
    await record(name, scenario)
  } catch (error) {
    console.error(`${name} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
process.exit(0)
