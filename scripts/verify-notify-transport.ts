/**
 * Windows toast transport contract (T03): the toast XML layer, the lazy AUMID
 * registration state machine, and the external-notifier dedup - all driven
 * through injected ports.
 *
 * Nothing here touches the machine: the registry port records instead of
 * writing, the runner records instead of spawning, and the environment is
 * redirected to a throwaway home before the import. Popping a real toast and
 * registering the real AUMID are the machine pass (UAT).
 *
 * Run: node --import tsx/esm scripts/verify-notify-transport.ts
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { stringWidth } from '../src/ink/stringWidth.js'
import type { ExecFileNoThrowOptions, ExecFileNoThrowResult } from '../src/utils/execFileNoThrow.js'
import type { RegistryPort, WindowsToastTransport, WindowsToastTransportOptions } from '../src/ink/terminal-notification-windows.js'

const tempDirs: string[] = []
process.on('exit', () => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* the fixture is gone already */ }
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-notify-transport-'))
  tempDirs.push(dir)
  return dir
}

// The environment is redirected before the import so that a production default
// this suite does not inject - a data directory, a home - resolves inside a
// throwaway tree rather than in the user's.
const fakeHome = tempDir()
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.DSH_HOME = join(fakeHome, '.dsh')

const {
  AUMID_REGISTRY_KEY,
  EXTERNAL_NOTIFIER_PACKAGES,
  createWindowsToastTransport,
  escapeXmlText,
  shouldYieldToExternalNotifier,
  toastHostSpawnOptions,
  toastXml,
} = await import('../src/ink/terminal-notification-windows.js')

/** The title the renderer passes today (`src/i18n.ts`, AC-1). */
const TITLE = 'dsh-TUI · 任务已完成'
/** Escaping torture: every character AC-8 names, plus CJK and an emoji. */
const NASTY = 'a & b < c > d "quoted" · 摘要 🐋 & < > "'
/**
 * `NASTY` after escaping, spelled out rather than derived from `escapeXmlText`.
 * An expectation built by calling the function under test cannot fail when that
 * function breaks - both sides move together.
 */
const NASTY_ESCAPED = 'a &amp; b &lt; c &gt; d &quot;quoted&quot; · 摘要 🐋 &amp; &lt; &gt; &quot;'
const WINDIR = 'C:\\WINDOWS'
// Composed with `join`, like the module does: the suite also runs on POSIX CI,
// where a hardcoded `\` path would never equal what the module built.
const REG_PATH = join(WINDIR, 'System32', 'reg.exe')
const POWERSHELL_PATH = join(WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const FAILURE = 'ERROR: Access is denied.'

/** The process runner the ports are given, as `execFileNoThrow` provides it. */
type RunCommand = (
  file: string,
  args: readonly string[],
  options?: ExecFileNoThrowOptions,
) => Promise<ExecFileNoThrowResult>

type RunCall = { file: string, args: readonly string[], input: string | undefined, timeout: number | undefined }
type RegistryWrite = { key: string, name: string | null, value: string }
type LogLine = [string, Record<string, unknown> | undefined]

/** Stands in for execFileNoThrow: records the invocation, spawns nothing. */
function recordingRunner(outcome: (file: string) => { code: number, stderr?: string } = () => ({ code: 0 })) {
  const calls: RunCall[] = []
  const run: RunCommand = async (file, args, options) => {
    calls.push({ file, args, input: options?.input, timeout: options?.timeout })
    const settled = outcome(file)
    return { code: settled.code, stdout: '', stderr: settled.stderr ?? '' }
  }
  return { calls, run }
}

/** Stands in for the registry: records every attempt, so "no retry" is countable. */
function recordingRegistry(failOn?: (name: string | null) => string | undefined) {
  const writes: RegistryWrite[] = []
  const registry: RegistryPort = {
    async setValue(key, name, value) {
      writes.push({ key, name, value })
      const detail = failOn?.(name)
      return detail === undefined ? { ok: true } : { ok: false, detail }
    },
  }
  return { writes, registry }
}

interface Harness {
  registry: ReturnType<typeof recordingRegistry>
  runner: ReturnType<typeof recordingRunner>
  logged: LogLine[]
  transport: WindowsToastTransport
}

/** One construction point for the whole suite: every port is a stub. */
function harness(options: {
  registry?: ReturnType<typeof recordingRegistry>
  runner?: ReturnType<typeof recordingRunner>
  env?: Record<string, string | undefined>
  /** The icon lookup; the default resolves the file the package ships. */
  iconPath?: () => string | undefined
} = {}): Harness {
  const registry = options.registry ?? recordingRegistry()
  const runner = options.runner ?? recordingRunner()
  const logged: LogLine[] = []
  const transportOptions: WindowsToastTransportOptions = {
    platform: 'win32',
    env: options.env ?? { windir: WINDIR },
    registry: registry.registry,
    run: runner.run,
    // One recorder for both runners: no case here is about the split, and the one
    // that is ("the toast host runs on its own runner") builds its own transport.
    runToastHost: runner.run,
    now: () => 1_000,
    log: (message, fields) => logged.push([message, fields]),
    iconPath: options.iconPath,
  }
  return { registry, runner, logged, transport: createWindowsToastTransport(transportOptions) }
}

/** A profile document with (or without) a `dependencies` block. */
function profileWith(dependencies: Record<string, string> | undefined): string {
  const path = join(tempDir(), 'package.json')
  writeFileSync(path, dependencies === undefined ? '{ "name": "dsh-tui" }' : JSON.stringify({ name: 'dsh-tui', dependencies }))
  return path
}

let passed = 0
async function check(name: string, body: () => void | Promise<void>): Promise<void> {
  await body()
  passed += 1
  process.stdout.write(`ok ${passed} - ${name}\n`)
}

// --- the pure layer (D10/AC-8) -------------------------------------------------

await check('text escaping covers exactly the characters AC-8 names', () => {
  assert.equal(escapeXmlText(NASTY), NASTY_ESCAPED)
  assert.equal(escapeXmlText('plain · 🐋'), 'plain · 🐋', 'escaping must leave ordinary text - emoji included - alone')
  assert.equal(escapeXmlText('&amp;'), '&amp;amp;', 'already-escaped input is text, not markup')
})

await check('the toast XML carries the title and the summary, and nothing else', () => {
  const xml = toastXml({ title: TITLE, message: '摘要一行' })
  assert.ok(xml.startsWith('<toast'), 'the document root is a toast')
  assert.ok(xml.includes('<binding template="ToastGeneric">'), 'the generic template is what desktop toasts render')
  assert.deepEqual(textNodes(xml), [TITLE, '摘要一行'], 'title first, summary second - AC-1')
  assert.deepEqual(textNodes(toastXml({ title: TITLE })), [TITLE], 'an empty summary shows the title alone')

  const nasty = toastXml({ title: NASTY, message: NASTY })
  assert.deepEqual(textNodes(nasty), [NASTY_ESCAPED, NASTY_ESCAPED])
  for (const node of textNodes(nasty)) {
    assert.doesNotMatch(node, /[<>]/u, 'a text node must not carry raw markup')
    assert.doesNotMatch(node, /&(?!(?:amp|lt|gt|quot);)/u, 'every ampersand must open one of the four entities')
  }
  assert.ok(nasty.includes('🐋'), 'the emoji must survive escaping')
})

await check('an over-long summary is clipped to the two lines the toast can show', () => {
  // Windows clips the body itself at around four rendered lines and stops the
  // sentence with no ellipsis at all (UAT screenshot, 2026-10-16), so the
  // budget has to be ours. 80 columns is two of the roughly 43-column lines
  // that screenshot rendered for a mixed CJK/Latin summary - and the same
  // measure, so an English summary still reads as two lines rather than one
  // clipped by the shell.
  const message = '很长的任务摘要。'.repeat(20)
  assert.ok(stringWidth(message) > 80, 'the fixture must exceed the budget, or this check proves nothing (L-048)')
  const [, body] = textNodes(toastXml({ title: TITLE, message }))
  assert.ok(stringWidth(body) <= 80, `the body must fit two lines, got ${stringWidth(body)} columns`)
  assert.ok(body.endsWith('…'), `a clipped summary says so instead of just stopping: ${body}`)
  assert.ok(message.startsWith(body.slice(0, -1)), 'the clip keeps the opening - it is a cut, not a rewrite')
})

// --- the dedup decision (D8/AC-6) ---------------------------------------------

await check('a profile that depends on an external notifier yields', () => {
  assert.ok(EXTERNAL_NOTIFIER_PACKAGES.length > 0, 'the list is the single place the names live')
  for (const name of EXTERNAL_NOTIFIER_PACKAGES) {
    assert.equal(shouldYieldToExternalNotifier(profileWith({ [name]: '^1.0.0' })), true, `${name} must count as an external notifier`)
  }
})

await check('a profile without one does not yield, and an unreadable profile never throws', () => {
  assert.equal(shouldYieldToExternalNotifier(profileWith({ '@deepseek-harness-tui/dsh-tui': '^0.15.0' })), false)
  assert.equal(shouldYieldToExternalNotifier(profileWith(undefined)), false, 'no dependencies block means no notifier')
  assert.equal(shouldYieldToExternalNotifier(join(tempDir(), 'absent', 'package.json')), false, 'an unreadable profile must not silence the notification')
})

// --- the registration state machine (D11/AC-5) ---------------------------------

await check('the first notification registers the AUMID', async () => {
  const h = harness()
  const result = await h.transport.notify({ title: TITLE, message: '摘要' })
  assert.deepEqual(result, { status: 'shown' })
  assert.deepEqual(
    h.registry.writes.map(write => [write.key, write.name]),
    [
      [AUMID_REGISTRY_KEY, 'DisplayName'],
      [AUMID_REGISTRY_KEY, 'IconUri'],
    ],
    'the AUMID comes first: without it Show() succeeds silently (E2)',
  )
  assert.equal(h.registry.writes[0].value, 'dsh-TUI')
  // IconUri is resolved by the shell, which has no working directory of ours
  // and no second chance: pointing it at the in-box host rendered no icon at
  // all in the UAT (2026-10-16), so the value has to be an image file the
  // package really ships.
  const iconPath = h.registry.writes[1].value
  assert.ok(isAbsolute(iconPath), `IconUri must be an absolute path: ${iconPath}`)
  assert.match(iconPath, /\.png$/u, `IconUri must be an image, not the in-box executable: ${iconPath}`)
  assert.ok(existsSync(iconPath), `IconUri must point at a file that ships with the package: ${iconPath}`)
})

await check('an icon the package cannot supply is left unregistered instead of guessed at', async () => {
  // "No icon" is the deliberate answer when the shipped file is missing: the
  // shell renders nothing for a path it cannot read either, and leaving the
  // value out is the one outcome that cannot poison the AUMID entry.
  const h = harness({ iconPath: () => undefined })
  assert.deepEqual(await h.transport.notify({ title: TITLE, message: '摘要' }), { status: 'shown' })
  assert.deepEqual(
    h.registry.writes.map(write => write.name),
    ['DisplayName'],
    'DisplayName still creates the key first, and no IconUri is written at all',
  )
  assert.match(JSON.stringify(h.logged), /icon/, 'and the missing icon is reported, not silently dropped')
})

await check('registration happens once and is reused by later notifications', async () => {
  const h = harness()
  await h.transport.notify({ title: TITLE })
  const writes = h.registry.writes.length
  const spawns = h.runner.calls.length
  await h.transport.notify({ title: TITLE, message: 'second' })
  assert.equal(h.registry.writes.length, writes, 'the second toast must not rewrite the registry')
  assert.equal(h.runner.calls.length, spawns + 1, 'but it does show a toast')
})

await check('a refused AUMID write is reported, not retried', async () => {
  const registry = recordingRegistry(name => (name === 'DisplayName' ? FAILURE : undefined))
  const h = harness({ registry })
  const first = await h.transport.notify({ title: TITLE })
  assert.equal(first.status, 'unavailable')
  assert.equal(first.reason, 'aumid-registration-failed')
  assert.match(first.detail ?? '', /Access is denied/, 'the registry error is the only clue for R2')
  assert.equal(h.registry.writes.length, 1, 'a policy refusal is not retried on the next notification')
  const second = await h.transport.notify({ title: TITLE })
  assert.deepEqual(second, first)
  assert.equal(h.registry.writes.length, 1, 'the unavailable state is cached for the process (D11)')
  assert.equal(h.runner.calls.length, 0, 'a toast that cannot display must not be spawned (AC-5: the caller rings the bell)')
})

await check('the toast is spawned by in-box PowerShell with the XML on stdin, never in argv', async () => {
  const h = harness()
  await h.transport.notify({ title: TITLE, message: NASTY })
  const [call] = h.runner.calls
  assert.equal(call.file, POWERSHELL_PATH, 'the in-box host, resolved from %WINDIR% rather than PATH')
  assert.ok(call.args[0] === '-NoProfile', 'the profile is what makes the cold start 3.1-3.4 s worse')
  assert.ok(call.args.includes('-Command'), 'the script itself travels as one argument')
  assert.equal(
    call.input,
    `<toast><visual><binding template="ToastGeneric"><text>${TITLE}</text><text>${NASTY_ESCAPED}</text></binding></visual></toast>`,
    'the whole document reaches stdin, spelled out: comparing it against toastXml() would move both sides at once',
  )
  assert.ok(!/[<>·🐋]/u.test(call.args.join(' ')), 'user text must never reach the command line (security)')
  assert.ok(typeof call.timeout === 'number' && call.timeout > 0, 'a stuck PowerShell must not hold the caller forever')
  assert.equal(h.logged.filter(([, fields]) => fields?.ms !== undefined).length, 1, 'R1: the log records how long the spawn took')
})

await check('the script body carries the two things the real host needs', async () => {
  const h = harness()
  await h.transport.notify({ title: TITLE })
  const [call] = h.runner.calls
  const script = call.args[call.args.indexOf('-Command') + 1]
  assert.ok(script !== undefined, 'the script travels as the single -Command argument')
  // Measured on a real machine: Windows PowerShell does not project WinRT types
  // on demand, so without these loads the toast never appears - while the argv
  // shape above still looks perfect. Nothing else in this suite can catch that,
  // and CI has no Windows host.
  const documentType = script.indexOf('Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument')
  const managerType = script.indexOf('Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications')
  const firstUse = script.indexOf('New-Object Windows.Data.Xml.Dom.XmlDocument')
  assert.ok(documentType >= 0 && managerType >= 0, 'the WinRT types have to be loaded explicitly')
  assert.ok(documentType < firstUse && managerType < firstUse, 'loading them after the first New-Object is too late')
  // And stdin is decoded as UTF-8: `[Console]::In` decodes with the console code
  // page (CP936 here), which turns a Chinese summary into mojibake - measured too.
  assert.ok(script.includes('Encoding]::UTF8'), 'the toast XML must be decoded as UTF-8')
  assert.ok(!script.includes('[Console]::In'), 'the console code page must not be involved')
})

await check('the toast host is spawned with no console of its own, so it cannot retitle ours', () => {
  // The defect this pins (UAT-M4): the in-box host inherits the TUI's console and
  // sets its title as it starts. Measured on a real machine (2026-10-16): the
  // title went to "Windows PowerShell" with the previous options and stayed put
  // with these.
  const options = toastHostSpawnOptions()
  assert.equal(options.windowsHide, true, 'CREATE_NO_WINDOW is what leaves the host without a console to retitle')
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe'], 'the XML and the failure text still travel on pipes')
  assert.equal(options.detached, undefined, 'DETACHED_PROCESS also leaves the title alone, but measured 2026-10-16 it skipped the script entirely: a toast that never appears is worse than a renamed tab')
})

await check('the toast host runs on its own runner, never on the one that keeps this console', async () => {
  // Where the toast is spawned is the half a test can see: handing it back to
  // `run` - the runner `reg.exe` uses, which `execFileNoThrow` spawns with the
  // console inherited - leaves the isolated runner empty, and that is the shape
  // that produced UAT-M4. Every port but the registry is stubbed, so the two
  // runners are told apart by what they carried.
  const shared = recordingRunner()
  const toast = recordingRunner()
  const transport = createWindowsToastTransport({
    platform: 'win32',
    env: { windir: WINDIR },
    run: shared.run,
    runToastHost: toast.run,
    log: () => {},
  })
  await transport.notify({ title: TITLE, message: '摘要' })
  assert.deepEqual(shared.calls.map(call => call.file), [REG_PATH, REG_PATH], 'the registry writes keep the shared runner')
  assert.deepEqual(toast.calls.map(call => call.file), [POWERSHELL_PATH], 'and the toast host is the one spawn that must not inherit this console')
})

await check('a failed PowerShell run is unavailable with its cause logged', async () => {
  const h = harness({ runner: recordingRunner(() => ({ code: 1, stderr: FAILURE })) })
  const result = await h.transport.notify({ title: TITLE })
  assert.equal(result.status, 'unavailable')
  assert.equal(result.reason, 'toast-failed')
  assert.match(JSON.stringify(h.logged), /Access is denied/, 'the caller falls back to the bell, so the log is the only trace')
})

await check('a throwing port is reported as unexpected instead of rejecting', async () => {
  const h = harness({ runner: { calls: [], run: async () => { throw new Error('spawn exploded') } } })
  const result = await h.transport.notify({ title: TITLE })
  assert.equal(result.status, 'unavailable')
  assert.equal(result.reason, 'unexpected')
  assert.match(result.detail ?? '', /spawn exploded/)
})

await check('a toast host that cannot be started is unavailable, not an uncaught error', async () => {
  // No `runToastHost`, so this is the production spawn - pointed at a %WINDIR%
  // that holds no host, which is how the child fails to start. Without the
  // 'error' listener that failure is an uncaught exception in the process
  // rendering the TUI, which no caller can catch or fall back from.
  const transport = createWindowsToastTransport({
    platform: 'win32',
    env: { windir: tempDir() },
    registry: recordingRegistry().registry,
    run: recordingRunner().run,
    log: () => {},
  })
  const result = await transport.notify({ title: TITLE })
  assert.equal(result.status, 'unavailable')
  assert.equal(result.reason, 'toast-failed')
})

await check('a missing %WINDIR% is refused before any write', async () => {
  const h = harness({ env: {} })
  const result = await h.transport.notify({ title: TITLE })
  assert.equal(result.status, 'unavailable')
  assert.equal(result.reason, 'system-root-missing')
  assert.deepEqual(h.registry.writes, [])
  assert.deepEqual(h.runner.calls, [])
})

await check('every registry write targets this module\'s own HKCU keys', async () => {
  const h = harness()
  await h.transport.notify({ title: TITLE })
  for (const write of h.registry.writes) {
    assert.ok(write.key.startsWith('HKCU\\Software\\Classes\\'), `${write.key} is outside the user's own classes hive`)
  }
})

await check('the default registry port drives in-box reg.exe against our own key', async () => {
  // Every port but the registry is stubbed, so this is the production writer
  // path - `reg.exe add` argv included - with nothing actually written.
  const runner = recordingRunner()
  const transport = createWindowsToastTransport({
    platform: 'win32',
    env: { windir: WINDIR },
    run: runner.run,
    runToastHost: runner.run,
    log: () => {},
  })
  const result = await transport.notify({ title: TITLE })
  assert.deepEqual(result, { status: 'shown' })
  assert.deepEqual(runner.calls.map(call => call.file), [REG_PATH, REG_PATH, POWERSHELL_PATH])
  const [display, icon, toast] = runner.calls
  assert.deepEqual(display.args.slice(0, 2), ['add', AUMID_REGISTRY_KEY])
  assert.deepEqual(display.args.slice(2, 7), ['/v', 'DisplayName', '/t', 'REG_SZ', '/d'])
  assert.equal(display.args[7], 'dsh-TUI')
  assert.ok(display.args.includes('/f'), 'without /f reg.exe waits for a prompt nobody can answer')
  for (const call of [display, icon]) {
    assert.ok(typeof call.timeout === 'number' && call.timeout > 0, 'a stuck reg.exe must not hold the caller forever')
  }
  assert.equal(toast.file, POWERSHELL_PATH, 'and the toast follows the registration')
})

// --- the assembled contract ----------------------------------------------------

// A dedup hit is asserted end to end instead: the real caller reads the real
// profile document through the real transport
// (verify-task-notifications-windows.ts, "delivers nothing at all").

await check('dedup misses still deliver the notification', async () => {
  const h = harness()
  const result = await h.transport.notify({ title: TITLE, profilePackageJsonPath: profileWith({ 'dsh-ops': '^0.3.0' }) })
  assert.deepEqual(result, { status: 'shown' })
  assert.equal(h.runner.calls.length, 1)
})

for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
process.stdout.write(`notify transport regression passed (${passed} checks)\n`)

/** The `<text>` nodes of a ToastGeneric document, in document order. */
function textNodes(xml: string): string[] {
  return [...xml.matchAll(/<text>([\s\S]*?)<\/text>/gu)].map(match => match[1])
}
