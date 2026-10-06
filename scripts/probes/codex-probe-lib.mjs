// Maintainer probe library, not a regression test and not part of CI.
//
// A tiny `codex app-server` client for the Codex probes
// (docs/codex-backend-design.md §10.6, §12.1), moved from the research
// workspace. Every run goes through scripts/lib/codex-cheap-only.mjs:
// a throwaway CODEX_HOME (never ~/.codex), the relay provider through `-c`
// arguments, the cheap model at effort `low`, and every model-bearing
// request checked before it is written.
//
// Recording: `connect({ scenario })` writes every wire line to
// `$CODEX_PROBE_RECORD_DIR/<scenario>.raw.jsonl` (default: a directory under
// the OS temp dir, never the repo). Raw recordings hold real ids and paths:
// commit only what `node scripts/lib/codex-fixture-sanitize.mjs --write`
// produced from them.
//
// Executable: CODEX_EXECUTABLE, else `codex` on PATH.
// Credentials: source the relay env file in the same command (it sets
// CODEX_TEST_BASE_URL / CODEX_TEST_API_KEY); never print them.
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { assertCheapRequest } from '../lib/codex-cheap-only.mjs'

export { liveCodexHome, pinCheapOrExit, LIVE_MODELS, LIVE_EFFORT } from '../lib/codex-cheap-only.mjs'

export const CODEX = process.env.CODEX_EXECUTABLE || 'codex'
const RECORD_DIR = process.env.CODEX_PROBE_RECORD_DIR || join(tmpdir(), 'codex-probe-recordings')

/** Values a recording must never hold: the relay URL / host and the key. */
const RELAY_SECRETS = (() => {
  const values = [process.env.CODEX_TEST_BASE_URL, process.env.CODEX_TEST_API_KEY].filter(value => typeof value === 'string' && value !== '')
  try {
    values.push(new URL(process.env.CODEX_TEST_BASE_URL).host)
  } catch {
    // No (or no parsable) base URL: nothing more to hide.
  }
  return values
})()

const scrub = (text, home, cwd) => {
  let out = text.replaceAll(home, '/TMP/home').replaceAll(cwd, '/TMP/cwd').replace(/sk-[A-Za-z0-9_-]{8,}/gu, 'sk-***')
  for (const secret of RELAY_SECRETS) out = out.split(secret).join(secret.includes('://') ? 'https://relay.invalid/v1' : 'relay.invalid')
  return out
}

/**
 * Start `codex app-server` on a probe home. `args` are extra app-server
 * arguments (the relay provider overrides from `liveCodexHome`).
 */
export async function connect({ home, cwd, args = [], scenario, onServerRequest, env: extraEnv = {}, initialize = true, clientName = 'dsh-tui-probe' }) {
  let fixture
  if (scenario) {
    mkdirSync(RECORD_DIR, { recursive: true })
    fixture = join(RECORD_DIR, `${scenario}.raw.jsonl`)
    writeFileSync(fixture, '')
  }
  const env = { ...process.env, CODEX_HOME: home, ...extraEnv }
  delete env.OPENAI_API_KEY
  delete env.CODEX_API_KEY
  const t0 = performance.now()
  const child = spawn(CODEX, ['app-server', ...args], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  const log = (dir, line) => {
    if (fixture === undefined) return
    try {
      appendFileSync(fixture, JSON.stringify({ t: Math.round(performance.now() - t0), dir, msg: JSON.parse(scrub(line, home, cwd)) }) + '\n')
    } catch {
      // A non-JSON line is not recorded.
    }
  }
  const pending = new Map()
  const listeners = new Set()
  const events = []
  let nextId = 1
  const write = message => {
    if (message.method !== undefined) assertCheapRequest('probe', message.method, message.params ?? {})
    const line = JSON.stringify(message)
    log('out', line)
    child.stdin.write(line + '\n')
  }
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, at: Math.round(performance.now() - t0) })))
  createInterface({ input: child.stdout }).on('line', line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    log('in', line)
    if (message.id !== undefined && message.method === undefined) {
      pending.get(message.id)?.(message)
      pending.delete(message.id)
      return
    }
    const event = { at: Math.round(performance.now() - t0), ...message }
    events.push(event)
    for (const listener of listeners) listener(event)
    if (message.id !== undefined && onServerRequest !== undefined) {
      Promise.resolve(onServerRequest(message, api)).then(result => { if (result !== undefined) write({ id: message.id, result }) })
    }
  })
  const call = (method, params) => new Promise(resolve => {
    const id = nextId++
    pending.set(id, resolve)
    write({ id, method, params })
  })
  const until = (predicate, ms = 90000) => new Promise(resolve => {
    const hit = events.find(predicate)
    if (hit) { resolve(hit); return }
    const listener = event => {
      if (!predicate(event)) return
      listeners.delete(listener)
      clearTimeout(timer)
      resolve(event)
    }
    const timer = setTimeout(() => { listeners.delete(listener); resolve(undefined) }, ms)
    listeners.add(listener)
  })
  const api = {
    call,
    write,
    until,
    events,
    child,
    exit,
    get stderr() { return stderr },
    respond: (id, result) => write({ id, result }),
    respondError: (id, code, message) => write({ id, error: { code, message } }),
    close: async () => {
      child.kill('SIGTERM')
      await exit
      return stderr
    },
  }
  if (initialize) {
    api.initializeResult = await call('initialize', { clientInfo: { name: clientName, title: 'dsh-TUI probe', version: '0.0.0' }, capabilities: { experimentalApi: true, requestAttestation: false } })
    write({ method: 'initialized' })
  }
  return api
}

/** Compact one-line tags for a run's notifications/requests. */
export function summarize(events, from = 0) {
  const out = []
  for (const event of events.slice(from)) {
    const params = event.params ?? {}
    let tag = (event.id !== undefined ? 'REQ ' : '') + event.method
    const item = params.item
    if (item?.type) tag += `{${item.type}${item.phase ? ':' + item.phase : ''}${item.status ? ' ' + JSON.stringify(item.status) : ''}}`
    if (event.method === 'turn/completed') tag += `{${params.turn?.status}${params.turn?.error ? ' err=' + String(params.turn.error.message).slice(0, 100) : ''}}`
    if (event.method === 'error') tag += ` willRetry=${params.willRetry} ${String(params.error?.message).slice(0, 100)}`
    const last = out[out.length - 1]
    const key = tag.replace(/\{.*$/u, '')
    if (last && last.key === key && /delta|outputDelta/iu.test(key)) { last.n++; continue }
    out.push({ at: event.at, tag, key, n: 1 })
  }
  return out.map(entry => `${String(entry.at).padStart(6)} ${entry.tag}${entry.n > 1 ? ` ×${entry.n}` : ''}`).join('\n')
}

export const text = value => [{ type: 'text', text: value, text_elements: [] }]

/** Bounded JSON for console output (long strings cut). */
export const brief = (value, limit = 600) =>
  String(JSON.stringify(value, (key, item) => (typeof item === 'string' && item.length > 80 ? item.slice(0, 80) + '…' : item))).slice(0, limit)

export const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })
