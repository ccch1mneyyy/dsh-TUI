/**
 * DECSTBM Windows-terminal-stack gate — regression probes.
 *
 * The `win32 || WT_SESSION` exclusion in hasDecstbmScrollBug() has no other
 * CI coverage: all four required groups run on ubuntu (process.platform is
 * read-only, so the win32 half cannot be exercised there), the Windows
 * platform-smoke lane only installs and imports, and every repro script
 * sets DSH_TUI_FORCE_DECSTBM=1 — which bypasses this very gate. Deleting
 * the gate would leave every CI run green; these probes are its defense.
 *
 * Env probes run in spawned subprocesses (each import re-evaluates the
 * module-load SYNC constant and the live env reads), complete in seconds,
 * and need no terminal UI. Inherited env keys that could skew the
 * sync/JediTerm halves (tmux, kitty, Zed, VTE, a host WT_SESSION, leftover
 * FORCE) are scrubbed so the probes stay honest on any host.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

type Probe = { jet: boolean; sync: boolean; decstbm: boolean }

// Keys that could skew isSynchronizedOutputSupported / JediTerm detection
// in the child. Scrubbed before overrides are applied.
const SCRUB_KEYS = [
  'TMUX',
  'KITTY_WINDOW_ID',
  'ZED_TERM',
  'VTE_VERSION',
  'WT_SESSION',
  'DSH_TUI_FORCE_DECSTBM',
  'TERMINAL_EMULATOR',
  'TERM_PROGRAM',
] as const

function probeEnv(overrides: Record<string, string>): Probe {
  const terminalUrl = new URL('../src/ink/terminal.ts', import.meta.url).href
  const src = `
    const { isJetBrainsIdeTerminal, isSynchronizedOutputSupported, isDecstbmSafe } = await import(${JSON.stringify(terminalUrl)})
    console.log(JSON.stringify({
      jet: isJetBrainsIdeTerminal(),
      sync: isSynchronizedOutputSupported(),
      decstbm: isDecstbmSafe(),
    }))
  `
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color' }
  for (const key of SCRUB_KEYS) delete env[key]
  Object.assign(env, overrides)
  const res = spawnSync(process.execPath, ['--import', 'tsx/esm', '-e', src], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  })
  if (res.status !== 0) throw new Error(`probe failed: ${res.stderr}`)
  return JSON.parse(res.stdout.trim().split('\n').at(-1) ?? '{}') as Probe
}

// 1. The gate itself: WT_SESSION must exclude DECSTBM even with DEC 2026
//    support — one mis-applied region scroll shifts static chrome forever
//    (the persistent fullscreen-ghost class this gate exists to prevent).
const wt = probeEnv({ TERM_PROGRAM: 'WezTerm', WT_SESSION: 'ci-wt-session' })
check('WT_SESSION stack: sync on, DECSTBM excluded', wt.sync && !wt.decstbm)

// 2. The bypass env re-enables the fast path on that stack …
const wtForced = probeEnv({
  TERM_PROGRAM: 'WezTerm',
  WT_SESSION: 'ci-wt-session',
  DSH_TUI_FORCE_DECSTBM: '1',
})
check('DSH_TUI_FORCE_DECSTBM bypasses the Windows gate', wtForced.sync && wtForced.decstbm)

// 3. … WITHOUT weakening the JediTerm gate (the "only" in the bypass
//    contract, pinned: a global FORCE would turn this red).
const jbForced = probeEnv({
  TERMINAL_EMULATOR: 'JetBrains-JediTerm',
  WT_SESSION: 'ci-wt-session',
  DSH_TUI_FORCE_DECSTBM: '1',
})
check('FORCE does not weaken the JediTerm gate', jbForced.sync && jbForced.jet && !jbForced.decstbm)

// 4. … and without weakening the sync gate (a no-sync terminal stays
//    excluded even with FORCE set).
const noSyncForced = probeEnv({ DSH_TUI_FORCE_DECSTBM: '1' })
check('FORCE does not weaken the sync gate', !noSyncForced.sync && !noSyncForced.decstbm)

// 5. Baseline: a terminal without DEC 2026 never takes the fast path.
const plain = probeEnv({})
check('unknown terminal: no sync, no DECSTBM', !plain.sync && !plain.decstbm)

// 6. The win32 half of the gate (process.platform === 'win32') cannot be
//    asserted on linux CI — process.platform is read-only. Its coverage is
//    the Windows platform-smoke lane importing this module plus local runs
//    on Windows dev machines; recorded so nobody mistakes ubuntu green for
//    full-gate coverage.
check('win32 half documented (not assertable on this platform)', true, `platform=${process.platform}`)

console.log('')
if (failed > 0) {
  console.error(`verify-decstbm-gate: ${failed} FAILURE(S)`)
  process.exit(1)
}
console.log('verify-decstbm-gate: ALL PASS')
