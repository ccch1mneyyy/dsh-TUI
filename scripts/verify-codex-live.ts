/**
 * Codex backend against a real `codex app-server` (docs/codex-backend-design.md
 * §10.6) — the C1 live smoke: a text turn, a command approval, a file change,
 * through the backend's own executable resolution, hub, session, translator
 * and approval bridge. Spends real tokens, so it is not in CI and runs only
 * with DSH_TUI_CODEX_LIVE=1.
 *
 * Cost and credential rules (scripts/lib/codex-cheap-only.mjs): a throwaway
 * CODEX_HOME pinned to gpt-5.6-terra at effort low (never ~/.codex), the
 * relay provider passed as `-c` arguments from CODEX_TEST_BASE_URL /
 * CODEX_TEST_API_KEY (sourced in the same shell, never printed or written),
 * every model-bearing request checked before it is sent. Three turns.
 *
 * The relay provider is the one thing `codexBackend.open` cannot take until
 * channels exist (C2), so the hub is built here with the same settings the
 * backend builds plus those arguments; everything after it is the backend's
 * own code.
 *
 * Run (one shell):
 *   set -a; . <relay env file>; set +a
 *   DSH_TUI_CODEX_LIVE=1 CODEX_EXECUTABLE=<codex 0.160.x> node --import tsx/esm scripts/verify-codex-live.ts
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

if (process.env.DSH_TUI_CODEX_LIVE !== '1') {
  console.log('verify-codex-live: skipped (set DSH_TUI_CODEX_LIVE=1 to spend real tokens)')
  process.exit(0)
}
process.env.DSH_TUI_LANG = 'en'
const { assertCheapRequest, liveCodexHome, pinCheapOrExit } = await import('./lib/codex-cheap-only.mjs')
const { model } = pinCheapOrExit('verify-codex-live', join(homedir(), '.dsh-tui'))
const live = liveCodexHome({ model })
// The backend reads CODEX_HOME from the environment, as for a user.
process.env.CODEX_HOME = live.home
delete process.env.OPENAI_API_KEY
delete process.env.CODEX_API_KEY

const { codexBackend } = await import('../src/backends/codex/index.js')
const { memoryCodexPrefs } = await import('../src/backends/codex/prefs.js')
const { buildCodexEnv, resolveCodexExecutable } = await import('../src/backends/codex/rpc/binary.js')
const { acquireCodexHub, closeAllCodexHubs } = await import('../src/backends/codex/rpc/hub.js')
const { openCodexSession } = await import('../src/backends/codex/session/session.js')
const { createProjectorHarness } = await import('./lib/projector-harness.js')
import type { AgentEvent } from '../src/agent/events.js'
import type { CodexHub } from '../src/backends/codex/rpc/hub.js'

let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${JSON.stringify(detail).slice(0, 600)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
const SECRETS = [process.env.CODEX_TEST_BASE_URL, process.env.CODEX_TEST_API_KEY].filter((value): value is string => typeof value === 'string' && value !== '')
const safe = (text: string): string => SECRETS.reduce((out, secret) => out.split(secret).join('<relay>'), text)
const debug: string[] = []
const host = { cwd: live.cwd, debug: (line: string) => debug.push(safe(line)), warn: () => undefined }

let turnsUsed = 0
let session: Awaited<ReturnType<typeof openCodexSession>> | undefined
try {
  const detection = await codexBackend.detect(host)
  check('detect: installed, a version, credentials judged without a network call', detection.installed && typeof detection.version === 'string', detection)
  const executable = await resolveCodexExecutable()
  check('the executable honours CODEX_EXECUTABLE', executable?.source === 'env', executable)
  const hub = acquireCodexHub({ executable: executable!.path, args: ['app-server', ...live.appServerArgs], env: buildCodexEnv(), cwd: live.cwd }, {
    debug: line => debug.push(safe(line)),
    stderr: line => debug.push(`[stderr] ${safe(line)}`),
    clientVersion: 'live-test',
  })
  await hub.ready
  check('handshake: the server answers with the throwaway home', hub.info?.codexHome === live.home)
  // Every request is checked against the cost rule before it is sent.
  const guarded = new Proxy(hub, {
    get(target, prop, receiver) {
      if (prop === 'call') {
        return (method: string, params?: unknown, options?: unknown) => {
          assertCheapRequest('verify-codex-live', method, (params ?? {}) as Record<string, unknown>)
          if (method === 'turn/start') turnsUsed += 1
          return target.call(method, params, options as never)
        }
      }
      return Reflect.get(target, prop, receiver) as unknown
    },
  }) as CodexHub
  session = await openCodexSession({
    hub: guarded,
    release: hub.retain(),
    target: { kind: 'create', cwd: live.cwd },
    cwd: live.cwd,
    prefs: memoryCodexPrefs(),
    executable: executable!,
    host: { debug: line => debug.push(safe(line)) },
  })
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
  await guarded.call('thread/settings/update', { threadId: session.ref.sessionId, approvalPolicy: 'untrusted' })
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
  await closeAllCodexHubs()
  live.cleanup()
}
console.log(`\nverify-codex-live ${process.exitCode === 1 ? 'FAILED' : 'OK'} (${passed} checks, ${turnsUsed} turns)`)
