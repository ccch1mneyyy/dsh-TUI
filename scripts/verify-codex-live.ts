/**
 * Real Codex smoke through production codexBackend.open (C2 §10.6).
 * DSH_TUI_CODEX_LIVE=1 explicitly opts into three paid turns. Missing
 * CODEX_TEST_BASE_URL/CODEX_TEST_API_KEY is a skip, never a passing live run.
 *
 * HOME/USERPROFILE and CODEX_HOME are isolated before runtime imports.
 * Temporary prefs/config pin terra (fallback sol) + low. The external-process
 * boundary adds the existing guard's relay argv, never persisting URL/key.
 * Every JSON-RPC request is checked at the real child's stdin boundary.
 *
 * Run: DSH_TUI_CODEX_LIVE=1 CODEX_EXECUTABLE=<codex 0.160.x>
 *      node --import tsx/esm scripts/verify-codex-live.ts
 */
import assert from 'node:assert/strict'
import childProcess, { type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { AgentEvent } from '../src/agent/events.js'
import type { AgentSession } from '../src/agent/session.js'
import type { CodexRuntime } from '../src/backends/codex/backend.js'

if (process.env.DSH_TUI_CODEX_LIVE !== '1') {
  console.log('verify-codex-live: skipped (set DSH_TUI_CODEX_LIVE=1 to spend real tokens)')
  process.exit(0)
}
if (!process.env.CODEX_TEST_BASE_URL || !process.env.CODEX_TEST_API_KEY) {
  console.log('verify-codex-live: skipped (CODEX_TEST_BASE_URL / CODEX_TEST_API_KEY are not set)')
  process.exit(0)
}
const { assertCheap, assertCheapRequest, liveCodexHome, pinCheapOrExit } = await import('./lib/codex-cheap-only.mjs')
try { assertCheap('verify-codex-live', { model: process.env.CODEX_TEST_MODEL, effort: process.env.CODEX_TEST_EFFORT }) }
catch { console.error('verify-codex-live: refusing non-cheap model/effort; use gpt-5.6-terra (fallback gpt-6-sol) + low'); process.exit(2) }

const isolatedHome = mkdtempSync(join(tmpdir(), 'codex-live-tui-home-'))
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME }
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
process.env.DSH_TUI_LANG = 'en'
const { model } = pinCheapOrExit('verify-codex-live', join(isolatedHome, '.dsh-tui'))
const live = liveCodexHome({ model })
process.env.CODEX_HOME = live.home
// Only these ambient credentials are removed; all unrelated child env survives.
delete process.env.OPENAI_API_KEY
delete process.env.CODEX_API_KEY

const runtimeRoot = process.env.CODEX_TEST_SOURCE_ROOT ?? fileURLToPath(new URL('../', import.meta.url))
const fromSource = (path: string) => import(pathToFileURL(resolve(runtimeRoot, 'src', path)).href)
const SECRETS = [process.env.CODEX_TEST_BASE_URL, process.env.CODEX_TEST_API_KEY].filter((value): value is string => typeof value === 'string' && value !== '')
const safe = (text: string): string => SECRETS.reduce((out, secret) => out.split(secret).join('<relay>'), text)
const debug: string[] = []
let turnsUsed = 0
let guardedServers = 0
let guardFailure: Error | undefined
const originalSpawn = childProcess.spawn
// Test-only instrumentation of the external process boundary, not a second
// backend assembly. syncBuiltinESMExports keeps transport's named import live.
childProcess.spawn = ((...args: Parameters<typeof originalSpawn>) => {
  if (guardFailure !== undefined) throw guardFailure
  const server = Array.isArray(args[1]) && args[1].includes('app-server')
  const launchArgs = server ? [args[0], [...args[1] as readonly string[], ...live.appServerArgs], args[2]] : args
  const child = Reflect.apply(originalSpawn, childProcess, launchArgs) as ChildProcess
  if (!server) return child
  const stdin = child.stdin
  if (stdin === null) throw new Error('verify-codex-live: app-server has no stdio input')
  guardedServers += 1
  const originalWrite = stdin.write
  stdin.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    try {
      const line = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : undefined
      if (line === undefined) throw new Error('verify-codex-live: unexpected RPC write type')
      const request = JSON.parse(line) as Record<string, unknown>
      if (typeof request.method === 'string') {
        const params = typeof request.params === 'object' && request.params !== null ? request.params as Record<string, unknown> : {}
        assertCheapRequest('verify-codex-live', request.method, params)
        if (request.method === 'turn/start') {
          if (turnsUsed >= 3) throw new Error('verify-codex-live: three-turn budget exhausted')
          turnsUsed += 1
        }
      }
    } catch (error) {
      guardFailure = new Error(safe(error instanceof Error ? error.message : String(error)))
      child.kill()
      throw guardFailure
    }
    return Reflect.apply(originalWrite, stdin, [chunk, ...rest]) as boolean
  }) as typeof stdin.write
  return child
}) as typeof originalSpawn
syncBuiltinESMExports()

let session: AgentSession | undefined
let runtime: CodexRuntime | undefined
let closeAll: (() => Promise<void>) | undefined
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${JSON.stringify(detail).slice(0, 600)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
try {
  // No backend module may cache personal DATA_DIR before isolation above.
  const { DATA_DIR } = await fromSource('utils/paths.js') as typeof import('../src/utils/paths.js')
  assert.equal(DATA_DIR, join(isolatedHome, '.dsh-tui'))
  const { codexBackend, prepareCodexRuntime } = await fromSource('backends/codex/backend.js') as typeof import('../src/backends/codex/backend.js')
  const { fileCodexPrefs } = await fromSource('backends/codex/prefs.js') as typeof import('../src/backends/codex/prefs.js')
  const { resolveCodexExecutable } = await fromSource('backends/codex/rpc/binary.js') as typeof import('../src/backends/codex/rpc/binary.js')
  const { closeAllCodexHubs } = await fromSource('backends/codex/rpc/hub.js') as typeof import('../src/backends/codex/rpc/hub.js')
  closeAll = closeAllCodexHubs
  const { createProjectorHarness } = await import('./lib/projector-harness.js')
  fileCodexPrefs().write({ model, effort: 'low', mode: 'auto' })
  const host = { cwd: live.cwd, debug: (line: string) => debug.push(safe(line)), warn: () => undefined, stderr: (line: string) => debug.push('[stderr] ' + safe(line)) }
  const detection = await codexBackend.detect(host)
  check('detect: installed, a version, credentials judged without a network call', detection.installed && typeof detection.version === 'string', detection)
  const executable = await resolveCodexExecutable()
  check('the executable honours CODEX_EXECUTABLE', executable?.source === 'env', executable)
  session = await codexBackend.open({ kind: 'create', cwd: live.cwd }, host)
  // Borrow the already-open production runtime only for smoke control calls.
  runtime = await prepareCodexRuntime({ kind: 'create', cwd: live.cwd }, host)
  check('handshake: formal backend uses isolated home and one guarded process', runtime.hub.info?.codexHome === live.home && guardedServers === 1)
  check('provider: formal runtime sees the guarded external relay override', runtime.config?.model_provider === 'relay' && !runtime.auth.route.firstParty)
  const events: AgentEvent[] = []
  const projector = createProjectorHarness({ model: '' })
  session.subscribe(batch => {
    events.push(...batch)
    projector.apply(batch)
    for (const event of batch) {
      if (event.type === 'permission.request') {
        // The smoke approves what it is asked (the decision mapping is pinned offline).
        session!.capabilities.permissions!.respond(event.request.requestId, { kind: 'allow-once' })
        console.log(`  approved ${event.request.toolName}: ${safe(event.request.command ?? event.request.displayName ?? '')} [${event.request.options.map(option => option.label ?? option.kind).join(' | ')}]`)
      }
    }
  })
  const turnEnds = (): number => events.filter(event => event.type === 'turn.end').length
  const waitTurn = async (count: number): Promise<void> => {
    for (let i = 0; i < 1800 && turnEnds() < count; i++) await new Promise(resolve => setTimeout(resolve, 100))
    if (turnEnds() < count) throw new Error(`no turn.end ${count} within 180 s`)
  }
  // The start-up events wait for the subscriber (delivered on the next tick).
  await new Promise(resolve => setTimeout(resolve, 0))
  check('session.ready names the thread, the model and the default mode', events.some(event => event.type === 'session.ready' && event.sessionId !== '' && event.model === model && event.permissionMode === 'auto'), events.find(event => event.type === 'session.ready'))

  // 1. text
  await session.submit({ text: 'Reply with exactly: live-ok', clientMessageId: 'live-1' }, 'followup')
  await waitTurn(1)
  check('turn 1: the echoed user row and the reply', events.some(event => event.type === 'user.message' && event.id === 'live-1') && projector.state.rows.some(row => row.kind === 'assistant' && row.text.includes('live-ok')), projector.state.rows.map(row => `${row.kind}:${row.text.slice(0, 60)}`))
  check('turn 1: completed, usage booked, context window known', events.find(event => event.type === 'turn.end')?.type === 'turn.end' && projector.state.tokens.output > 0 && (projector.state.contextWindow ?? 0) > 0)

  // 2. a command approval (every command asks under `untrusted`)
  await runtime.hub.call('thread/settings/update', { threadId: session.ref.sessionId, approvalPolicy: 'untrusted' })
  await session.submit({ text: 'Run exactly this shell command and nothing else: echo live > a.txt', clientMessageId: 'live-2' }, 'followup')
  await waitTurn(2)
  const asked = events.filter(event => event.type === 'permission.request')
  check('turn 2: the command asked for approval with the official options', asked.length >= 1 && asked[0]!.type === 'permission.request' && asked[0]!.request.options.some(option => option.label === 'Yes, proceed'), asked)
  check('turn 2: the approved command ran (card ok, file written)', projector.state.rows.some(row => row.tool?.name === 'shell' && row.tool.status === 'ok') && existsSync(join(live.cwd, 'a.txt')) && readFileSync(join(live.cwd, 'a.txt'), 'utf8').trim() === 'live')
  check('turn 2: every prompt settled', events.filter(event => event.type === 'permission.settled').length === asked.length)

  // 3. a file change
  await session.submit({ text: 'Use apply_patch to create b.txt containing the single line: hi. Do nothing else and reply done.', clientMessageId: 'live-3' }, 'followup')
  await waitTurn(3)
  const patch = projector.state.rows.find(row => row.tool?.name === 'apply_patch')
  check('turn 3: a diff card for the new file, applied', patch?.tool?.status === 'ok' && patch.tool.callView?.card === 'diff' && existsSync(join(live.cwd, 'b.txt')), patch?.tool)
  const doctor = session.capabilities.diagnostics!.lines()
  check('/doctor names the CLI, its version and the thread', doctor.some(line => line.includes('Codex CLI') && line.includes('0.16')) && doctor.some(line => line.includes(session!.ref.sessionId)), doctor)
  check(`the cost budget held (${turnsUsed} turns ≤ 3)`, turnsUsed <= 3)
  console.log('\nrows:')
  for (const row of projector.state.rows) console.log(`  ${row.kind}${row.tool === undefined ? '' : `[${row.tool.name}:${row.tool.status}]`} ${safe(row.text.slice(0, 80))}`)
} catch (error) {
  console.error(safe(error instanceof Error ? error.stack ?? error.message : String(error)))
  console.error(debug.slice(-30).join('\n'))
  process.exitCode = 1
} finally {
  await session?.dispose().catch(() => undefined)
  runtime?.release()
  await closeAll?.()
  childProcess.spawn = originalSpawn
  syncBuiltinESMExports()
  live.cleanup()
  rmSync(isolatedHome, { recursive: true, force: true })
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}
console.log(`\nverify-codex-live ${process.exitCode === 1 ? 'FAILED' : 'OK'} (${passed} checks, ${turnsUsed} turns)`)
