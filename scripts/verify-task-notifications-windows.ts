/**
 * Windows task-completion delivery, end to end: the routing the host owns and
 * the toast transport behind it, driven as one chain.
 *
 * The layers under this one have regressions of their own
 * (`verify-notify-transport` / `verify-task-notifications`); what neither covers
 * is the seam between them: a completion resolves to `windows`, the host hands
 * its title and summary to the transport, the transport reads the profile
 * document the host resolved and spawns the in-box host - and a refusal anywhere
 * in that chain has to end in a bell rather than in silence (AC-5), while a toast
 * that did show must not also ring one.
 *
 * Every machine side effect is injected: the registry port records, the runner
 * records instead of spawning, so this script shows no toast, writes no key and
 * starts no PowerShell. One check reads the source instead of running it,
 * because the load-time import graph is what keeps the Windows module out of
 * POSIX processes.
 *
 * Run: node --import tsx/esm scripts/verify-task-notifications-windows.ts
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { TaskNotificationSettings } from '../src/dsh-adapter/plugin.js'
import type { ExecFileNoThrowOptions, ExecFileNoThrowResult } from '../src/utils/execFileNoThrow.js'
import type { RegistryPort, RegistryWriteResult, WindowsToastResult } from '../src/ink/terminal-notification-windows.js'

// What the real ~/.dsh-tui is watched for is a NEW entry a side effect would
// leave behind, and not its mtime: a live host session rewrites files in that
// directory every few seconds, so its mtime moves for reasons this script has
// nothing to do with (L-049).
const realHome = process.env.USERPROFILE ?? process.env.HOME ?? ''
const realDataDir = realHome === '' ? '' : join(realHome, '.dsh-tui')
const realEntriesBefore = realDataDir !== '' && existsSync(realDataDir) ? new Set(readdirSync(realDataDir)) : null

// `DATA_DIR` is a module-level constant, so the throwaway home has to be in place
// before the first import of anything that reads it (L-049). The last check proves
// it held.
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-notify-windows-'))
const sandboxHome = join(sandbox, 'home')
const dshHome = join(sandbox, 'dsh-home')
mkdirSync(sandboxHome)
process.env.HOME = sandboxHome
process.env.USERPROFILE = sandboxHome
process.env.DSH_HOME = dshHome
process.on('exit', () => {
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* the fixture is gone already */ }
})

const {
  EXTERNAL_NOTIFIER_PACKAGES,
  createWindowsToastTransport,
} = await import('../src/ink/terminal-notification-windows.js')
const { createTerminalNotifier } = await import('../src/ink/terminal-notification.js')
const { deliverTaskCompletionOnWindows, ringTaskCompletion } = await import('../src/dsh-adapter/plugin.js')
const { resetTerminalFocusState, setTerminalFocused } = await import('../src/ink/terminal-focus-state.js')

/** The title the renderer passes today (`src/i18n.ts`, AC-1). */
const TITLE = 'dsh-TUI · 任务已完成'
/** Escaping torture: every character AC-8 names, plus CJK and an emoji. */
const NASTY = 'a & b < c > d "quoted" · 摘要 🐋'
/**
 * `NASTY` after escaping, spelled out rather than derived from `escapeXmlText`.
 * An expectation built by calling the function under test cannot fail when that
 * function breaks - both sides move together.
 */
const NASTY_ESCAPED = 'a &amp; b &lt; c &gt; d &quot;quoted&quot; · 摘要 🐋'
const WINDIR = 'C:\\WINDOWS'
const REGISTRY_REFUSED = 'ERROR: Access is denied.'
/** The profile every case below resolves its dedup document through. */
const PROFILE = 'verify-notify-windows'
const PROFILE_DOCUMENT = join(dshHome, 'profiles', PROFILE, 'package.json')
process.env.DSH_TUI_PROFILE = PROFILE
const thisFile = fileURLToPath(import.meta.url)
const repoRoot = dirname(dirname(thisFile))
/**
 * The host module that reaches the Windows transport. It has to load it on
 * first use, so the D12 import scan below covers it.
 */
const PLUGIN_ENTRY = join(repoRoot, 'src', 'dsh-adapter', 'plugin.ts')
/** The module whose load has to wait until a Windows toast needs it. */
const WINDOWS_MODULE = 'terminal-notification-windows'

/**
 * Load-time value imports, in both forms: `import ... from '<specifier>'` (the
 * pattern spans lines, because an import list may) and the bare side-effect
 * `import '<specifier>'`. `import type` is excluded deliberately - tsc erases it,
 * so it loads nothing - and `import()` is not a statement at all.
 */
const LOAD_TIME_IMPORTS = [
  /^import\s+(?!type\b)(?:[\s\S]*?)from\s+'([^']+)'/gmu,
  /^import\s+(?!type\b)'([^']+)'/gmu,
]

/** The process runner the ports are given, as `execFileNoThrow` provides it. */
type RunCommand = (
  file: string,
  args: readonly string[],
  options?: ExecFileNoThrowOptions,
) => Promise<ExecFileNoThrowResult>

type RegistryWrite = { key: string, name: string | null, value: string }
type RunCall = { file: string, args: readonly string[], input: string | undefined }

/** Stands in for the registry: records every write, so "did not touch it" is observable. */
function recordingRegistry(failOn?: (name: string | null) => string | undefined) {
  const writes: RegistryWrite[] = []
  const registry: RegistryPort = {
    async setValue(key, name, value): Promise<RegistryWriteResult> {
      writes.push({ key, name, value })
      const detail = failOn?.(name)
      return detail === undefined ? { ok: true } : { ok: false, detail }
    },
  }
  return { writes, registry }
}

/** Stands in for execFileNoThrow: records the invocation, spawns nothing. */
function recordingRunner(outcome: () => { code: number, stderr?: string } = () => ({ code: 0 })) {
  const calls: RunCall[] = []
  const run: RunCommand = async (file, args, options) => {
    calls.push({ file, args, input: options?.input })
    const settled = outcome()
    return { code: settled.code, stdout: '', stderr: settled.stderr ?? '' }
  }
  return { calls, run }
}

/** A profile document with (or without) an external notifier in its dependencies. */
function writeProfile(dependencies: Record<string, string>): void {
  mkdirSync(dirname(PROFILE_DOCUMENT), { recursive: true })
  writeFileSync(PROFILE_DOCUMENT, JSON.stringify({ name: PROFILE, dependencies }))
}

interface Chain {
  registry: ReturnType<typeof recordingRegistry>
  runner: ReturnType<typeof recordingRunner>
  /** The profile document the host handed the transport, per attempt (F2). */
  profileDocuments: (string | undefined)[]
  /** What the toast port answered, per attempt (D8's three answers). */
  toastResults: WindowsToastResult[]
  /** What the terminal path was asked to announce, in order. */
  delivered: [string, string][]
  /** The bytes that reached the terminal: `\x07` is the bell this fallback rings. */
  bell: string[]
  /** What logForDebugging wrote while the completion was delivered (AC-5's reason). */
  debug: string[]
}

/**
 * One task completion, driven through the same three hops production uses:
 * `deliverTaskCompletionOnWindows` → the transport → the in-box host. Only the
 * ports are stubs; the routing, the dedup read and the XML are the real code.
 * @param message - The summary the completion carries.
 * @param options.platform - What the transport sees; defaults to win32.
 * @param options.registry - A recording registry, or one that refuses a write.
 * @param options.notifications - The live settings the terminal port reads;
 *   `always` unless the case is about the gate that decides before the toast.
 */
async function deliverCompletion(
  message: string,
  options: {
    platform?: NodeJS.Platform
    registry?: ReturnType<typeof recordingRegistry>
    notifications?: TaskNotificationSettings
  } = {},
): Promise<Chain> {
  const registry = options.registry ?? recordingRegistry()
  const runner = recordingRunner()
  const delivered: [string, string][] = []
  const profileDocuments: (string | undefined)[] = []
  const toastResults: WindowsToastResult[] = []
  const bell: string[] = []
  const debug: string[] = []
  const notifications: TaskNotificationSettings = options.notifications ?? { condition: 'always', method: 'bel' }
  // The real terminal path, pinned to the one byte this fallback produces: the
  // host's gate decides whether a completion is announced at all, and this port
  // is reached only after that gate said yes.
  const notifier = createTerminalNotifier(Object.assign(new Writable({
    write(chunk, _encoding, done) { bell.push(String(chunk)); done() },
  }), { isTTY: true }))
  notifier.configure(notifications.condition, notifications.method)
  const transport = createWindowsToastTransport({
    platform: options.platform ?? 'win32',
    env: { windir: WINDIR },
    registry: registry.registry,
    run: runner.run,
    // The toast host has a runner of its own, and it is the one that would
    // otherwise start a real PowerShell (UAT-M4): a stub here is what keeps this
    // suite off the machine.
    runToastHost: runner.run,
  })
  const realStderrWrite = process.stderr.write.bind(process.stderr)
  const realDebug = process.env.DSH_TUI_DEBUG
  // Only this window needs the debug logger on: it is where the fallback's reason
  // is written.
  process.env.DSH_TUI_DEBUG = '1'
  process.stderr.write = ((chunk: unknown): boolean => { debug.push(String(chunk)); return true }) as typeof process.stderr.write
  try {
    await deliverTaskCompletionOnWindows(TITLE, message, {
      toast: async input => {
        profileDocuments.push(input.profilePackageJsonPath)
        const result = await transport.notify(input)
        toastResults.push(result)
        return result
      },
      terminal: (fallbackTitle, fallbackMessage) => {
        delivered.push([fallbackTitle, fallbackMessage])
        ringTaskCompletion(notifier, notifications, fallbackTitle, fallbackMessage)
      },
    })
  } finally {
    process.stderr.write = realStderrWrite
    if (realDebug === undefined) delete process.env.DSH_TUI_DEBUG
    else process.env.DSH_TUI_DEBUG = realDebug
  }
  return { registry, runner, profileDocuments, toastResults, delivered, bell, debug }
}

/**
 * Put the two things that can name this launch's profile in place, and put them
 * back afterwards: the argv the launcher inherited, and the variable its entry
 * route hands down (`src/update.ts`).
 * @param route.argv - The argv the process sees for this case.
 * @param route.env - The variable's value, or undefined to leave it unset.
 * @param body - The case itself.
 */
async function withLaunchRoute<T>(route: { argv: readonly string[], env: string | undefined }, body: () => Promise<T>): Promise<T> {
  const originalArgv = process.argv
  try {
    process.argv = [...route.argv]
    if (route.env === undefined) delete process.env.DSH_TUI_PROFILE
    else process.env.DSH_TUI_PROFILE = route.env
    return await body()
  } finally {
    process.argv = originalArgv
    process.env.DSH_TUI_PROFILE = PROFILE
  }
}

let passed = 0
async function check(name: string, body: () => void | Promise<void>): Promise<void> {
  await body()
  passed += 1
  process.stdout.write(`ok ${passed} - ${name}\n`)
}

// --- AC-1/AC-8: the completion reaches the in-box host as one escaped toast ----

await check('a completion reaches the in-box host as one escaped toast', async () => {
  writeProfile({})
  const chain = await deliverCompletion(NASTY)
  assert.equal(chain.runner.calls.length, 1, 'exactly one toast process')
  const xml = chain.runner.calls[0].input ?? ''
  assert.deepEqual(
    textNodes(xml),
    [TITLE, NASTY_ESCAPED],
    'the title and the summary the host passed are the two text nodes, escaped (AC-8)',
  )
  assert.equal(chain.registry.writes.length, 2, 'the AUMID is registered before the toast goes out')
  assert.deepEqual(chain.delivered, [], 'a toast that showed must not also ring the bell')
  assert.deepEqual(chain.bell, [], 'and nothing reaches the terminal path')
})

// --- AC-6: an external notifier owns the completion ----------------------------

await check('a profile that names an external notifier delivers nothing at all', async () => {
  writeProfile({ [EXTERNAL_NOTIFIER_PACKAGES[0]]: '^1.0.0' })
  const chain = await deliverCompletion(NASTY)
  assert.deepEqual(
    chain.toastResults,
    [{ status: 'yielded' }],
    'the transport has to answer "yielded", not claim a toast it never showed',
  )
  assert.deepEqual(chain.runner.calls, [], 'no toast process')
  assert.deepEqual(chain.registry.writes, [], 'not even the AUMID is registered')
  assert.deepEqual(chain.delivered, [], 'nothing falls back to the terminal')
  assert.deepEqual(chain.bell, [], 'no bell either: the external notifier already reminded the user (AC-6)')
  assert.deepEqual(chain.debug, [], 'yielding is not a fallback, so there is nothing to explain')
})

// --- AC-5: a refusal degrades to the bell, never to silence --------------------

await check('a refused AUMID falls back to the bell and leaves the reason in the log', async () => {
  writeProfile({})
  const registry = recordingRegistry(name => (name === 'DisplayName' ? REGISTRY_REFUSED : undefined))
  const chain = await deliverCompletion(NASTY, { registry })
  assert.deepEqual(chain.bell, ['\x07'], 'AC-5: the bell, not silence')
  assert.deepEqual(chain.delivered, [[TITLE, NASTY]], 'the fallback announces the completion the toast was going to carry')
  assert.deepEqual(chain.runner.calls, [], 'a toast that cannot display is not spawned')
  const logged = chain.debug.join('')
  assert.match(logged, /aumid-registration-failed/u, 'the log names the reason (the pair "no toast + bell" has to be explainable)')
})

await check('off Windows nothing touches the registry or a child process, and the bell still rings', async () => {
  writeProfile({})
  const chain = await deliverCompletion(NASTY, { platform: 'darwin' })
  assert.deepEqual(chain.registry.writes, [], 'POSIX must not write the registry')
  assert.deepEqual(chain.runner.calls, [], 'POSIX must not spawn anything')
  assert.deepEqual(chain.bell, ['\x07'], 'the transport refusing is not a reason to lose the notification')
})

await check('a terminal that comes back while the toast is in flight still gets the bell', async () => {
  writeProfile({})
  // The gate asked the focus question before the toast was attempted and saw a
  // blurred terminal - that is why this completion is being announced at all.
  // The registry port is where the toast's first await is spent, so the user's
  // return to the terminal lands in the middle of it.
  setTerminalFocused(false)
  try {
    const registry = recordingRegistry(name => {
      setTerminalFocused(true)
      return name === 'DisplayName' ? REGISTRY_REFUSED : undefined
    })
    const chain = await deliverCompletion(NASTY, { registry, notifications: { condition: 'unfocused', method: 'bel' } })
    const logged = chain.debug.join('')
    assert.deepEqual(chain.bell, ['\x07'], 'AC-5: the reminder the gate approved must not be eaten by a second look at the focus')
    assert.equal(/ringing the terminal bell/u.test(logged), chain.bell.length > 0, 'the log may only report a bell that actually rang')
    assert.match(logged, /windows toast unavailable/u, 'and the pair "no toast + bell" stays explainable')
  } finally {
    resetTerminalFocusState()
  }
})

// --- F2: which profile document governs this launch ----------------------------
// The host resolves "which profile document governs this launch" on its own, and
// either launch route - `--profile` in argv, or the variable the launcher's entry
// route hands down - may be the one that names it. Both have to reach the
// transport: a launch whose document is not read stops yielding to an external
// notifier, and the user gets two notifications for one completion.

await check('the completion resolves the profile document on both launch routes', async () => {
  const routes = [
    { label: '--profile in argv', argv: ['node', 'dsh', '--profile', PROFILE], env: undefined },
    { label: 'DSH_TUI_PROFILE from the launcher', argv: ['node', 'dsh'], env: PROFILE },
  ] as const
  for (const route of routes) {
    await withLaunchRoute(route, async () => {
      writeProfile({ [EXTERNAL_NOTIFIER_PACKAGES[0]]: '^1.0.0' })
      const chain = await deliverCompletion(NASTY)
      assert.deepEqual(chain.profileDocuments, [PROFILE_DOCUMENT], `${route.label}: the toast half resolves the document this launch names`)
      assert.deepEqual(chain.toastResults, [{ status: 'yielded' }], `${route.label}: the external notifier in that document stands the toast down`)
      assert.deepEqual(chain.bell, [], `${route.label}: yielding is not a fallback`)
      // The control the comparison needs: without the notifier the same route
      // delivers, so "yielded" above is that document's doing.
      writeProfile({})
      const wired = await deliverCompletion(NASTY)
      assert.deepEqual(wired.toastResults, [{ status: 'shown' }], `${route.label}: control - the same launch delivers without that document`)
    })
  }
})

// --- D12/AC-7: what a POSIX process must not load ------------------------------
// A static import is what drags the Windows transport into every process that
// loads the host, on every platform. The platform gates inside the module keep
// the side effects off, but the load is the part nothing else can undo, so it is
// pinned here by source text.

await check('no source file imports the Windows transport at load time', () => {
  const scanned = collectSources(join(repoRoot, 'src'))
  const offenders = scanned.flatMap(file => {
    const source = readFileSync(file, 'utf8')
    return LOAD_TIME_IMPORTS.flatMap(pattern => [...source.matchAll(pattern)].map(match => match[1]))
      .filter(specifier => specifier.includes(WINDOWS_MODULE))
      .map(specifier => `${relative(repoRoot, file)} -> ${specifier}`)
  })
  // A scan over nothing passes for the wrong reason: the host that reaches the
  // transport has to be inside the set it reads.
  assert.ok(scanned.includes(PLUGIN_ENTRY), 'the scan must cover the host module that reaches the transport')
  assert.deepEqual(offenders, [], `the transport is loaded on first use, never at load time (D12/AC-7):\n${offenders.join('\n')}`)
})

// --- L-049: the sandbox held, and the real home was left alone -----------------

await check('the module graph resolved into the sandbox and added nothing to the real ~/.dsh-tui', async () => {
  const realEntriesAfter = realDataDir !== '' && existsSync(realDataDir) ? new Set(readdirSync(realDataDir)) : null
  const added = [...(realEntriesAfter ?? [])].filter(name => !(realEntriesBefore?.has(name) ?? false))
  assert.deepEqual(added, [], 'a side effect would leave a NEW entry, and that is what this watches')
})

rmSync(sandbox, { recursive: true, force: true })
process.stdout.write(`windows task notification regression passed (${passed} checks)\n`)

/** The `<text>` nodes of a ToastGeneric document, in document order. */
function textNodes(xml: string): string[] {
  return [...xml.matchAll(/<text>([\s\S]*?)<\/text>/gu)].map(match => match[1])
}

/** Every TypeScript source under `dir`. */
function collectSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return collectSources(path)
    return /\.tsx?$/u.test(entry.name) ? [path] : []
  })
}
