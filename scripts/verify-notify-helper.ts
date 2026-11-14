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
 * The same executable is then driven the way the shell drives it. The click
 * contract lives between two languages - the TUI writes the marker records and
 * their `pid`, the C# side reads them - and neither compiler sees the other end,
 * so only a real run proves the record scan, the liveness gate and the argv rules.
 *
 * Windows-only. On a POSIX host, or a Windows machine without the in-box csc,
 * the suite prints one `skip:` line and exits 0 - loudly, never silently green.
 *
 * Run: node --import tsx/esm scripts/verify-notify-helper.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

/**
 * A marker only this suite writes: no terminal title carries it, so a case that
 * fell through to the pane path would find nothing instead of touching a window.
 */
const CLICK_MARKER = 'verify-click-path'

/** Part of the record the TUI writes, but no click reads it; any value proves that. */
const RECORD_STARTED_AT = '2026-01-01T12:00:00.000Z'

/** The record directory the TUI writes and the helper scans. */
function recordsDir(directory: string): string {
  return join(directory, 'notify', 'jumpback')
}

/** One throwaway data directory per case, so records cannot leak between them. */
function clickDataDir(): string {
  return mkdtempSync(join(sandbox, 'click-'))
}

/**
 * One marker record as the TUI writes it. `schemaVersion` and `startedAt` belong to
 * that shape on purpose: the helper has to ignore them, and a case that renames or
 * drops a field is asserting exactly which fields the click reads.
 */
function writeRecord(directory: string, fileName: string, body: Record<string, unknown>): void {
  mkdirSync(recordsDir(directory), { recursive: true })
  writeFileSync(join(recordsDir(directory), fileName), JSON.stringify(body))
}

/**
 * A pid that is certain to be gone when the helper looks it up: a child process
 * that has already exited. The click must learn "gone" from the process table, and
 * a live pid here would let it move a real window - the one thing these cases must
 * never do. The fallback is past any real pid, so the lookup still fails.
 */
function exitedPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8', timeout: 15_000 })
  return typeof child.pid === 'number' && child.pid > 0 ? child.pid : 2_147_483_600
}

/**
 * One run of the built helper. stdout and stderr are joined because the helper
 * leaves its stages on stdout and the usage text on stderr; the contract is the
 * pair of them, not one channel.
 */
function runHelper(args: string[]): { status: number | null, out: string } {
  const run = spawnSync(HELPER_EXE, args, { encoding: 'utf8', timeout: 15_000 })
  return { status: run.status, out: `${run.stdout ?? ''}${run.stderr ?? ''}` }
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
    // On the Windows CI lane a missing compiler is a broken runner for this
    // feature, not a reason to report green: the whole suite would skip.
    if (process.env.CI !== undefined && process.env.CI !== '') {
      assert.fail(`this Windows CI lane has no in-box .NET Framework csc under ${REAL_WINDOWS_ROOT ?? 'an empty environment'}`)
    }
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

  // The click is driven end to end from here, one small directory per case. These
  // are the only assertions that run the executable the shell really starts: the
  // record scan, the liveness gate and the argv rules sit between two languages,
  // where neither compiler can see a drift. The field-name case comes first because
  // every case below reads a record with the writer's own names: when that pairing
  // breaks, this is the case that has to say so.
  await check('a record whose pid field was renamed names no process', () => {
    // The field name is the whole contract between the writer and the reader:
    // nothing checks it across the two languages, so only a record with the drifted
    // name can prove the C# side still reads `pid` and does not fall back silently.
    const dataDir = clickDataDir()
    writeRecord(dataDir, 'session.json', {
      schemaVersion: 1,
      marker: CLICK_MARKER,
      ProcessId: exitedPid(),
      startedAt: RECORD_STARTED_AT,
    })
    const run = runHelper(['--activate', CLICK_MARKER, '-DataDir', dataDir])
    assert.equal(run.status, 3, `a record without a pid has no target: ${run.out}`)
    assert.match(run.out, /route=invalid/u, 'the record names no process, so the click refuses it')
    assert.doesNotMatch(run.out, /stage=liveness/u, 'and it must never reach the process check with a guessed pid')
  })

  await check('a click whose recorded process is gone moves no window', () => {
    const dataDir = clickDataDir()
    writeRecord(dataDir, 'session.json', {
      schemaVersion: 1,
      marker: CLICK_MARKER,
      pid: exitedPid(),
      startedAt: RECORD_STARTED_AT,
    })
    const run = runHelper(['--activate', CLICK_MARKER, '-DataDir', dataDir])
    assert.equal(run.status, 3, `a gone pid is an unreachable target: ${run.out}`)
    assert.match(run.out, /stage=liveness ok=false/u, 'the click must name the process it cannot go back to')
    assert.doesNotMatch(run.out, /stage=restore/u, 'a gone process must not have its window restored')
    assert.doesNotMatch(run.out, /stage=foreground/u, 'nor brought to the foreground')
  })

  await check('one process with several sessions is one click target', () => {
    // The marker names the process, not the session: a process that started a second session
    // leaves one record per session, all with the same marker and pid. They are one target.
    const dataDir = clickDataDir()
    const pid = process.pid
    writeRecord(dataDir, 'first.json', { schemaVersion: 1, marker: CLICK_MARKER, pid, startedAt: RECORD_STARTED_AT })
    writeRecord(dataDir, 'second.json', { schemaVersion: 1, marker: CLICK_MARKER, pid, startedAt: RECORD_STARTED_AT })
    const run = runHelper(['--activate', CLICK_MARKER, '-DataDir', dataDir])
    assert.match(run.out, /route=record/u, 'the sessions of one process still name that process')
    assert.doesNotMatch(run.out, /route=ambiguous/u, 'and must not be refused as a tie')
    assert.match(run.out, /stage=liveness ok=true/u, 'the live pid passes the gate')
  })

  await check('two different processes behind one marker are refused', () => {
    const dataDir = clickDataDir()
    const first = exitedPid()
    let second = exitedPid()
    if (second === first) second = first === 2_147_483_600 ? 2_147_483_599 : first + 1
    writeRecord(dataDir, 'first.json', { schemaVersion: 1, marker: CLICK_MARKER, pid: first, startedAt: RECORD_STARTED_AT })
    writeRecord(dataDir, 'second.json', { schemaVersion: 1, marker: CLICK_MARKER, pid: second, startedAt: RECORD_STARTED_AT })
    const run = runHelper(['--activate', CLICK_MARKER, '-DataDir', dataDir])
    assert.equal(run.status, 3, `two processes behind one marker are not a target: ${run.out}`)
    assert.match(run.out, /route=ambiguous/u, 'the click must refuse the tie before it looks at any window')
  })

  await check('a record with no usable pid names no process', () => {
    // Two ways a record can name no process - the field is absent, or it holds a value
    // that cannot be a pid - so each is planted in full and named for its failure.
    const cases = [
      { name: 'missing pid', record: { schemaVersion: 1, marker: CLICK_MARKER, startedAt: RECORD_STARTED_AT } },
      { name: 'zero pid', record: { schemaVersion: 1, marker: CLICK_MARKER, pid: 0, startedAt: RECORD_STARTED_AT } },
    ]
    for (const { name, record } of cases) {
      const dataDir = clickDataDir()
      writeRecord(dataDir, 'session.json', record)
      const run = runHelper(['--activate', CLICK_MARKER, '-DataDir', dataDir])
      assert.equal(run.status, 3, `a record with a ${name} cannot be resumed: ${run.out}`)
      assert.match(run.out, /route=invalid/u, `a record with a ${name} must be refused, not resolved`)
    }
  })

  await check('a neighbour that cannot be parsed does not make a good record ambiguous', () => {
    // A corrupt leftover is the normal state after a crash, so it has to drop out of
    // the scan instead of turning every click on that marker into a refusal.
    const dataDir = clickDataDir()
    writeRecord(dataDir, 'good.json', {
      schemaVersion: 1,
      marker: CLICK_MARKER,
      pid: exitedPid(),
      startedAt: RECORD_STARTED_AT,
    })
    writeFileSync(join(recordsDir(dataDir), 'broken.json'), '{not json')
    const run = runHelper(['--activate', CLICK_MARKER, '-DataDir', dataDir])
    assert.equal(run.status, 3, `the good record still decides the route: ${run.out}`)
    assert.match(run.out, /route=record/u, 'the record that parsed is the one that counts')
    assert.match(run.out, /stage=liveness ok=false/u, 'and the dead process behind it stops the click')
  })

  await check('the -Host option is accepted only by the probe', () => {
    // All three exits are 2, exactly like "unknown option": the text is the only
    // thing that says which rule fired, so it is what these cases assert.
    const onActivate = runHelper(['--activate', CLICK_MARKER, '-Host', 'vscode'])
    assert.equal(onActivate.status, 2, `the click resolves its host from the desktop: ${onActivate.out}`)
    assert.match(onActivate.out, /-Host is only valid with --probe/u, 'so the click must reject the option by name')

    const unsupported = runHelper(['--probe', CLICK_MARKER, '-Host', 'bogus'])
    assert.equal(unsupported.status, 2, `an unknown host is an invalid invocation: ${unsupported.out}`)
    assert.match(unsupported.out, /unsupported host/u, 'the probe must say which value it refuses')

    const missingValue = runHelper(['--probe', CLICK_MARKER, '-Host'])
    assert.equal(missingValue.status, 2, `a trailing option without its value is invalid: ${missingValue.out}`)
    assert.match(missingValue.out, /missing value after -Host/u, 'and it is refused rather than guessed at')
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

  await check('a csc that cannot build the helper answers undefined, logs, and leaves the working build alone', async () => {
    // A real (tiny) in-box executable stands in for a compiler that runs and
    // exits non-zero: the module has to treat that as a failed build, not as a
    // usable cache entry. `reg.exe` is small, always present, and exits 1 on
    // compiler switches.
    const fakeRoot = join(sandbox, 'fake-windows')
    const fakeCsc = join(fakeRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
    mkdirSync(dirname(fakeCsc), { recursive: true })
    assert.ok(REAL_WINDOWS_ROOT !== undefined, 'the fixture needs a real Windows directory to copy the stand-in compiler from')
    copyFileSync(join(REAL_WINDOWS_ROOT, 'System32', 'reg.exe'), fakeCsc)
    const goodKey = readFileSync(HELPER_HASH, 'utf8')
    const goodSize = statSync(HELPER_EXE).size
    const failed = await withWindowsRoot(fakeRoot, () => captureDebug(() => ensureHelper()))
    assert.equal(failed.result, undefined, 'a failed build degrades instead of rejecting')
    assert.match(failed.lines.join(''), /notify helper: csc failed/u, 'the stage is in the log')
    assert.deepEqual(
      readdirSync(dirname(HELPER_EXE)).filter(name => name.endsWith('.tmp') || name.endsWith('.tmp.exe')),
      [],
      'a failed build removes only its own temporary output',
    )
    // Another instance may have finished a good build: a failed retry here must
    // not delete it, or a transient compiler failure would cost the feature.
    assert.equal(existsSync(HELPER_EXE), true, 'the executable an earlier build produced is still there')
    assert.equal(statSync(HELPER_EXE).size, goodSize)
    assert.equal(readFileSync(HELPER_HASH, 'utf8'), goodKey, 'and its cache key still describes it')
  })

  await check('a failed build is retried only after a cooldown', async () => {
    // A compiler path no earlier case used, so the key is fresh: the first
    // failing call arms the cooldown, the second must not spawn csc again
    // (each retry would delay a toast by up to the compile timeout).
    const coolRoot = join(sandbox, 'fake-windows-cool')
    const coolCsc = join(coolRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
    mkdirSync(dirname(coolCsc), { recursive: true })
    assert.ok(REAL_WINDOWS_ROOT !== undefined)
    copyFileSync(join(REAL_WINDOWS_ROOT, 'System32', 'reg.exe'), coolCsc)
    const first = await withWindowsRoot(coolRoot, () => captureDebug(() => ensureHelper()))
    assert.equal(first.result, undefined)
    assert.match(first.lines.join(''), /notify helper: csc failed/u)
    const second = await withWindowsRoot(coolRoot, () => captureDebug(() => ensureHelper()))
    assert.equal(second.result, undefined, 'the caller still degrades')
    assert.match(second.lines.join(''), /cooling down/u, 'a recent failure is remembered instead of retried')
    assert.doesNotMatch(second.lines.join(''), /notify helper: csc failed/u, 'and no second compiler run happens')
  })

  await check('a stray temporary build is not mistaken for the helper', async () => {
    // A killed csc leaves `<exe>.<pid>-<rand>.tmp.exe`; the documented path is
    // untouched, and the next call must compile rather than trust the leftover.
    const stray = `${HELPER_EXE}.99999-deadbeef.tmp.exe`
    writeFileSync(stray, 'truncated')
    rmSync(HELPER_HASH, { force: true })
    const rebuilt = await captureDebug(() => ensureHelper())
    assert.equal(rebuilt.result, HELPER_EXE)
    assert.match(rebuilt.lines.join(''), /notify helper: compiled/u, 'the documented executable is rebuilt, not read from a temp')
    assert.ok(statSync(HELPER_EXE).size > 'truncated'.length, 'and it is a real executable')
    rmSync(stray, { force: true })
  })

  return true
}

const ran = await main()
rmSync(sandbox, { recursive: true, force: true })
if (ran) process.stdout.write(`notify helper regression passed (${passed} checks)\n`)
