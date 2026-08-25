/**
 * End-to-end recovery regression for the /update machinery (issues
 * #225/#479/#483), against the REAL compiled lib with REAL child
 * processes and a REAL filesystem — no network, everything sandboxed:
 *
 * - A fake `dsh` launcher sits first on PATH and replays a scripted
 *   exit-code/stderr plan, reproducing the pnpm failures verbatim:
 *   the deterministic Linux EEXIST tmp-rename collision (#479), the
 *   transient Windows ENOENT flavor (#225), and a genuine resolution
 *   error (404) that must NOT trigger any recovery.
 * - HOME/USERPROFILE/DSH_HOME point into a sandbox BEFORE the compiled
 *   module is imported, so the stale-install removal and the restart
 *   diagnostics only ever touch sandbox paths.
 * - The /update restart tail (now the hardened restartTui handoff)
 *   re-invokes THIS script as the replacement process; the child guard
 *   at the top records the env contract it received and exits 0.
 *
 * Scenarios:
 *   A  EEXIST on first run  -> stale install + staging dirs cleared,
 *      rerun succeeds, replacement receives DSH_TUI_UPDATED_FROM.
 *   B  transient ENOENT, plain retry fails EEXIST -> escalates to the
 *      same recovery (three dsh calls total).
 *   C  genuine 404 failure -> NO retry, NO destructive removal, the
 *      stale install stays intact for the manual repair path.
 *
 * Requires a prior build (imports ../lib/types/update.js).
 * Run: node scripts/verify-update-recovery.mjs
 */

// ---- child guard: this script re-invoked as the /update replacement ----
// Must run before any sandbox setup — the replacement only records the env
// contract (resume session id + updated-from stamp) and exits cleanly.
if (process.env.DSH_TUI_UPDATED_FROM !== undefined) {
  const out = process.env.DSH_TUI_RECOVERY_CHILD_MARKER
  if (out !== undefined) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(out, JSON.stringify({
      updatedFrom: process.env.DSH_TUI_UPDATED_FROM,
      resumeSession: process.env.DSH_TUI_RESUME_SESSION,
      legacyResume: process.env.DSH_CC_RESUME_SESSION,
    }))
  }
  process.exit(0)
}

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const repoVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
const isWindows = process.platform === 'win32'

// One sandbox root for the whole run: HOME/USERPROFILE redirect DATA_DIR
// (restart.log) into it, and each scenario gets its own DSH_HOME profile
// tree + fake-dsh script dir.
const sandbox = mkdtempSync(join(tmpdir(), 'verify-update-recovery-'))
const HOME_BACKUP = process.env.HOME
const USERPROFILE_BACKUP = process.env.USERPROFILE
const DSH_HOME_BACKUP = process.env.DSH_HOME
const PATH_BACKUP = process.env.PATH

// Redirect BEFORE importing the compiled module: utils/paths.js resolves
// DATA_DIR from the home dir at import time.
const fakeHome = join(sandbox, 'home')
mkdirSync(fakeHome, { recursive: true })
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome

const { updateTuiAndRestart } = await import('../lib/types/update.js')

const EEXIST_STDERR =
  "ERR_PNPM_EEXIST  EEXIST: file already exists, rename " +
  "'/root/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/node_modules' " +
  "-> '/root/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui_tmp_2424672_1/node_modules'"
const TRANSIENT_STDERR =
  "[ERR_PNPM_ENOENT] [importPackage D:\\p\\node_modules\\@deepseek-harness-tui\\dsh-tui] " +
  "ENOENT: no such file or directory, scandir 'D:\\p\\dsh-tui_tmp_40044_1\\node_modules'"
const REAL_FAILURE_STDERR =
  'ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/x: Not Found - 404'

/**
 * Lay out one scenario sandbox: a fake dsh on PATH replaying `plan`, and a
 * profile tree carrying a stale install plus leftover tmp staging dirs.
 */
function makeScenario(name, plan) {
  const dir = join(sandbox, name)
  const fakeDir = join(dir, 'fake-bin')
  const dshHome = join(dir, 'dsh-home')
  mkdirSync(fakeDir, { recursive: true })
  writeFileSync(join(fakeDir, 'plan.json'), JSON.stringify(plan))
  writeFileSync(join(fakeDir, 'calls'), '0')
  writeFileSync(
    join(fakeDir, 'fake-dsh.mjs'),
    `import { readFileSync, writeFileSync } from 'node:fs'\n` +
      `import { join } from 'node:path'\n` +
      `const dir = ${JSON.stringify(fakeDir)}\n` +
      `const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'))\n` +
      `const counter = join(dir, 'calls')\n` +
      `let n = 0\n` +
      `try { n = Number.parseInt(readFileSync(counter, 'utf8'), 10) } catch {}\n` +
      `writeFileSync(counter, String(n + 1))\n` +
      `const step = plan[n]\n` +
      `if (step === undefined) {\n` +
      `  process.stderr.write('fake-dsh: unexpected call\\\\n')\n` +
      `  process.exitCode = 99\n` +
      `} else {\n` +
      `  if (step.stderr !== undefined) process.stderr.write(step.stderr)\n` +
      `  process.exitCode = step.code\n` +
      `}\n`,
  )
  if (isWindows) {
    writeFileSync(
      join(fakeDir, 'dsh.cmd'),
      '@echo off\r\nnode "%~dp0fake-dsh.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n',
    )
  } else {
    writeFileSync(join(fakeDir, 'dsh'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-dsh.mjs" "$@"\n')
    chmodSync(join(fakeDir, 'dsh'), 0o755)
  }

  // Profile layout with the stale install + leftover staging (#479 shape).
  const scope = join(dshHome, 'profiles', 'dsh-tui', 'node_modules', '@deepseek-harness-tui')
  const stalePkg = join(scope, 'dsh-tui')
  mkdirSync(join(stalePkg, 'lib'), { recursive: true })
  writeFileSync(join(stalePkg, 'package.json'), JSON.stringify({ name: '@deepseek-harness-tui/dsh-tui', version: '0.8.7' }))
  mkdirSync(join(scope, 'dsh-tui_tmp_2424672_1'))
  writeFileSync(join(scope, 'dsh-tui_tmp_2424672_1', 'leftover'), 'x')
  // Neighbors that must survive every recovery.
  mkdirSync(join(scope, 'unrelated-pkg'))
  mkdirSync(join(scope, 'other_tmp_999_1'))

  return { name, dir, fakeDir, dshHome, scope, stalePkg, staging: join(scope, 'dsh-tui_tmp_2424672_1') }
}

async function runScenario(scenario, sessionId) {
  process.env.DSH_HOME = scenario.dshHome
  process.env.FAKE_DSH_DIR = scenario.fakeDir
  process.env.PATH = `${scenario.fakeDir}${delimiter}${PATH_BACKUP}`
  const childMarker = join(scenario.dir, 'child-marker.json')
  process.env.DSH_TUI_RECOVERY_CHILD_MARKER = childMarker
  const result = await updateTuiAndRestart(sessionId, 'dsh-tui')
  const calls = Number.parseInt(readFileSync(join(scenario.fakeDir, 'calls'), 'utf8'), 10)
  return { result, calls, childMarker }
}

function assertCleaned(label, scenario) {
  check(`${label}: stale package dir removed by the recovery`, !existsSyncSafe(scenario.stalePkg))
  check(`${label}: leftover tmp staging dir removed`, !existsSyncSafe(scenario.staging))
  check(
    `${label}: sibling packages and foreign tmp names survive`,
    existsSyncSafe(join(scenario.scope, 'unrelated-pkg')) && existsSyncSafe(join(scenario.scope, 'other_tmp_999_1')),
  )
}

function existsSyncSafe(path) {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

try {
  // ---- Scenario A: deterministic EEXIST (#479) ----
  // First call fails with the verbatim issue stderr; the recovery must
  // clear the stale install and rerun, and the rerun succeeds.
  {
    const scenario = makeScenario('a-eexist', [
      { code: 1, stderr: EEXIST_STDERR },
      { code: 0 },
    ])
    const { result, calls, childMarker } = await runScenario(scenario, 'session-a')
    check('A: update succeeds after recovery', result.updateCode === 0 && result.restartCode === 0,
      `updateCode=${result.updateCode} restartCode=${result.restartCode}`)
    check('A: exactly two dsh calls (fail + recovery rerun), no wasted plain retry', calls === 2, `calls=${calls}`)
    assertCleaned('A', scenario)
    // The hardened restart tail: the replacement received the stamp and the
    // dual-written resume contract, and exited 0 through the parent's wait.
    let child = undefined
    try {
      child = JSON.parse(readFileSync(childMarker, 'utf8'))
    } catch {}
    check(
      'A: replacement received DSH_TUI_UPDATED_FROM + resume contract',
      child !== undefined && child.updatedFrom === repoVersion
        && child.resumeSession === 'session-a' && child.legacyResume === 'session-a',
      `child=${JSON.stringify(child)}`,
    )
  }

  // ---- Scenario B: transient (#225) whose plain retry hits EEXIST (#479) ----
  // Plain retry first, then the failed retry escalates to the recovery.
  {
    const scenario = makeScenario('b-transient-then-eexist', [
      { code: 1, stderr: TRANSIENT_STDERR },
      { code: 1, stderr: EEXIST_STDERR },
      { code: 0 },
    ])
    const { result, calls } = await runScenario(scenario, 'session-b')
    check('B: update succeeds after escalation', result.updateCode === 0 && result.restartCode === 0,
      `updateCode=${result.updateCode} restartCode=${result.restartCode}`)
    check('B: three dsh calls (fail + retry + recovery rerun)', calls === 3, `calls=${calls}`)
    assertCleaned('B', scenario)
  }

  // ---- Scenario C: genuine resolution failure — no recovery may fire ----
  // A 404 is neither tmp-race signature; the run must fail through with the
  // resume hint and leave the profile untouched for the manual repair path.
  {
    const scenario = makeScenario('c-real-failure', [
      { code: 1, stderr: REAL_FAILURE_STDERR },
    ])
    const { result, calls, childMarker } = await runScenario(scenario, 'session-c')
    check('C: genuine failure propagates (update exit 1, no restart)', result.updateCode === 1 && result.restartCode === 1,
      `updateCode=${result.updateCode} restartCode=${result.restartCode}`)
    check('C: exactly one dsh call — no retry, no recovery', calls === 1, `calls=${calls}`)
    check(
      'C: stale install left intact (recovery never fires on real errors)',
      existsSyncSafe(scenario.stalePkg) && existsSyncSafe(scenario.staging),
    )
    check('C: no replacement spawned', !existsSyncSafe(childMarker))
  }
} finally {
  if (HOME_BACKUP === undefined) delete process.env.HOME
  else process.env.HOME = HOME_BACKUP
  if (USERPROFILE_BACKUP === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = USERPROFILE_BACKUP
  if (DSH_HOME_BACKUP === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = DSH_HOME_BACKUP
  process.env.PATH = PATH_BACKUP
  delete process.env.FAKE_DSH_DIR
  delete process.env.DSH_TUI_RECOVERY_CHILD_MARKER
  rmSync(sandbox, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
