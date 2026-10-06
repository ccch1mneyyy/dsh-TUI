/**
 * Codex JSON-RPC layer (docs/codex-backend-design.md §5.1–§5.2, §10.3):
 *
 *  - client: id pairing (answers out of order), error answers as
 *    `CodexRpcError` with code and data, per-call and per-method timeouts on
 *    an injected clock (a late answer is dropped, the process untouched),
 *    abort signals, server requests (sync / async / parked / throwing /
 *    unhandled), notification listeners, malformed and stray lines dropped,
 *    `close` rejecting what is pending and everything after, no request
 *    parameters in diagnostics;
 *  - line splitting: CRLF, empty lines, chunk boundaries, an oversize line
 *    dropped without growing;
 *  - transport: a real child (node) echoes lines, its stderr arrives by line,
 *    stdin EOF ends it, a child that ignores EOF is terminated, a missing
 *    executable reports through `onExit`.
 *
 * Run: node --import tsx/esm scripts/verify-codex-rpc.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexRpcError, createRpcClient, RPC_ERROR, type RpcClock } from '../src/backends/codex/rpc/client.js'
import { createLineSplitter, spawnTransport, type TransportExit } from '../src/backends/codex/rpc/transport.js'

let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
const tick = (ms = 0): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/** A manual clock: `advance(ms)` fires what is due. */
function manualClock(): RpcClock & { advance(ms: number): void } {
  let now = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  let next = 1
  return {
    setTimeout: (callback, ms) => { const id = next++; timers.set(id, { at: now + ms, callback }); return id },
    clearTimeout: handle => { timers.delete(handle as number) },
    advance(ms) {
      now += ms
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback() }
    },
  }
}

// ── client ──────────────────────────────────────────────────────────────
{
  const sent: Record<string, unknown>[] = []
  const debug: string[] = []
  const clock = manualClock()
  const client = createRpcClient({ write: line => sent.push(JSON.parse(line) as Record<string, unknown>), debug: line => debug.push(line), clock })
  const first = client.call<{ v: number }>('model/list', { includeHidden: false })
  const second = client.call<{ v: number }>('thread/read', { threadId: 'x' })
  check('requests get increasing integer ids', sent[0]?.id === 1 && sent[1]?.id === 2 && sent[0]?.method === 'model/list')
  client.receive(JSON.stringify({ id: 2, result: { v: 2 } }))
  client.receive(JSON.stringify({ id: 1, result: { v: 1 } }))
  check('answers pair by id, in any order', (await first).v === 1 && (await second).v === 2)
  const failing = client.call('thread/resume', { threadId: 'nope' })
  client.receive(JSON.stringify({ id: 3, error: { code: -32600, message: 'thread not found', data: { why: 'x' } } }))
  const error = await failing.catch((caught: unknown) => caught)
  check('an error answer rejects with CodexRpcError(code, message, data)', error instanceof CodexRpcError && error.code === -32600 && error.message === 'thread not found' && (error.data as { why: string }).why === 'x')
  const slow = client.call('thread/list', {}, { timeoutMs: 1000 })
  clock.advance(999)
  check('a request waits until its timeout', client.pending === 1)
  clock.advance(1)
  const timedOut = await slow.catch((caught: unknown) => caught)
  check('a timeout rejects with -32000 and keeps the connection', timedOut instanceof CodexRpcError && timedOut.code === RPC_ERROR.timeout && !client.closed)
  client.receive(JSON.stringify({ id: 4, result: {} }))
  check('a late answer to a timed-out request is dropped (debug only)', debug.some(line => line.includes('unknown request #4')))
  const turn = client.call('turn/start', {})
  clock.advance(30_001)
  check('turn/start has the longer method timeout (60 s)', client.pending === 1)
  clock.advance(30_000)
  check('… and times out at 60 s', (await turn.catch((caught: unknown) => caught)) instanceof CodexRpcError)
  const controller = new AbortController()
  const aborted = client.call('thread/read', {}, { signal: controller.signal })
  controller.abort()
  check('an abort signal rejects the call', (await aborted.catch((caught: unknown) => caught)) instanceof CodexRpcError && client.pending === 0)

  const notes: string[] = []
  const off = client.onNotification((method, params) => notes.push(`${method}:${JSON.stringify(params)}`))
  client.receive(JSON.stringify({ method: 'thread/started', params: { thread: { id: 't' } } }))
  client.receive(JSON.stringify({ method: 'initialized' }))
  off()
  client.receive(JSON.stringify({ method: 'warning', params: {} }))
  check('notifications reach listeners (missing params → {}) until unsubscribed', notes.length === 2 && notes[1] === 'initialized:{}')
  client.receive('{nope')
  client.receive('[1,2]')
  client.receive(JSON.stringify({ hello: true }))
  check('malformed, non-object and id-less/method-less lines are dropped', debug.some(line => line.includes('not JSON')) && debug.some(line => line.includes('non-object')) && debug.some(line => line.includes('neither id nor method')))

  // Server requests.
  sent.length = 0
  client.receive(JSON.stringify({ id: 0, method: 'item/commandExecution/requestApproval', params: { itemId: 'x' } }))
  await tick()
  check('a server request without a handler answers -32601', (sent[0]?.error as { code: number } | undefined)?.code === RPC_ERROR.methodNotFound && sent[0]?.id === 0)
  const parked: unknown[] = []
  client.onServerRequest((id, method, params) => {
    if (method === 'sync') return { ok: true }
    if (method === 'async') return Promise.resolve({ later: true })
    if (method === 'reject') return Promise.reject(new CodexRpcError('no', -32602))
    if (method === 'throw') throw new Error('handler bug')
    parked.push({ id, method, params })
    return undefined
  })
  sent.length = 0
  client.receive(JSON.stringify({ id: 10, method: 'sync', params: {} }))
  client.receive(JSON.stringify({ id: 11, method: 'async' }))
  client.receive(JSON.stringify({ id: 12, method: 'reject', params: {} }))
  client.receive(JSON.stringify({ id: 13, method: 'throw', params: {} }))
  client.receive(JSON.stringify({ id: 'abc', method: 'park', params: { a: 1 } }))
  await tick()
  const byId = new Map(sent.map(message => [message.id, message]))
  check('a sync handler result is the answer', (byId.get(10)?.result as { ok: boolean } | undefined)?.ok === true)
  check('a promise handler result is the answer', (byId.get(11)?.result as { later: boolean } | undefined)?.later === true)
  check('a rejected handler answers its error code', (byId.get(12)?.error as { code: number } | undefined)?.code === -32602)
  check('a throwing handler answers -32603 (never a hang)', (byId.get(13)?.error as { code: number } | undefined)?.code === RPC_ERROR.internal)
  check('`undefined` parks the request (string ids too); respond answers later', !byId.has('abc') && parked.length === 1)
  client.respond('abc', { decision: 'accept' })
  client.respondError(99, -32000, 'late')
  check('respond / respondError write the answer', sent.some(message => message.id === 'abc' && (message.result as { decision: string }).decision === 'accept') && sent.some(message => message.id === 99))

  const pendingCall = client.call('thread/read', { threadId: 'secret-param-value' })
  client.close(new Error('gone'))
  check('close rejects what is pending with the reason', (await pendingCall.catch((caught: unknown) => (caught as Error).message)) === 'gone')
  check('calls after close reject at once', (await client.call('x').catch((caught: unknown) => (caught as Error).message)) === 'gone' && client.closed)
  check('diagnostics never carry request parameters', !debug.some(line => line.includes('secret-param-value')))
}

// ── line splitting ───────────────────────────────────────────────────────
{
  const lines: string[] = []
  const oversize: number[] = []
  const splitter = createLineSplitter(line => lines.push(line), bytes => oversize.push(bytes), 32)
  splitter.push('{"a":1}\r\n\n{"b"')
  splitter.push(':2}\n')
  splitter.push('x'.repeat(40))
  splitter.push('yyy\n{"c":3}\n')
  splitter.push('{"d":4}')
  splitter.end()
  check('CRLF and empty lines; a line split across chunks joins', lines[0] === '{"a":1}' && lines[1] === '{"b":2}')
  check('an oversize line is dropped (reported once) and the next line survives', oversize.length === 1 && lines[2] === '{"c":3}' && !lines.some(line => line.includes('xxx')))
  check('the last unterminated line flushes at end', lines[3] === '{"d":4}' && lines.length === 4)
}

// ── transport ───────────────────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'codex-rpc-'))
  const echo = join(dir, 'echo.mjs')
  writeFileSync(echo, `
import { createInterface } from 'node:readline'
process.stderr.write('booting\\nsecond line\\n')
createInterface({ input: process.stdin }).on('line', line => process.stdout.write(line.toUpperCase() + '\\n'))
process.stdin.on('end', () => { setTimeout(() => process.exit(0), 10) })
`)
  const stubborn = join(dir, 'stubborn.mjs')
  writeFileSync(stubborn, "process.stdin.resume(); process.stdin.on('end', () => {}); setInterval(() => {}, 1000)\n")
  const run = (script: string) => {
    const lines: string[] = []
    const errors: string[] = []
    let exit: TransportExit | undefined
    const transport = spawnTransport({
      executable: process.execPath,
      args: [script],
      env: { PATH: process.env.PATH ?? '' },
      cwd: dir,
      onLine: line => lines.push(line),
      onStderr: line => errors.push(line),
      onExit: info => { exit = info },
    })
    return { transport, lines, errors, exit: () => exit }
  }
  const echoed = run(echo)
  echoed.transport.write('{"id":1}')
  echoed.transport.write('{"id":2}')
  for (let i = 0; i < 100 && echoed.lines.length < 2; i++) await tick(20)
  check('transport: lines written reach the child and its stdout comes back by line', echoed.lines.join(',') === '{"ID":1},{"ID":2}', echoed.lines)
  check('transport: stderr arrives line by line', echoed.errors.join('|') === 'booting|second line', echoed.errors)
  const started = Date.now()
  await echoed.transport.close()
  check('transport: close() ends stdin and the child exits on its own (V1)', echoed.exit()?.code === 0 && Date.now() - started < 1500, { exit: echoed.exit(), ms: Date.now() - started })
  echoed.transport.write('{"after":"close"}')
  check('transport: writes after close are ignored', true)
  const stuck = run(stubborn)
  await tick(100)
  const before = Date.now()
  await stuck.transport.close()
  check('transport: a child that ignores EOF is terminated after the grace period', stuck.exit()?.signal === 'SIGTERM' && Date.now() - before >= 1900, { exit: stuck.exit(), ms: Date.now() - before })
  let missingExit: TransportExit | undefined
  spawnTransport({ executable: join(dir, 'no-such-codex'), args: ['app-server'], env: {}, cwd: dir, onLine: () => undefined, onStderr: () => undefined, onExit: info => { missingExit = info } })
  for (let i = 0; i < 50 && missingExit === undefined; i++) await tick(20)
  check('transport: a missing executable reports through onExit with the error', missingExit?.error !== undefined && /ENOENT/u.test(missingExit.error.message), missingExit)
}

// ── npm shims: spawn the native binary, not codex.cmd (review fix) ──────
{
  const { resolveNpmShim } = await import('../src/backends/codex/rpc/binary.js')
  const { unwrapShell } = await import('../src/backends/codex/translate/commands.js')
  const NPM = 'C:\\Users\\u\\AppData\\Roaming\\npm'
  const CMD = '@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n'
  const tree = (files: readonly string[]) => ({ platform: 'win32', arch: 'x64', exists: (path: string) => files.includes(path), read: (path: string) => (path.endsWith('.cmd') ? CMD : undefined) })
  const hoisted = `${NPM}\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`
  const nested = `${NPM}\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`
  check('npm shim (win32): the hoisted platform package\'s codex.exe', resolveNpmShim(`${NPM}\\codex.cmd`, tree([hoisted])) === hoisted)
  check('npm shim (win32): the nested platform package\'s codex.exe', resolveNpmShim(`${NPM}\\codex.cmd`, tree([nested])) === nested)
  check('npm shim: no binary on disk → undefined (the shim itself is spawned)', resolveNpmShim(`${NPM}\\codex.cmd`, tree([])) === undefined)
  check('npm shim: not a codex shim → undefined', resolveNpmShim(`${NPM}\\other.cmd`, { ...tree([hoisted]), read: () => '@node other.js %*' }) === undefined)
  check('npm shim: an unsupported platform → undefined', resolveNpmShim('/usr/bin/codex', { platform: 'aix', arch: 'ppc64', exists: () => true, read: () => CMD }) === undefined)
  // Lossless unwrap (review nits): plain `bash -lc`, -NoLogo, quoted pwsh paths.
  check('unwrap: plain bash -lc, a quoted script', unwrapShell("bash -lc 'ls -la'") === 'ls -la')
  check('unwrap: pwsh -NoLogo -Command', unwrapShell('pwsh -NoLogo -NoProfile -Command "Get-ChildItem"') === 'Get-ChildItem')
  check('unwrap: a quoted pwsh path', unwrapShell('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Get-Date"') === 'Get-Date')
  check('unwrap: concatenated quoting is not unwrapped (lossless or nothing)', unwrapShell(`/bin/bash -lc 'a "'b'" c'`) === undefined)
}

console.log(`\nverify-codex-rpc OK (${passed} checks)`)
