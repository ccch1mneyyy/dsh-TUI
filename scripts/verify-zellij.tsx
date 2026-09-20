/**
 * zellij compatibility regression (DECSTBM withdrawal).
 *
 * Real-terminal report: inside zellij, ScrollBox scrolls leave stale rows —
 * tearing and leftover transcript lines that accumulate as content scrolls.
 * zellij's grid handling deviates from xterm in exactly the two sequences the
 * hardware-scroll optimization leans on:
 *
 *  - `CSI T` (grid.rs rotate_scroll_region_up) shifts rows only while the
 *    cursor sits inside the scroll region, and `CSI r` does not home the
 *    cursor outside origin mode — but the renderer parks the cursor on the
 *    last screen row, below every ScrollBox. The shift is silently dropped
 *    while the diff engine assumes it happened, so stale rows survive every
 *    scroll-up frame.
 *  - zellij DOES implement DEC 2026 synchronized output, so only DECSTBM is
 *    withdrawn: BSU/ESU stay on and frames remain atomic.
 *
 * Hermetic environment: the probed module reads every capability marker
 * straight from `process.env` and freezes SYNC_OUTPUT_SUPPORTED at import, so
 * a probe that inherits the host environment reports the machine the script
 * happens to run on rather than the scenario — with TMUX set the zellij
 * assertion goes red on a host that has nothing to do with zellij, and a
 * matching host marker can equally mask a real regression (nothing about this
 * file is zellij-specific except the marker it sets). Every scenario below
 * therefore OWNS its terminal environment: it starts from the host env with
 * each marker stripped and applies the scenario explicitly. The child echoes
 * back the markers it actually observed so the parent can assert the scenario
 * arrived unmodified; leaked markers fail loudly instead of silently flipping
 * a check.
 *
 * The strip list is drift-guarded: PROBE_ENV_KEYS must cover every
 * `process.env.<NAME>` read in src/ink/terminal.ts (plus the utils/env.ts shim
 * it imports), and the guard fails with the offending name when the module
 * starts reading a new marker — an unlisted marker would leak from the host
 * again. All four capability assertions read only env-derived state, so the
 * script is platform-independent and a local run and a CI run agree.
 *
 * Asserts (capability probe, same harness as verify-jediterm.tsx):
 *  1. isZellij() reads the ZELLIJ env var.
 *  2. Under ZELLIJ=1: sync output stays enabled (DEC 2026 kept).
 *  3. Under ZELLIJ=1: DECSTBM is excluded even though sync is on.
 *  4. Without ZELLIJ (plain xterm-ish env): sync + DECSTBM both stay on.
 *  5. Each scenario reaches the probe unmodified (no host env leakage).
 *
 * Run: node --import tsx/esm scripts/verify-zellij.tsx
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Repo root, so `--import tsx/esm` resolves no matter where the script is
// invoked from.
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// ---- hermetic terminal environment -----------------------------------------
// Every marker the probed module (or its env shim) can read. Scenarios declare
// the ones they need; the rest are deleted from the child env so the host
// cannot vote on the result.
const PROBE_ENV_KEYS = [
  'ZELLIJ',
  'TMUX',
  'TERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERMINAL_EMULATOR',
  'WT_SESSION',
  'KITTY_WINDOW_ID',
  'ZED_TERM',
  'VTE_VERSION',
  'ConEmuANSI',
  'ConEmuPID',
  'ConEmuTask',
  'DSH_TUI_RENDER_LOG',
]

/** Terminal markers a scenario pins; `undefined` means "explicitly absent". */
type Scenario = Record<string, string | undefined>

type ProbeResult = {
  zellij: boolean
  sync: boolean
  decstbm: boolean
  /** What the child process actually saw, one entry per PROBE_ENV_KEYS. */
  observed: Record<string, string | null>
}

/** Host env minus every terminal marker: the blank slate scenarios start from. */
function scrubbedHostEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !PROBE_ENV_KEYS.includes(key)) env[key] = value
  }
  return env
}

const HOST_ENV = scrubbedHostEnv()

function checkProbeEnvCoversModule(): void {
  const sources = [
    new URL('../src/ink/terminal.ts', import.meta.url),
    new URL('../src/utils/env.ts', import.meta.url),
  ]
  const known = new Set(PROBE_ENV_KEYS)
  const missing = new Set<string>()
  for (const source of sources) {
    for (const match of readFileSync(source, 'utf8').matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const name = match[1] ?? ''
      if (!known.has(name)) missing.add(name)
    }
  }
  check(
    'PROBE_ENV_KEYS covers every marker the probed module reads',
    missing.size === 0,
    missing.size > 0 ? `missing: ${[...missing].join(', ')}` : `${PROBE_ENV_KEYS.length} markers`,
  )
}

// ---- capability wiring (SYNC_OUTPUT_SUPPORTED is computed at import) -------
function probeEnv(scenario: Scenario): ProbeResult {
  const env: Record<string, string> = { ...HOST_ENV }
  for (const [key, value] of Object.entries(scenario)) {
    if (value !== undefined) env[key] = value
  }

  const terminalUrl = new URL('../src/ink/terminal.ts', import.meta.url).href
  const src = `
    const { isZellij, isSynchronizedOutputSupported, isDecstbmSafe } = await import(${JSON.stringify(terminalUrl)})
    const observed = {}
    for (const key of ${JSON.stringify(PROBE_ENV_KEYS)}) observed[key] = process.env[key] ?? null
    console.log(JSON.stringify({
      zellij: isZellij(),
      sync: isSynchronizedOutputSupported(),
      decstbm: isDecstbmSafe(),
      observed,
    }))
  `
  const res = spawnSync(process.execPath, ['--import', 'tsx/esm', '-e', src], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  })
  if (res.status !== 0) throw new Error(`probe failed: ${res.stderr}`)
  return JSON.parse(res.stdout.trim().split('\n').at(-1) ?? '{}') as ProbeResult
}

/**
 * The probe must have seen exactly the scenario — every marker the scenario
 * does not name has to be absent, which is what proves the host environment
 * (TMUX, WT_SESSION, TERMINAL_EMULATOR, …) was actually stripped.
 */
function checkScenarioReachedProbe(label: string, result: ProbeResult, scenario: Scenario): void {
  const leaked = PROBE_ENV_KEYS.filter(key => (result.observed[key] ?? null) !== (scenario[key] ?? null))
    .map(key => `${key}=${JSON.stringify(result.observed[key])} (scenario: ${JSON.stringify(scenario[key] ?? null)})`)
  check(`${label}: scenario env reaches the probe unmodified`, leaked.length === 0, leaked.join(', '))
}

checkProbeEnvCoversModule()

// zellij multiplexes the outer terminal instead of emulating it, so the sync
// probe describes the OUTER terminal's DEC 2026 support. Pin TERM_PROGRAM to
// a known-sync terminal (vscode) as the controlled premise: that isolates the
// zellij DECSTBM withdrawal from whatever terminal the script itself runs in.
const ZELLIJ_SCENARIO: Scenario = { ZELLIJ: '1', TERM_PROGRAM: 'vscode' }
// The same premise without zellij, so the DECSTBM assertion above has a
// control: ZELLIJ is explicitly unset, not merely left to the host.
const PLAIN_SCENARIO: Scenario = { ZELLIJ: undefined, TERM_PROGRAM: 'vscode' }

const zellij = probeEnv(ZELLIJ_SCENARIO)
checkScenarioReachedProbe('zellij', zellij, ZELLIJ_SCENARIO)
check('zellij detected via ZELLIJ env', zellij.zellij)
check('sync output (DEC 2026) stays enabled under zellij', zellij.zellij && zellij.sync)
check('DECSTBM excluded under zellij', zellij.zellij && !zellij.decstbm)

const plain = probeEnv(PLAIN_SCENARIO)
checkScenarioReachedProbe('no-zellij', plain, PLAIN_SCENARIO)
check('same outer terminal without zellij keeps DECSTBM', plain.sync && plain.decstbm)

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nzellij DECSTBM regression: all checks passed')
