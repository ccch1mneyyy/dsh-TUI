/**
 * Jump-back helper contract (T01): the C# source keeps the properties the
 * in-box csc can compile, and `ensureActivateHelper()` decides reuse-vs-rebuild
 * for the cached exe without ever throwing at the caller.
 *
 * The decision logic and the failure paths are pinned here; compiling for real
 * needs Windows and belongs to the machine pass (UAT). Every case below drives
 * a stub runner inside a temporary data directory (never the user's
 * ~/.dsh-tui), because the helper's whole job on the cache side is: reuse a
 * fresh exe, rebuild a missing/stale one, and report a failure instead of
 * taking the call down with it.
 *
 * T08 pins the packaging half too: tsc emits this module into `lib/types/` and
 * `scripts/copy-notify-helper.mjs` drops `activate.cs` beside it, because an
 * installed package ships no `src/`. Where that copy lands, how it fails, and
 * that the compiled module resolves the source next to itself (never through the
 * working directory) are all asserted here.
 *
 * T-FIX-06 pins how the jump-back waits: each step polls the state it needs on
 * the delay the fixed sleep used to spend as its ceiling, and the tab search
 * reads the whole strip's names in one cross-process trip.
 *
 * Run: node --import tsx/esm scripts/verify-notify-helper.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compilerFor, ensureActivateHelper, helperPaths } from '../src/ink/notify-helper/compile.js'

const WINDIR = 'C:\\WINDOWS'
const FRAMEWORK_DIR = `${WINDIR}${sep}Microsoft.NET${sep}Framework64${sep}v4.0.30319`
const CSC_PATH = `${FRAMEWORK_DIR}${sep}csc.exe`
const UIA_REFERENCES = ['UIAutomationClient.dll', 'UIAutomationTypes.dll']
  .map(name => `${FRAMEWORK_DIR}${sep}WPF${sep}${name}`)
const CSC_FAILURE = 'error CS0246: AutomationElement could not be found'

const thisFile = fileURLToPath(import.meta.url)
const repoRoot = dirname(dirname(thisFile))
const helperSourceDir = join('src', 'ink', 'notify-helper')
const packagedSourcePath = join(repoRoot, helperSourceDir, 'activate.cs')
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { main: string, scripts: Record<string, string> }
/**
 * Where the C# source has to end up: tsc mirrors `src/` under the directory
 * `main` points into, so the copy keeps its `ink/notify-helper/` place beside
 * the compiled module - which is what the runtime's `new URL('./activate.cs',
 * import.meta.url)` looks for. Deriving it from `main` keeps this assertion
 * honest when either side of that pair moves.
 */
const copiedSourcePath = join(dirname(manifest.main), 'ink', 'notify-helper', 'activate.cs')

const tempDirs: string[] = []
process.on('exit', () => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* the fixture is gone already */ }
  }
})

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-notify-helper-'))
  tempDirs.push(dir)
  return dir
}

/** Run the build step against a throwaway tree (the real one defaults to the repo root). */
function copyHelper(root: string) {
  return spawnSync(process.execPath, [join(repoRoot, 'scripts', 'copy-notify-helper.mjs'), root], { encoding: 'utf8' })
}

/** A throwaway tree holding nothing but the packaged C# source. */
function helperSourceRoot(): string {
  const root = tempDataDir()
  mkdirSync(join(root, helperSourceDir), { recursive: true })
  writeFileSync(join(root, helperSourceDir, 'activate.cs'), readFileSync(packagedSourcePath))
  return root
}

type RunnerCall = { file: string, args: readonly string[], timeout: number | undefined }

/** A stand-in for execFileNoThrow: records the invocation and settles on demand. */
function recordingRunner(
  outcome: { code: number, stdout?: string, stderr?: string },
  after?: (args: readonly string[]) => void,
) {
  const calls: RunnerCall[] = []
  const run = async (file: string, args: readonly string[], options: { timeout?: number } = {}) => {
    calls.push({ file, args, timeout: options.timeout })
    if (after !== undefined) after(args)
    return { code: outcome.code, stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? '' }
  }
  return { calls, run }
}

/** The exe csc was told to write, read back from the `/out:` argument. */
function productOf(args: readonly string[]): string {
  const out = args.find(arg => arg.startsWith('/out:'))
  assert.ok(out !== undefined, 'csc needs /out: to know where the product goes')
  return out.slice('/out:'.length)
}

function optionsFor(dir: string, sourcePath: string, run: unknown, log: unknown = () => {}) {
  return { dataDir: dir, sourcePath, platform: 'win32' as const, env: { windir: WINDIR }, run, log }
}

let passed = 0
async function check(name: string, body: () => void | Promise<void>): Promise<void> {
  await body()
  passed += 1
  process.stdout.write(`ok ${passed} - ${name}\n`)
}

let sourceText = ''

await check('the C# source ships next to the compile module', () => {
  sourceText = readFileSync(packagedSourcePath, 'utf8')
  assert.ok(sourceText.trim().length > 0, 'activate.cs is empty')
  assert.notEqual(sourceText.charCodeAt(0), 0xfeff, 'a BOM would need a csc flag this build does not pass')
})

// The pair above lives in `src/`; these four keep the same pair intact in the
// tree the package actually ships (no `src/` there), which is the whole point
// of the build step.
await check('the build step copies the C# source beside the compiled module', () => {
  const root = helperSourceRoot()
  const result = copyHelper(root)
  assert.equal(result.status, 0, `the copy step failed: ${result.stderr.trim()}`)
  assert.equal(
    readFileSync(join(root, copiedSourcePath), 'utf8'),
    sourceText,
    `the copy step must land byte-identical source at ${copiedSourcePath}`,
  )
  assert.equal(
    relative(dirname(manifest.main), copiedSourcePath),
    relative(join(repoRoot, 'src'), packagedSourcePath),
    'the copy must keep the source file\'s place under tsc outDir, or the runtime URL will not find it',
  )
})

await check('a missing helper source fails the build step instead of shipping nothing', () => {
  const root = tempDataDir()
  const result = copyHelper(root)
  assert.notEqual(result.status, 0, 'a tree without the C# source must not report success')
  assert.match(result.stderr, /activate\.cs/, 'the failure must name the file it could not find')
  assert.ok(!existsSync(join(root, copiedSourcePath)), 'a failed copy must not leave a half product behind')
})

/**
 * The copy step belongs in the chain, after tsc: it writes into the tree tsc
 * has just produced, and the packaged tree ships no `src/`, so nothing else
 * puts `activate.cs` beside the compiled module.
 */
function assertCopyStepAfterTsc(script: string): void {
  const chain = manifest.scripts[script] ?? ''
  const tscAt = chain.indexOf('tsc -p tsconfig.json')
  const copyAt = chain.indexOf('scripts/copy-notify-helper.mjs')
  assert.notEqual(tscAt, -1, `${script} must still run tsc`)
  assert.notEqual(copyAt, -1, `${script} must run the copy step, or an installed package has no activate.cs`)
  assert.ok(copyAt > tscAt, `${script} must run the copy step after tsc: it writes into the tree tsc has just produced`)
}

await check('the compile chain runs the copy step after tsc', () => assertCopyStepAfterTsc('compile'))

// `compile:src` rebuilds the same product without the vendor and clean steps,
// so it needs the same copy. A chain that skips it still builds and still
// starts; the loss only shows up on an installed package, as a jump-back that
// falls back to the bell.
await check('the compile:src chain runs the copy step after tsc', () => assertCopyStepAfterTsc('compile:src'))

await check('the C# source stays ASCII, which is what csc can read without /codepage', () => {
  assert.match(sourceText, /^[\t\n\r\x20-\x7e]*$/, 'csc runs without /codepage: the source must stay ASCII')
})

await check('the C# source carries the D6 jump-back steps', () => {
  const capabilities = [
    'WindowsTerminal',       // D7: enumerate the terminal's windows, not our own process
    'SelectionItemPattern',  // D6: pick the tab by name - the window title is the active tab's
    'SW_RESTORE',            // D6 step 1
    'SetForegroundWindow',   // D6 step 3
    'GetForegroundWindow',   // R8: the step is verified, never trusted
    'SetFocus',              // D6 step 6 / AC-4: the keyboard focus is part of the jump
    'TermControl',           // the focus target
    'InputSite',             // D6: Window -> Pane(InputSite) -> Custom -> Text[TermControl]
  ]
  for (const capability of capabilities) assert.ok(sourceText.includes(capability), `activate.cs lost ${capability}`)
  for (const markerInput of ['-Marker', '?m=']) {
    assert.ok(sourceText.includes(markerInput), `activate.cs must take the marker from ${markerInput}`)
  }
  assert.match(sourceText, /args\[i\] == "-DataDir"[\s\S]{0,40}dataDir =/u, 'activate.cs must consume -DataDir from argv, not just name it in the header: the shell starts this helper without our environment, and one that ignores the flag logs into the real %USERPROFILE% (T01)')
  assert.match(sourceText, /keybd_event\(VK_MENU/u, 'the Alt unlock is R8\'s only remedy - the foreground lock does not yield to a plain SetForegroundWindow - and losing it looks exactly like a click that never comes back')
})

/**
 * T-FIX-06. A click used to spend about 1.2 s of its 1.8 s inside fixed sleeps,
 * while every one of those steps had a real state to wait for. What those waits
 * now cost is only measurable on a running Windows session, so it is recorded in
 * the UAT segment readings and T-FIX-06-SUMMARY instead of being asserted here.
 * The ceilings, the poll interval and each call site's exact text were asserted
 * here too, and a reformat or a local rename turned all of them red while the
 * jump-back behaved exactly as before: those are gone on purpose.
 */
await check('no step on the jump-back path waits by a fixed sleep', () => {
  // A sleep is only allowed to be the poll interval: any sleep handed a delay
  // constant (or the number itself) is the fixed wait this task removed.
  const sleeps = [...sourceText.matchAll(/Thread\.Sleep\(([^)]*)\)/gu)].map(match => match[1].trim())
  assert.ok(sleeps.length > 0, 'a bounded poll still has to sleep between looks, or it burns a core on cross-process queries')
  for (const argument of sleeps) {
    assert.doesNotMatch(argument, /\d|StepDelayMs|FocusDelayMs|AltTapDelayMs/u, `Thread.Sleep(${argument}) spends a step delay instead of polling for its state`)
  }
})

await check('the tab search reads every tab name in one cross-process trip', () => {
  assert.match(sourceText, /new CacheRequest\(\)/, 'the tab names must come back with the search, not one round trip per tab')
  assert.match(sourceText, /\.Cached\.Name/, 'the tabs must be matched on their cached names')
})

await check('the helper lives under <dataDir>/notify', () => {
  const paths = helperPaths(join('root', 'data'))
  assert.equal(paths.dir, join('root', 'data', 'notify'))
  assert.deepEqual(Object.keys(paths).sort(), ['dir', 'exePath', 'sourceCopyPath'])
  for (const key of ['sourceCopyPath', 'exePath'] as const) {
    assert.equal(dirname(paths[key]), paths.dir, `${key} escaped the notify directory`)
  }
})

await check('the compiler is the in-box Framework64 csc with the WPF UIA references', () => {
  assert.deepEqual(compilerFor({ windir: WINDIR }), { cscPath: CSC_PATH, references: UIA_REFERENCES })
  assert.equal(compilerFor({}), null, 'without WINDIR there is no compiler to spawn')
})

await check('a fresh cache is reused without spawning the compiler', async () => {
  const dir = tempDataDir()
  const now = Date.now()
  const paths = helperPaths(dir)
  mkdirSync(paths.dir, { recursive: true })
  writeFileSync(paths.sourceCopyPath, sourceText)
  utimesSync(paths.sourceCopyPath, (now - 60_000) / 1000, (now - 60_000) / 1000)
  writeFileSync(paths.exePath, 'MZ-stub')
  utimesSync(paths.exePath, now / 1000, now / 1000)
  const { calls, run } = recordingRunner({ code: 0 })
  const result = await ensureActivateHelper(optionsFor(dir, packagedSourcePath, run) as never)
  assert.deepEqual(result, { ok: true, exePath: paths.exePath, sourcePath: paths.sourceCopyPath, reused: true })
  assert.equal(calls.length, 0, 'a fresh cache must not spawn the compiler')
})

await check('an empty cache copies the source and compiles the copy with the UIA references', async () => {
  const dir = tempDataDir()
  const paths = helperPaths(dir)
  const { calls, run } = recordingRunner({ code: 0 }, args => writeFileSync(productOf(args), 'MZ-stub'))
  const result = await ensureActivateHelper(optionsFor(dir, packagedSourcePath, run) as never)
  assert.deepEqual(result, { ok: true, exePath: paths.exePath, sourcePath: paths.sourceCopyPath, reused: false })
  assert.equal(readFileSync(paths.sourceCopyPath, 'utf8'), sourceText, 'the cached copy must be the packaged source')
  assert.equal(calls.length, 1, 'exactly one compile')
  const [call] = calls
  assert.equal(call.file, CSC_PATH)
  // winexe, not exe: a console-subsystem product is what made every click on a
  // toast flash a console window for about half a second (UAT 2026-10-16 - the
  // product measured PE Subsystem 3, and the helper's own log listed
  // activate.exe among the visible windows).
  assert.ok(call.args.includes('/target:winexe'), 'csc must build a GUI-subsystem exe, or the click flashes a console')
  assert.ok(call.args.includes(`/out:${paths.exePath}`), 'the product must land in the notify directory')
  assert.deepEqual(
    call.args.filter(arg => arg.startsWith('/reference:')).map(arg => arg.slice('/reference:'.length)),
    UIA_REFERENCES,
    'UIA must be referenced by path: csc cannot resolve these by simple name',
  )
  assert.equal(call.args[call.args.length - 1], paths.sourceCopyPath, 'compiling the copy is what ties the cache to the source')
  assert.ok(typeof call.timeout === 'number' && call.timeout > 0, 'a compile must be bounded')
})

/**
 * The other half of the winexe decision: a GUI-subsystem process has no
 * console, so `Console.WriteLine` in the helper goes nowhere. Losing that
 * output is only acceptable because every line also reaches the log file -
 * measured on the real product, where the GUI-subsystem activate.exe driven
 * with no marker still exits 1 and writes "no marker: ..." to
 * `<DATA_DIR>/notify/activate.log`. Drop the file write and a helper that fails
 * on a user's machine has no way left to say why.
 */
await check('the helper writes its diagnostics to a file, not just a console', () => {
  assert.ok(sourceText.includes('File.AppendAllText('), 'activate.cs must keep writing its log file')
  assert.ok(sourceText.includes('"activate.log"'), 'under the notify directory it resolves from -DataDir, so the trace lands somewhere the user can find it')
})

await check('the default source is the activate.cs next to the module, wherever the cwd is', async () => {
  const dir = tempDataDir()
  const { calls, run } = recordingRunner({ code: 0 }, args => writeFileSync(productOf(args), 'MZ-stub'))
  const cwd = process.cwd()
  process.chdir(tempDataDir())
  try {
    // No `sourcePath`: the module has to resolve `./activate.cs` against its own
    // URL, the way the compiled module does inside an installed package.
    const result = await ensureActivateHelper({ dataDir: dir, platform: 'win32', env: { windir: WINDIR }, run, log: () => {} } as never)
    assert.equal(result.ok, true, `the module did not find its sibling activate.cs: ${JSON.stringify(result)}`)
    assert.equal(calls.length, 1, 'the sibling source must be compiled, not skipped')
    assert.equal(readFileSync(helperPaths(dir).sourceCopyPath, 'utf8'), sourceText, 'the compiled copy must be the packaged source')
  } finally {
    process.chdir(cwd)
  }
})

await check('a changed package source invalidates an otherwise fresh exe', async () => {
  const dir = tempDataDir()
  const now = Date.now()
  const paths = helperPaths(dir)
  mkdirSync(paths.dir, { recursive: true })
  writeFileSync(paths.sourceCopyPath, '// helper from the previous version\n')
  utimesSync(paths.sourceCopyPath, (now - 120_000) / 1000, (now - 120_000) / 1000)
  writeFileSync(paths.exePath, 'MZ-old')
  // A minute apart, because the rewrite below is stamped by the filesystem's
  // own clock and can land on or before an exe stamped `now`.
  utimesSync(paths.exePath, (now - 60_000) / 1000, (now - 60_000) / 1000)
  const upgradedDir = tempDataDir()
  const upgradedSource = join(upgradedDir, 'activate.cs')
  writeFileSync(upgradedSource, `${sourceText}\n// upgraded\n`)
  const { calls, run } = recordingRunner({ code: 0 }, args => writeFileSync(productOf(args), 'MZ-stub'))
  const result = await ensureActivateHelper(optionsFor(dir, upgradedSource, run) as never)
  assert.deepEqual(result, { ok: true, exePath: paths.exePath, sourcePath: paths.sourceCopyPath, reused: false })
  assert.equal(calls.length, 1, 'an upgraded package must not keep running the old helper')
  assert.equal(readFileSync(paths.sourceCopyPath, 'utf8'), readFileSync(upgradedSource, 'utf8'))
})

await check('a failing compiler is reported with its cause instead of thrown', async () => {
  const dir = tempDataDir()
  const logged: Array<[string, Record<string, unknown> | undefined]> = []
  const { calls, run } = recordingRunner({ code: 1, stderr: CSC_FAILURE })
  const result = await ensureActivateHelper(optionsFor(dir, packagedSourcePath, run, (message: string, fields?: Record<string, unknown>) => logged.push([message, fields])) as never)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'compile-failed')
  assert.match(result.detail, /CS0246/, 'the compiler output is the only clue for R3')
  assert.equal(calls.length, 1)
  assert.match(JSON.stringify(logged), /CS0246/, 'the cause must reach logForDebugging')
})

await check('a compiler that produces nothing is a failure, not a success', async () => {
  const dir = tempDataDir()
  const { run } = recordingRunner({ code: 0 })
  const result = await ensureActivateHelper(optionsFor(dir, packagedSourcePath, run) as never)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'compile-failed')
})

await check('a missing helper source fails without spawning the compiler', async () => {
  const dir = tempDataDir()
  const { calls, run } = recordingRunner({ code: 0 })
  const result = await ensureActivateHelper(optionsFor(dir, join(dir, 'absent.cs'), run) as never)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'source-missing')
  assert.equal(calls.length, 0)
})

await check('a non-win32 platform is refused before any file or process side effect', async () => {
  const dir = tempDataDir()
  const { calls, run } = recordingRunner({ code: 0 })
  const result = await ensureActivateHelper({
    dataDir: dir,
    sourcePath: packagedSourcePath,
    platform: 'darwin',
    env: { windir: WINDIR },
    run,
    log: () => {},
  } as never)
  assert.deepEqual(result, { ok: false, reason: 'not-win32' })
  assert.equal(calls.length, 0, 'POSIX must not spawn csc')
  assert.deepEqual(readdirSync(dir), [], 'POSIX must not write the cache either')
})

for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
process.stdout.write(`notify helper regression passed (${passed} checks)\n`)
