/**
 * Jump-back contracts: the pane marker (minted once, published to the title
 * writer and the activation URI), the probe, the lazy protocol registration, the
 * documented marker file, the cleanup/stale sweep, and the launch URI wiring.
 *
 * The toast XML/AUMID machine and the delivery chain live in their own suites;
 * the helper's five-point UIA check stays UAT. Every side effect is an injected
 * port, and the last assertion proves the production profile was never reached.
 *
 * Run: node --import tsx/esm scripts/verify-jumpback.ts
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { TaskCompletionDelivery, TaskCompletionJumpBack } from '../src/dsh-adapter/plugin.js'
import type { PluginManagerView } from '../src/dsh-adapter/plugin-manager.js'
import type { JumpBackProbe } from '../src/ink/jumpback.js'
import type { WindowsToastInput, WindowsToastResult } from '../src/ink/terminal-notification-windows.js'
import type { ExecFileNoThrowOptions, ExecFileNoThrowResult } from '../src/utils/execFileNoThrow.js'

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-jumpback-'))
const sandboxHome = join(sandbox, 'home')
mkdirSync(sandboxHome)
// `DATA_DIR` is a module-level constant: the redirect has to be in place before
// the first import that reads it, or the suite writes the user's profile.
process.env.HOME = process.env.USERPROFILE = sandboxHome
process.env.DSH_HOME = join(sandbox, 'dsh-home')
process.on('exit', () => { try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* the fixture is gone already */ } })

const { DATA_DIR } = await import('../src/utils/paths.js')
const { createJumpBack } = await import('../src/ink/jumpback.js')
const { getJumpBackState, setJumpBackEnabled, subscribeJumpBack } = await import('../src/ink/jumpback-state.js')
const { jumpBackTitleSuffix } = await import('../src/ink/hooks/use-terminal-title.js')
const { applyJumpBackSetting, deliverTaskCompletionOnWindows } = await import('../src/dsh-adapter/plugin.js')

/** The title the renderer passes today (`src/i18n.ts`). */
const TITLE = 'dsh-TUI · 任务已完成'
/** A marker with the documented shape; fixed so argv expectations are literal. */
const MARKER = '0123456789abcdef'
/** The fixed clock and dead pid every age/owner case reads. */
const NOW = 1_700_000_000_000
const DAY_MS = 24 * 60 * 60 * 1_000
/** Above every platform's pid ceiling, so no live process can own it (D8 sweep). */
const DEAD_PID = 2_147_483_647
const WINDIR = 'C:\\WINDOWS'
// Composed with `join` like the module does: this suite also runs on POSIX CI,
// where a hardcoded backslash path would never equal what the module built.
const REG_EXE = join(WINDIR, 'System32', 'reg.exe')
/** The scheme root a toast click resolves through (D7); literal so a wrong key cannot agree with itself. */
const PROTOCOL_KEY = 'HKCU\\Software\\Classes\\dsh-tui'
/** The subkey whose default value is the command a click runs. */
const PROTOCOL_COMMAND_KEY = `${PROTOCOL_KEY}\\shell\\open\\command`
const HELPER = join(sandbox, 'helper', 'activate.exe')
/** The per-orchestration data directory; the suite never lets it default. */
const PROFILE = join(sandbox, 'profile')
const MARKER_DIR = join(PROFILE, 'notify', 'jumpback')
/** The two argv rows a full (re)registration writes, shared by every self-heal case. */
const REGISTRATION_WRITES = [
  ['add', PROTOCOL_KEY, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f'],
  ['add', PROTOCOL_COMMAND_KEY, '/ve', '/t', 'REG_SZ', '/d', `"${HELPER}" --activate "%1" -DataDir "${PROFILE}"`, '/f'],
] as const
const MISSING_KEY = 'ERROR: The system was unable to find the specified registry key or value.'

type RunCommand = (file: string, args: readonly string[], options?: ExecFileNoThrowOptions) => Promise<ExecFileNoThrowResult>
type RunCall = { file: string, args: readonly string[], timeout: number | undefined }
type RunOutcome = { code: number | null, stdout?: string, stderr?: string }

/** The map key for one registry value, so a case can delete or rewrite it. */
const registryValueId = (key: string, name: string | null): string => `${key}\u0000${name ?? ''}`

/**
 * Records the call and, by default, applies `reg.exe` verbs to an in-memory
 * value map: a later `reg query` answers an earlier `reg add`, without HKCU.
 */
function recordingRunner(
  outcome?: (call: { file: string, args: readonly string[] }, index: number) => RunOutcome | Promise<RunOutcome>,
) {
  const calls: RunCall[] = []
  const values = new Map<string, string>()
  const applyRegistryVerb = (args: readonly string[]): RunOutcome => {
    const [verb, key, ...rest] = args
    if (key === undefined) return { code: 1 }
    if (verb === 'add') {
      const name = rest[0] === '/ve' ? null : rest[0] === '/v' ? rest[1] ?? null : null
      const dataAt = rest.indexOf('/d')
      values.set(registryValueId(key, name), dataAt === -1 ? '' : rest[dataAt + 1] ?? '')
      return { code: 0 }
    }
    if (verb === 'delete') {
      for (const id of [...values.keys()]) if (id.startsWith(`${key}\u0000`) || id.startsWith(`${key}\\`)) values.delete(id)
      return { code: 0 }
    }
    if (verb === 'query') {
      const name = rest[0] === '/ve' ? null : rest[1] ?? null
      const data = values.get(registryValueId(key, name))
      if (data === undefined) return { code: 1, stderr: MISSING_KEY }
      return { code: 0, stdout: `${key}\r\n    ${name ?? '(Default)'}    REG_SZ${data === '' ? '' : `    ${data}`}\r\n` }
    }
    // Anything else is the helper run the probe tests drive, not a registry verb.
    return { code: 0 }
  }
  const run: RunCommand = async (file, args, options) => {
    const index = calls.length
    calls.push({ file, args, timeout: options?.timeout })
    const settled = await (outcome === undefined ? applyRegistryVerb(args) : outcome({ file, args }, index))
    return { code: settled.code, stdout: settled.stdout ?? '', stderr: settled.stderr ?? '' }
  }
  return { calls, run, values }
}

/** The protocol keys a recorded sequence leaves under the scheme root: `reg.exe`'s subtree semantics, without HKCU. */
function protocolKeys(calls: readonly RunCall[]): string[] {
  const keys = new Set<string>()
  for (const { args } of calls) {
    const [verb, key] = args
    if (key === undefined) continue
    if (verb === 'add') keys.add(key)
    else if (verb === 'delete') for (const existing of [...keys]) if (existing === key || existing.startsWith(`${key}\\`)) keys.delete(existing)
  }
  return [...keys].filter(key => key === PROTOCOL_KEY || key.startsWith(`${PROTOCOL_KEY}\\`)).sort()
}

/** One orchestration with every port stubbed; nothing here reaches the machine. */
function makeJumpBack(options: {
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  run?: ReturnType<typeof recordingRunner>
  /** The resolver's answer; `null` means "cannot be compiled". */
  helper?: string | null
  now?: () => number
  dataDir?: string
  pidAlive?: (pid: number) => boolean
} = {}) {
  const runner = options.run ?? recordingRunner()
  let resolverCalls = 0
  const instance = createJumpBack({
    platform: options.platform ?? 'win32',
    env: options.env ?? { WINDIR },
    run: runner.run,
    helperPath: async () => {
      resolverCalls += 1
      return options.helper === null ? undefined : options.helper ?? HELPER
    },
    now: options.now ?? (() => NOW),
    dataDir: options.dataDir ?? PROFILE,
    pidAlive: options.pidAlive,
  })
  return { instance, runner, resolverCalls: () => resolverCalls }
}

/** Run one body with the debug logger on and stderr captured; a failed assertion must still reach the real stderr. */
async function captureDebug<T>(body: () => T | Promise<T>): Promise<{ result: T, lines: string[] }> {
  const realWrite = process.stderr.write.bind(process.stderr)
  const lines: string[] = []
  const previous = process.env.DSH_TUI_DEBUG
  process.env.DSH_TUI_DEBUG = '1'
  process.stderr.write = ((chunk: unknown): boolean => { lines.push(String(chunk)); return true }) as typeof process.stderr.write
  try {
    return { result: await body(), lines }
  } finally {
    process.stderr.write = realWrite
    if (previous === undefined) delete process.env.DSH_TUI_DEBUG
    else process.env.DSH_TUI_DEBUG = previous
  }
}

/** The stage a probe reported, or undefined when it promised a jump. */
const unavailableStage = (probe: JumpBackProbe): string | undefined => probe.capable ? undefined : probe.stage
const reasonOf = (probe: JumpBackProbe): string => probe.capable ? '' : probe.reason

/** Turn the setting on and answer the marker the title writer would append. */
function enableJumpBack(): string {
  setJumpBackEnabled(true)
  const { marker } = getJumpBackState()
  assert.ok(marker !== null, 'the suite needs the marker the title writer appends')
  return marker
}

let passed = 0
async function check(name: string, body: () => void | Promise<void>): Promise<void> {
  await body()
  process.stdout.write(`ok ${++passed} - ${name}\n`)
}

// --- the marker in the pane title (D2/D3, AC-1/AC-2) ---------------------------
await check('the pane title carries the marker only on Windows, once enabled', () => {
  const suffix = (enabled: boolean, marker: string | null, platform: NodeJS.Platform): string => jumpBackTitleSuffix({ enabled, marker }, platform)
  assert.equal(suffix(false, null, 'win32'), '', 'off by default: the title must not change (AC-1)')
  assert.equal(suffix(false, MARKER, 'win32'), '', 'a retained marker is not a licence to write it while the setting is off')
  assert.equal(suffix(true, null, 'win32'), '', 'an enabled switch without a minted marker has nothing to name')
  assert.equal(suffix(true, MARKER, 'linux'), '', 'no other host resolves the marker, so tagging would only rename the tab (D2)')
  assert.equal(suffix(true, MARKER, 'win32'), ` [dsh-tui:${MARKER}]`, 'the documented suffix is appended after the title')
})

// --- one published identity ---------------------------------------------------
await check('enabling mints one 16-hex marker and publishes it once', () => {
  assert.deepEqual(getJumpBackState(), { enabled: false, marker: null, generation: 0 }, 'a fresh process starts off with no identity')
  const before = getJumpBackState()
  const seen: number[] = []
  const unsubscribe = subscribeJumpBack(() => seen.push(1))
  setJumpBackEnabled(true)
  const state = getJumpBackState()
  assert.notEqual(state, before, 'a real change publishes a new snapshot, or useSyncExternalStore never re-renders')
  assert.equal(state.enabled, true)
  assert.equal(state.generation, before.generation + 1, 'every toggle publishes a new generation, so a late preparation can tell it is stale')
  assert.match(String(state.marker), /^[0-9a-f]{16}$/u, 'the marker is 16 lowercase hex characters (D2/AC-2)')
  assert.deepEqual(seen, [1], 'subscribers are told exactly once')
  unsubscribe()
})
await check('republishing the same switch changes nothing, and an unsubscribed listener is not told', () => {
  const state = getJumpBackState()
  const seen: number[] = []
  const unsubscribe = subscribeJumpBack(() => seen.push(1))
  setJumpBackEnabled(true)
  assert.equal(getJumpBackState(), state, 'an unchanged switch must not replace the snapshot')
  assert.deepEqual(seen, [], 'nor wake the title writer')
  unsubscribe()
  setJumpBackEnabled(false)
  assert.deepEqual(seen, [], 'an unsubscribed listener stops hearing about changes')
  setJumpBackEnabled(true)
})
await check('disabling hides the marker, and enabling again reuses the same identity', () => {
  const marker = getJumpBackState().marker
  assert.match(String(marker), /^[0-9a-f]{16}$/u)
  setJumpBackEnabled(false)
  assert.equal(getJumpBackState().marker, marker, 'the identity survives the switch: an already-delivered toast keeps pointing at this pane')
  assert.equal(jumpBackTitleSuffix(getJumpBackState(), 'win32'), '', 'while it is off the title loses the suffix immediately (D3)')
  setJumpBackEnabled(true)
  assert.equal(getJumpBackState().marker, marker, 're-enabling must not rename the pane (AC-2)')
  assert.equal(jumpBackTitleSuffix(getJumpBackState(), 'win32'), ` [dsh-tui:${marker}]`)
})

// --- the pre-toast probe (D4, AC-3) -------------------------------------------
await check('a malformed marker is refused before the helper is even resolved', async () => {
  const { instance, runner, resolverCalls } = makeJumpBack()
  const malformed = ['', '0123456789ABCDEF', '0123456789abcde', '0123456789abcdef0', '0123456789abcdeg', '0123 456789abcde']
  for (const marker of malformed) assert.equal(unavailableStage(await instance.probe(marker)), 'marker', `${JSON.stringify(marker)} is not the documented marker shape`)
  assert.equal(resolverCalls(), 0, 'a wrong marker needs no compiler')
  assert.deepEqual(runner.calls, [], 'and no child process')
})
await check('exit 0 is capable and names the helper, with the data directory passed explicitly', async () => {
  const { instance, runner } = makeJumpBack()
  assert.deepEqual(await instance.probe(MARKER), { capable: true, helperPath: HELPER }, 'only exit 0 promises a jump (D4)')
  assert.deepEqual(runner.calls.map(call => call.file), [HELPER], 'the helper itself is spawned')
  assert.deepEqual(runner.calls[0].args, ['--probe', MARKER, '-DataDir', PROFILE], 'the helper inherits no environment, so the data directory travels as argv')
  assert.equal(runner.calls[0].timeout, 1_500, 'D4 budgets 1.5 s for a probe; a stuck helper must not delay the notification')
})
await check('the helper\'s own failure exit codes degrade with its line kept in the reason', async () => {
  for (const settled of [{ code: 2, stderr: 'usage: --probe <marker>' }, { code: 3, stderr: 'no reachable target' }]) {
    const { instance, runner } = makeJumpBack({ run: recordingRunner(() => settled) })
    const { result, lines } = await captureDebug(() => instance.probe(MARKER))
    assert.equal(unavailableStage(result), 'probe', `exit ${settled.code} is not a promise`)
    assert.ok(reasonOf(result).includes(`code ${settled.code}`), 'the exit code is in the reason')
    assert.ok(reasonOf(result).includes(settled.stderr), 'and the helper\'s own line is the only clue for the post-mortem')
    assert.match(lines.join(''), /"stage":"probe"/u, 'the stage and reason reach the debug log (AC-3)')
    assert.equal(runner.calls.length, 1)
  }
})
await check('a probe that never exits is a timeout, not a hang', async () => {
  const { instance } = makeJumpBack({ run: recordingRunner(() => ({ code: null })) })
  const probe = await instance.probe(MARKER)
  assert.equal(unavailableStage(probe), 'probe')
  assert.match(reasonOf(probe), /timed out after 1500 ms/u, 'the reason says what happened to the child')
})
await check('a throwing runner degrades instead of rejecting', async () => {
  const { instance } = makeJumpBack({ run: { calls: [], run: async () => { throw new Error('spawn exploded') } } })
  const probe = await instance.probe(MARKER)
  assert.equal(unavailableStage(probe), 'unexpected', 'the notification path must not inherit the error (AC-3)')
  assert.match(reasonOf(probe), /spawn exploded/u)
})
await check('a helper that cannot be compiled is unavailable before anything runs', async () => {
  const { instance, runner } = makeJumpBack({ helper: null })
  assert.equal(unavailableStage(await instance.probe(MARKER)), 'helper')
  assert.deepEqual(runner.calls, [], 'no child process is started for a helper that does not exist')
})
await check('off Windows the probe compiles and spawns nothing', async () => {
  const { instance, runner, resolverCalls } = makeJumpBack({ platform: 'linux' })
  assert.equal(unavailableStage(await instance.probe(MARKER)), 'not-win32')
  assert.equal(resolverCalls(), 0, 'no csc run either')
  assert.deepEqual(runner.calls, [])
})

// --- the lazy protocol registration (D7, AC-1/AC-9) ---------------------------
await check('registration writes the scheme root marker and the command, quoted', async () => {
  const { instance, runner } = makeJumpBack()
  assert.equal(await instance.ensureProtocol(HELPER), true)
  assert.deepEqual(runner.calls.map(call => call.file), [REG_EXE, REG_EXE], 'the in-box registry tool comes from %WINDIR%, never PATH')
  assert.deepEqual(runner.calls.map(call => call.args), REGISTRATION_WRITES, 'the root carries URL Protocol; the command below it is the default value')
  assert.ok(runner.calls.every(call => typeof call.timeout === 'number' && call.timeout > 0), 'a stuck reg.exe must not hold the notification')
})
await check('registration is verified after the first write, and a burst of notifications writes the key once', async () => {
  const cached = makeJumpBack()
  assert.equal(await cached.instance.ensureProtocol(HELPER), true)
  assert.equal(await cached.instance.ensureProtocol(HELPER), true)
  assert.deepEqual(cached.runner.calls.map(call => call.args[0]), ['add', 'add', 'query', 'query'], 'the second notification proves both values are still ours instead of trusting the cache')

  const burst = makeJumpBack()
  const answers = await Promise.all([1, 2, 3].map(() => burst.instance.ensureProtocol(HELPER)))
  assert.deepEqual(answers, [true, true, true])
  assert.equal(burst.runner.calls.length, 2, 'concurrent notifications share the one registration in flight (D7)')
  assert.deepEqual(burst.runner.calls.map(call => call.args[0]), ['add', 'add'], 'and none of them re-checks a key that is still in flight')
})
await check('a key deleted outside this process is written again before the next notification', async () => {
  const cases = [
    ['root value', registryValueId(PROTOCOL_KEY, 'URL Protocol'), [['query', PROTOCOL_KEY, '/v', 'URL Protocol'], ...REGISTRATION_WRITES]],
    ['command value', registryValueId(PROTOCOL_COMMAND_KEY, null), [['query', PROTOCOL_KEY, '/v', 'URL Protocol'], ['query', PROTOCOL_COMMAND_KEY, '/ve'], ...REGISTRATION_WRITES]],
  ] as const
  for (const [vanished, valueId, expected] of cases) {
    const runner = recordingRunner()
    const { instance } = makeJumpBack({ run: runner })
    assert.equal(await instance.ensureProtocol(HELPER), true)
    runner.values.delete(valueId)
    const before = runner.calls.length
    assert.equal(await instance.ensureProtocol(HELPER), true, `${vanished} gone: the next notification still promises the click`)
    assert.deepEqual(runner.calls.slice(before).map(call => call.args), expected, `${vanished} gone: the cache is only a hint; both values are rewritten before the promise`)
  }
})
await check('a command rewritten to another helper is replaced before the next notification', async () => {
  const runner = recordingRunner()
  const { instance } = makeJumpBack({ run: runner })
  assert.equal(await instance.ensureProtocol(HELPER), true)
  runner.values.set(registryValueId(PROTOCOL_COMMAND_KEY, null), `"C:\\other\\activate.exe" --activate "%1" -DataDir "C:\\other"`)
  const before = runner.calls.length
  assert.equal(await instance.ensureProtocol(HELPER), true)
  assert.deepEqual(runner.calls.slice(before).map(call => call.args), [['query', PROTOCOL_KEY, '/v', 'URL Protocol'], ['query', PROTOCOL_COMMAND_KEY, '/ve'], ...REGISTRATION_WRITES], 'a value that points at someone else\'s helper is not this process\'s registration')
  assert.equal(runner.values.get(registryValueId(PROTOCOL_COMMAND_KEY, null)), `"${HELPER}" --activate "%1" -DataDir "${PROFILE}"`, 'and the click is rewritten to this process\'s helper and data directory')
})
await check('either refused value answers false and is retried later', async () => {
  for (const refused of [0, 1]) {
    const runner = recordingRunner((_call, index) => (index === refused ? { code: 1, stderr: 'ERROR: Access is denied.' } : { code: 0 }))
    const { instance } = makeJumpBack({ run: runner })
    const { result, lines } = await captureDebug(() => instance.ensureProtocol(HELPER))
    assert.equal(result, false, `refusing write ${refused + 1} must not claim the key is registered`)
    assert.equal(runner.calls.length, refused + 1, 'a refused write stops the pair: the other value alone is not a registration')
    assert.match(lines.join(''), /protocol registration failed/u, 'and the refusal keeps its cause')
    assert.equal(await instance.ensureProtocol(HELPER), true, 'and must not be cached: the next notification retries')
    assert.equal(runner.calls.length, refused + 1 + 2, 'the retry writes both values again')
  }
})
await check('an unquotable helper is refused before reg.exe runs', async () => {
  const { instance, runner } = makeJumpBack()
  assert.equal(await instance.ensureProtocol('C:\\a"b\\activate.exe'), false)
  assert.equal(await instance.ensureProtocol(''), false, 'an empty path is not a helper either')
  assert.deepEqual(runner.calls, [], 'recording a handler that cannot start would be a silent dead click (R8)')
})
await check('off Windows, or with no Windows directory, nothing is written', async () => {
  const linux = makeJumpBack({ platform: 'linux' })
  assert.equal(await linux.instance.ensureProtocol(HELPER), false)
  assert.deepEqual(linux.runner.calls, [])
  const rootless = makeJumpBack({ env: {} })
  assert.equal(await rootless.instance.ensureProtocol(HELPER), false, 'without %WINDIR% the absolute reg.exe path cannot be built')
  assert.deepEqual(rootless.runner.calls, [], 'and PATH is never used as a fallback')
})
await check('unregistering deletes the whole scheme root, and a key that is already gone is not an error', async () => {
  const { instance, runner } = makeJumpBack({ run: recordingRunner(() => ({ code: 1, stderr: 'ERROR: The system was unable to find the specified registry key.' })) })
  const { lines } = await captureDebug(() => instance.unregisterProtocol())
  assert.deepEqual(runner.calls.map(call => call.args), [['delete', PROTOCOL_KEY, '/f']], 'the scheme root, force-deleted: deleting only `...\\command` would leave the protocol key behind')
  assert.match(lines.join(''), /unregistration failed/u, 'another instance may have removed it first; the refusal is recorded, not thrown')
})
await check('after unregistering, no protocol key is left behind', async () => {
  const { instance, runner } = makeJumpBack()
  assert.equal(await instance.ensureProtocol(HELPER), true)
  assert.ok(protocolKeys(runner.calls).includes(PROTOCOL_KEY), 'the scheme root is created')
  assert.ok(protocolKeys(runner.calls).includes(PROTOCOL_COMMAND_KEY), 'and so is the command subkey under it')
  await instance.cleanup()
  assert.deepEqual(protocolKeys(runner.calls), [], 'a normal exit leaves no protocol key at all, not just no command subkey')
})

// --- the documented marker file (D8, AC-9, R8) --------------------------------
await check('the marker file is the documented JSON at the documented path', () => {
  const { instance } = makeJumpBack({ dataDir: join(sandbox, 'marker-schema') })
  const path = instance.writeMarker('session-abc', MARKER)
  assert.equal(path, join(sandbox, 'marker-schema', 'notify', 'jumpback', 'session-abc.json'), 'D8 names the file for the session')
  assert.ok(path !== undefined)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { schemaVersion: 1, marker: MARKER, pid: process.pid, startedAt: new Date(NOW).toISOString() }, 'AC-9: exactly the four documented fields, so an external plugin can build the URI it describes')
})
await check('a session id that could leave the marker directory is refused', () => {
  const dir = join(sandbox, 'marker-refuse')
  const { instance } = makeJumpBack({ dataDir: dir })
  for (const sessionId of ['../escape', '..\\escape', 'a/b', 'a\\b', '', 'x'.repeat(129), 'two words', 'bad:name']) {
    assert.equal(instance.writeMarker(sessionId, MARKER), undefined, `${JSON.stringify(sessionId)} must not name a file`)
  }  assert.equal(instance.writeMarker('session-abc', 'NOT-A-MARKER'), undefined, 'and a wrong marker is no better')
  // `..` is not a traversal once `.json` is appended; it names a file, not the
  // directory. Whatever the guard accepts must still stay inside the directory.
  const dotdot = instance.writeMarker('..', MARKER)
  if (dotdot !== undefined) assert.equal(resolve(dirname(dotdot)), resolve(dir, 'notify', 'jumpback'), 'no accepted id may escape the marker directory')
})
await check('off Windows no marker file is written', () => {
  const dir = join(sandbox, 'marker-linux')
  const { instance } = makeJumpBack({ platform: 'linux', dataDir: dir })
  assert.equal(instance.writeMarker('session-abc', MARKER), undefined, 'AC-1: a POSIX process leaves no trace')
  assert.equal(existsSync(join(dir, 'notify')), false)
})
await check('an unwritable marker directory degrades instead of throwing', async () => {
  const file = join(sandbox, 'not-a-directory')
  writeFileSync(file, 'x')
  const { result, lines } = await captureDebug(() => makeJumpBack({ dataDir: file }).instance.writeMarker('session-abc', MARKER))
  assert.equal(result, undefined, 'the notification path must not inherit a filesystem error')
  assert.match(lines.join(''), /marker file unwritable/u)
})

// --- cleanup and the stale sweep (D7/D8) --------------------------------------

/** One marker file body, with the fields the sweep inspects overridable. */
const markerRecord = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  schemaVersion: 1, marker: MARKER, pid: process.pid, startedAt: new Date(NOW).toISOString(), ...overrides,
})

function markerFixture(name: string, files: Record<string, string> = {}): { dir: string, markerDir: string } {
  const dir = join(sandbox, name)
  const markerDir = join(dir, 'notify', 'jumpback')
  mkdirSync(markerDir, { recursive: true })
  for (const [file, body] of Object.entries(files)) writeFileSync(join(markerDir, file), body)
  return { dir, markerDir }
}

await check('cleanup removes the key it registered and the files it wrote, once', async () => {
  const { dir, markerDir } = markerFixture('cleanup', { 'foreign.json': '{}' })
  const { instance, runner } = makeJumpBack({ dataDir: dir })
  assert.equal(await instance.ensureProtocol(HELPER), true)
  const markerPath = instance.writeMarker('session-cleanup', MARKER)
  assert.ok(markerPath !== undefined)
  const foreign = join(markerDir, 'foreign.json')
  await instance.cleanup()
  assert.deepEqual(runner.calls.map(call => call.args[0]), ['add', 'add', 'delete'], 'both values this process wrote go with the one root deletion; nothing else is touched')
  assert.equal(existsSync(markerPath), false, 'the marker file this process wrote is removed')
  assert.equal(existsSync(foreign), true, 'another instance\'s file is not ours to delete')
  await instance.cleanup()
  assert.equal(runner.calls.filter(call => call.args[0] !== 'query').length, 3, 'cleanup is idempotent: the second pass only reads, it never writes or deletes again')
})
await check('a process that never registered or wrote leaves everything alone', async () => {
  const { dir, markerDir } = markerFixture('cleanup-empty', { 'session-other.json': '{}' })
  const { instance, runner } = makeJumpBack({ dataDir: dir })
  await instance.cleanup()
  assert.deepEqual(runner.calls, [], 'a disabled process must not delete a key another instance registered')
  assert.equal(existsSync(join(markerDir, 'session-other.json')), true)
})
await check('cleanup yields the shared key to a live instance, and removes it when no one else is alive', async () => {
  const { dir, markerDir } = markerFixture('cleanup-yield', { 'session-sibling.json': markerRecord({ pid: 4_242 }) })
  const live = makeJumpBack({ dataDir: dir, pidAlive: pid => pid === 4_242 })
  assert.equal(await live.instance.ensureProtocol(HELPER), true)
  const own = live.instance.writeMarker('session-own', MARKER)
  const { lines } = await captureDebug(() => live.instance.cleanup())
  assert.deepEqual(live.runner.calls.map(call => call.args[0]), ['add', 'add'], 'a live sibling still needs the shared key: removing it would make its next toast click dead')
  assert.equal(existsSync(join(markerDir, 'session-sibling.json')), true, 'the sibling keeps its identity')
  assert.ok(own !== undefined)
  assert.equal(existsSync(own), false, 'this process still removes the file it wrote')
  assert.match(lines.join(''), /left the protocol key/u, 'and the reason survives in the debug log')
  const quiet = markerFixture('cleanup-dead-sibling', { 'gone.json': markerRecord({ pid: DEAD_PID }) })
  const dead = makeJumpBack({ dataDir: quiet.dir })
  assert.equal(await dead.instance.ensureProtocol(HELPER), true)
  await dead.instance.cleanup()
  assert.deepEqual(dead.runner.calls.map(call => call.args[0]), ['add', 'add', 'delete'], 'a dead owner is not a live instance: the last one out removes the key')
  assert.deepEqual(dead.runner.calls.at(-1)?.args, ['delete', PROTOCOL_KEY, '/f'], 'and it removes the whole scheme root, not just the command below it')
})
await check('the sweep removes a gone owner and a file older than a week', () => {
  const { dir, markerDir } = markerFixture('sweep-remove', {
    'gone.json': markerRecord({ pid: DEAD_PID }),
    'old.json': markerRecord({ startedAt: new Date(NOW - 8 * DAY_MS).toISOString() }),
  })
  makeJumpBack({ dataDir: dir, now: () => NOW }).instance.sweepStale()
  assert.equal(existsSync(join(markerDir, 'gone.json')), false, 'a pid nobody answers cannot own a live pane (D8)')
  assert.equal(existsSync(join(markerDir, 'old.json')), false, 'a file older than the 7-day ceiling is stale even when its pid answers')
})
await check('the sweep keeps a live owner and every file it cannot interpret', () => {
  const files: Record<string, string> = {
    'live.json': markerRecord(), 'corrupt.json': '{not json',
    'nopid.json': markerRecord({ pid: undefined }), 'nostart.json': markerRecord({ startedAt: undefined }),
    'note.txt': 'not a marker',
  }
  const { dir, markerDir } = markerFixture('sweep-keep', files)
  makeJumpBack({ dataDir: dir, now: () => NOW }).instance.sweepStale()
  assert.deepEqual(readdirSync(markerDir).sort(), Object.keys(files).sort(), 'a live pane keeps its identity, and an unreadable file is not proof its owner is gone (D8)')
})
await check('off Windows the sweep deletes nothing', () => {
  const { dir, markerDir } = markerFixture('sweep-linux', { 'gone.json': markerRecord({ pid: DEAD_PID }) })
  makeJumpBack({ platform: 'linux', dataDir: dir }).instance.sweepStale()
  assert.equal(existsSync(join(markerDir, 'gone.json')), true)
})

// --- the setting flip (D8) ----------------------------------------------------

/** Stands in for the orchestration's lifecycle side: a setting flip calls exactly these. */
function recordingLifecycle() {
  const steps: string[] = []
  const markerWrites: [string, string][] = []
  return {
    steps,
    markerWrites,
    jumpback: {
      sweepStale: (): void => { steps.push('sweepStale') },
      cleanup: async (): Promise<void> => { steps.push('cleanup') },
      writeMarker(sessionId: string, marker: string): string | undefined {
        steps.push('writeMarker')
        markerWrites.push([sessionId, marker])
        return undefined
      },
    },
  }
}

/** The session a settings flip names, standing in for `rawChannel.sessionRef.sessionId`. */
const FLIP_SESSION = 'session-flip'

await check('flipping the setting cleans up on disable, sweeps once on enable, and refreshes the marker file', async () => {
  const marker = enableJumpBack()
  const port = recordingLifecycle()
  const flip = (enabled: boolean, sessionId: string | undefined, platform: NodeJS.Platform = 'win32'): Promise<void> => applyJumpBackSetting(port.jumpback, enabled, sessionId, platform)
  await flip(false, FLIP_SESSION)
  assert.deepEqual(port.steps, ['cleanup'], 'on→off cleans up: the key and marker files this process left must go (AC-1/AC-9)')
  assert.equal(getJumpBackState().enabled, false)
  await flip(false, FLIP_SESSION)
  assert.deepEqual(port.steps, ['cleanup'], 'republishing off publishes nothing and cleans up nothing twice')
  await flip(true, FLIP_SESSION)
  assert.deepEqual(port.steps, ['cleanup', 'sweepStale', 'writeMarker'], 'off→on sweeps stale marker files once and refreshes the documented seam for the current session (D8)')
  assert.deepEqual(port.markerWrites, [[FLIP_SESSION, marker]], 'the refresh names the current session with this pane\'s marker, so an external reader finds it before the first completion (AC-9)')
  assert.equal(getJumpBackState().marker, marker, 'the flip keeps this pane\'s identity (AC-2)')
  await flip(true, FLIP_SESSION)
  assert.deepEqual(port.steps, ['cleanup', 'sweepStale', 'writeMarker'], 'republishing on neither sweeps nor refreshes again')
  assert.deepEqual(port.markerWrites, [[FLIP_SESSION, marker]], 'repeated true writes the seam exactly once (D8)')
  // The refresh is only a Windows, session-named promise: another host or a
  // boot without a session yet has no documented file to publish (D2/D8).
  for (const [on, session, platform] of [[false, FLIP_SESSION, 'win32'], [true, undefined, 'win32'], [false, FLIP_SESSION, 'win32'], [true, FLIP_SESSION, 'linux']] as const) {
    await flip(on, session, platform)
  }
  assert.deepEqual(port.markerWrites, [[FLIP_SESSION, marker]], 'off Windows, or with no session to name, enabling publishes no marker file')
})
await check('an enable whose marker refresh fails keeps the switch on and leaves the reason', async () => {
  setJumpBackEnabled(false)
  const throwing = {
    sweepStale(): void {},
    async cleanup(): Promise<void> {},
    writeMarker(): string | undefined { throw new Error('marker port exploded') },
  }
  const { lines } = await captureDebug(() => applyJumpBackSetting(throwing, true, FLIP_SESSION, 'win32'))
  assert.equal(getJumpBackState().enabled, true, 'a failed refresh must not roll the switch back')
  assert.match(lines.join(''), /enabled marker file could not be refreshed/u, 'the reason stays in the log instead of the user losing the switch')
})

// --- the toast wiring ---------------------------------------------------------

type Step = { name: string, args: string[] }

/** Stands in for this process's orchestration: records each step and its answer. */
function recordingJumpBack(options: {
  probe?: JumpBackProbe | (() => Promise<JumpBackProbe>)
  register?: boolean
  markerPath?: string
  /** False makes the port answer like an unwritable directory (undefined, not a throw). */
  markerWritten?: boolean
  /** Holds the registration open so a toggle can land while it is pending. */
  registerGate?: Promise<void>
  throwOn?: 'writeMarker' | 'probe' | 'ensureProtocol'
  /** Also reports each step into a shared log, so ordering against another port is assertable. */
  onStep?: (name: string) => void
} = {}) {
  const steps: Step[] = []
  const record = (name: string, args: string[]): void => { steps.push({ name, args }); options.onStep?.(name) }
  const guard = (name: 'writeMarker' | 'probe' | 'ensureProtocol'): void => { if (options.throwOn === name) throw new Error(`${name} port exploded`) }
  const probeAnswer = options.probe ?? { capable: true, helperPath: HELPER }
  const jumpback: TaskCompletionJumpBack = {
    writeMarker(sessionId, marker) {
      guard('writeMarker')
      record('writeMarker', [sessionId, marker])
      if (options.markerWritten === false) return undefined
      return options.markerPath ?? join(MARKER_DIR, `${sessionId}.json`)
    },
    async probe(marker) {
      guard('probe')
      record('probe', [marker])
      return typeof probeAnswer === 'function' ? await probeAnswer() : probeAnswer
    },
    async ensureProtocol(helper) {
      guard('ensureProtocol')
      record('ensureProtocol', [helper])
      if (options.registerGate !== undefined) await options.registerGate
      return options.register ?? true
    },
  }
  return { steps, jumpback }
}

type PluginRow = Awaited<ReturnType<PluginManagerView['listPlugins']>>[number]

/** The external notifier the delivery chain yields to (D4/AC-6). */
const notifierRow = (): PluginRow => ({
  entryId: 'notifier' as PluginRow['entryId'], moduleName: '@baobaolaodie/cc-dsh-notifier',
  enabled: true, fiberPhase: 'active', readOnlyReason: 'unaddressable',
})

/** One completion through the real host function; only the ports are stubs. */
async function deliver(options: {
  jumpback: TaskCompletionJumpBack
  platform?: NodeJS.Platform
  sessionId?: string
  plugins?: PluginRow[]
  toast?: WindowsToastResult
  /** Reports the inventory read into a shared log, for ordering against the ports. */
  onInventory?: () => void
  /** Holds the inventory read open so a toggle can land while it is pending. */
  inventoryGate?: Promise<void>
  /** The host's live permission; false stands in for a released owner. */
  canDispatch?: () => boolean
}): Promise<{ toastInputs: WindowsToastInput[] }> {
  const toastInputs: WindowsToastInput[] = []
  const delivery: TaskCompletionDelivery = {
    async toast(input) { toastInputs.push(input); return options.toast ?? { status: 'shown' } },
    terminal: () => {},
    jumpback: options.jumpback,
    sessionId: options.sessionId,
    platform: options.platform,
    canDispatch: options.canDispatch,
    pluginManager: options.plugins === undefined
      ? undefined
      : {
          listPlugins: async () => {
            options.onInventory?.()
            if (options.inventoryGate !== undefined) await options.inventoryGate
            return options.plugins ?? []
          },
        },
  }
  await deliverTaskCompletionOnWindows(TITLE, '摘要一行', 'dsh', delivery)
  return { toastInputs }
}

await check('an off switch, or a non-Windows host, sends the plain toast without asking any port', async () => {
  setJumpBackEnabled(false)
  const off = recordingJumpBack()
  const disabled = await deliver({ jumpback: off.jumpback, platform: 'win32' })
  assert.deepEqual(off.steps, [], 'the setting is the cheapest gate: nothing is probed, written or registered (AC-1)')
  assert.equal(disabled.toastInputs.length, 1)
  assert.equal(disabled.toastInputs[0].launch, undefined, 'and the toast is the plain one')

  enableJumpBack()
  const elsewhere = recordingJumpBack()
  const posix = await deliver({ jumpback: elsewhere.jumpback, platform: 'linux' })
  assert.deepEqual(elsewhere.steps, [], 'the title is untagged here, so a promised jump would be one that can never be kept')
  assert.equal(posix.toastInputs[0].launch, undefined)
})
await check('a capable probe prepares the documented URI, in the documented order', async () => {
  const marker = enableJumpBack()
  const recorder = recordingJumpBack({ markerPath: join(MARKER_DIR, 'session-abc.json') })
  const delivery = await deliver({ jumpback: recorder.jumpback, platform: 'win32', sessionId: 'session-abc' })
  assert.deepEqual(recorder.steps, [
    { name: 'writeMarker', args: ['session-abc', marker] },
    { name: 'probe', args: [marker] },
    { name: 'ensureProtocol', args: [HELPER] },
  ], 'AC-9 refreshes the file before the probe; D7 registers only the handler the URI will call')
  assert.equal(delivery.toastInputs[0].launch, `dsh-tui:activate?m=${marker}`, 'the URI carries the same published marker the title carries')
})
await check('a probe that cannot prove a single target sends the plain toast', async () => {
  enableJumpBack()
  const recorder = recordingJumpBack({ probe: { capable: false, stage: 'probe', reason: 'two panes carry the marker' } })
  const delivery = await deliver({ jumpback: recorder.jumpback, platform: 'win32' })
  assert.deepEqual(recorder.steps.map(step => step.name), ['writeMarker', 'probe'], 'the marker file is still refreshed, but no handler is registered for a promise that will not be made')
  assert.equal(delivery.toastInputs[0].launch, undefined, 'AC-3/AC-7: an unverifiable layout gets an ordinary toast')
})
await check('a refused protocol registration sends the plain toast', async () => {
  enableJumpBack()
  const recorder = recordingJumpBack({ register: false })
  const delivery = await deliver({ jumpback: recorder.jumpback, platform: 'win32' })
  assert.equal(delivery.toastInputs[0].launch, undefined, 'a URI whose handler was not registered is a dead click (D7)')
})
await check('a throwing port costs the jump-back promise, not the notification', async () => {
  enableJumpBack()
  for (const throwOn of ['writeMarker', 'probe', 'ensureProtocol'] as const) {
    const recorder = recordingJumpBack({ throwOn })
    const { result, lines } = await captureDebug(() => deliver({ jumpback: recorder.jumpback, platform: 'win32' }))
    assert.equal(result.toastInputs.length, 1, `a ${throwOn} failure must still deliver a notification (AC-3/AC-10)`)
    assert.equal(result.toastInputs[0].launch, undefined)
    assert.match(lines.join(''), /the launch could not be prepared/u, 'and the reason is in the log, not swallowed')
  }
})
await check('an external notifier still gets the seam refreshed, but is never probed or registered', async () => {
  const marker = enableJumpBack()
  // One ordered log across the ports and the inventory read: the refresh must
  // precede the ownership question, or an external plugin may see the old session (D8/AC-9).
  const order: string[] = []
  const recorder = recordingJumpBack({ onStep: name => order.push(name) })
  const delivery = await deliver({ jumpback: recorder.jumpback, platform: 'win32', sessionId: 'session-external', plugins: [notifierRow()], onInventory: () => order.push('inventory') })
  assert.deepEqual(order, ['writeMarker', 'inventory'], 'the file is refreshed first and exactly once; the yielded completion is never probed or registered')
  assert.deepEqual(recorder.steps, [{ name: 'writeMarker', args: ['session-external', marker] }], 'the seam names the session that completed, and this process promises nothing else')
  assert.equal(delivery.toastInputs[0].externalNotifierActive, true)
  assert.equal(delivery.toastInputs[0].launch, undefined, 'that toast belongs to the other plugin, so this process may not promise a click (D4)')
})
await check('the marker file is named for the session, or for this process when the id is unusable', async () => {
  const marker = enableJumpBack()
  const named = recordingJumpBack()
  await deliver({ jumpback: named.jumpback, platform: 'win32', sessionId: 'session-abc' })
  assert.deepEqual(named.steps[0], { name: 'writeMarker', args: ['session-abc', marker] }, 'the documented file names the session that completed (D8)')

  for (const sessionId of ['../escape', undefined]) {
    const fallback = recordingJumpBack()
    await deliver({ jumpback: fallback.jumpback, platform: 'win32', sessionId })
    assert.deepEqual(fallback.steps[0], { name: 'writeMarker', args: [`process-${process.pid}`, marker] }, 'an unsafe or missing id must not decide the path, and the file still has to exist (AC-9)')
  }
})

// --- lifecycle under a moving switch ------------------------------------------

/** Let a pending port reach its await before the test toggles the switch. */
const tick = (): Promise<void> => new Promise(resolve => { setImmediate(resolve) })

await check('a marker file the port refuses to write sends the plain toast', async () => {
  enableJumpBack()
  const recorder = recordingJumpBack({ markerWritten: false })
  const { result, lines } = await captureDebug(() => deliver({ jumpback: recorder.jumpback, platform: 'win32' }))
  assert.deepEqual(recorder.steps.map(step => step.name), ['writeMarker'], 'an unwritten seam stops before the probe: there is no target to promise')
  assert.equal(result.toastInputs[0].launch, undefined, 'no file, no click: the toast stays ordinary')
  assert.match(lines.join(''), /marker file was not written/u, 'the reason is in the log instead of a silent degradation')
})

await check('disabling during the inventory read cancels the preparation', async () => {
  enableJumpBack()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const recorder = recordingJumpBack()
  const pending = deliver({ jumpback: recorder.jumpback, platform: 'win32', plugins: [], inventoryGate: gate })
  await tick()
  setJumpBackEnabled(false)
  release()
  const { toastInputs } = await pending
  assert.deepEqual(recorder.steps.map(step => step.name), ['writeMarker'], 'the target taken before the await must not reach the probe after the switch moved')
  assert.equal(toastInputs[0].launch, undefined, 'the plain toast is what a disabled switch sends')
})

await check('disabling while the probe is in flight drops the launch and never registers', async () => {
  enableJumpBack()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const recorder = recordingJumpBack({ probe: async () => { await gate; return { capable: true, helperPath: HELPER } } })
  const pending = deliver({ jumpback: recorder.jumpback, platform: 'win32' })
  await tick()
  setJumpBackEnabled(false)
  release()
  const { toastInputs } = await pending
  assert.deepEqual(recorder.steps.map(step => step.name), ['writeMarker', 'probe'], 'a probe that resolves after the disable must not write the key back')
  assert.equal(toastInputs[0].launch, undefined, 'and the toast carries no URI')
})

await check('a probe that outlives an off→on cycle cannot register for the new generation', async () => {
  enableJumpBack()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const recorder = recordingJumpBack({ probe: async () => { await gate; return { capable: true, helperPath: HELPER } } })
  const pending = deliver({ jumpback: recorder.jumpback, platform: 'win32' })
  await tick()
  setJumpBackEnabled(false)
  setJumpBackEnabled(true)
  release()
  const { toastInputs } = await pending
  assert.deepEqual(recorder.steps.map(step => step.name), ['writeMarker', 'probe'], 'the old completion belongs to the generation it started in, even though the switch is on again')
  assert.equal(toastInputs[0].launch, undefined, 'a re-enabled generation must not inherit the old preparation')
})

await check('a released owner during the probe never reaches registration', async () => {
  enableJumpBack()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let allowed = true
  const recorder = recordingJumpBack({ probe: async () => { await gate; return { capable: true, helperPath: HELPER } } })
  const pending = deliver({ jumpback: recorder.jumpback, platform: 'win32', canDispatch: () => allowed })
  await tick()
  allowed = false
  release()
  const { toastInputs } = await pending
  assert.deepEqual(recorder.steps.map(step => step.name), ['writeMarker', 'probe'], 'the owner check happens before the registry write')
  assert.equal(toastInputs[0].launch, undefined, 'a released owner gets no promise it cannot keep')
})

await check('a quick re-enable waits for the disable cleanup before writing the marker again', async () => {
  enableJumpBack()
  const steps: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const port = {
    sweepStale: (): void => { steps.push('sweepStale') },
    cleanup: async (): Promise<void> => { steps.push('cleanup-start'); await gate; steps.push('cleanup-end') },
    writeMarker: (): string => { steps.push('writeMarker'); return join(MARKER_DIR, 'flip.json') },
  }
  const off = applyJumpBackSetting(port, false, FLIP_SESSION, 'win32')
  const on = applyJumpBackSetting(port, true, FLIP_SESSION, 'win32')
  await tick()
  assert.deepEqual(steps, ['cleanup-start'], 'the new generation must not write the documented path while the old cleanup is deleting it')
  release()
  await Promise.all([off, on])
  assert.deepEqual(steps, ['cleanup-start', 'cleanup-end', 'sweepStale', 'writeMarker'], 'the enable lands after the old cleanup, so the new file survives')
})

await check('the last instance out releases a shared key it never registered', async () => {
  const dir = join(sandbox, 'shared-owner')
  const markerDir = join(dir, 'notify', 'jumpback')
  mkdirSync(markerDir, { recursive: true })
  const helper = join(dir, 'notify', 'helper', 'activate.exe')
  const runner = recordingRunner()
  const first = makeJumpBack({ run: runner, dataDir: dir, helper, pidAlive: pid => pid === 1000 }).instance
  assert.equal(await first.ensureProtocol(helper), true, 'the first instance registers the shared key')
  // A second instance wrote only its marker (it never notified), and is alive.
  writeFileSync(join(markerDir, 'second.json'), JSON.stringify({ schemaVersion: 1, marker: MARKER, pid: 1000, startedAt: new Date(NOW).toISOString() }))
  await first.cleanup()
  assert.equal(protocolKeys(runner.calls).length, 2, 'a live sibling still needs the key, so the first one leaves it')

  rmSync(join(markerDir, 'second.json'))
  const second = makeJumpBack({ run: runner, dataDir: dir, pidAlive: () => false }).instance
  second.writeMarker('session-second', MARKER)
  await second.cleanup()
  assert.deepEqual(protocolKeys(runner.calls), [], 'the last one out recognises the shared template and removes it even though it never registered')
  assert.ok(runner.calls.some(call => call.args[0] === 'delete'), 'the release is a real unregister, not just bookkeeping')
})

await check('disabling while the registration is in flight yields no URI', async () => {
  enableJumpBack()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const recorder = recordingJumpBack({ registerGate: gate })
  const pending = deliver({ jumpback: recorder.jumpback, platform: 'win32' })
  await tick()
  setJumpBackEnabled(false)
  release()
  const { toastInputs } = await pending
  assert.deepEqual(recorder.steps.map(step => step.name), ['writeMarker', 'probe', 'ensureProtocol'], 'the registration may finish, but its result is not used by a superseded generation')
  assert.equal(toastInputs[0].launch, undefined, 'the disable cleanup owns the key from here; the toast must not promise it')
})

await check('an enable that waited for cleanup does not write after a later disable', async () => {
  enableJumpBack()
  const steps: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const port = {
    sweepStale: (): void => { steps.push('sweepStale') },
    cleanup: async (): Promise<void> => { steps.push('cleanup-start'); await gate; steps.push('cleanup-end') },
    writeMarker: (): string => { steps.push('writeMarker'); return join(MARKER_DIR, 'triple.json') },
  }
  const off1 = applyJumpBackSetting(port, false, FLIP_SESSION, 'win32')
  const on = applyJumpBackSetting(port, true, FLIP_SESSION, 'win32')
  const off2 = applyJumpBackSetting(port, false, FLIP_SESSION, 'win32')
  await tick()
  release()
  await Promise.all([off1, on, off2])
  assert.ok(!steps.includes('writeMarker'), 'the enable must re-check the switch after the cleanup it waited for')
  assert.ok(!steps.includes('sweepStale'), 'and skip the sweep that belongs to an enabled generation')
})

await check('a throwing owner check is a released owner, not a broken delivery', async () => {
  enableJumpBack()
  const recorder = recordingJumpBack()
  const { result, lines } = await captureDebug(() => deliver({
    jumpback: recorder.jumpback,
    platform: 'win32',
    canDispatch: () => { throw new Error('owner port exploded') },
  }))
  assert.deepEqual(recorder.steps.map(step => step.name), ['writeMarker'], 'no probe and no registration for an owner that cannot confirm it still owns the completion')
  assert.equal(result.toastInputs[0].launch, undefined)
  assert.match(lines.join(''), /treating the owner as released/u, 'the reason is logged, not swallowed')
})

// --- isolation self-proof ------------------------------------------------------

assert.equal(DATA_DIR, join(sandboxHome, '.dsh-tui'), 'the throwaway home must own DATA_DIR, or the redirect ran after the import')
assert.equal(existsSync(join(DATA_DIR, 'notify')), false, 'no case reached the production data directory: every orchestration was given its own')

rmSync(sandbox, { recursive: true, force: true })
process.stdout.write(`jump-back regression passed (${passed} checks)\n`)
