// Maintainer probe — NOT a regression test, NOT part of CI. OFFLINE as far as
// billing goes: no real credential is ever used.
//
// Proves the route pin of an injected subscription token (Phase 4b review 1,
// docs/agent-backend-design.md §4.12): a global config file the gate might
// not read (`<CLAUDE_CONFIG_DIR>/.config.json`, which the CLI prefers over
// `.claude.json`) sets `ANTHROPIC_BASE_URL` to a local HTTP listener; the CLI
// is started with a SENTINEL `CLAUDE_CODE_OAUTH_TOKEN` (not a token at all)
// and one prompt.
//
//  - control (no pin): the listener is expected to receive the sentinel —
//    the leak path exists;
//  - pinned (the SDK `settings` option, the flag-settings layer, setting
//    `ANTHROPIC_BASE_URL` to https://api.anthropic.com and blanking the
//    other routing variables, as auth.ts does): the listener must receive
//    NOTHING carrying the sentinel; the request goes to api.anthropic.com
//    and is refused (401), which costs nothing.
//
// The same two cases run with the base URL in `.claude.json` too.
// HOME and CLAUDE_CONFIG_DIR are fresh temp directories (no login, no
// settings of the maintainer's are read); the child environment is built
// from scratch (PATH only from the parent). Prints counts, never headers.
// Prerequisites: SDK 0.3.287 resolvable, a local `claude` CLI
// (CLAUDE_CODE_EXECUTABLE, else the SDK's bundled one).
// Usage: node scripts/probes/claude-auth-pin-probe.mjs
// Exit: 0 = control leaked and pinned did not (the pin holds); 1 = the pin
// leaked; 3 = inconclusive (the control did not reach the listener).
import { query } from '@anthropic-ai/claude-agent-sdk'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

// Maintainer cost rule (2026-10-02): every real-CLI run uses haiku only.
for (const name of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) {
  const value = process.env[name]
  if (value !== undefined && value !== '' && !/haiku/iu.test(value)) {
    console.error(`refusing to run: ${name}=${value} — real-CLI runs use haiku only`)
    process.exit(2)
  }
}

const SENTINEL = 'dsh-tui-pin-probe-sentinel-not-a-token'
const FIRST_PARTY = 'https://api.anthropic.com'
/** The pin auth.ts adds whenever it injects the subscription token. */
const PIN = {
  env: {
    ANTHROPIC_BASE_URL: FIRST_PARTY,
    CLAUDE_CODE_API_BASE_URL: '', ANTHROPIC_UNIX_SOCKET: '', CLAUDE_CODE_CUSTOM_OAUTH_URL: '', CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR: '',
    CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: '', CLAUDE_CODE_USE_ANTHROPIC_AWS: '',
    CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '', CLAUDE_CODE_USE_MANTLE: '', CLAUDE_CODE_USE_GATEWAY: '',
  },
}

/** A listener that records whether a request carried the sentinel. */
async function listener() {
  const hits = []
  const server = http.createServer((request, response) => {
    const carried = Object.values(request.headers).some(value => String(value).includes(SENTINEL))
    hits.push({ path: request.url, carried })
    request.resume()
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'pin probe listener' } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise(resolve => server.close(resolve)) }
}

class Inbox {
  constructor() { this.q = []; this.w = []; this.closed = false }
  push(v) { const w = this.w.shift(); if (w) w({ value: v, done: false }); else this.q.push(v) }
  close() { this.closed = true; for (const w of this.w.splice(0)) w({ value: undefined, done: true }) }
  [Symbol.asyncIterator]() {
    return { next: () => this.q.length ? Promise.resolve({ value: this.q.shift(), done: false }) : this.closed ? Promise.resolve({ value: undefined, done: true }) : new Promise(r => this.w.push(r)) }
  }
}

async function run(label, { file, pinned }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tui-pin-probe-'))
  const home = path.join(root, 'home')
  const config = path.join(root, 'config')
  const cwd = path.join(root, 'project')
  for (const dir of [home, config, cwd]) fs.mkdirSync(dir, { recursive: true })
  const server = await listener()
  fs.writeFileSync(path.join(config, file), JSON.stringify({ env: { ANTHROPIC_BASE_URL: server.url } }))
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_OAUTH_TOKEN: SENTINEL,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'dsh-tui/pin-probe',
  }
  const inbox = new Inbox()
  const abortController = new AbortController()
  const q = query({
    prompt: inbox,
    options: {
      cwd,
      env,
      abortController,
      settingSources: ['user', 'project', 'local'],
      permissionMode: 'default',
      maxTurns: 1,
      ...(pinned ? { settings: PIN } : {}),
      ...(process.env.CLAUDE_CODE_EXECUTABLE ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE } : {}),
      stderr: () => undefined,
      model: 'haiku',
    },
  })
  inbox.push({ type: 'user', message: { role: 'user', content: 'Reply with exactly: ok' }, parent_tool_use_id: null })
  let result
  const timer = setTimeout(() => abortController.abort(), 90_000)
  try {
    for await (const message of q) {
      if (message.type === 'result') { result = message; break }
    }
  } catch (error) {
    result = { error: String(error instanceof Error ? error.message : error).slice(0, 160) }
  } finally {
    clearTimeout(timer)
    inbox.close()
    try { q.close() } catch { /* already closed */ }
  }
  await server.close()
  fs.rmSync(root, { recursive: true, force: true })
  const leaked = server.hits.filter(hit => hit.carried).length
  const outcome = {
    label,
    file,
    pinned,
    listenerRequests: server.hits.length,
    listenerRequestsCarryingSentinel: leaked,
    resultIsError: result?.is_error ?? null,
    resultText: typeof result?.result === 'string' ? result.result.replaceAll(SENTINEL, '<sentinel>').slice(0, 160) : (result?.error ?? null),
  }
  console.log(JSON.stringify(outcome))
  return outcome
}

const outcomes = []
for (const file of ['.config.json', '.claude.json']) {
  outcomes.push(await run(`control ${file}`, { file, pinned: false }))
  outcomes.push(await run(`pinned ${file}`, { file, pinned: true }))
}
const controlLeaked = outcomes.filter(item => !item.pinned).every(item => item.listenerRequestsCarryingSentinel > 0)
const pinnedLeaked = outcomes.filter(item => item.pinned).some(item => item.listenerRequestsCarryingSentinel > 0)
console.log(JSON.stringify({ controlLeaked, pinnedLeaked, verdict: pinnedLeaked ? 'PIN LEAKS' : controlLeaked ? 'PIN HOLDS' : 'INCONCLUSIVE' }))
process.exit(pinnedLeaked ? 1 : controlLeaked ? 0 : 3)
