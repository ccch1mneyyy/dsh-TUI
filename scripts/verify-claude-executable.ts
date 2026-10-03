/**
 * `claude` executable resolution (docs/agent-backend-design.md §4.2): which
 * PATH hit this backend may hand to the SDK — offline, no CLI, no network.
 *
 *  - a candidate only wins when THIS process can spawn it (`--version`
 *    through the same execFile path the SDK uses). An npm install publishes
 *    the package bin as wrappers (an extensionless POSIX `sh` script first,
 *    a `.cmd` second), neither of which Windows can run without a shell —
 *    so "the file exists" is not enough, and handing one to the SDK fails
 *    the whole start with its own misleading "native binary … failed to
 *    launch";
 *  - a wrapper that merely forwards to the real binary is FOLLOWED instead
 *    of skipped, so a Windows npm install still runs the user's own CLI
 *    (its version and session store) rather than silently switching to the
 *    SDK's bundled copy;
 *  - a candidate that spawns but reports no version loses too, and one that
 *    hangs is skipped after the probe's bounded timeout (POSIX fixture;
 *    Windows has no spawnable hang without a compiler) — never waited for;
 *  - nothing spawnable anywhere on PATH → no path at all, which is how the
 *    SDK is told to use its own bundled binary (the documented last resort);
 *  - `CLAUDE_CODE_EXECUTABLE` still wins verbatim and stays unvalidated: a
 *    typo the user made should fail loudly, not silently change binaries.
 *
 * Run: node --import tsx/esm scripts/verify-claude-executable.ts
 */
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { resolveClaudeExecutable } from '../src/backends/claude/process.js'

let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

const win = process.platform === 'win32'
const root = mkdtempSync(join(tmpdir(), 'dsh-tui-claude-exe-'))
const originalPath = process.env.PATH
// The lookup tool itself has to stay reachable; everything else is fenced
// off so this machine's own `claude` cannot decide the outcome.
const systemRoot = process.env.SystemRoot ?? 'C:/Windows'
const systemPath = win ? join(systemRoot, 'System32') : '/usr/bin:/bin'
const dir = (name: string): string => {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  return path
}
const withPath = (...entries: string[]): void => { process.env.PATH = [...entries, systemPath].join(delimiter) }

/** A `claude` this process can really spawn: node prints `v<major>.<minor>.<patch>` for `--version`. */
const spawnableClaude = (target: string): string => {
  copyFileSync(process.execPath, target)
  if (!win) chmodSync(target, 0o755)
  return target
}

/**
 * A `claude` that exists and still cannot be spawned: on Windows the
 * extensionless npm wrapper is exactly this shape (a POSIX script `where`
 * reports first), on POSIX a `+x` script whose interpreter is missing.
 */
const deadClaude = (target: string, text = '#!/nonexistent/dsh-tui-interpreter\n'): string => {
  writeFileSync(target, text)
  if (!win) chmodSync(target, 0o755)
  return target
}

/** The npm wrapper shape: a shell script that execs the packaged binary. */
const forwardingClaude = (target: string, realName: string): string =>
  deadClaude(target, `#!/bin/sh\nbasedir=$(dirname "$0")\nexec "$basedir/${realName}" "$@"\n`)

/** A `claude` that spawns but reports no version the probe accepts. */
const versionlessClaude = (target: string): string => {
  if (win) copyFileSync(join(systemRoot, 'System32', 'where.exe'), target)
  else deadClaude(target, '#!/bin/sh\necho definitely not a claude version\n')
  return target
}

try {
  // ── a dead wrapper earlier on PATH must not shadow a working binary ────
  {
    const dead = dir('dead-first')
    const live = dir('live-second')
    const deadPath = deadClaude(join(dead, 'claude'))
    const livePath = spawnableClaude(join(live, win ? 'claude.exe' : 'claude'))
    withPath(dead, live)
    const resolved = await resolveClaudeExecutable({})
    check('a PATH hit that cannot be spawned is skipped', resolved.path !== deadPath, resolved)
    check('the next PATH binary that really launches wins', resolved.source === 'path' && resolved.path === livePath, resolved)
  }

  // ── a candidate that runs but reports no version loses too ─────────────
  {
    const versionless = dir('versionless')
    const live = dir('live-after-versionless')
    versionlessClaude(join(versionless, win ? 'claude.exe' : 'claude'))
    const livePath = spawnableClaude(join(live, win ? 'claude.exe' : 'claude'))
    withPath(versionless, live)
    const resolved = await resolveClaudeExecutable({})
    check('a candidate that spawns but reports no version is skipped', resolved.source === 'path' && resolved.path === livePath, resolved)
  }

  // ── nothing spawnable → no path at all (the SDK's bundled binary) ──────
  {
    const dead = dir('dead-only')
    deadClaude(join(dead, 'claude'))
    withPath(dead)
    const resolved = await resolveClaudeExecutable({})
    check('no spawnable candidate leaves the path to the SDK bundle', resolved.source === 'bundled' && resolved.path === undefined, resolved)
  }

  // ── a forwarding wrapper is followed to the binary it names ────────────
  {
    const shim = dir('npm-shape')
    const wrapperPath = forwardingClaude(join(shim, 'claude'), 'claude-real.exe')
    const realPath = spawnableClaude(join(shim, 'claude-real.exe'))
    withPath(shim)
    const resolved = await resolveClaudeExecutable({})
    // Windows cannot spawn the wrapper, so it must resolve through it; POSIX
    // spawns the wrapper itself, which then execs the same binary.
    const expected = win ? realPath : wrapperPath
    check('a forwarding wrapper still yields the user CLI', resolved.source === 'path' && resolved.path === expected, resolved)
  }

  // ── a hung candidate is skipped after the probe's bounded timeout ──────
  if (win) {
    console.log('SKIP a hung candidate is skipped after the bounded probe (no spawnable hang fixture on Windows without a compiler)')
  } else {
    const hang = dir('hang-only')
    deadClaude(join(hang, 'claude'), '#!/bin/sh\nsleep 30\n')
    withPath(hang)
    const started = Date.now()
    const resolved = await resolveClaudeExecutable({})
    check('a hung candidate is skipped after the bounded probe, then the SDK bundle', resolved.source === 'bundled' && resolved.path === undefined && Date.now() - started >= 9000, resolved)
  }

  // ── CLAUDE_CODE_EXECUTABLE: explicit wins, and is never second-guessed ──
  {
    const dead = dir('env-dead')
    const warned = deadClaude(join(dead, 'claude'))
    const live = spawnableClaude(join(dir('env-live'), win ? 'claude.exe' : 'claude'))
    withPath(dead)
    const configured = await resolveClaudeExecutable({ CLAUDE_CODE_EXECUTABLE: live })
    check('CLAUDE_CODE_EXECUTABLE wins over PATH', configured.source === 'env' && configured.path === live, configured)
    const typo = await resolveClaudeExecutable({ CLAUDE_CODE_EXECUTABLE: warned })
    check('a dead explicit path is returned as-is (fails loudly, not silently)', typo.source === 'env' && typo.path === warned, typo)
  }
} finally {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  rmSync(root, { recursive: true, force: true })
}

console.log(`\nverify-claude-executable OK (${passed} checks)`)
