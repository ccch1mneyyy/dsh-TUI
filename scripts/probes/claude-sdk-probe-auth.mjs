// Maintainer probe — NOT a regression test, NOT part of CI.
//
// P-AUTH-1 (docs/agent-backend-design.md §8.8, §4.12): how the Claude CLI
// behaves with an injected `CLAUDE_CODE_OAUTH_TOKEN`.
//
//  - `dsh-auth`: when the dsh-auth credential file holds an `anthropic`
//    credential (`$DSH_AUTH_CREDENTIALS`, `$DSH_HOME/dsh-auth/credentials.json`
//    or `~/.dsh/dsh-auth/credentials.json`), inject its access token and run
//    one turn: does the CLI accept it, and what do `init.apiKeySource` and
//    `accountInfo()` report? Skipped (and said so) when none is stored.
//  - `rejected`: inject a syntactically plausible but invalid token and run
//    one turn: the failure shape (`assistant.error`, `result.is_error`, its
//    text) the backend's reconnect logic keys on; then reopen the SAME
//    session with `resume` on the local login: does it resume a session
//    whose only turn failed authentication?
//
// Prints field PRESENCE and error text only — never token material (the
// injected token is never echoed; account fields are reduced to presence).
// Prerequisites: SDK 0.3.287 resolvable, a local `claude` CLI
// (CLAUDE_CODE_EXECUTABLE), a local login for the resume half.
// Usage: node scripts/probes/claude-sdk-probe-auth.mjs <output-dir>
import { query } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = process.argv[2]
if (!root) {
  console.error('usage: node claude-sdk-probe-auth.mjs <output-dir>')
  process.exit(2)
}
const cwd = path.join(root, 'project-auth')
fs.mkdirSync(cwd, { recursive: true })

function childEnv(extra = {}, drop = []) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || drop.includes(key)) continue
    if (key === 'CLAUDECODE' || key === 'CLAUDE_CODE_ENTRYPOINT' || key === 'CLAUDE_CODE_SESSION_ID' || key.startsWith('CLAUDE_CODE_MESSAGING_')) continue
    env[key] = value
  }
  return { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: 'dsh-tui/probe', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1', ...extra }
}

class Inbox {
  constructor() { this.q = []; this.w = []; this.closed = false }
  push(v) { const w = this.w.shift(); if (w) w({ value: v, done: false }); else this.q.push(v) }
  close() { this.closed = true; for (const w of this.w.splice(0)) w({ value: undefined, done: true }) }
  [Symbol.asyncIterator]() {
    return { next: () => this.q.length ? Promise.resolve({ value: this.q.shift(), done: false }) : this.closed ? Promise.resolve({ value: undefined, done: true }) : new Promise(r => this.w.push(r)) }
  }
}

const presence = value => value === undefined || value === null || value === '' ? 'absent' : 'present'
const scrub = text => String(text ?? '').replace(/sk-ant-[A-Za-z0-9_-]+/gu, '<token>').replace(/\/[^\s"']+/gu, '…').slice(0, 300)

async function turn(label, { env, resume, sessionId, prompt }) {
  const inbox = new Inbox()
  const q = query({
    prompt: inbox,
    options: {
      cwd,
      ...(resume ? { resume } : { sessionId }),
      model: 'haiku',
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      tools: { type: 'preset', preset: 'claude_code' },
      permissionMode: 'default',
      includePartialMessages: true,
      env,
      stderr: () => {},
      ...(process.env.CLAUDE_CODE_EXECUTABLE ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE } : {}),
    },
  })
  const facts = { label, init: undefined, assistantErrors: [], result: undefined, account: undefined, failure: undefined }
  try {
    const initialization = await q.initializationResult()
    facts.handshake = { account: presence(initialization?.account), keys: Object.keys(initialization ?? {}).sort() }
    try {
      const account = await q.accountInfo()
      facts.account = { organization: presence(account.organization), subscriptionType: account.subscriptionType ?? 'absent', apiProvider: account.apiProvider ?? 'absent', apiKeySource: account.apiKeySource ?? 'absent', tokenSource: account.tokenSource ?? 'absent', email: presence(account.email) }
    } catch (error) {
      facts.account = { error: scrub(error?.message ?? error) }
    }
    inbox.push({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, uuid: randomUUID() })
    for await (const message of q) {
      if (message.type === 'system' && message.subtype === 'init') facts.init = { apiKeySource: message.apiKeySource, model: message.model }
      if (message.type === 'assistant' && message.error !== undefined) facts.assistantErrors.push({ error: message.error, text: scrub(message.message?.content?.map(b => b.text ?? '').join('')) })
      if (message.type === 'result') {
        facts.result = { subtype: message.subtype, is_error: message.is_error, result: scrub(message.result), errors: (message.errors ?? []).map(scrub), terminal: message.terminal_reason }
        break
      }
    }
  } catch (error) {
    facts.failure = scrub(error?.message ?? error)
  } finally {
    inbox.close()
    try { q.close() } catch {}
  }
  console.log(JSON.stringify(facts, null, 2))
  return facts
}

function storedAnthropic() {
  const file = process.env.DSH_AUTH_CREDENTIALS || path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'dsh-auth', 'credentials.json')
  try {
    const document = JSON.parse(fs.readFileSync(file, 'utf8'))
    const credential = document?.providers?.anthropic
    return credential?.type === 'oauth' && typeof credential.access === 'string' ? credential : undefined
  } catch {
    return undefined
  }
}

const stored = storedAnthropic()
if (stored === undefined) {
  console.log('dsh-auth: no stored `anthropic` credential — P-AUTH-1 acceptance needs a maintainer login (skipped)')
} else {
  console.log(`dsh-auth: stored anthropic credential found (expired: ${stored.expires <= Date.now()})`)
  await turn('dsh-auth', { env: childEnv({ CLAUDE_CODE_OAUTH_TOKEN: stored.access }, ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']), sessionId: randomUUID(), prompt: 'Reply with exactly: auth-ok' })
}

const sessionId = randomUUID()
const rejected = await turn('rejected', {
  env: childEnv({ CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${'x'.repeat(40)}` }, ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']),
  sessionId,
  prompt: 'Reply with exactly: should-not-run',
})
// PROBE_SKIP_RESUME=1 skips the (billed) resume half.
if (process.env.PROBE_SKIP_RESUME !== '1') {
  await turn('resume-after-rejection', { env: childEnv(), resume: sessionId, prompt: 'Reply with exactly: resumed-ok' })
}
void rejected
process.exit(0)
