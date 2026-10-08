/**
 * winbash preset regression: registration shape (with/without a job
 * registry), foreground execution, background admission, cancellation,
 * promote-on-timeout, argument validation, and the present-call/result
 * shapes — against a mock ctx/registry with REAL child processes.
 *
 * Zero dependencies: node: built-ins only; imports the preset file directly,
 * so it runs without a prior build (unlike scripts that import lib/types).
 *
 * Usage: node scripts/verify-winbash.mjs
 */
import assert from 'node:assert/strict'
import { spawn as cpSpawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const preset = await import(new URL('../presets/winbash.mjs', import.meta.url).href)

let passed = 0
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log('  ok', name) })
    .catch((error) => { console.error('  FAIL', name); throw error })
}

// ── locate a runnable bash for this platform ────────────────────────────────
function findBash() {
  if (process.platform !== 'win32') return 'bash'
  const candidates = preset.windowsBashCandidates({}, process.env)
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'exit 0'], { stdio: 'ignore', timeout: 5000 })
    if (probe.status === 0) return candidate
  }
  throw new Error('no runnable Git Bash found for the regression')
}
const BASH = findBash()
console.log('bash executor:', BASH)

// ── mock subprocess service wrapping real child processes ──────────────────
function makeSubprocess() {
  return {
    async resolveExecutable(candidate) {
      if (candidate === 'bash' || candidate === BASH) return BASH
      throw new Error(`not found: ${candidate}`)
    },
    spawn(spec) {
      const [exe, ...rest] = spec.argv
      const child = cpSpawn(exe, rest, {
        ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
      })
      const collect = (stream) => {
        let text = ''
        stream.on('data', (chunk) => { text += chunk.toString('utf8') })
        return {
          readFrom(offset) {
            const from = Math.min(offset, text.length)
            return { text: text.slice(from), nextOffset: text.length, lossy: false }
          },
        }
      }
      const handle = {
        collected: { stdout: collect(child.stdout), stderr: collect(child.stderr) },
        kill() { try { child.kill() } catch { /* already gone */ } },
        done: new Promise((resolve, reject) => {
          child.on('error', (error) => reject(error))
          child.on('close', (code, signal) => resolve({ exitCode: code, signal: signal ?? null }))
        }),
      }
      return handle
    },
  }
}

// ── mock job registry (consumer cursor simplified to read-all) ─────────────
function makeRegistry() {
  const table = new Map()
  let seq = 0
  const registry = {
    table,
    admits: [],
    start(spec) {
      const id = `bash-${++seq}`
      const hooks = spec.run()
      const entry = { spec, hooks, view: { status: 'running', detail: '' } }
      table.set(id, entry)
      void hooks.done.then((outcome) => {
        const row = table.get(id)
        if (row !== undefined) row.view = { status: outcome.status, detail: outcome.detail }
      })
      registry.admits.push({ id, spec })
      return id
    },
    async wait(id, timeoutMs, _owner, signal) {
      const entry = table.get(id)
      if (entry === undefined) return { status: 'failed', detail: 'unknown job' }
      const settled = entry.hooks.done.then(() => 'settled')
      const timer = new Promise((resolve) => setTimeout(resolve, timeoutMs, 'timeout'))
      const result = await Promise.race([settled, timer, ...(signal !== undefined ? [new Promise((resolve) => { if (signal.aborted) resolve('aborted') })] : [])])
      return { ...table.get(id).view }
    },
    read(id, _owner) {
      const entry = table.get(id)
      if (entry === undefined) return { chunks: [], lossy: false, job: { output: { spillPaths: [] } } }
      const chunks = []
      for (const source of entry.spec.output) {
        const chunk = source.read(0)
        if (chunk.text.length > 0) chunks.push({ channel: source.channel, text: chunk.text })
      }
      return { chunks, lossy: false, job: { output: { spillPaths: [] } } }
    },
    kill(id, _owner, reason) { table.get(id)?.hooks.cancel(reason) },
    remove(id, _owner) { table.delete(id) },
  }
  return registry
}

// ── mock ctx ────────────────────────────────────────────────────────────────
function makeCtx({ jobs }) {
  const registered = []
  const ctx = {
    warnings: [],
    logger: { warn: (message) => ctx.warnings.push(message) },
    subprocess: makeSubprocess(),
    tools: { register: (tool) => { registered.push(tool); return () => {} } },
    get(name) { return name === 'jobs' && jobs !== undefined ? { jobs } : undefined },
    inject(names, callback) { if (names.includes('jobs') && jobs !== undefined) callback({ jobs, effect: () => {} }) },
    fiber: { state: 0 },
    effect: () => {},
  }
  return { ctx, registered }
}

async function setupTool({ jobs } = {}) {
  const harness = makeCtx({ jobs })
  await preset.apply(harness.ctx, {})
  assert.equal(harness.registered.length, 1, 'exactly one bash tool registers')
  return harness.registered[0]
}

const noAgent = { agent: { id: 'agent-test', session: { header: { cwd: process.cwd() } } }, signal: new AbortController().signal }

// ── V1: pure resolution helpers ─────────────────────────────────────────────
await ok('V1 WSL launcher is rejected, git tree candidates and shim following work', async () => {
  assert.equal(preset.isWindowsSubsystemLauncher('C:\\Windows\\System32\\bash.exe'), true)
  assert.equal(preset.isWindowsSubsystemLauncher('C:\\Program Files\\Git\\bin\\bash.exe'), false)
  assert.deepEqual(
    preset.bashCandidatesFromGit('D:\\tools\\git\\cmd\\git.exe'),
    ['D:\\tools\\git\\bin\\bash.exe', 'D:\\tools\\git\\usr\\bin\\bash.exe'],
  )
  const dir = mkdtempSync(join(tmpdir(), 'winbash-verify-'))
  try {
    const shim = join(dir, 'git.shim')
    writeFileSync(shim, 'path = "C:\\real\\Git\\cmd\\git.exe"\n', 'utf8')
    assert.equal(preset.resolveShimTarget(join(dir, 'git.exe')), 'C:\\real\\Git\\cmd\\git.exe')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.deepEqual(
    preset.windowsBashCandidates({ bashPath: 'X:\\b\\bash.exe' }),
    ['X:\\b\\bash.exe'],
    'explicit config wins as the only candidate',
  )
})

// ── V2/V3: registration shape with and without a registry ───────────────────
await ok('V2 without jobs: foreground-only schema, description required', async () => {
  const tool = await setupTool({})
  assert.equal(tool.name, 'bash')
  assert.equal(tool.parameters.required.includes('description'), true)
  assert.equal('run_in_background' in tool.parameters.properties, false)
  assert.match(tool.description, /fresh shell/)
  assert.equal(typeof tool.timeoutMs, 'number')
})

await ok('V3 with jobs: run_in_background exposed, promote wording present', async () => {
  const tool = await setupTool({ jobs: makeRegistry() })
  assert.equal('run_in_background' in tool.parameters.properties, true)
  assert.match(tool.description, /run_in_background/)
  assert.match(tool.parameters.properties.timeoutMs.description, /background as a job/)
})

// ── V4/V5/V6/V7: foreground execution and validation ───────────────────────
await ok('V4 foreground echo renders stdout through output.render', async () => {
  const tool = await setupTool({})
  const value = await tool.execute({ command: 'echo winbash-ok', description: 'Smoke the foreground path' }, noAgent)
  assert.equal(value.kind, 'foreground')
  assert.equal(value.exitCode, 0)
  assert.match(value.stdout.text, /winbash-ok/)
  const blocks = tool.output.render({}, value)
  assert.equal(blocks.length, 1)
  assert.match(blocks[0].text, /winbash-ok/)
})

await ok('V5 non-zero exit is reported as a marker, not thrown', async () => {
  const tool = await setupTool({})
  const value = await tool.execute({ command: 'echo boom 1>&2; exit 3', description: 'Fail on purpose' }, noAgent)
  assert.equal(value.exitCode, 3)
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /\[exit code: 3\]/)
  const presented = tool.presentResult({ command: 'x', description: 'd' }, { content: tool.output.render({}, value), value, isError: false })
  assert.equal(presented.card, 'terminal')
  assert.equal(presented.exitCode, 3)
  assert.match(presented.output, /boom/)
})

await ok('V6 stderr lands in a marked [stderr] section', async () => {
  const tool = await setupTool({})
  const value = await tool.execute({ command: 'echo out; echo err-line 1>&2', description: 'Mix streams' }, noAgent)
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /out/)
  assert.match(text, /\[stderr\]\nerr-line/)
})

await ok('V7 argument validation rejects empty command/description and bad timeoutMs', async () => {
  const tool = await setupTool({})
  await assert.rejects(() => tool.execute({ command: '   ', description: 'x' }, noAgent), /non-empty string/)
  await assert.rejects(() => tool.execute({ command: 'echo hi' }, noAgent), /invalid description/)
  await assert.rejects(() => tool.execute({ command: 'echo hi', description: 'x', timeoutMs: 0 }, noAgent), /invalid timeoutMs/)
})

// ── V8/V9/V10: the job paths (mock registry, real processes) ───────────────
await ok('V8 background admission returns a job id and settles completed', async () => {
  const registry = makeRegistry()
  const tool = await setupTool({ jobs: registry })
  const value = await tool.execute({ command: 'echo bg-line && sleep 0.2', description: 'Background smoke', run_in_background: true }, noAgent)
  assert.equal(value.kind, 'background')
  assert.equal(typeof value.jobId, 'string')
  const admit = registry.admits[0]
  assert.equal(admit.spec.kind, 'bash')
  assert.equal(admit.spec.label, 'echo bg-line && sleep 0.2')
  assert.equal(admit.spec.owner, 'agent-test')
  assert.deepEqual(admit.spec.output.map((source) => source.channel), ['stdout', 'stderr'])
  const outcome = await registry.table.get(value.jobId).hooks.done
  assert.equal(outcome.status, 'completed')
  assert.match(outcome.detail, /exit code: 0/)
  const read = registry.read(value.jobId, 'agent-test')
  assert.match(read.chunks.map((chunk) => chunk.text).join(''), /bg-line/)
  assert.match(tool.output.render({}, value)[0].text, new RegExp(`started background job ${value.jobId}`))
  registry.remove(value.jobId, 'agent-test')
})

await ok('V9 cancellation kills the process and settles killed', async () => {
  const registry = makeRegistry()
  const tool = await setupTool({ jobs: registry })
  const value = await tool.execute({ command: 'sleep 30', description: 'Cancel target', run_in_background: true }, noAgent)
  const entry = registry.table.get(value.jobId)
  entry.hooks.cancel('verification kill')
  const outcome = await Promise.race([entry.hooks.done, new Promise((resolve) => setTimeout(resolve, 3000, { status: 'stuck' }))])
  assert.equal(outcome.status, 'killed')
  registry.remove(value.jobId, 'agent-test')
})

await ok('V10 a foreground call that outlives its timeout is promoted, not killed', async () => {
  const registry = makeRegistry()
  const tool = await setupTool({ jobs: registry })
  const value = await tool.execute({ command: 'echo promoted-line && sleep 4', description: 'Promotion target', timeoutMs: 250 }, noAgent)
  assert.equal(value.kind, 'promoted')
  assert.equal(typeof value.jobId, 'string')
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /promoted-line/)
  assert.match(text, new RegExp(`moved to background job ${value.jobId}`))
  const presented = tool.presentResult({ command: 'x', description: 'd', timeoutMs: 250 }, { content: [{ type: 'text', text }], value, isError: false })
  assert.equal(presented.card, 'generic')
  // cleanup: stop the still-running job
  registry.kill(value.jobId, 'agent-test', 'cleanup')
  await registry.wait(value.jobId, 5000, 'agent-test')
  registry.remove(value.jobId, 'agent-test')
})

// ── V11: presentCall shapes ────────────────────────────────────────────────
await ok('V11 presentCall renders a terminal card in the foreground and a generic card in the background', async () => {
  const tool = await setupTool({ jobs: makeRegistry() })
  const fg = tool.presentCall({ command: 'ls', description: 'List files' })
  assert.equal(fg.card, 'terminal')
  assert.equal(fg.description, 'List files')
  const bg = tool.presentCall({ command: 'sleep 10', description: 'Long watch', run_in_background: true })
  assert.equal(bg.card, 'generic')
  assert.equal(bg.kind, 'execute')
  assert.equal(bg.content[0].text, 'Long watch')
})

// ── V12: unresolvable bash skips registration with a warning ───────────────
await ok('V12 an unresolvable executor skips registration loudly', async () => {
  const registered = []
  const warnings = []
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    warnings,
    subprocess: {
      async resolveExecutable() { throw new Error('none') },
      spawn() { throw new Error('unreachable') },
    },
    tools: { register: (tool) => { registered.push(tool); return () => {} } },
    get: () => undefined,
    inject: () => {},
    fiber: { state: 0 },
    effect: () => {},
  }
  await preset.apply(ctx, {})
  assert.equal(registered.length, 0)
  assert.match(warnings[0], /Git Bash executable unavailable/)
})

console.log(`\nverify-winbash: ALL ${passed} PASS`)
