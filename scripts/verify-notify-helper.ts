/**
 * The jump-back helper's build cache: the first call compiles
 * `activate.cs` with the in-box .NET Framework csc, later calls reuse the
 * executable, and a cache key that no longer matches the source - or a
 * compiler that moved - rebuilds it.
 *
 * Every path is redirected into a throwaway home before the module is imported:
 * `DATA_DIR` is a module-level constant, so the executable this suite builds
 * can never land in the user's profile. The source is shipped, not
 * modified: "the source changed" is simulated by planting a cache key that no
 * longer matches, which is exactly the pair the key compares.
 *
 * Windows-only. On a POSIX host, or a Windows machine without the in-box csc,
 * the suite prints one `skip:` line and exits 0 - loudly, never silently green.
 *
 * Run: node --import tsx/esm scripts/verify-notify-helper.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-notify-helper-'))
const sandboxHome = join(sandbox, 'home')
mkdirSync(sandboxHome)
// `DATA_DIR` and the cache paths built from it are module-level constants: the
// redirect has to be in place before the import, or this suite compiles into
// the user's real profile.
process.env.HOME = sandboxHome
process.env.USERPROFILE = sandboxHome
process.env.DSH_HOME = join(sandbox, 'dsh-home')
process.on('exit', () => {
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* the fixture is gone already */ }
})

const { DATA_DIR } = await import('../src/utils/paths.js')
const { ensureHelper } = await import('../src/ink/notify-helper/compile.js')

const HELPER_EXE = join(DATA_DIR, 'notify', 'helper', 'activate.exe')
const HELPER_HASH = `${HELPER_EXE}.hash`
/** The Windows directory the module resolves csc from; saved so cases can move it. */
const REAL_WINDOWS_ROOT = process.env.WINDIR ?? process.env.SystemRoot

async function captureDebug<T>(body: () => T | Promise<T>): Promise<{ result: T, lines: string[] }> {
  const realWrite = process.stderr.write.bind(process.stderr)
  const lines: string[] = []
  const previous = process.env.DSH_TUI_DEBUG
  process.env.DSH_TUI_DEBUG = '1'
  process.stderr.write = ((chunk: unknown): boolean => {
    lines.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    return { result: await body(), lines }
  } finally {
    process.stderr.write = realWrite
    if (previous === undefined) delete process.env.DSH_TUI_DEBUG
    else process.env.DSH_TUI_DEBUG = previous
  }
}

/**
 * The module resolves csc per call, so the missing and failing compiler paths are
 * reachable in-process.
 * @returns The body's result.
 */
async function withWindowsRoot<T>(root: string, body: () => Promise<T>): Promise<T> {
  const savedWindir = process.env.WINDIR
  process.env.WINDIR = root
  try {
    return await body()
  } finally {
    if (savedWindir === undefined) delete process.env.WINDIR
    else process.env.WINDIR = savedWindir
  }
}

function skipped(reason: string): false {
  process.stdout.write(`skip: ${reason}\n`)
  return false
}

let passed = 0
async function check(name: string, body: () => void | Promise<void>): Promise<void> {
  await body()
  passed += 1
  process.stdout.write(`ok ${passed} - ${name}\n`)
}

/**
 * @returns Whether the compile/cache assertions ran (false when the machine
 *   cannot build the helper at all).
 */
async function main(): Promise<boolean> {
  if (process.platform !== 'win32') {
    const { result, lines } = await captureDebug(() => ensureHelper())
    await check('off Windows the helper is never built', () => {
      assert.equal(result, undefined, 'a POSIX process must not try to run csc')
      assert.match(lines.join(''), /only exists on Windows/u, 'and the reason is in the debug log')
    })
    return skipped(`the notify helper needs Windows and the in-box .NET Framework csc (platform: ${process.platform})`)
  }

  // The first call is also the machine probe: if this host has no in-box csc at
  // all, there is nothing to assert about compiling and the suite says so out
  // loud. A build that fails with a compiler present is a real failure.
  const first = await captureDebug(() => ensureHelper())
  if (first.result === undefined) {
    const log = first.lines.join('')
    if (!/in-box csc not found/u.test(log)) {
      assert.fail(`the helper failed to build although a compiler lookup succeeded: ${log.trim()}`)
    }
    await check('a machine without the in-box csc answers undefined instead of throwing', () => {
      assert.match(log, /in-box csc not found/u)
    })
    return skipped(`no in-box .NET Framework csc under ${REAL_WINDOWS_ROOT ?? 'an empty environment'}`)
  }
  const exePath = first.result
  assert.equal(exePath, HELPER_EXE, 'the module and this suite must name the same executable')

  await check('the first call compiles the helper into the throwaway profile', () => {
    assert.equal(exePath, HELPER_EXE)
    assert.ok(existsSync(HELPER_EXE), 'the executable is the thing the probe will spawn')
    assert.ok(statSync(HELPER_EXE).size > 0, 'an empty file would be a broken helper')
    assert.ok(existsSync(HELPER_HASH), 'the cache key is written next to the executable')
    assert.match(first.lines.join(''), /notify helper: compiled/u, 'and the build is recorded, not silent')
    const [sourceHash, compiler] = readFileSync(HELPER_HASH, 'utf8').split('\n')
    assert.match(sourceHash, /^[0-9a-f]{64}$/u, 'the key carries the source content hash (D5)')
    assert.equal(basename(compiler), 'csc.exe', 'and the compiler that built it, so a framework move rebuilds')
    assert.ok(existsSync(compiler), 'the key names a compiler that really exists')
  })
  await check('the candidate table accepts one associated target and rejects unrelated hits', () => {
    const selftest = spawnSync(HELPER_EXE, ['--selftest-candidates'], { encoding: 'utf8', timeout: 15_000 })
    assert.equal(selftest.status, 0, `the helper's own decision table must agree: ${selftest.stdout}${selftest.stderr}`)
    assert.match(selftest.stdout, /candidate selftest passed/u, 'a silent pass would not prove the table ran')
  })
  const builtKey = readFileSync(HELPER_HASH, 'utf8')

  await check('a second call reuses the executable without compiling', async () => {
    const mtime = statSync(HELPER_EXE).mtimeMs
    const second = await captureDebug(() => ensureHelper())
    assert.equal(second.result, HELPER_EXE)
    assert.equal(statSync(HELPER_EXE).mtimeMs, mtime, 'a warm cache must not rewrite the executable')
    assert.equal(readFileSync(HELPER_HASH, 'utf8'), builtKey, 'nor its key')
    assert.doesNotMatch(second.lines.join(''), /notify helper: compiled/u, 'no csc process is started for a warm cache')
  })

  await check('a missing cache key rebuilds instead of trusting the executable', async () => {
    rmSync(HELPER_HASH)
    const rebuilt = await captureDebug(() => ensureHelper())
    assert.equal(rebuilt.result, HELPER_EXE)
    assert.match(rebuilt.lines.join(''), /notify helper: compiled/u, 'without its key the executable is not provably current')
    assert.equal(readFileSync(HELPER_HASH, 'utf8'), builtKey, 'and the key is restored to the pair that built this executable')
  })

  await check('a key that no longer matches the source rebuilds', async () => {
    writeFileSync(HELPER_HASH, 'stale\nkey\n')
    const rebuilt = await captureDebug(() => ensureHelper())
    assert.equal(rebuilt.result, HELPER_EXE)
    assert.match(rebuilt.lines.join(''), /notify helper: compiled/u, 'a package update must not run a stale executable')
    assert.equal(readFileSync(HELPER_HASH, 'utf8'), builtKey)
  })

  await check('a machine with no in-box csc answers undefined and says why', async () => {
    const emptyRoot = join(sandbox, 'no-windows')
    mkdirSync(emptyRoot)
    const missing = await withWindowsRoot(emptyRoot, () => captureDebug(() => ensureHelper()))
    assert.equal(missing.result, undefined, 'the caller degrades to a plain toast; it must not throw')
    assert.match(missing.lines.join(''), /in-box csc not found/u)
  })

  await check('a csc that cannot build the helper answers undefined, logs, and leaves no executable', async () => {
    // A real (tiny) in-box executable stands in for a compiler that runs and
    // exits non-zero: the module has to treat that as a failed build, not as a
    // usable cache entry. `reg.exe` is small, always present, and exits 1 on
    // compiler switches.
    const fakeRoot = join(sandbox, 'fake-windows')
    const fakeCsc = join(fakeRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
    mkdirSync(dirname(fakeCsc), { recursive: true })
    assert.ok(REAL_WINDOWS_ROOT !== undefined, 'the fixture needs a real Windows directory to copy the stand-in compiler from')
    copyFileSync(join(REAL_WINDOWS_ROOT, 'System32', 'reg.exe'), fakeCsc)
    const failed = await withWindowsRoot(fakeRoot, () => captureDebug(() => ensureHelper()))
    assert.equal(failed.result, undefined, 'a failed build degrades instead of rejecting')
    assert.match(failed.lines.join(''), /notify helper: csc failed/u, 'the stage is in the log')
    assert.equal(existsSync(HELPER_EXE), false, 'a half-written executable must never look like a cache hit')
  })

  return true
}

const ran = await main()
rmSync(sandbox, { recursive: true, force: true })
if (ran) process.stdout.write(`notify helper regression passed (${passed} checks)\n`)
