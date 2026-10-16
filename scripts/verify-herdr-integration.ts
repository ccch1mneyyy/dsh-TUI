/**
 * Herdr lifecycle integration regression.
 *
 * Covers:
 * - Lifecycle state reporting (idle -> working -> blocked -> idle -> release)
 * - Deduplication of unchanged states
 * - [P1] Rejection isolation: throwing/rejecting run commands do not break queue or dispose
 * - [P1] Exit code confirmation: non-zero exit code leaves state unconfirmed and retries
 * - [P1] In-flight backlog folding: rapid state changes while in-flight fold into latest state
 * - Gating when Herdr env vars are missing/disabled
 * - [P2] CLI parameter contract gate: strict validation of Herdr CLI subcommands and flags
 * - [P2] Stubbed Herdr E2E lifecycle via real child processes in CI
 *
 * Run: node --import tsx/esm scripts/verify-herdr-integration.ts
 */

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachHerdrIntegration } from '../src/herdr.js'
import { execFileNoThrow } from '../src/utils/execFileNoThrow.js'

class ObservableState {
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(): void {
    for (const listener of this.listeners) listener()
  }
}

class TestChannel extends ObservableState {
  agentId = 'session-1'
  working = false
}

class TestBlockingStore extends ObservableState {
  snapshot: object | null = null

  getSnapshot = (): object | null => this.snapshot
}

// -----------------------------------------------------------------------------
// 1. Basic lifecycle & deduplication
// -----------------------------------------------------------------------------
{
  const channel = new TestChannel()
  const questions = new TestBlockingStore()
  const approvals = new TestBlockingStore()
  const calls: Array<{ file: string; args: readonly string[] }> = []

  const clock = 1_700_000_000_000
  const integration = attachHerdrIntegration({
    channel,
    questions,
    approvals,
    env: {
      HERDR_ENV: '1',
      HERDR_BIN_PATH: 'C:\\Tools\\herdr.exe',
      HERDR_PANE_ID: 'w1:p2',
    },
    now: () => clock,
    run: async (file, args) => {
      calls.push({ file, args })
      return { code: 0, stdout: '', stderr: '' }
    },
  })

  assert.ok(integration, 'Herdr environment should enable the integration')
  await integration.settled()
  const initialSequence = Number(calls[0]?.args.at(10))
  assert.ok(Number.isSafeInteger(initialSequence), 'sequence should be an integer')
  assert.ok(initialSequence >= 1_000_000_000_000, 'sequence should be seeded from the current time')
  assert.deepEqual(calls, [{
    file: 'C:\\Tools\\herdr.exe',
    args: [
      'pane', 'report-agent', 'w1:p2',
      '--source', 'custom:dsh-tui',
      '--agent', 'dsh-tui',
      '--state', 'idle',
      '--seq', String(initialSequence),
    ],
  }])

  channel.working = true
  channel.emit()
  await integration.settled()
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1]?.args, [
    'pane', 'report-agent', 'w1:p2',
    '--source', 'custom:dsh-tui',
    '--agent', 'dsh-tui',
    '--state', 'working',
    '--seq', String(initialSequence + 1),
  ])

  questions.snapshot = { key: 'question-1' }
  questions.emit()
  await integration.settled()
  assert.deepEqual(calls[2]?.args, [
    'pane', 'report-agent', 'w1:p2',
    '--source', 'custom:dsh-tui',
    '--agent', 'dsh-tui',
    '--state', 'blocked',
    '--message', 'Waiting for user input',
    '--seq', String(initialSequence + 2),
  ])

  approvals.snapshot = { key: 'approval-1' }
  approvals.emit()
  channel.emit()
  await integration.settled()
  assert.equal(calls.length, 3, 'unchanged blocked state must not spawn duplicate reports')

  channel.agentId = 'session-2'
  channel.emit()
  await integration.settled()
  assert.equal(calls.length, 3, 'custom integrations must not claim native session identity')

  questions.snapshot = null
  questions.emit()
  await integration.settled()
  assert.equal(calls.length, 3, 'approval keeps the agent blocked after the question closes')

  approvals.snapshot = null
  approvals.emit()
  await integration.settled()
  assert.equal(calls[3]?.args.at(8), 'working')

  channel.working = false
  channel.emit()
  await integration.settled()
  assert.equal(calls[4]?.args.at(8), 'idle')

  await integration.dispose()
  assert.deepEqual(calls[5]?.args, [
    'pane', 'release-agent', 'w1:p2',
    '--source', 'custom:dsh-tui',
    '--agent', 'dsh-tui',
    '--seq', String(initialSequence + 5),
  ])
  await integration.dispose()
  assert.equal(calls.length, 6, 'dispose must be idempotent')
}

// A later clock sample must replace the startup anchor. Incrementing by one
// leaves this process behind any reporter that attached afterwards.
{
  const channel = new TestChannel()
  const questions = new TestBlockingStore()
  const approvals = new TestBlockingStore()
  const calls: Array<{ file: string; args: readonly string[] }> = []
  let clock = 1_700_000_000_000
  const integration = attachHerdrIntegration({
    channel,
    questions,
    approvals,
    env: {
      HERDR_ENV: '1',
      HERDR_BIN_PATH: 'herdr',
      HERDR_PANE_ID: 'w1:p2',
    },
    now: () => clock,
    run: async (file, args) => {
      calls.push({ file, args })
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  await integration!.settled()
  const first = Number(calls[0]?.args.at(-1))
  clock += 60_000
  channel.working = true
  channel.emit()
  await integration!.settled()
  const second = Number(calls[1]?.args.at(-1))
  assert.equal(second, clock * 1000)
  assert.ok(second > first + 1, 'a later report must jump to the new clock, not startup+1')
  await integration!.dispose()
}

// -----------------------------------------------------------------------------
// 1b. Resume command reporting (Herdr reopens the pane after a server restart)
// -----------------------------------------------------------------------------
{
  const channel = new TestChannel()
  const questions = new TestBlockingStore()
  const approvals = new TestBlockingStore()
  const calls: Array<{ file: string; args: readonly string[] }> = []
  let session: { id: string; argv: readonly string[] } | undefined
  const sessionTail = (id: string): string[] => ['--agent-session-id', id, '--', 'dsh-tui', '--resume', id]

  const integration = attachHerdrIntegration({
    channel,
    questions,
    approvals,
    env: { HERDR_ENV: '1', HERDR_BIN_PATH: 'herdr', HERDR_PANE_ID: 'w1:p2' },
    now: () => 1_700_000_000_000,
    session: () => session,
    run: async (file, args) => {
      calls.push({ file, args })
      return { code: 0, stdout: '', stderr: '' }
    },
  })

  assert.ok(integration, 'Herdr environment should enable the integration')
  await integration.settled()
  assert.equal(calls[0]?.args.includes('--agent-session-id'), false, 'without a resumable session the report stays state-only')

  session = { id: 'session-9', argv: ['dsh-tui', '--resume', 'session-9'] }
  channel.working = true
  channel.emit()
  await integration.settled()
  assert.equal(calls[1]?.args.at(8), 'working')
  assert.deepEqual(calls[1]?.args.slice(-6), sessionTail('session-9'), 'the session rides on the next state report')

  // An agent swap changes only the session: it must be reported without a duplicate state change.
  session = { id: 'session-10', argv: ['dsh-tui', '--resume', 'session-10'] }
  channel.emit()
  await integration.settled()
  assert.equal(calls.length, 3, 'a new session must be reported even when the state did not change')
  assert.equal(calls[2]?.args.at(8), 'working')
  assert.deepEqual(calls[2]?.args.slice(-6), sessionTail('session-10'))

  // The same session is never reported twice.
  channel.emit()
  await integration.settled()
  assert.equal(calls.length, 3, 'an unchanged session must not spawn a duplicate report')

  // A session that goes away must not clear what Herdr already holds (release does that).
  session = undefined
  channel.emit()
  await integration.settled()
  assert.equal(calls.length, 3, 'a session that disappears must not report an empty one')

  await integration.dispose()
}

// -----------------------------------------------------------------------------
// 2. [P1] Rejection isolation: throwing / rejecting run does not stall the queue
// -----------------------------------------------------------------------------
{
  const channel = new TestChannel()
  const questions = new TestBlockingStore()
  const approvals = new TestBlockingStore()
  const calls: Array<{ file: string; args: readonly string[] }> = []
  let shouldThrow = true

  const integration = attachHerdrIntegration({
    channel,
    questions,
    approvals,
    env: {
      HERDR_ENV: '1',
      HERDR_BIN_PATH: 'herdr',
      HERDR_PANE_ID: 'w1:p2',
    },
    run: async (file, args) => {
      calls.push({ file, args })
      if (shouldThrow) {
        throw new Error('simulated process spawn failure or rejection')
      }
      return { code: 0, stdout: '', stderr: '' }
    },
    retryDelaysMs: [],
  })
  assert.ok(integration)

  // Initial report rejected
  await integration.settled()
  assert.equal(calls.length, 1)

  // Subsequent event recovers and executes
  shouldThrow = false
  channel.working = true
  channel.emit()
  await integration.settled()
  assert.equal(calls.length, 2, 'queue must not be permanently broken by a prior rejection')
  assert.equal(calls[1]?.args.at(8), 'working')

  // Dispose successfully releases
  await integration.dispose()
  assert.equal(calls.length, 3)
  assert.equal(calls[2]?.args.at(1), 'release-agent')
}

// -----------------------------------------------------------------------------
// 3. [P1] Exit code confirmation: code !== 0 is not confirmed and retries
// -----------------------------------------------------------------------------
{
  const channel = new TestChannel()
  const questions = new TestBlockingStore()
  const approvals = new TestBlockingStore()
  const calls: Array<{ file: string; args: readonly string[] }> = []
  let exitCode = 1

  const integration = attachHerdrIntegration({
    channel,
    questions,
    approvals,
    env: {
      HERDR_ENV: '1',
      HERDR_BIN_PATH: 'herdr',
      HERDR_PANE_ID: 'w1:p2',
    },
    run: async (file, args) => {
      calls.push({ file, args })
      return { code: exitCode, stdout: '', stderr: exitCode ? 'error' : '' }
    },
    retryDelaysMs: [],
  })
  assert.ok(integration)

  await integration.settled()
  assert.equal(calls.length, 1, 'initial idle report attempted')

  // Since exit code was 1, idle state was not confirmed.
  // Emitting an event with the same state should retry rather than deduplicating away.
  exitCode = 0
  channel.emit()
  await integration.settled()
  assert.equal(calls.length, 2, 'failed state report must retry on subsequent trigger')
  assert.equal(calls[1]?.args.at(8), 'idle')

  // Now that it succeeded (exit code 0), emitting again should deduplicate
  channel.emit()
  await integration.settled()
  assert.equal(calls.length, 2, 'successful state report must deduplicate')

  await integration.dispose()
}

// -----------------------------------------------------------------------------
// 4. [P1] Bounded backoff retries recover without a new state event
// -----------------------------------------------------------------------------
{
  const channel = new TestChannel()
  const questions = new TestBlockingStore()
  const approvals = new TestBlockingStore()
  const calls: Array<{ file: string; args: readonly string[] }> = []
  let failuresLeft = 2
  const integration = attachHerdrIntegration({
    channel,
    questions,
    approvals,
    env: { HERDR_ENV: '1', HERDR_BIN_PATH: 'herdr', HERDR_PANE_ID: 'w1:p2' },
    retryDelaysMs: [5, 5, 5],
    run: async (file, args) => {
      calls.push({ file, args })
      return { code: failuresLeft-- > 0 ? 1 : 0, stdout: 'prompt must not be logged', stderr: 'tool detail' }
    },
  })
  assert.ok(integration)
  await integration.settled()
  assert.equal(calls.length, 3, 'late service recovery must not need a fresh state event')
  await integration.dispose()
}

// -----------------------------------------------------------------------------
// 5. [P1] In-flight backlog folding: rapid state changes fold into latest
// -----------------------------------------------------------------------------
{
  const channel = new TestChannel()
  const questions = new TestBlockingStore()
  const approvals = new TestBlockingStore()
  const calls: Array<{ file: string; args: readonly string[] }> = []

  let delayedResolve: (() => void) | null = null

  const integration = attachHerdrIntegration({
    channel,
    questions,
    approvals,
    env: {
      HERDR_ENV: '1',
      HERDR_BIN_PATH: 'herdr',
      HERDR_PANE_ID: 'w1:p2',
    },
    run: async (file, args) => {
      calls.push({ file, args })
      if (delayedResolve !== null) {
        await new Promise<void>(resolve => {
          delayedResolve = resolve
        })
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  assert.ok(integration)
  await integration.settled()
  assert.equal(calls.length, 1, 'initial idle report')

  // Set up delayed run for the next call
  let resolveInFlight: (() => void) | undefined
  delayedResolve = () => {
    if (resolveInFlight) resolveInFlight()
  }

  // Trigger working state -> starts in-flight report
  channel.working = true
  channel.emit()

  // Rapidly transition states while first report is in-flight:
  // working (in-flight) -> blocked -> working -> idle
  questions.snapshot = { key: 'q1' }
  questions.emit()
  questions.snapshot = null
  questions.emit()
  channel.working = false
  channel.emit()

  // At this moment, only the initial in-flight 'working' call was dispatched
  assert.equal(calls.length, 2)
  assert.equal(calls[1]?.args.at(8), 'working')

  // Let in-flight report complete
  const finish = delayedResolve
  delayedResolve = null
  finish()

  await integration.settled()

  // After the in-flight 'working' report settled, the latest state was 'idle'.
  // It should dispatch 'idle' directly, completely folding away the intermediate 'blocked' and 'working'.
  assert.equal(calls.length, 3, 'intermediate states must be folded into latest state')
  assert.equal(calls[2]?.args.at(8), 'idle')

  await integration.dispose()
}

// -----------------------------------------------------------------------------
// 6. dispose/release is bounded and idempotent when the CLI hangs
// -----------------------------------------------------------------------------
{
  const integration = attachHerdrIntegration({
    channel: new TestChannel(),
    questions: new TestBlockingStore(),
    approvals: new TestBlockingStore(),
    env: { HERDR_ENV: '1', HERDR_BIN_PATH: 'herdr', HERDR_PANE_ID: 'w1:p2' },
    reportTimeoutMs: 1000,
    releaseTimeoutMs: 20,
    run: async () => new Promise(() => {}),
  })
  assert.ok(integration)
  const started = Date.now()
  const first = integration.dispose()
  assert.equal(await Promise.race([first.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))]), true)
  assert.ok(Date.now() - started < 100, 'dispose must not wait for a hung report or release')
  assert.equal(integration.dispose(), first, 'dispose must be idempotent')
}

// -----------------------------------------------------------------------------
// 7. Gating: disabled integration when env vars are missing/invalid
// -----------------------------------------------------------------------------
for (const env of [
  {},
  { HERDR_ENV: '0', HERDR_BIN_PATH: 'herdr', HERDR_PANE_ID: 'w1:p2' },
  { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p2' },
  { HERDR_ENV: '1', HERDR_BIN_PATH: 'herdr' },
]) {
  assert.equal(attachHerdrIntegration({
    channel: new TestChannel(),
    questions: new TestBlockingStore(),
    approvals: new TestBlockingStore(),
    env,
    run: async () => {
      throw new Error('disabled integration must not run Herdr')
    },
  }), undefined)
}

// -----------------------------------------------------------------------------
// 6. [P2] CLI Parameter Contract Gate & Stub E2E (Always runs in CI)
// -----------------------------------------------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), 'verify-herdr-stub-'))
  const stateDir = join(tmp, 'state')
  mkdirSync(stateDir, { recursive: true })

  const stubScript = join(tmp, 'mock-herdr.mjs')
  const isWin = process.platform === 'win32'
  const stubBin = isWin ? join(tmp, 'mock-herdr.cmd') : join(tmp, 'mock-herdr')

  // Write mock Herdr CLI that strictly enforces argument and subcommand contracts
  const mockCliCode = `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const stateDir = process.env.HERDR_STUB_STATE_DIR || ${JSON.stringify(stateDir)}
const args = process.argv.slice(2)

function fail(msg, code = 2) {
  process.stderr.write('herdr: ' + msg + '\\n')
  process.exit(code)
}

function parseFlags(raw) {
  const flags = {}
  const positionals = []
  let resumeArgv = []
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]
    if (a === '--') {
      resumeArgv = raw.slice(i + 1)
      break
    }
    if (a.startsWith('--')) {
      const key = a.slice(2)
      if (i + 1 < raw.length && !raw[i + 1].startsWith('--')) {
        flags[key] = raw[++i]
      } else {
        flags[key] = true
      }
    } else {
      positionals.push(a)
    }
  }
  return { flags, positionals, resumeArgv }
}

const { flags, positionals, resumeArgv } = parseFlags(args)
const [command, subcommand, paneId] = positionals

if (command === 'pane' && subcommand === 'report-agent') {
  if (!paneId) fail('missing paneId')
  if (typeof flags.source !== 'string' || !flags.source.startsWith('custom:')) fail('missing or invalid --source')
  if (typeof flags.agent !== 'string' || !flags.agent) fail('missing or invalid --agent')
  if (!['idle', 'working', 'blocked'].includes(flags.state)) fail('invalid --state: ' + flags.state)
  if (typeof flags.seq !== 'string' || !/^\\d+$/.test(flags.seq)) fail('missing or invalid --seq')
  const allowed = new Set(['source', 'agent', 'state', 'message', 'seq', 'agent-session-id'])
  for (const k of Object.keys(flags)) {
    if (!allowed.has(k)) fail('unknown option --' + k)
  }
  // Herdr's own resume_argv rules: a plain command name on PATH, no apostrophes,
  // bounded length, and a session id to attach it to.
  if (resumeArgv.length > 0) {
    if (typeof flags['agent-session-id'] !== 'string') fail('resume_argv requires --agent-session-id')
    if (!/^[A-Za-z0-9._-]+$/.test(resumeArgv[0])) fail('resume_argv must start with a plain command name, not a path')
    if (resumeArgv.some(t => t.includes("'"))) fail('resume_argv must not contain apostrophes')
    if (resumeArgv.length > 64) fail('resume_argv has too many arguments')
  }
  const statePath = join(stateDir, 'herdr-pane-' + paneId.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json')
  writeFileSync(statePath, JSON.stringify({
    pane: paneId,
    agent: flags.agent,
    agent_status: flags.state,
    source: flags.source,
    message: flags.message ?? null,
    agent_session_id: flags['agent-session-id'] ?? null,
    resume_argv: resumeArgv,
    seq: Number(flags.seq),
  }))
  process.exit(0)
} else if (command === 'pane' && subcommand === 'release-agent') {
  if (!paneId) fail('missing paneId')
  if (typeof flags.source !== 'string' || !flags.source.startsWith('custom:')) fail('missing or invalid --source')
  if (typeof flags.agent !== 'string' || !flags.agent) fail('missing or invalid --agent')
  if (typeof flags.seq !== 'string' || !/^\\d+$/.test(flags.seq)) fail('missing or invalid --seq')
  const allowed = new Set(['source', 'agent', 'seq'])
  for (const k of Object.keys(flags)) {
    if (!allowed.has(k)) fail('unknown option --' + k)
  }
  const statePath = join(stateDir, 'herdr-pane-' + paneId.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json')
  if (existsSync(statePath)) rmSync(statePath, { force: true })
  process.exit(0)
} else if (command === 'agent' && subcommand === 'get') {
  if (!paneId) fail('missing paneId')
  const statePath = join(stateDir, 'herdr-pane-' + paneId.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json')
  if (!existsSync(statePath)) fail('no agent active on pane ' + paneId, 1)
  const data = readFileSync(statePath, 'utf8')
  process.stdout.write(data + '\\n')
  process.exit(0)
} else {
  fail('unknown command: ' + args.join(' '))
}
`

  writeFileSync(stubScript, mockCliCode, 'utf8')
  chmodSync(stubScript, 0o755)

  if (isWin) {
    writeFileSync(stubBin, `@echo off\r\nnode "${stubScript}" %*\r\n`, 'ascii')
  } else {
    writeFileSync(stubBin, `#!/bin/sh\nexec node "${stubScript}" "$@"\n`, 'utf8')
    chmodSync(stubBin, 0o755)
  }

  // Windows must launch .cmd/.bat through cmd.exe without letting argv become
  // shell syntax. This also exercises paths containing spaces in the temp dir.
  if (isWin) {
    const injectionMarker = join(tmp, 'argv-injected.txt')
    const specialPane = `pane & echo injected > ${injectionMarker}`
    const special = await execFileNoThrow(stubBin, [
      'pane', 'report-agent', specialPane,
      '--source', 'custom:dsh-tui', '--agent', 'dsh-tui', '--state', 'idle', '--seq', '1',
    ], { timeout: 2000 })
    assert.equal(special.code, 0, special.stderr)
    assert.equal(existsSync(injectionMarker), false, 'cmd metacharacters in argv must remain data')
  }

  // --- CLI Contract Gates: Verify that invalid argument shapes are strictly rejected ---
  const invalidContractCalls: Array<string[]> = [
    // Missing required flags
    ['pane', 'report-agent', 'w1:p2', '--agent', 'dsh-tui', '--state', 'idle', '--seq', '1'],
    ['pane', 'report-agent', 'w1:p2', '--source', 'custom:dsh-tui', '--state', 'idle', '--seq', '1'],
    ['pane', 'report-agent', 'w1:p2', '--source', 'custom:dsh-tui', '--agent', 'dsh-tui', '--seq', '1'],
    // Invalid state enum
    ['pane', 'report-agent', 'w1:p2', '--source', 'custom:dsh-tui', '--agent', 'dsh-tui', '--state', 'unknown-state', '--seq', '1'],
    // Invalid seq
    ['pane', 'report-agent', 'w1:p2', '--source', 'custom:dsh-tui', '--agent', 'dsh-tui', '--state', 'idle', '--seq', 'not-a-number'],
    // Unknown option
    ['pane', 'report-agent', 'w1:p2', '--source', 'custom:dsh-tui', '--agent', 'dsh-tui', '--state', 'idle', '--seq', '1', '--unknown-flag'],
    // resume_argv must be a plain command name, not a path
    ['pane', 'report-agent', 'w1:p2', '--source', 'custom:dsh-tui', '--agent', 'dsh-tui', '--state', 'idle', '--seq', '1', '--agent-session-id', 'session-1', '--', '/usr/bin/dsh-tui', '--resume', 'session-1'],
    // resume_argv must not carry apostrophes
    ['pane', 'report-agent', 'w1:p2', '--source', 'custom:dsh-tui', '--agent', 'dsh-tui', '--state', 'idle', '--seq', '1', '--agent-session-id', 'session-1', '--', 'dsh-tui', '--resume', "it's"],
    // a resume command without a session id has nothing to attach to
    ['pane', 'report-agent', 'w1:p2', '--source', 'custom:dsh-tui', '--agent', 'dsh-tui', '--state', 'idle', '--seq', '1', '--', 'dsh-tui', '--resume', 'session-1'],
    // Invalid release-agent options
    ['pane', 'release-agent', 'w1:p2', '--source', 'custom:dsh-tui', '--agent', 'dsh-tui', '--seq', '1', '--invalid'],
  ]

  for (const args of invalidContractCalls) {
    const res = await execFileNoThrow(stubBin, args, { timeout: 2000 })
    assert.notEqual(res.code, 0, `Contract gate must reject invalid CLI args: ${args.join(' ')}`)
  }

  // The session-bearing report is the exact shape the integration sends.
  const sessionReport = await execFileNoThrow(stubBin, [
    'pane', 'report-agent', 'w1:p2',
    '--source', 'custom:dsh-tui', '--agent', 'dsh-tui', '--state', 'idle', '--seq', '1',
    '--agent-session-id', 'session-1', '--', 'dsh-tui', '--resume', 'session-1',
  ], { timeout: 2000 })
  assert.equal(sessionReport.code, 0, sessionReport.stderr)
  const storedSession = JSON.parse(
    (await execFileNoThrow(stubBin, ['agent', 'get', 'w1:p2'], { timeout: 2000 })).stdout.trim(),
  ) as { agent_session_id: string; resume_argv: string[] }
  assert.equal(storedSession.agent_session_id, 'session-1')
  assert.deepEqual(storedSession.resume_argv, ['dsh-tui', '--resume', 'session-1'])

  // --- Real End-to-End lifecycle through actual child process execution ---
  const testPane = 'w1:p2'
  const e2eChannel = new TestChannel()
  const e2eQuestions = new TestBlockingStore()
  const e2eApprovals = new TestBlockingStore()

  // Real execFileNoThrow is used (no mock run provided)
  const e2eIntegration = attachHerdrIntegration({
    channel: e2eChannel,
    questions: e2eQuestions,
    approvals: e2eApprovals,
    env: {
      HERDR_ENV: '1',
      HERDR_BIN_PATH: stubBin,
      HERDR_PANE_ID: testPane,
      HERDR_STUB_STATE_DIR: stateDir,
    },
  })
  assert.ok(e2eIntegration, 'E2E integration should attach')

  const verifyAgentState = async (expectedStatus: 'idle' | 'working' | 'blocked'): Promise<void> => {
    await e2eIntegration.settled()
    const res = await execFileNoThrow(stubBin, ['agent', 'get', testPane], { timeout: 2000 })
    assert.equal(res.code, 0, `agent get failed: ${res.stderr}`)
    const parsed = JSON.parse(res.stdout.trim()) as { agent: string; agent_status: string; source: string }
    assert.equal(parsed.agent, 'dsh-tui')
    assert.equal(parsed.agent_status, expectedStatus)
    assert.equal(parsed.source, 'custom:dsh-tui')
  }

  // 1. Initial idle state
  await verifyAgentState('idle')

  // 2. Working state
  e2eChannel.working = true
  e2eChannel.emit()
  await verifyAgentState('working')

  // 3. Blocked state
  e2eQuestions.snapshot = { question: 'Approve action?' }
  e2eQuestions.emit()
  await verifyAgentState('blocked')

  // 4. Return to working -> idle
  e2eQuestions.snapshot = null
  e2eQuestions.emit()
  await verifyAgentState('working')

  e2eChannel.working = false
  e2eChannel.emit()
  await verifyAgentState('idle')

  // 5. Dispose and verify agent release
  await e2eIntegration.dispose()
  const released = await execFileNoThrow(stubBin, ['agent', 'get', testPane], { timeout: 2000 })
  assert.notEqual(released.code, 0, 'released agent must no longer resolve')

  // Clean up tmp directory
  rmSync(tmp, { recursive: true, force: true })
}

// -----------------------------------------------------------------------------
// 7. Live Herdr environment check (when DSH_TUI_HERDR_E2E=1)
// -----------------------------------------------------------------------------
if (process.env.DSH_TUI_HERDR_E2E === '1') {
  const executable = process.env.HERDR_BIN_PATH
  const paneId = process.env.HERDR_PANE_ID
  assert.ok(executable && paneId, 'real Herdr verification requires HERDR_BIN_PATH and HERDR_PANE_ID')

  const realChannel = new TestChannel()
  const realQuestions = new TestBlockingStore()
  const realApprovals = new TestBlockingStore()
  const real = attachHerdrIntegration({
    channel: realChannel,
    questions: realQuestions,
    approvals: realApprovals,
  })
  assert.ok(real, 'real Herdr environment should enable the integration')

  const expectRealState = async (state: 'idle' | 'working' | 'blocked'): Promise<void> => {
    await real.settled()
    const result = await execFileNoThrow(executable, ['agent', 'get', paneId], { timeout: 2000 })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, new RegExp(`"agent":"dsh-tui".*"agent_status":"${state}"`))
  }

  await expectRealState('idle')
  realChannel.working = true
  realChannel.emit()
  await expectRealState('working')
  realQuestions.snapshot = { key: 'real-question' }
  realQuestions.emit()
  await expectRealState('blocked')
  await real.dispose()

  const released = await execFileNoThrow(executable, ['agent', 'get', paneId], { timeout: 2000 })
  assert.notEqual(released.code, 0, 'released custom agent must no longer resolve')
  console.log('verify-herdr-integration: real live Herdr lifecycle passed')
}

console.log('verify-herdr-integration: lifecycle, rejection isolation, folding, contract gate, and release passed')
