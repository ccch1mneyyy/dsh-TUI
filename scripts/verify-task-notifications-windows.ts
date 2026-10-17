/**
 * Windows task-completion delivery, end to end: the routing the host owns, the
 * toast transport and the terminal title's jump-back marker, driven as one chain.
 *
 * The three layers under this one have regressions of their own
 * (`verify-notify-helper` / `verify-notify-transport` / `verify-task-notifications`);
 * what none of them covers is the seam between them: a completion resolves to
 * `windows`, the host hands its title and summary to the transport, the transport
 * reads the profile document the host resolved and spawns the in-box host - and a
 * refusal anywhere in that chain has to end in a bell rather than in silence
 * (AC-5), while a toast that did show must not also ring one.
 *
 * Every machine side effect is injected: the registry port records, the runner
 * records instead of spawning, and the helper build is a stub, so this script
 * shows no toast, writes no key and starts no PowerShell. The title half needs no
 * injection at all - it reads `process.title` and the OSC bytes the hook writes,
 * which is exactly what a user's tab shows (AC-3).
 *
 * Two decisions the host takes once are pinned here as well: the bell a failed
 * toast falls back to is the one the gate approved, however the focus moved while
 * the toast was in flight, and the title's marker is only written while this
 * launch really routes to the toast (`notification-wiring-state.ts`). The last
 * check reads the source instead of running it, because the load-time import
 * graph is what keeps the Windows module out of POSIX processes.
 *
 * Run: node --import tsx/esm scripts/verify-task-notifications-windows.ts
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { ReactElement } from 'react'
import type { TaskNotificationSettings } from '../src/dsh-adapter/plugin.js'
import type { ActivateHelperResult, EnsureActivateHelperOptions, RunCommand } from '../src/ink/notify-helper/compile.js'
import type { RegistryPort, RegistryWriteResult, WindowsToastResult } from '../src/ink/terminal-notification-windows.js'

// What the real ~/.dsh-tui is watched for is a NEW entry - the helper cache a
// side effect would leave behind - and not its mtime: a live host session rewrites
// files in that directory every few seconds, so its mtime moves for reasons this
// script has nothing to do with (L-049).
const realHome = process.env.USERPROFILE ?? process.env.HOME ?? ''
const realDataDir = realHome === '' ? '' : join(realHome, '.dsh-tui')
const realEntriesBefore = realDataDir !== '' && existsSync(realDataDir) ? new Set(readdirSync(realDataDir)) : null

// `DATA_DIR` is a module-level constant, so the throwaway home has to be in place
// before the first import of anything that reads it (L-049). The last check proves
// it took effect.
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-notify-windows-'))
const sandboxHome = join(sandbox, 'home')
const sandboxDataDir = join(sandboxHome, '.dsh-tui')
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
  activationUri,
  createWindowsToastTransport,
  markerFor,
} = await import('../src/ink/terminal-notification-windows.js')
const { createTerminalNotifier } = await import('../src/ink/terminal-notification.js')
const { deliverTaskCompletionOnWindows, createTaskNotificationSettings, publishWindowsToastWiring, ringTaskCompletion } = await import('../src/dsh-adapter/plugin.js')
const { resetTerminalFocusState, setTerminalFocused } = await import('../src/ink/terminal-focus-state.js')
const { setWindowsToastWiring, windowsToastWired } = await import('../src/ink/notification-wiring-state.js')
const { DATA_DIR } = await import('../src/utils/paths.js')
const { OSC, osc } = await import('../src/ink/termio/osc.js')
const { TerminalWriteProvider } = await import('../src/ink/useTerminalNotification.js')
const { useTerminalTitle } = await import('../src/ink/hooks/use-terminal-title.js')
const { render } = await import('../src/ui.js')
const React = await import('react')
const { settle } = await import('./lib/term-test.mjs')

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
const MARKER = markerFor(process.pid)
/** Anchors the title assertions: a value the hook has to move away from. */
const SENTINEL = 'dsh-tui verify sentinel'
const ANSI_TITLE = '\u001b[31m✳ 🐋 verify\u001b[0m'
const CLEAN_TITLE = '✳ 🐋 verify'
const originalTitle = process.title
process.env.DSH_TUI_PROFILE = PROFILE
// The shared transport reads `%WINDIR%` from `process.env` when it is first asked
// and the title groups below reach it, so the variable is pinned here: "win32 + a
// transport that can deliver" has to mean the same thing on a Windows host and on
// a POSIX runner, where a missing system root is a real "no toast" answer (F5).
process.env.windir ??= WINDIR
const thisFile = fileURLToPath(import.meta.url)
const repoRoot = dirname(dirname(thisFile))
/** The hook that appends the marker: the one file the D12 import scan has to cover. */
const titleHookPath = join(repoRoot, 'src', 'ink', 'hooks', 'use-terminal-title.ts')
/** The module whose load has to wait until a Windows title or toast needs it. */
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

/** Stands in for compile.ts: reports a cached product without building anything. */
function helperStub() {
  const calls: EnsureActivateHelperOptions[] = []
  return {
    calls,
    ensureHelper: async (options: EnsureActivateHelperOptions): Promise<ActivateHelperResult> => {
      calls.push(options)
      // Same default the real port applies, so a caller that stopped passing the
      // directory cannot look like a success here.
      const dataDir = options.dataDir ?? DATA_DIR
      return { ok: true, exePath: join(dataDir, 'notify', 'activate.exe'), sourcePath: 'stub.cs', reused: true }
    },
  }
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
  helper: ReturnType<typeof helperStub>
  runner: ReturnType<typeof recordingRunner>
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
 * ports are stubs; the routing, the dedup read and the XML are the real code. The
 * transport gets no `dataDir`, so the paths it resolves are the module constants -
 * which the last check proves landed inside the sandbox (L-049).
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
  const helper = helperStub()
  const runner = recordingRunner()
  const delivered: [string, string][] = []
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
    pid: process.pid,
    env: { windir: WINDIR },
    registry: registry.registry,
    ensureHelper: helper.ensureHelper,
    run: runner.run,
    // The toast host has a runner of its own, and it is the one that would
    // otherwise start a real PowerShell (UAT-M4): a stub here is what keeps this
    // suite off the machine.
    runToastHost: runner.run,
  })
  const realStderrWrite = process.stderr.write.bind(process.stderr)
  const realDebug = process.env.DSH_TUI_DEBUG
  // Only this window needs the debug logger on: it is where the fallback's reason
  // is written, and the render groups below stay quiet with it off.
  process.env.DSH_TUI_DEBUG = '1'
  process.stderr.write = ((chunk: unknown): boolean => { debug.push(String(chunk)); return true }) as typeof process.stderr.write
  try {
    await deliverTaskCompletionOnWindows(TITLE, message, {
      toast: async input => {
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
  return { registry, helper, runner, toastResults, delivered, bell, debug }
}

/** Swap the platform the hook and the transport see, and put it back afterwards. */
async function withPlatform<T>(platform: NodeJS.Platform, body: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true, enumerable: true, writable: false })
  try {
    return await body()
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true, enumerable: true, writable: false })
  }
}

function TitleProbe({ title }: { title: string }): null {
  useTerminalTitle(title)
  return null
}

class FakeInput extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}

/**
 * One step in a title trace: a title to render, or the answer the host publishes
 * underneath the title already on screen. The second kind is the timeline a
 * resumed session hits - its title is decided early and never changes again, so
 * the publish that arrives afterwards is the marker's only chance (T-FIX-04).
 */
type TitleStep = string | { wired: boolean }

/**
 * Render `useTerminalTitle` for the first step's title, then apply the remaining
 * steps and answer what reached the terminal: the value `process.title` ended up
 * with after each step, and the bytes the POSIX branch wrote. Each wait is
 * anchored on the value moving away from the previous one, so a case that expects
 * *no* marker still proves the hook ran - the assertion below it reads the value,
 * it does not race the render.
 * @param platform - The platform the hook sees (this suite runs on both).
 * @param steps - The first title (it mounts the probe), then further titles to
 *   rerender or wiring values to publish; one entry in `seen` per step.
 */
async function titleTrace(platform: NodeJS.Platform, steps: readonly [string, ...TitleStep[]]): Promise<{ seen: string[], raw: string[] }> {
  return withPlatform(platform, async () => {
    const raw: string[] = []
    const input = new FakeInput()
    const output = Object.assign(new Writable({
      write(_chunk, _encoding, done) { done() },
    }), { isTTY: true, columns: 40, rows: 6 })
    process.title = SENTINEL
    const element = (title: string): ReactElement => React.createElement(
      TerminalWriteProvider,
      { value: (data: string) => { raw.push(data) } },
      React.createElement(TitleProbe, { title }),
    )
    const instance = await render(element(steps[0]), {
      stdin: input, stdout: output, stderr: output, patchConsole: false, exitOnCtrlC: false,
    })
    const seen: string[] = []
    try {
      for (const [index, step] of steps.entries()) {
        const previous = seen.at(-1) ?? SENTINEL
        const arrived = (): boolean => process.title !== previous || raw.length > 0
        if (typeof step === 'string') {
          if (index > 0) instance.rerender(element(step))
        } else {
          // No rerender accompanies this one: the store's own publish is what has
          // to reach the mounted hook.
          setWindowsToastWiring(step.wired)
        }
        await settle(arrived)
        seen.push(process.title)
      }
      return { seen, raw }
    } finally {
      instance.unmount()
    }
  })
}

let passed = 0
async function check(name: string, body: () => void | Promise<void>): Promise<void> {
  await body()
  passed += 1
  process.stdout.write(`ok ${passed} - ${name}\n`)
}

/** The line the marker decision writes whenever it withholds the marker. */
const NO_MARKER_LOG = '[dsh-tui] terminal title: no jump-back marker'

/**
 * Run one title case with the debug channel captured, and answer the marker
 * decisions it wrote alongside the trace. `logForDebugging` is stderr-only and
 * off by default, so this pins the switch for the case and puts it back after -
 * the other groups run with it off, as a user's session does.
 * @param body - The case to run with the channel on.
 */
async function withMarkerLogs<T>(body: () => Promise<T>): Promise<{ logs: Record<string, unknown>[], result: T }> {
  const logs: Record<string, unknown>[] = []
  const realStderrWrite = process.stderr.write.bind(process.stderr)
  const realDebug = process.env.DSH_TUI_DEBUG
  process.env.DSH_TUI_DEBUG = '1'
  process.stderr.write = ((chunk: unknown): boolean => {
    const line = String(chunk).trimEnd()
    if (line.startsWith(NO_MARKER_LOG)) logs.push(JSON.parse(line.slice(NO_MARKER_LOG.length)) as Record<string, unknown>)
    return true
  }) as typeof process.stderr.write
  try {
    return { logs, result: await body() }
  } finally {
    process.stderr.write = realStderrWrite
    if (realDebug === undefined) delete process.env.DSH_TUI_DEBUG
    else process.env.DSH_TUI_DEBUG = realDebug
  }
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
  assert.ok(xml.includes(`launch="${activationUri(MARKER)}"`), 'the click comes back to the marker the title promises')
  const command = chain.registry.writes.find(write => write.name === null)
  assert.ok(command !== undefined, 'the handler command is the key\'s default value')
  // The shell starts the helper without this process's environment (T01): without
  // -DataDir it logs into the user's real ~/.dsh-tui even in an isolated run.
  assert.ok(command.value.includes(`-DataDir "${DATA_DIR}"`), 'the handler carries the data directory this run resolved')
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
  assert.deepEqual(chain.helper.calls, [], 'and no helper is looked at')
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
  assert.deepEqual(chain.helper.calls, [], 'POSIX must not build the helper')
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

// --- AC-3/D7: the title's jump-back marker, the toast's promise ----------------
// The win32 groups come first on purpose: the shared transport fixes its platform
// on first use, and every one of them stubs win32 so the suite means the same
// thing on a Windows host and on the POSIX CI runner.

/**
 * Publish the host's answer to "does this launch deliver through the toast",
 * which `apply` does wherever it configures the settings (F5). The platform is
 * pinned rather than read, so the answer does not depend on where the suite runs.
 * @param settings - The condition and method this launch was configured with.
 */
function wireToast(settings: TaskNotificationSettings): void {
  publishWindowsToastWiring(settings, 'win32')
}

await check('configuring the settings publishes the wiring the title marker reads', async () => {
  const notifier = createTerminalNotifier(Object.assign(new Writable({
    write(_chunk, _encoding, done) { done() },
  }), { isTTY: true }))
  const { configure } = createTaskNotificationSettings(notifier, { condition: 'always', method: 'auto' })
  // The decision is the host's, taken from the settings and the platform: this
  // is the same call `apply` and a live /settings edit make.
  await withPlatform('win32', async () => {
    configure('off', 'auto')
    assert.equal(windowsToastWired(), false, 'a launch that never announces has no toast to promise')
    configure('unfocused', 'bel')
    assert.equal(windowsToastWired(), false, 'the bell is the notification: nothing is waiting to be clicked')
    configure('unfocused', 'auto')
    assert.equal(windowsToastWired(), true, 'and this is the launch the marker exists for')
  })
})

await check('win32 + a transport that can deliver: the title ends with the marker', async () => {
  writeProfile({})
  wireToast({ condition: 'unfocused', method: 'auto' })
  const run = await titleTrace('win32', [ANSI_TITLE])
  assert.equal(run.seen[0], `${CLEAN_TITLE} ${MARKER}`, 'the marker is appended to the ANSI-stripped title, at the end (D7)')
})

await check('a later title update keeps the marker', async () => {
  writeProfile({})
  wireToast({ condition: 'unfocused', method: 'auto' })
  const run = await titleTrace('win32', [ANSI_TITLE, '✳ 🐋 verify (updated)'])
  assert.deepEqual(run.seen, [`${CLEAN_TITLE} ${MARKER}`, `✳ 🐋 verify (updated) ${MARKER}`], 'every title change, not just the first, carries the jump-back')
})

// --- T-FIX-04: the wiring that lands after the first title ---------------------
// A resumed session decides its title early and never changes it again, so the
// host's configure can land after the only title write there will ever be. The
// marker is decided from the published answer, so the title has to be rewritten
// when that answer moves: without the wakeup the tab stays unmarked for the rest
// of that session and a click on the toast finds no window to jump back to.

await check('a title written before the host publishes the wiring gains the marker when it lands', async () => {
  writeProfile({})
  wireToast({ condition: 'off', method: 'auto' })
  const run = await titleTrace('win32', [ANSI_TITLE, { wired: true }])
  assert.equal(run.seen[0], CLEAN_TITLE, 'premise: nothing is published yet, so the title already on screen carries no marker')
  assert.equal(run.seen[1], `${CLEAN_TITLE} ${MARKER}`, 'the publish has to rewrite the title as it stands: a resumed session renders no other one (T-FIX-04)')
})

await check('the wiring moving off the toast withdraws the marker from the title on screen', async () => {
  writeProfile({})
  wireToast({ condition: 'unfocused', method: 'auto' })
  const run = await titleTrace('win32', [ANSI_TITLE, { wired: false }])
  assert.equal(run.seen[0], `${CLEAN_TITLE} ${MARKER}`, 'control: this launch routes its completions to the toast')
  assert.equal(run.seen[1], CLEAN_TITLE, 'a launch that stops routing to it must take the promise back, byte for byte')
})

// --- T-FIX-04: why a title carries no marker -----------------------------------
// An unmarked tab looks exactly like a marked one until the user clicks the toast
// and nothing comes back, so every branch that withholds the marker has to name
// the condition that did it - the settings, the profile document, the system.

const skipCases = [
  {
    name: 'the profile document names an external notifier',
    arrange: () => {
      writeProfile({ [EXTERNAL_NOTIFIER_PACKAGES[0]]: '^1.0.0' })
      wireToast({ condition: 'unfocused', method: 'auto' })
    },
    expected: { reason: 'yielded', profile: PROFILE_DOCUMENT },
  },
]

for (const skipCase of skipCases) {
  await check(`a title without the marker names why: ${skipCase.name}`, async () => {
    skipCase.arrange()
    const { logs, result } = await withMarkerLogs(() => titleTrace('win32', [ANSI_TITLE]))
    assert.equal(result.seen[0], CLEAN_TITLE, 'this is one of the cases that leave the marker off')
    assert.deepEqual(logs, [skipCase.expected], 'the reason, and the input it was decided from, once per title')
  })
}

await check('no branch withholds the marker without saying so', () => {
  const branch = /function jumpBackMarker[\s\S]*?\n\}/u.exec(readFileSync(titleHookPath, 'utf8'))?.[0]
  assert.ok(branch !== undefined, 'the scan has to find the decision it is about')
  assert.deepEqual(
    [...branch.matchAll(/return undefined/gu)].map(match => match[0]),
    [],
    'a silent `return undefined` is the failure this group exists for; withhold through noMarker()',
  )
})

await check('a launch that does not route to the toast keeps the title byte-identical', async () => {
  writeProfile({})
  // The control comes first: without a case that does write the marker, "no
  // marker" below would also pass for a marker that is never written at all.
  wireToast({ condition: 'unfocused', method: 'auto' })
  const wired = await titleTrace('win32', [ANSI_TITLE])
  assert.equal(wired.seen[0], `${CLEAN_TITLE} ${MARKER}`, 'control: this launch delivers its completions through the toast')
  wireToast({ condition: 'off', method: 'auto' })
  const off = await titleTrace('win32', [ANSI_TITLE])
  assert.equal(off.seen[0], CLEAN_TITLE, 'taskNotifications=off shows no toast, so a marker would promise a click that never comes')
  wireToast({ condition: 'always', method: 'bel' })
  const bel = await titleTrace('win32', [ANSI_TITLE])
  assert.equal(bel.seen[0], CLEAN_TITLE, 'notificationMethod=bel makes the bell the notification: no toast is waiting for a click')
})

await check('win32 + a profile this process cannot name: the marker is still written', async () => {
  delete process.env.DSH_TUI_PROFILE
  try {
    wireToast({ condition: 'unfocused', method: 'auto' })
    const run = await titleTrace('win32', [ANSI_TITLE])
    assert.equal(run.seen[0], `${CLEAN_TITLE} ${MARKER}`, 'an unnameable profile only drops the dedup question, not the jump-back')
  } finally {
    process.env.DSH_TUI_PROFILE = PROFILE
  }
})

await check('off Windows the title is untouched and OSC 0 carries the bytes it always did', async () => {
  const run = await titleTrace('darwin', [ANSI_TITLE])
  assert.equal(run.seen[0], SENTINEL, 'the marker belongs to the Windows title only')
  assert.deepEqual(run.raw, [osc(OSC.SET_TITLE_AND_ICON, CLEAN_TITLE)], 'the POSIX branch is unchanged (AC-7)')
})

// --- D12/AC-7: what a POSIX process must not load ------------------------------
// A static import is what drags the Windows transport - and the helper compiler
// behind it - into every process that renders the title, on every platform. The
// platform gates inside the module keep the side effects off, but the load is
// the part nothing else can undo, so it is pinned here by source text.

await check('no source file imports the Windows transport at load time', () => {
  const scanned = collectSources(join(repoRoot, 'src'))
  const offenders = scanned.flatMap(file => {
    const source = readFileSync(file, 'utf8')
    return LOAD_TIME_IMPORTS.flatMap(pattern => [...source.matchAll(pattern)].map(match => match[1]))
      .filter(specifier => specifier.includes(WINDOWS_MODULE))
      .map(specifier => `${relative(repoRoot, file)} -> ${specifier}`)
  })
  // A scan over nothing passes for the wrong reason: the hook that appends the
  // marker has to be inside the set it reads.
  assert.ok(scanned.includes(titleHookPath), 'the scan must cover the hook that appends the marker')
  assert.deepEqual(offenders, [], `the transport is loaded on first use, never at load time (D12/AC-7):\n${offenders.join('\n')}`)
})

// --- L-049: the sandbox held, and the real home was left alone -----------------

await check('the module graph resolved into the sandbox and added nothing to the real ~/.dsh-tui', async () => {
  assert.equal(DATA_DIR, sandboxDataDir, 'the environment preceded the import: DATA_DIR resolved inside the sandbox')
  const realEntriesAfter = realDataDir !== '' && existsSync(realDataDir) ? new Set(readdirSync(realDataDir)) : null
  const added = [...(realEntriesAfter ?? [])].filter(name => !(realEntriesBefore?.has(name) ?? false))
  assert.deepEqual(added, [], 'a side effect would leave a NEW entry (the helper cache), and that is what this watches')
})

process.title = originalTitle
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
