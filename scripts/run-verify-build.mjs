#!/usr/bin/env node
/**
 * The `verify:build` chain: every gate in GATES, in order, under one
 * throwaway HOME, then a ✓/✗ summary with timings.
 *
 * Each gate is a package.json script name, so every gate stays runnable on
 * its own (`pnpm verify:<name>`); this list only decides membership and
 * order. Register a new gate by adding its name here.
 *
 * All gates run even after a failure — a fail-fast chain hides every later
 * failure behind the first one (the same reason run-ci-group.mjs collects
 * instead of stopping, #466). The exit code is non-zero if any gate failed.
 *
 * Gates run their package.json command directly through the shell rather
 * than `npm run`, which would start a fresh npm per gate: seconds of
 * overhead and an `npm notice` banner in between every result.
 *
 * Why the HOME sandbox: the chain mounts the real composer in dozens of
 * fixtures, and any of them can append fixture text to the developer's real
 * `~/.dsh-tui/history.jsonl` — which `↑` walks (#986). CI runners are
 * disposable, so this only ever hurt local runs. The sandbox is shared by the
 * whole chain on purpose: scripts may keep sharing state exactly as they do on
 * a CI runner — they just no longer share the user's.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GATES = [
  'verify:boundary',
  'verify:agent-domain',
  'verify:contract',
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
  'verify:packaged-presets',
  'verify:history-search',
  'verify:initial-prompt',
  'verify:minimal-preset-tools',
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
  'verify:renderer-primitives',
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

const root = new URL('..', import.meta.url)
const scripts = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).scripts ?? {}
const unknown = GATES.filter(name => typeof scripts[name] !== 'string')
if (unknown.length > 0) {
  console.error(`verify:build: no package.json script for ${unknown.join(', ')}`)
  process.exit(1)
}

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-verify-home-'))
const results = []
try {
  for (const name of GATES) {
    console.log(`\n> ${name}\n> ${scripts[name]}\n`)
    const startedAt = performance.now()
    const r = spawnSync(scripts[name], {
      cwd: root,
      stdio: 'inherit',
      shell: true,
      // HOME on POSIX, USERPROFILE on Windows: DATA_DIR resolves from
      // `os.homedir()`, so both have to move together.
      env: { ...process.env, HOME: home, USERPROFILE: home },
    })
    results.push({ name, status: r.status ?? 1, seconds: (performance.now() - startedAt) / 1000 })
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}

const fmt = seconds => `${seconds.toFixed(1)}s`
const failed = results.filter(r => r.status !== 0)
const total = results.reduce((sum, r) => sum + r.seconds, 0)
console.log(`\nverify:build — ${results.length} gates, ${fmt(total)}`)
for (const { name, status, seconds } of results) {
  console.log(`  ${status === 0 ? '✓' : '✗'} ${name}  ${fmt(seconds)}${status === 0 ? '' : ` (exit ${status})`}`)
}

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    `### verify:build: ${results.length} gates, ${fmt(total)}`,
    '',
    '| Result | Gate | Time |',
    '| --- | --- | ---: |',
    ...[...results].sort((a, b) => b.seconds - a.seconds)
      .map(r => `| ${r.status === 0 ? '✓' : `✗ exit ${r.status}`} | ${r.name} | ${fmt(r.seconds)} |`),
    '',
  ].join('\n'))
}

if (failed.length > 0) {
  console.error(`\nverify:build: ${failed.length}/${results.length} failed — ${failed.map(r => r.name).join(', ')}`)
  process.exit(1)
}
