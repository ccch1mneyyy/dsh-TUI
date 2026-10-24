/**
 * Real-process /restart and /update regression (no network or credentials).
 * Repeated execve restarts must keep the PID, parent, cwd, argv and stdio,
 * carry the resume/kernel markers, and never return to the old runtime.
 * Missing/throwing execve must retain the supervised spawn fallback.
 *
 * Run: node --import tsx/esm scripts/verify-restart-process.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const self = fileURLToPath(import.meta.url)
const driver = process.argv.includes('--restart-driver')

if (driver) {
  const { restartTui } = await import('../src/update.js')
  const mode = process.env.RESTART_TEST_MODE ?? 'restart'
  const generation = Number(process.env.RESTART_TEST_GENERATION ?? '0')
  const rounds = Number(process.env.RESTART_TEST_ROUNDS ?? '3')
  process.stdout.write('BOOT ' + JSON.stringify({
    generation, pid: process.pid, ppid: process.ppid, cwd: process.cwd(),
    argv: process.argv.slice(1), execArgv: process.execArgv,
    resume: process.env.DSH_TUI_RESUME_SESSION ?? null,
    kernel: process.env.DSH_TUI_BACKEND_HANDOFF ?? null,
    restarted: process.env.DSH_TUI_RESTART_CHILD ?? null,
    promptSent: process.env.DSH_TUI_LAUNCH_PROMPT_SENT ?? null,
    updatedFrom: process.env.DSH_TUI_UPDATED_FROM ?? null,
    staleScreen: process.env.DSH_TUI_HANDOFF_SCREEN ?? null,
    staleAck: process.env.DSH_TUI_HANDOFF_ACK_FD ?? null,
  }) + '\n')
  process.stderr.write(`STDERR ${generation}\n`)
  if (generation === rounds) {
    if (mode === 'signal') process.kill(process.pid, 'SIGTERM')
    else process.exit(17)
    await new Promise(() => {})
  }
  if (mode === 'missing') process.execve = undefined
  if (mode === 'throwing') process.execve = () => { throw new Error('execve stub unavailable') }
  const code = await restartTui(mode === 'fresh' ? '' : 'session-to-resume', {
    kind: mode === 'update' ? 'update' : 'restart',
    kernel: 'claude',
    env: {
      RESTART_TEST_GENERATION: String(generation + 1),
      ...(mode === 'update' ? { DSH_TUI_UPDATED_FROM: '0.0.1' } : {}),
    },
    onSpawn: () => { process.stdout.write('SPAWN\n') },
  })
  process.stdout.write(`RETURNED ${code}\n`)
  process.exit(code)
}

type Boot = {
  generation: number
  pid: number
  ppid: number
  cwd: string
  argv: string[]
  execArgv: string[]
  resume: string | null
  kernel: string | null
  restarted: string | null
  promptSent: string | null
  updatedFrom: string | null
  staleScreen: string | null
  staleAck: string | null
}

const home = mkdtempSync(join(tmpdir(), 'verify-restart-process-'))
let passed = 0
function run(mode: string, rounds: number) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home,
    RESTART_TEST_MODE: mode, RESTART_TEST_GENERATION: '0', RESTART_TEST_ROUNDS: String(rounds),
  }
  for (const key of ['DSH_TUI_HOST_ENTRY_PATH', 'DSH_TUI_RESTART_CHILD', 'DSH_TUI_RESUME_SESSION',
    'DSH_TUI_BACKEND_HANDOFF', 'DSH_TUI_HANDOFF_SCREEN', 'DSH_TUI_HANDOFF_ACK_FD',
    'DSH_TUI_HANDOFF_ATTEMPT', 'DSH_TUI_UPDATED_FROM', 'DSH_TUI_LAUNCH_PROMPT_SENT',
    'DSH_TUI_HOST_DELEGATED']) delete env[key]
  if (mode === 'delegated') {
    env.DSH_TUI_HOST_ENTRY = '1'
    env.DSH_TUI_HOST_DELEGATED = '1'
    env.DSH_TUI_HOST_ENTRY_PATH = join(home, 'entry-must-not-be-reentered.js')
  }
  const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx/esm'), self,
    '--restart-driver', 'argument with spaces', '--resume=old-session'], {
    cwd: home, env, encoding: 'utf8', timeout: 30000,
  })
  assert.ifError(result.error)
  const boots: Boot[] = result.stdout.split('\n').filter(line => line.startsWith('BOOT ')).map(line => JSON.parse(line.slice(5)))
  assert.equal(boots.length, rounds + 1, result.stderr)
  assert.equal(result.status, mode === 'signal' ? null : 17, result.stderr)
  assert.equal(result.signal, mode === 'signal' ? 'SIGTERM' : null, result.stderr)
  for (const [i, boot] of boots.entries()) {
    assert.equal(boot.generation, i)
    assert.equal(boot.cwd, boots[0]!.cwd)
    assert.deepEqual(boot.execArgv, boots[0]!.execArgv)
    assert.deepEqual(boot.argv, mode === 'fresh' && i > 0
      ? boots[0]!.argv.filter(arg => arg !== '--resume=old-session') : boots[0]!.argv)
    assert.ok(result.stderr.includes(`STDERR ${i}\n`), 'stderr survives the handoff')
    if (i === 0) continue
    assert.equal(boot.resume, mode === 'fresh' ? null : 'session-to-resume')
    assert.equal(boot.kernel, 'claude')
    assert.equal(boot.restarted, mode === 'update' ? null : '1')
    assert.equal(boot.promptSent, '1')
    assert.equal(boot.updatedFrom, mode === 'update' ? '0.0.1' : null)
    assert.equal(boot.staleScreen, null)
    assert.equal(boot.staleAck, null)
  }
  return { result, boots }
}
try {
  if (process.platform !== 'win32' && typeof process.execve === 'function') {
    for (const mode of ['restart', 'update', 'fresh', 'signal', 'delegated']) {
      const { result, boots } = run(mode, 3)
      assert.equal(new Set(boots.map(boot => boot.pid)).size, 1, 'restarts must not accumulate processes')
      assert.equal(new Set(boots.map(boot => boot.ppid)).size, 1, 'the original foreground parent keeps waiting')
      assert.ok(!result.stdout.includes('SPAWN'), 'execve must not spawn a waiting parent')
      assert.ok(!result.stdout.includes('RETURNED'), 'the old runtime must never resume')
      console.log(`PASS: ${mode} keeps one PID across three restarts; argv/env/cwd/stdio and exit status survive`)
      passed++
    }
  } else {
    console.log('SKIP: real execve is unavailable on this runtime/platform')
  }
  for (const mode of ['missing', 'throwing']) {
    const { result, boots } = run(mode, 1)
    assert.notEqual(boots[0]!.pid, boots[1]!.pid)
    assert.equal(boots[1]!.ppid, boots[0]!.pid)
    assert.ok(result.stdout.includes('SPAWN\n'))
    assert.ok(result.stdout.includes('RETURNED 17\n'), 'the fallback waits for and reports the child exit')
    console.log(`PASS: ${mode} execve retains the supervised spawn fallback and child exit code`)
    passed++
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`\n${passed} restart process scenarios passed`)
