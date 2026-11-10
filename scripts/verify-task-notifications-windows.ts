/**
 * Windows notification delivery, end to end: the routing the host owns and the
 * toast transport behind it, driven as one chain. Completions and pending
 * approvals share this chain; only the title and the body differ.
 *
 * The layers under this one have regressions of their own
 * (`verify-notify-transport` / `verify-task-notifications`); what neither covers
 * is the seam between them: a notification resolves to `windows`, the host hands
 * its title, body and active-inventory decision to the transport, which
 * spawns the in-box host - and a refusal anywhere
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
import type { TaskCompletionJumpBack, TaskNotificationSettings } from '../src/dsh-adapter/plugin.js'
import type { PluginManagerView } from '../src/dsh-adapter/plugin-manager.js'
import type { ExecFileNoThrowOptions, ExecFileNoThrowResult } from '../src/utils/execFileNoThrow.js'
import type { RegistryPort, RegistryWriteResult, WindowsToastInput, WindowsToastResult } from '../src/ink/terminal-notification-windows.js'

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
  createWindowsToastTransport,
} = await import('../src/ink/terminal-notification-windows.js')
const { createTerminalNotifier } = await import('../src/ink/terminal-notification.js')
const {
  approvalNotificationMessage,
  createInterruptionAnnouncer,
  deliverTaskCompletionOnWindows,
  ringTaskCompletion,
} = await import('../src/dsh-adapter/plugin.js')
const { getJumpBackState, setJumpBackEnabled } = await import('../src/ink/jumpback-state.js')
const { setLang, t } = await import('../src/i18n.js')
const { resetTerminalFocusState, setTerminalFocused } = await import('../src/ink/terminal-focus-state.js')
const { Context } = await import('@deepseek-ai/cordis')
const { channelOwnerCurrent, createChannelOwner, registerChannelOwner } = await import('../src/dsh-adapter/channel/owner.js')

/** The title the renderer passes today (`src/i18n.ts`, AC-1). */
const TITLE = 'dsh-TUI · 任务已完成'
// The approval title is read from the same translation table the host uses,
// pinned to zh so the fixture does not depend on the machine's language.
setLang('zh')
const APPROVAL_TITLE = t('approval-notification')
/** One pending approval: session, tool, reason. */
const APPROVAL_BODY = approvalNotificationMessage('会话A', 'Bash', '需要写文件')
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
const EXTERNAL_NOTIFIER_PACKAGES = ['@baobaolaodie/cc-dsh-notifier', 'cc-dsh-notifier']
type PluginRow = Awaited<ReturnType<PluginManagerView['listPlugins']>>[number]
function notifierRow(moduleName = EXTERNAL_NOTIFIER_PACKAGES[0]): PluginRow {
  return { entryId: 'notifier' as PluginRow['entryId'], moduleName, enabled: true, fiberPhase: 'active', readOnlyReason: 'unaddressable' }
}
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
function recordingRegistry(failOn?: (name: string | null) => string | undefined | Promise<string | undefined>) {
  const writes: RegistryWrite[] = []
  const registry: RegistryPort = {
    async setValue(key, name, value): Promise<RegistryWriteResult> {
      writes.push({ key, name, value })
      const detail = await failOn?.(name)
      return detail === undefined ? { ok: true } : { ok: false, detail }
    },
  }
  return { writes, registry }
}

/** Stands in for execFileNoThrow: records the invocation, spawns nothing. */
function recordingRunner(outcome: () => { code: number, stderr?: string } | Promise<{ code: number, stderr?: string }> = () => ({ code: 0 })) {
  const calls: RunCall[] = []
  const run: RunCommand = async (file, args, options) => {
    calls.push({ file, args, input: options?.input })
    const settled = await outcome()
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
  /** The active-notifier decision read from the running profile, per attempt. */
  externalNotifierStates: (boolean | undefined)[]
  /** What the toast port received, per attempt. */
  toastInputs: WindowsToastInput[]
  /** What the toast port answered, per attempt. */
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
 * ports are stubs; the routing, the inventory decision and the XML are the real code.
 * @param message - The summary the completion carries.
 * @param options.platform - What the transport sees; defaults to win32.
 * @param options.registry - A recording registry, or one that refuses a write.
 * @param options.notifications - The live settings the terminal port reads;
 *   `always` unless the case is about the gate that decides before the toast.
 * @param options.title - The title to announce; a task completion unless the
 *   case is about the approval path, which carries its own title.
 */
async function deliverCompletion(
  message: string,
  options: {
    platform?: NodeJS.Platform
    backendId?: string
    plugins?: PluginRow[]
    readPlugins?: () => Promise<PluginRow[]>
    pluginReadFails?: boolean
    registry?: ReturnType<typeof recordingRegistry>
    runner?: ReturnType<typeof recordingRunner>
    notifications?: TaskNotificationSettings
    channel?: object
    title?: string
  } = {},
): Promise<Chain> {
  const registry = options.registry ?? recordingRegistry()
  const runner = options.runner ?? recordingRunner()
  const delivered: [string, string][] = []
  const externalNotifierStates: (boolean | undefined)[] = []
  const toastInputs: WindowsToastInput[] = []
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
    await deliverTaskCompletionOnWindows(options.title ?? TITLE, message, options.backendId ?? 'dsh', {
      canDispatch: () => (options.channel === undefined || channelOwnerCurrent(options.channel)) && notifications.condition !== 'off',
      pluginManager: { listPlugins: async () => {
        if (options.pluginReadFails) throw new Error('inventory unavailable')
        return options.readPlugins ? options.readPlugins() : options.plugins ?? []
      } },
      toast: async input => {
        toastInputs.push(input)
        externalNotifierStates.push(input.externalNotifierActive)
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
  return { registry, runner, externalNotifierStates, toastInputs, toastResults, delivered, bell, debug }
}

let passed = 0
async function check(name: string, body: () => void | Promise<void>): Promise<void> {
  await body()
  passed += 1
  process.stdout.write(`ok ${passed} - ${name}\n`)
}

/** Let the fire-and-forget announcement finish its awaits before asserting. */
const flushAnnouncement = async (rounds = 3): Promise<void> => {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

/** What one announcement did: the toast port's inputs, the answers and the bell. */
interface InterruptionChain {
  readonly inputs: WindowsToastInput[]
  readonly statuses: WindowsToastResult[]
  readonly writes: string[]
}

/**
 * Drive the production interruption seam with recording ports. The toast stub
 * answers like the transport does - it asks `canDispatch` before showing - so a
 * stale notice is observably suppressed instead of merely asserted.
 * @param options - Port overrides; defaults are an always-enabled gate on win32.
 * @returns The announce function and what it recorded.
 */
function interruptionChain(options: {
  sessionId?: () => string | undefined
  ownerCurrent?: () => boolean
  alertsEnabled?: () => boolean
  settings?: () => TaskNotificationSettings
  pluginManager?: () => Pick<PluginManagerView, 'listPlugins'> | undefined
  jumpback?: TaskCompletionJumpBack
  platform?: NodeJS.Platform
} = {}): { announce: ReturnType<typeof createInterruptionAnnouncer>; chain: InterruptionChain } {
  const chain: InterruptionChain = { inputs: [], statuses: [], writes: [] }
  const stdout = Object.assign(new Writable({
    write(chunk, _encoding, done) { chain.writes.push(String(chunk)); done() },
  }), { isTTY: true })
  const notifier = createTerminalNotifier(stdout)
  const settings = options.settings ?? (() => ({ condition: 'always', method: 'windows' }))
  notifier.configure(settings().condition, settings().method)
  const announce = createInterruptionAnnouncer({
    notifier,
    settings,
    alertsEnabled: options.alertsEnabled ?? (() => true),
    platform: options.platform ?? 'win32',
    sessionId: options.sessionId ?? (() => 'session-a'),
    ownerCurrent: options.ownerCurrent ?? (() => true),
    pluginManager: options.pluginManager ?? (() => undefined),
    toast: async input => {
      chain.inputs.push(input)
      const result: WindowsToastResult = input.canDispatch?.() === false
        ? { status: 'suppressed' }
        : { status: 'shown' }
      chain.statuses.push(result)
      return result
    },
    jumpback: options.jumpback ?? {
      writeMarker: () => undefined,
      probe: async () => ({ capable: false, stage: 'probe', reason: 'not probed' }),
      ensureProtocol: async () => false,
    },
  })
  return { announce, chain }
}

/** A jump-back port that records the calls the delivery makes, in order. */
function recordingJumpBack(): { jumpback: TaskCompletionJumpBack; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    jumpback: {
      writeMarker: (sessionId, marker) => {
        calls.push(`write:${sessionId}:${marker}`)
        return join(sandbox, `${sessionId}.json`)
      },
      probe: async marker => {
        calls.push(`probe:${marker}`)
        return { capable: true, helperPath: join(sandbox, 'helper.exe') }
      },
      ensureProtocol: async () => {
        calls.push('protocol')
        return true
      },
    },
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
  assert.equal(chain.registry.writes.length, 2, 'the AUMID is registered before the toast goes out')
  assert.deepEqual(chain.delivered, [], 'a toast that showed must not also ring the bell')
  assert.deepEqual(chain.bell, [], 'and nothing reaches the terminal path')
})

// --- AC-6: an external notifier owns the completion ----------------------------

await check('an active external DSH notifier owns the completion', async () => {
  writeProfile({ [EXTERNAL_NOTIFIER_PACKAGES[0]]: '^1.0.0' })
  const chain = await deliverCompletion(NASTY, { plugins: [notifierRow()] })
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

await check('an installed but inactive notifier never swallows a completion', async () => {
  writeProfile({ [EXTERNAL_NOTIFIER_PACKAGES[0]]: '^1.0.0' })
  const row = notifierRow()
  for (const plugins of [[], [{ ...row, enabled: false }],
    ...(['pending', 'loading', 'failed', 'unloading', null] as const).map(fiberPhase => [{ ...row, fiberPhase }])]) {
    const chain = await deliverCompletion(NASTY, { plugins })
    assert.deepEqual(chain.toastResults, [{ status: 'shown' }], 'installed dependencies are not live ownership')
    assert.equal(chain.runner.calls.length, 1)
    assert.deepEqual(chain.bell, [])
  }
})

await check('active inventory covers both package names without a profile-file guess', async () => {
  writeProfile({})
  for (const moduleName of EXTERNAL_NOTIFIER_PACKAGES) {
    const chain = await deliverCompletion(NASTY, { plugins: [notifierRow(moduleName)] })
    assert.deepEqual(chain.toastResults, [{ status: 'yielded' }])
    assert.deepEqual(chain.runner.calls, [])
  }
  const unavailable = await deliverCompletion(NASTY, { pluginReadFails: true })
  assert.deepEqual(unavailable.toastResults, [{ status: 'shown' }], 'inventory failure must not silently drop the notification')
})

await check('a DSH notifier dependency does not swallow other backends\' completions', async () => {
  writeProfile({ [EXTERNAL_NOTIFIER_PACKAGES[0]]: '^1.0.0' })
  for (const backendId of ['codex', 'claude']) {
    const chain = await deliverCompletion(NASTY, { backendId, plugins: [notifierRow()] })
    assert.deepEqual(chain.externalNotifierStates, [false], `${backendId}: DSH plugins do not own this session`)
    assert.equal(chain.toastResults[0]?.status, 'shown')
    assert.equal(chain.runner.calls.length, 1, 'the built-in toast still delivers')
    assert.deepEqual(chain.bell, [], 'one delivered notification')
  }
})

// --- a pending approval travels the same Windows chain as a completion ----------

await check('a pending approval reaches the toast with its own title and body', async () => {
  writeProfile({})
  const chain = await deliverCompletion(APPROVAL_BODY, { title: APPROVAL_TITLE })
  assert.equal(APPROVAL_BODY, '会话A：Bash：需要写文件', 'the body is the session, tool and reason')
  assert.equal(chain.toastInputs.length, 1, 'the approval is handed to the one toast port')
  assert.equal(chain.toastInputs[0].title, APPROVAL_TITLE, 'the approval title, not the completion one')
  assert.equal(chain.toastInputs[0].message, APPROVAL_BODY, 'the session/tool/reason body travels intact')
  assert.equal(chain.toastInputs[0].externalNotifierActive, false)
  assert.equal(chain.runner.calls.length, 1, 'and the in-box host receives it')
  assert.deepEqual(chain.delivered, [], 'a shown approval toast does not also ring')
  assert.deepEqual(chain.bell, [])
})

await check('an active external notifier owns an approval; an installed or unreadable one does not', async () => {
  writeProfile({ [EXTERNAL_NOTIFIER_PACKAGES[0]]: '^1.0.0' })
  const owned = await deliverCompletion(APPROVAL_BODY, { title: APPROVAL_TITLE, plugins: [notifierRow()] })
  assert.deepEqual(owned.toastResults, [{ status: 'yielded' }], 'yielded, not a toast it never showed')
  assert.deepEqual(owned.runner.calls, [], 'no toast process')
  assert.deepEqual(owned.delivered, [], 'nothing falls back to the terminal')
  assert.deepEqual(owned.bell, [], 'no bell either: the external notifier already reminded the user')

  const row = notifierRow()
  for (const plugins of [[], [{ ...row, enabled: false }], [{ ...row, fiberPhase: 'loading' }]]) {
    const chain = await deliverCompletion(APPROVAL_BODY, { title: APPROVAL_TITLE, plugins })
    assert.deepEqual(chain.toastResults, [{ status: 'shown' }], 'installed dependencies are not live ownership')
    assert.equal(chain.runner.calls.length, 1)
    assert.deepEqual(chain.bell, [])
  }
  const unreadable = await deliverCompletion(APPROVAL_BODY, { title: APPROVAL_TITLE, pluginReadFails: true })
  assert.deepEqual(unreadable.toastResults, [{ status: 'shown' }], 'an inventory failure must not drop the approval alert')
})

await check('an approval whose toast cannot show falls back to the bell', async () => {
  writeProfile({})
  const registry = recordingRegistry(name => (name === 'DisplayName' ? REGISTRY_REFUSED : undefined))
  const chain = await deliverCompletion(APPROVAL_BODY, { title: APPROVAL_TITLE, registry })
  assert.deepEqual(chain.bell, ['\x07'], 'a toast that cannot show rings instead of going silent')
  assert.deepEqual(chain.delivered, [[APPROVAL_TITLE, APPROVAL_BODY]], 'the fallback carries the approval the toast could not')
  assert.deepEqual(chain.runner.calls, [], 'a toast that cannot display is not spawned')
})

await check('an approval honors the dispatch gate and never reads DSH inventory for another backend', async () => {
  writeProfile({ [EXTERNAL_NOTIFIER_PACKAGES[0]]: '^1.0.0' })
  const revoked = await deliverCompletion(APPROVAL_BODY, { title: APPROVAL_TITLE, channel: {} })
  assert.deepEqual(revoked.toastResults, [{ status: 'suppressed' }], 'a released owner suppresses before anything is shown')
  assert.deepEqual(revoked.delivered, [], 'a suppressed approval does not ring')
  assert.deepEqual(revoked.bell, [])

  let inventoryReads = 0
  const other = await deliverCompletion(APPROVAL_BODY, {
    title: APPROVAL_TITLE,
    backendId: 'claude',
    readPlugins: async () => { inventoryReads += 1; return [notifierRow()] },
  })
  assert.equal(inventoryReads, 0, 'the DSH plugin inventory does not describe another backend')
  assert.equal(other.toastInputs[0].externalNotifierActive, false)
  assert.deepEqual(other.toastResults, [{ status: 'shown' }], 'the built-in toast still delivers')
  assert.equal(other.runner.calls.length, 1, 'exactly one toast process')
  assert.deepEqual(other.bell, [], 'one delivered notification')
})

// --- jump-back reaches a waiting approval (accepted when rebasing onto #1675) --

await check('an approval with jump-back on carries the documented activation URI', async () => {
  writeProfile({})
  setJumpBackEnabled(true)
  const state = getJumpBackState()
  const recorder = recordingJumpBack()
  try {
    const { announce, chain } = interruptionChain({ jumpback: recorder.jumpback, sessionId: () => 'session-a' })
    announce(APPROVAL_TITLE, APPROVAL_BODY, 'dsh')
    await flushAnnouncement()
    assert.ok(state.marker !== null, 'enabling mints the pane marker')
    assert.deepEqual(
      recorder.calls,
      [`write:session-a:${state.marker}`, `probe:${state.marker}`, 'protocol'],
      'an approval uses the same marker, probe and registration as a completion (D4/D7/D8)',
    )
    assert.equal(chain.inputs.length, 1, 'the approval reaches the toast port')
    assert.equal(chain.inputs[0]?.launch, `dsh-tui:activate?m=${state.marker}`, 'the toast promises the documented jump-back')
    assert.equal(chain.inputs[0]?.externalNotifierActive, false)
    assert.deepEqual(chain.statuses, [{ status: 'shown' }])
  } finally {
    setJumpBackEnabled(false)
  }
})

await check('an approval with jump-back off never touches the jump-back ports', async () => {
  writeProfile({})
  setJumpBackEnabled(false)
  const recorder = recordingJumpBack()
  const { announce, chain } = interruptionChain({ jumpback: recorder.jumpback })
  announce(APPROVAL_TITLE, APPROVAL_BODY, 'dsh')
  await flushAnnouncement()
  assert.deepEqual(recorder.calls, [], 'the default-off switch costs no marker, probe or registry write')
  assert.equal(chain.inputs[0]?.launch, undefined, 'the plain toast carries no activation URI')
})

// --- the interruption seam rechecks the world before the toast dispatches ------

await check('a queued approval is dropped when its session is no longer attached', async () => {
  writeProfile({})
  let session = 'session-a'
  let releaseInventory: (() => void) | undefined
  const inventory = new Promise<PluginRow[]>(resolve => { releaseInventory = () => resolve([]) })
  const { announce, chain } = interruptionChain({
    sessionId: () => session,
    pluginManager: () => ({ listPlugins: () => inventory }),
  })
  announce(APPROVAL_TITLE, APPROVAL_BODY, 'dsh')
  // The user switches sessions while the toast is still being prepared.
  session = 'session-b'
  releaseInventory!()
  await flushAnnouncement()
  assert.deepEqual(chain.statuses, [{ status: 'suppressed' }], 'the old session approval is not shown')
  assert.deepEqual(chain.writes, [], 'and it does not ring the bell instead')
})

await check('a queued approval is dropped when it is answered while the toast prepares', async () => {
  writeProfile({})
  let waiting = true
  let releaseInventory: (() => void) | undefined
  const inventory = new Promise<PluginRow[]>(resolve => { releaseInventory = () => resolve([]) })
  const { announce, chain } = interruptionChain({ pluginManager: () => ({ listPlugins: () => inventory }) })
  announce(APPROVAL_TITLE, APPROVAL_BODY, 'dsh', { stillWaiting: () => waiting })
  waiting = false
  releaseInventory!()
  await flushAnnouncement()
  assert.deepEqual(chain.statuses, [{ status: 'suppressed' }], 'an answered approval does not pop up late')
})

await check('an approval whose session and ask are unchanged reaches the toast', async () => {
  writeProfile({})
  let releaseInventory: (() => void) | undefined
  const inventory = new Promise<PluginRow[]>(resolve => { releaseInventory = () => resolve([]) })
  const { announce, chain } = interruptionChain({ pluginManager: () => ({ listPlugins: () => inventory }) })
  announce(APPROVAL_TITLE, APPROVAL_BODY, 'dsh', { stillWaiting: () => true })
  releaseInventory!()
  await flushAnnouncement()
  assert.deepEqual(chain.statuses, [{ status: 'shown' }], 'the recheck keeps a notification that is still true')
  assert.equal(chain.inputs[0]?.message, APPROVAL_BODY)
})

// --- the shared focus/off gate runs before either transport -------------------

await check('the interruption seam consults the shared alert gate before either transport', async () => {
  writeProfile({})
  for (const enabled of [false, true]) {
    const { announce, chain } = interruptionChain({ alertsEnabled: () => enabled })
    announce(APPROVAL_TITLE, APPROVAL_BODY, 'dsh')
    await flushAnnouncement()
    assert.equal(chain.inputs.length, enabled ? 1 : 0, enabled
      ? 'a due interruption reaches the toast'
      : 'a gated interruption is dropped before the transport')
    assert.deepEqual(chain.writes, [], 'a gated notice never rings the bell instead')
  }
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

await check('native toast failure rings BEL even when the terminal supports OSC notifications', async () => {
  writeProfile({})
  const previous = process.env.TERM_PROGRAM
  process.env.TERM_PROGRAM = 'WezTerm'
  try {
    const registry = recordingRegistry(name => (name === 'DisplayName' ? REGISTRY_REFUSED : undefined))
    const chain = await deliverCompletion(NASTY, { registry, notifications: { condition: 'always', method: 'auto' } })
    assert.deepEqual(chain.bell, ['\x07'], 'the failed native path promises a bell')
  } finally {
    if (previous === undefined) delete process.env.TERM_PROGRAM
    else process.env.TERM_PROGRAM = previous
  }
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
    assert.match(logged, /using the terminal fallback/u, 'the log describes the fallback without overriding a later off setting')
    assert.match(logged, /windows toast unavailable/u, 'and the pair "no toast + bell" stays explainable')
  } finally {
    resetTerminalFocusState()
  }
})

await check('explicit off suppresses pending dispatch, while focus and dispatched toasts keep the original approval', async () => {
  const observed = []
  for (const phase of ['inventory', 'registration', 'refocused', 'dispatched'] as const) {
    const notifications: TaskNotificationSettings = { condition: 'unfocused', method: 'windows' }
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const pause = async (): Promise<void> => { entered.resolve(); await release.promise }
    const registry = recordingRegistry(async name => {
      if ((phase === 'registration' || phase === 'refocused') && name === 'DisplayName') await pause()
      return undefined
    })
    const runner = recordingRunner(async () => {
      if (phase === 'dispatched') await pause()
      return { code: 0 }
    })
    setTerminalFocused(false)
    try {
      const pending = deliverCompletion(NASTY, {
        notifications, registry, runner,
        readPlugins: async () => { if (phase === 'inventory') await pause(); return [] },
      })
      await entered.promise
      if (phase === 'refocused') setTerminalFocused(true)
      else notifications.condition = 'off'
      release.resolve()
      const chain = await pending
      observed.push({
        phase,
        result: chain.toastResults,
        registryWrites: chain.registry.writes.length,
        hostCalls: chain.runner.calls.length,
        fallback: chain.delivered,
        bell: chain.bell,
      })
    } finally {
      release.resolve()
      resetTerminalFocusState()
    }
  }
  assert.deepEqual(observed, [
    { phase: 'inventory', result: [{ status: 'suppressed' }], registryWrites: 0, hostCalls: 0, fallback: [], bell: [] },
    { phase: 'registration', result: [{ status: 'suppressed' }], registryWrites: 2, hostCalls: 0, fallback: [], bell: [] },
    { phase: 'refocused', result: [{ status: 'shown' }], registryWrites: 2, hostCalls: 1, fallback: [], bell: [] },
    { phase: 'dispatched', result: [{ status: 'shown' }], registryWrites: 2, hostCalls: 1, fallback: [], bell: [] },
  ])
})

await check('a disposed channel stops pending native dispatch and late failure BEL without disabling its replacement', async () => {
  const observed = []
  for (const phase of ['inventory', 'registration', 'failure'] as const) {
    const ctx = new Context()
    const channel = {}
    const owner = createChannelOwner()
    registerChannelOwner(channel, owner)
    ctx.effect(() => () => owner.dispose())
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const pause = async (): Promise<void> => { entered.resolve(); await release.promise }
    const registry = recordingRegistry(async name => {
      if (phase === 'registration' && name === 'DisplayName') await pause()
      return undefined
    })
    const runner = recordingRunner(async () => {
      if (phase === 'failure') { await pause(); return { code: 1, stderr: 'late toast failure' } }
      return { code: 0 }
    })
    const pending = deliverCompletion(NASTY, {
      channel, registry, runner,
      readPlugins: async () => { if (phase === 'inventory') await pause(); return [] },
    })
    await entered.promise
    await ctx.fiber.dispose()
    assert.equal(channelOwnerCurrent(channel), false, 'the real Cordis effect released this channel owner')
    release.resolve()
    const chain = await pending
    const replacement = {}
    const replacementOwner = createChannelOwner()
    registerChannelOwner(replacement, replacementOwner)
    try {
      const next = await deliverCompletion('replacement channel', { channel: replacement })
      observed.push({
        phase,
        status: chain.toastResults[0]?.status,
        hostCalls: chain.runner.calls.length,
        fallback: chain.delivered.length,
        bell: chain.bell,
        replacementStatus: next.toastResults[0]?.status,
        replacementHostCalls: next.runner.calls.length,
      })
    } finally {
      replacementOwner.dispose()
    }
  }
  assert.deepEqual(observed, [
    { phase: 'inventory', status: 'suppressed', hostCalls: 0, fallback: 0, bell: [], replacementStatus: 'shown', replacementHostCalls: 1 },
    { phase: 'registration', status: 'suppressed', hostCalls: 0, fallback: 0, bell: [], replacementStatus: 'shown', replacementHostCalls: 1 },
    { phase: 'failure', status: 'unavailable', hostCalls: 1, fallback: 0, bell: [], replacementStatus: 'shown', replacementHostCalls: 1 },
  ])
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
