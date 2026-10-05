#!/usr/bin/env node
/**
 * The `verify:build` chain: every gate in GATES, each under its own throwaway
 * HOME, run by a small worker pool, then a ✓/✗ summary with timings.
 *
 *   node scripts/run-verify-build.mjs              # jobs = available CPUs
 *   node scripts/run-verify-build.mjs --jobs 1     # serial, live output
 *   pnpm verify:build --jobs 1
 *   DSH_TUI_VERIFY_JOBS=2 pnpm verify:build
 *
 * Each gate is a package.json script name, so every gate stays runnable on
 * its own (`pnpm verify:<name>`); this list only decides membership. Register
 * a new gate by adding its name here.
 *
 * All gates run even after a failure — a fail-fast chain hides every later
 * failure behind the first one (the same reason run-ci-group.mjs collects
 * instead of stopping, #466). The exit code is non-zero if any gate failed.
 *
 * Gates run their package.json command directly through the shell rather
 * than `npm run`, which would start a fresh npm per gate: seconds of
 * overhead and an `npm notice` banner in between every result.
 *
 * Why a HOME per gate: the chain mounts the real composer in dozens of
 * fixtures, and any of them can append fixture text to the developer's real
 * `~/.dsh-tui/history.jsonl` — which `↑` walks (#986). The plugin gates also
 * seed `~/.dsh-tui/extension-grants.json` and friends. One sandbox per gate
 * (as run-ci-group.mjs does per script) keeps the developer's home out of it
 * and makes every gate independent of which gates ran before it or beside it,
 * which is what lets them run concurrently.
 *
 * Why a pool: the gates are separate processes that mostly wait (process
 * start-up, module loading, render settle windows), so the serial chain left
 * most of the machine idle. With more than one job, each gate's output is
 * buffered and printed as one block when it finishes, so logs never
 * interleave; gates still running are listed every minute, and an interrupt
 * prints what they had written so far. Gates whose results depend on having
 * the machine to themselves belong in SERIAL: they run alone after the pool.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'

const GATES = [
  'verify:boundary',
  'verify:agent-domain',
  'verify:contract',
  'verify:claude-contract',
  'verify:herdr',
  'verify:manifest-deps',
  'verify:oauth',
  'verify:patch-surface',
  'verify:web-coexistence',
  'verify:plugin-spec',
  'verify:plugin-grants',
  'verify:plugin-storage',
  'verify:plugin-messages',
  'verify:plugin-ledger',
  'verify:plugin-commands',
  'verify:plugin-negotiation',
  'verify:plugin-lifecycle',
  'verify:runtime-themes',
  'verify:theme-preview',
  'verify:packaged-presets',
  'verify:history-search',
  'verify:initial-prompt',
  'verify:preboot',
  'verify:minimal-preset-tools',
  'verify:agent-capabilities',
  'verify:minimal-ui-naming',
  'verify:liangshen-bootstrap',
  'verify:inject-channel',
  'verify:wheel-selection',
  'verify:win32-protocol',
  'verify:selection-resize',
  'verify:selection-stale-guard',
  'verify:liangshen-instruction-hint',
  'verify:pointer-events',
  'verify:terminal-images',
  'verify:overlay-occlusion',
  'verify:transcript-images',
  'verify:image-preview',
  'verify:backdrop-dim',
  'verify:composer-image-tokens',
  'verify:image-downsample',
  'verify:chat-overlay',
  'verify:i18n',
  'verify:approval-visibility',
  'verify:adapter-skeleton',
  'verify:adapter-ports',
  'verify:adapter-effect-class',
  'verify:adapter-shadow',
  'verify:adapter-descriptor',
  'verify:adapter-upstream-driver',
  'verify:adapter-kernel-runtime',
  'verify:adapter-live-probes',
  'verify:adapter-slices',
  'verify:adapter-channel',
  'verify:binding-transaction',
  'verify:session-extraction',
  'verify:rewind-edit',
  'verify:model-mode-workspace-extraction',
  'verify:model-lifecycle-fences',
  'verify:reports-metadata',
  'verify:background-extraction',
  'verify:plugin-catalog-extraction',
  'verify:session-reset',
  'verify:channel-ui',
  'verify:adapter-detection',
  'verify:adapter-replay-harness',
  'verify:adapter-channel-conformance',
  'verify:protocol-single-source',
  'verify:compat-removal',
  'verify:terminal-images-sixel',
  'verify:sixel-transcript',
  'verify:migrate-sessions',
  'verify:fixed-window',
  'verify:source-hygiene',
  'verify:sync-profile',
  'verify:renderer-primitives',
  'verify:terminal-size-source',
  'verify:product-migration',
  'verify:spinner-identity',
  'verify:table-layout',
  'verify:mermaid-diagram',
  'verify:latex-math',
  'verify:settings',
  'verify:math-renderer',
  'verify:math-block-image',
  'verify:math-inline-image',
  'verify:semantic-copy',
  'verify:btw',
  'verify:session-mounts',
  'verify:handoff-stdin',
]

// The longest gates start first so none of them is left running alone at the
// end of the pool. Order only affects the wall time, never the result.
const FRONT = [
  'verify:rewind-edit',
  'verify:image-preview',
  'verify:composer-image-tokens',
  'verify:initial-prompt',
  'verify:math-inline-image',
  'verify:approval-visibility',
]

// Gates that must not share the machine with other gates. Empty today: every
// gate passes under full parallel load. Add a gate here, with the reason,
// rather than raising a timeout inside it.
const SERIAL = []

const root = new URL('..', import.meta.url)
const scripts = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).scripts ?? {}
const unknown = [...GATES, ...FRONT, ...SERIAL].filter(name => typeof scripts[name] !== 'string')
const unlisted = [...FRONT, ...SERIAL].filter(name => !GATES.includes(name))
if (unknown.length > 0 || unlisted.length > 0) {
  if (unknown.length > 0) console.error(`verify:build: no package.json script for ${unknown.join(', ')}`)
  if (unlisted.length > 0) console.error(`verify:build: FRONT/SERIAL name gates missing from GATES: ${unlisted.join(', ')}`)
  process.exit(1)
}

function parseJobs() {
  const args = process.argv.slice(2)
  let raw = process.env.DSH_TUI_VERIFY_JOBS
  for (let i = 0; i < args.length; i++) {
    // `pnpm verify:build -- --jobs 1` forwards the separator itself.
    if (args[i] === '--') continue
    if (args[i] === '--jobs') raw = args[++i]
    else if (args[i].startsWith('--jobs=')) raw = args[i].slice('--jobs='.length)
    else {
      console.error(`verify:build: unknown argument ${args[i]} (usage: --jobs <n>)`)
      process.exit(2)
    }
  }
  if (raw === undefined || raw === '') return availableParallelism()
  if (!/^[1-9]\d*$/.test(raw)) {
    console.error(`verify:build: --jobs must be a positive integer, got ${raw}`)
    process.exit(2)
  }
  return Number(raw)
}

const jobs = parseJobs()
const live = jobs === 1
const pooled = [...FRONT, ...GATES.filter(name => !FRONT.includes(name))].filter(name => !SERIAL.includes(name))
const running = new Map()
const results = new Map()
const header = name => `\n> ${name}\n> ${scripts[name]}\n`
const fmt = seconds => `${seconds.toFixed(1)}s`

function runGate(name) {
  // HOME on POSIX, USERPROFILE on Windows: DATA_DIR resolves from
  // `os.homedir()`, so both have to move together.
  const home = mkdtempSync(join(tmpdir(), 'dsh-tui-verify-home-'))
  const startedAt = performance.now()
  const gate = { startedAt, output: [] }
  running.set(name, gate)
  if (live) console.log(header(name))
  return new Promise(resolve => {
    const child = spawn(scripts[name], {
      cwd: root,
      shell: true,
      // Pooled gates get their own process group on POSIX, so an interrupt
      // reaches the whole gate (the shell and everything it started), not just
      // the shell. A live gate stays in the terminal's foreground group, where
      // Ctrl+C and stdin reach it directly, as they did in the serial chain.
      detached: !live && process.platform !== 'win32',
      stdio: live ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, USERPROFILE: home },
    })
    gate.child = child
    child.stdout?.on('data', chunk => gate.output.push(chunk))
    child.stderr?.on('data', chunk => gate.output.push(chunk))
    let done = false
    const finish = status => {
      if (done) return
      done = true
      running.delete(name)
      // A stray the gate left behind may still be writing into its HOME; a
      // leftover temp directory must not fail the chain.
      try { rmSync(home, { recursive: true, force: true, maxRetries: 3 }) } catch { /* leave it */ }
      const seconds = (performance.now() - startedAt) / 1000
      results.set(name, { name, status, seconds })
      if (!live) {
        process.stdout.write(header(name))
        process.stdout.write(Buffer.concat(gate.output))
      }
      console.log(`${status === 0 ? '✓' : '✗'} ${name}  ${fmt(seconds)}${status === 0 ? '' : ` (exit ${status})`}`)
      resolve()
    }
    child.on('error', error => {
      gate.output.push(Buffer.from(`verify:build: could not start ${name}: ${error.message}\n`))
      finish(1)
    })
    child.on('close', code => finish(code ?? 1))
    // A process the gate left behind can hold its output pipe open after the
    // gate itself exited; the serial chain never waited for such strays, so
    // the pool does not either.
    child.on('exit', code => setTimeout(() => {
      if (done) return
      child.stdout?.destroy()
      child.stderr?.destroy()
      finish(code ?? 1)
    }, 2000).unref())
  })
}

async function runPool(names, width) {
  const queue = [...names]
  await Promise.all(Array.from({ length: Math.min(width, queue.length) }, async () => {
    while (queue.length > 0) await runGate(queue.shift())
  }))
}

// Say which gates are still going, so a hung gate is visible before the CI
// job timeout instead of only in its buffered output.
const heartbeat = live ? undefined : setInterval(() => {
  const now = performance.now()
  const names = [...running].map(([name, gate]) => `${name} (${fmt((now - gate.startedAt) / 1000)})`)
  if (names.length > 0) console.log(`verify:build: still running — ${names.join(', ')}`)
}, 60_000)

/** Stop every running gate; with `report`, print what each had written so far. */
function stopRunning(signal, report) {
  for (const [name, gate] of running) {
    if (report && !live) {
      process.stdout.write(`${header(name)}(interrupted after ${fmt((performance.now() - gate.startedAt) / 1000)})\n`)
      process.stdout.write(Buffer.concat(gate.output))
    }
    try {
      if (live || process.platform === 'win32') gate.child?.kill(signal)
      else process.kill(-gate.child.pid, signal)
    } catch { /* already gone */ }
  }
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, () => {
    stopRunning('SIGTERM', true)
    process.exit(code)
  })
}
// Pooled gates run in their own process groups, so nothing else would stop
// them if this runner died on an unexpected error.
process.on('exit', () => stopRunning('SIGTERM', false))

console.log(`verify:build: ${GATES.length} gates, ${jobs} ${jobs === 1 ? 'job' : 'jobs'}`)
const wallStartedAt = performance.now()
await runPool(pooled, jobs)
for (const name of SERIAL) await runGate(name)
clearInterval(heartbeat)
const wall = (performance.now() - wallStartedAt) / 1000

const ordered = GATES.map(name => results.get(name))
const failed = ordered.filter(r => r.status !== 0)
const total = ordered.reduce((sum, r) => sum + r.seconds, 0)
const headline = `${ordered.length} gates, ${fmt(wall)} wall (${jobs} ${jobs === 1 ? 'job' : 'jobs'}, ${fmt(total)} summed)`
console.log(`\nverify:build — ${headline}`)
for (const { name, status, seconds } of ordered) {
  console.log(`  ${status === 0 ? '✓' : '✗'} ${name}  ${fmt(seconds)}${status === 0 ? '' : ` (exit ${status})`}`)
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    `### verify:build: ${headline}`,
    '',
    '| Result | Gate | Time |',
    '| --- | --- | ---: |',
    ...[...ordered].sort((a, b) => b.seconds - a.seconds)
      .map(r => `| ${r.status === 0 ? '✓' : `✗ exit ${r.status}`} | ${r.name} | ${fmt(r.seconds)} |`),
    '',
  ].join('\n'))
}

if (failed.length > 0) {
  console.error(`\nverify:build: ${failed.length}/${ordered.length} failed — ${failed.map(r => r.name).join(', ')}`)
  process.exit(1)
}
