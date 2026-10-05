/**
 * verify-preboot — the `dst` fast start: one Chat, mounted before dsh, made
 * live in place.
 *
 * `dst` starts dsh with `--import lib/types/preboot/entry.js`; the preload
 * mounts the real root tree against a boot channel (`ready === false`) and
 * publishes the slot; the plugin later calls `slot.ready(live)` and the live
 * channel slides in underneath the running Chat. Pinned here, headless:
 *
 *   1. SETTINGS: renderer decisions come from the `dsh-tui:` layer of
 *      `$DSH_HOME/settings.yaml`, defaulting like the plugin schema.
 *   2. DEFERRED CHANNEL: one object for life — properties and methods follow
 *      the backing channel, `version` stays monotonic across the swap, and a
 *      listener subscribed against the boot channel keeps firing afterwards.
 *   3. BOOT CHANNEL: every port member has a boot answer (the inventory is
 *      covered at runtime too, not only by the compiler); actions refuse with
 *      a notice; notices expire.
 *   4. BOOT PHASE: the real Chat paints with the boot status hint; typing,
 *      Backspace and bracketed paste work; Enter refuses and keeps the text.
 *   5. GOING LIVE: after `ready()` the same Chat shows the live model, the
 *      hint is gone, the draft is still in the composer, a live-channel
 *      notification reaches the screen through the pre-live subscription,
 *      Enter now submits, and the handoff writes no scrollback/screen clear
 *      (a later real session switch still repaints).
 *   6. FALLBACK + EXIT: `draft()` + `dispose()` carry the text into a fresh
 *      slot mounted already live (renderer mismatch path); a double Ctrl+C in
 *      the boot phase exits with 0 (a user exit, like the live funnel); the
 *      published slot is taken exactly once.
 *   7. FATAL: an uncaught error while dsh is still loading tears the boot
 *      screen down, reaches stderr and exits 1 (the #185 process guard must
 *      not rethrow it from its listener — exit 7, terminal left in alt-screen).
 *   8. BOOT SCREENS: during boot only purely local slash commands run (a
 *      menu-selected /model or /settings is refused with the text kept, /vim
 *      runs); the session screen opened during boot gains its foreign-source
 *      tabs at ready; a draft (vim mode, or text parked via the prompt row's
 *      ⌸ in fullscreen) survives Esc back to the composer after ready.
 *   9. LANDING (M4): the preload makes the same workspace-home decision the
 *      plugin makes (home unseen + ordinary launch), so the FIRST frame is
 *      the home screen and the handoff does not flip it; a resume/workspace
 *      target or a first prompt keeps the chat screen.
 *  10. RENDERER DECISION (M6): a renderer choice persisted by the plugin
 *      (the profile's cordis.yml layer) is preferred when settings.yaml does
 *      not set the key, so the boot slot already matches and the plugin can
 *      take it live instead of re-mounting; settings.yaml still wins.
 *  11. WATCHDOG (M5): a boot slot nobody takes (the profile has no dsh-tui
 *      row, or its config failed validation) tears the boot screen down,
 *      prints why on the real stderr and exits non-zero; a slot that was
 *      taken or went live disarms it; a process exit while still booting
 *      restores the terminal and never reports success.
 *  12. HOST COMPOSITION: on a 0.1.7+ host (app-boot exports
 *      `readProfilePatches`) the settings come from the host-composed
 *      `dsh-tui` row — profile dir, home and `--patch` overlays passed
 *      through, the host's stderr muted during the call — with a leftover
 *      settings.yaml layered on top; a host whose settings service still
 *      has `register()` resolves its legacy document through the plugin's
 *      settings schema first (`value ?? config`); an older host, a
 *      non-profile launch, an unresolvable entry or a throwing host all fall
 *      back to settings.yaml.
 *  13. COMPILE CACHE: the preload enables Node's compile cache under
 *      `~/.dsh-tui/compile-cache` when the marker env is set, keeps an
 *      explicit NODE_COMPILE_CACHE directory, honors
 *      NODE_DISABLE_COMPILE_CACHE, and leaves a run without the marker alone.
 *  14. KERNEL: the preload resolves the kernel the plugin will boot by the
 *      same priority (handoff → the row's `backend` → DSH_TUI_BACKEND →
 *      kernel.json); on a claude kernel the boot frame skips the DSH-only
 *      screens (home, first-run guide) but keeps the launchpad, and the boot
 *      channel reports the kernel so the brand does not flip at the handoff.
 *
 * Run: node --import tsx/esm scripts/verify-preboot.tsx
 */
import { fileURLToPath } from 'node:url'
process.env.DSH_TUI_LANG = 'en'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES = '1'
const home = fileURLToPath(new URL('../node_modules/.cache/dsh-tui-preboot-home', import.meta.url))
process.env.HOME = home
process.env.USERPROFILE = home

import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import xterm from '@xterm/headless'
import type { ChannelUi } from '../src/adapter/ports/channel-ui.js'
import { settled, sleep } from './lib/term-test.mjs'

mkdirSync(home, { recursive: true })
// The test HOME persists across runs: start every run from the same prefs.
const dataDir = join(home, '.dsh-tui')
mkdirSync(dataDir, { recursive: true })
rmSync(join(dataDir, 'renderer.json'), { force: true })
const homePrefsFile = join(dataDir, 'home.json')
/** Sections 4–7 exercise the chat screen: the one-shot home landing is spent. */
const setHomeSeenForTest = (seen: boolean): void => {
  if (seen) writeFileSync(homePrefsFile, `${JSON.stringify({ seen: true })}\n`)
  else rmSync(homePrefsFile, { force: true })
}
setHomeSeenForTest(true)
// The sections below exercise the chat screen, so the launchpad and the
// first-run guide are off (section 9b turns them back on). Same files and
// escape hatch the plugin reads (homePrefs.ts / onboardingPrefs.ts).
const onboardingPrefsFile = join(dataDir, 'onboarding.json')
const setOnboardingDoneForTest = (done: boolean): void => {
  if (done) writeFileSync(onboardingPrefsFile, `${JSON.stringify({ completed: true, version: 1 })}\n`)
  else rmSync(onboardingPrefsFile, { force: true })
}
setOnboardingDoneForTest(true)
process.env.DSH_TUI_NO_LAUNCHPAD = '1'
delete process.env.DSH_TUI_RESUME_SESSION
delete process.env.DSH_TUI_WORKSPACE_TARGET
delete process.env.DSH_TUI_PREBOOT_TIMEOUT_MS
const dshHome = join(home, '.dsh')
mkdirSync(dshHome, { recursive: true })
writeFileSync(join(dshHome, 'settings.yaml'), [
  'dsh-tui:',
  '  fullscreen: false',
  '  pageMargin: none',
  '  whale: false',
  '  effortDefault: high',
  '  statusBar:',
  '    compact: true',
  '',
].join('\n'))

const { Terminal: XTerm } = xterm
const [
  { decidePreboot, decidePrebootLanding, mountPreboot, readPrebootSettingsLayer, readTuiSettingsLayer, resolvePrebootBackend },
  { peekPrebootSlot, takePrebootSlot },
  { mountChatHost },
  { createBootChannel },
  { createDeferredChannel },
  { CHANNEL_UI_EFFECTS, CHANNEL_UI_PROPERTIES },
  { QuestionStore },
  { default: instances },
] = await Promise.all([
  import('../src/preboot/mount.js'),
  import('../src/preboot/handle.js'),
  import('../src/preboot/host.js'),
  import('../src/preboot/bootChannel.js'),
  import('../src/adapter/channel/deferred.js'),
  import('../src/adapter/channel/ui-policy.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/ink/instances.js'),
])

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`ok   ${name}`)
  else {
    failures++
    console.error(`FAIL ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

const COLS = 100
const ROWS = 30
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  /** Every byte written, for escape-sequence assertions. */
  written = ''
  constructor(private readonly terminal: InstanceType<typeof XTerm>) { super() }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.written += String(chunk)
    this.terminal.write(String(chunk), callback)
  }
}
class FakeStderr extends Writable {
  isTTY = true
  text = ''
  _write(chunk: unknown, _e: BufferEncoding, callback: () => void): void {
    this.text += String(chunk)
    callback()
  }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  override ref(): this { return this }
  override unref(): this { return this }
}
const terminal = new XTerm({ cols: COLS, rows: ROWS, allowProposedApi: true })
const stdout = new FakeStdout(terminal)
const stdin = new FakeStdin()
// One stdin is shared by every mount below, and the renderer leaves an
// `error` listener behind per instance; the count is the fixture, not a leak.
stdin.setMaxListeners(0)
const stderr = new FakeStderr()
const screen = (): string => {
  const buffer = terminal.buffer.active
  return Array.from({ length: ROWS }, (_, index) => buffer.getLine(buffer.baseY + index)?.translateToString(true) ?? '').join('\n')
}
const type = async (data: string): Promise<void> => {
  stdin.write(data)
  await sleep(40) // 固定窗:pacing 每次写入后让 Ink 处理一拍
}
const renderOptions = { stdout: stdout as never, stdin: stdin as never, stderr: stderr as never, patchConsole: false }
const BOOT_HINT = 'DeepSeek Harness is starting'

/**
 * A stand-in live channel: the boot channel's shape with a live identity, its
 * own version/subscribe, and recording `submit`/`notify`.
 */
function makeLiveChannel() {
  const base = createBootChannel({ model: 'boot', effort: undefined, cwd: '/tmp/live', gitBranch: undefined, settings: {} })
  const listeners = new Set<() => void>()
  let version = 500
  let agentId = 'live-agent-0001'
  let notifications: { id: number; text: string; timeoutMs: number }[] = []
  const submitted: string[] = []
  const emit = (): void => {
    version += 1
    for (const listener of [...listeners]) listener()
  }
  const live = Object.create(null) as Record<string, unknown>
  // The boot channel is frozen: re-open its descriptors so the live identity
  // below can override them.
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(base))) {
    Object.defineProperty(live, key, { ...descriptor, configurable: true })
  }
  Object.defineProperties(live, {
    version: { enumerable: true, get: () => version },
    notifications: { enumerable: true, get: () => notifications },
    ready: { enumerable: true, value: true },
    status: { enumerable: true, value: 'idle' },
    agentId: { enumerable: true, get: () => agentId },
    sessionId: { enumerable: true, value: 'live-agent-0001' },
    model: { enumerable: true, value: 'live-model-x' },
    // Non-zero, unlike the boot channel's 0: a draft stored under the boot
    // owner must be rebound, not merely re-keyed by agent id.
    agentBindingGeneration: { enumerable: true, value: 7 },
    listForeignSources: { enumerable: true, value: () => Promise.resolve([{ agentId: 'claude-code', label: 'Claude Code' }]) },
    listForeignSessions: { enumerable: true, value: () => Promise.resolve([]) },
    subscribe: {
      enumerable: true,
      value: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    submit: {
      enumerable: true,
      value: (text: string) => {
        submitted.push(text)
        emit()
      },
    },
    notify: {
      enumerable: true,
      value: (text: string, options?: { timeoutMs?: number }) => {
        const id = notifications.length + 1
        notifications = [...notifications, { id, text, timeoutMs: options?.timeoutMs ?? 4000 }]
        emit()
        return () => {
          notifications = notifications.filter(item => item.id !== id)
          emit()
        }
      },
    },
  })
  /** A real session switch on the live channel (resume, /new). */
  const switchAgent = (id: string): void => {
    agentId = id
    emit()
  }
  return { channel: Object.freeze(live) as unknown as ChannelUi, submitted, emit, switchAgent, listenerCount: () => listeners.size }
}

// ── 1. settings layer → decisions ───────────────────────────────────────────
const layer = readTuiSettingsLayer(dshHome)
const decided = decidePreboot(layer)
check('settings: fullscreen false read from the user layer', decided.fullscreen === false)
check('settings: terminalImages defaults on', decided.terminalImages === true)
check('settings: effortDefault wins', decided.effort === 'high', String(decided.effort))
const defaults = decidePreboot(readTuiSettingsLayer(join(home, 'no-such-dsh-home')))
check('settings: missing file → schema defaults', defaults.fullscreen && defaults.terminalImages && !defaults.minimalUi)
// M6: the plugin's persisted renderer decision (cordis.yml layer) fills in
// where settings.yaml is silent; an explicit settings key still wins.
{
  const quiet = decidePreboot({}, { fullscreen: false, terminalImages: false })
  check('renderer: persisted decision preferred when settings is silent', quiet.fullscreen === false && quiet.terminalImages === false)
  const loud = decidePreboot({ fullscreen: true, terminalImages: true }, { fullscreen: false, terminalImages: false })
  check('renderer: settings.yaml key beats the persisted decision', loud.fullscreen === true && loud.terminalImages === true)
}

// ── 2. deferred channel ─────────────────────────────────────────────────────
{
  const boot = createBootChannel({ model: 'boot-model', effort: 'low', cwd: '/tmp/boot', gitBranch: 'main', settings: {} })
  const deferred = createDeferredChannel(boot)
  const view = deferred.channel
  check('deferred: boot properties read through', view.ready === false && view.model === 'boot-model' && view.gitBranch === 'main')
  let wakeups = 0
  const unsubscribe = view.subscribe(() => { wakeups += 1 })
  boot.notify('boot notice', { timeoutMs: 0 })
  check('deferred: boot-channel bump reaches a listener', wakeups === 1 && view.notifications.length === 1)
  const before = view.version
  const live = makeLiveChannel()
  deferred.resolve(live.channel)
  check('deferred: same object, live properties now', view.ready === true && view.model === 'live-model-x' && view.agentId === 'live-agent-0001')
  check('deferred: version advances by exactly one at the swap', view.version === before + 1, `${before} → ${view.version}`)
  check('deferred: resolve notifies existing listeners once', wakeups === 2, String(wakeups))
  check('deferred: listener moved to the live channel', live.listenerCount() === 1)
  live.emit()
  check('deferred: live bump reaches the pre-live listener', wakeups === 3 && view.version === before + 2)
  view.submit('through the view')
  check('deferred: methods forward to the live channel', live.submitted[0] === 'through the view')
  boot.notify('stale', { timeoutMs: 0 })
  check('deferred: the boot channel no longer wakes the view', wakeups === 4, String(wakeups))
  unsubscribe()
  check('deferred: unsubscribe detaches', live.listenerCount() === 0)
  let threw = false
  try { deferred.resolve(live.channel) } catch { threw = true }
  check('deferred: a second resolve throws', threw)
}

// ── 3. boot channel ─────────────────────────────────────────────────────────
{
  const boot = createBootChannel({ model: 'm', effort: undefined, cwd: '/tmp/x', gitBranch: undefined, settings: { whaleGirl: true, expandEditor: false } })
  const missingProps = CHANNEL_UI_PROPERTIES.filter(key => !(key in boot))
  const missingMethods = (Object.keys(CHANNEL_UI_EFFECTS) as (keyof typeof CHANNEL_UI_EFFECTS)[]).filter(key => typeof boot[key] !== 'function')
  check('boot: every inventoried property is present', missingProps.length === 0, missingProps.join(','))
  check('boot: every inventoried method is a function', missingMethods.length === 0, missingMethods.join(','))
  check('boot: settings layer shapes display properties', boot.whaleGirl === true && boot.expandEditor === false && boot.whale === true)
  check('boot: not ready, empty transcript, no agent', boot.ready === false && boot.rows.length === 0 && boot.agentId === '')
  const v0 = boot.version
  boot.submit('nope')
  check('boot: submit refuses with a notice', boot.notifications.some(item => item.text.includes('Not ready')) && boot.version > v0)
  const dismiss = boot.notify('short', { timeoutMs: 60 })
  check('boot: notify returns a dismiss handle', typeof dismiss === 'function')
  await sleep(120) // 固定窗:墙钟 等 60ms 通知到期
  check('boot: notices expire on their timeout', !boot.notifications.some(item => item.text === 'short'))
  check('boot: completions come from the local catalog', boot.commandCompletions('/mod').length > 0)
  check('boot: queries answer neutrally', (await boot.listSessions()).length === 0 && boot.settingsHost() === undefined && (await boot.resumeTo('x')).ok === false)
}

// ── 4. boot phase on the real Chat ──────────────────────────────────────────
let exitCode: number | undefined
const slot = await mountPreboot({ dshHome, renderOptions, exit: code => { exitCode = code } })
check('mount: slot published on globalThis', peekPrebootSlot() === slot)
check('mount: slot mirrors renderer decisions', slot.fullscreen === false && slot.terminalImages === true && slot.phase === 'booting')
check('mount: boot status hint painted', await settled(() => screen().includes(BOOT_HINT), { timeoutMs: 3000 }), screen())
check('mount: prompt painted', screen().includes('❯'))
check('mount: effort from settings on the status line', screen().includes('high'), screen())
const liveInstance = instances.get(stdout as never)
check('mount: instance registered by stdout', liveInstance !== undefined && slot.instance !== undefined)

await type('/mo')
check('edit: slash menu opens from the local catalog', await settled(() => screen().includes('commands ·') && screen().includes('model'), { timeoutMs: 2000 }), screen())
await type('\x7f\x7f\x7f')
check('edit: menu text removed again', await settled(() => slot.draft() === '', { timeoutMs: 2000 }), slot.draft())
await type('hello')
check('edit: typed text shows', await settled(() => screen().includes('hello'), { timeoutMs: 2000 }), screen())
await type('\r')
check('edit: Enter shows the not-ready notice', await settled(() => screen().includes('Not ready yet'), { timeoutMs: 2000 }), screen())
check('edit: Enter keeps the text', screen().includes('hello') && slot.draft() === 'hello')
await type('\x7f')
check('edit: Backspace deletes', await settled(() => slot.draft() === 'hell', { timeoutMs: 2000 }), slot.draft())
await type('\x1b[200~ 世界\x1b[201~')
check('edit: bracketed paste inserts (wide chars)', await settled(() => slot.draft() === 'hell 世界', { timeoutMs: 2000 }), slot.draft())

// ── 5. going live ───────────────────────────────────────────────────────────
const live = makeLiveChannel()
const versionBefore = slot.channel.version
check('live: taking the slot removes it', takePrebootSlot() === slot && takePrebootSlot() === undefined)
const bytesBeforeReady = stdout.written.length
slot.ready({ channel: live.channel, props: { questionStore: new QuestionStore(), onExit: () => { exitCode = 0 } } })
check('live: phase and channel flip in place', slot.phase === 'ready' && slot.channel.ready === true && slot.channel.version > versionBefore)
check('live: same instance, no re-mount', instances.get(stdout as never) === liveInstance)
check('live: boot hint gone', await settled(() => !screen().includes(BOOT_HINT), { timeoutMs: 2000 }), screen())
check('live: live model on the status line', await settled(() => screen().includes('live-model-x'), { timeoutMs: 2000 }), screen())
check('live: draft survived the session arriving', slot.draft() === 'hell 世界' && screen().includes('hell 世界'), slot.draft())
// The live id arriving is adoption, not a session switch: the switch path's
// scrollback clear (CSI 3J + 2J) would wipe inline scrollback and flash the
// screen at the handoff. Give its setTimeout(0) repaint time to fire.
await sleep(150) // 固定窗:探针 断言切换路径的 setTimeout(0) 重绘不发生
const handoffBytes = stdout.written.slice(bytesBeforeReady)
check('live: handoff writes no scrollback/screen clear', !handoffBytes.includes('\x1b[3J') && !handoffBytes.includes('\x1b[2J'), JSON.stringify(handoffBytes.slice(0, 200)))
live.channel.notify('LIVE NOTICE ARRIVED', { timeoutMs: 0 })
check('live: a live notification reaches the screen (pre-live subscription)', await settled(() => screen().includes('LIVE NOTICE ARRIVED'), { timeoutMs: 2000 }), screen())
await type('\r')
check('live: Enter now submits the draft', await settled(() => live.submitted[0] === 'hell 世界', { timeoutMs: 2000 }), JSON.stringify(live.submitted))
check('live: composer cleared after the send', await settled(() => slot.draft() === '', { timeoutMs: 2000 }), slot.draft())
const bytesBeforeSwitch = stdout.written.length
live.switchAgent('live-agent-0002')
check('live: a real session switch afterwards still repaints', await settled(() => stdout.written.slice(bytesBeforeSwitch).includes('\x1b[3J'), { timeoutMs: 2000 }))
let readyTwiceThrew = false
try { slot.ready({ channel: live.channel, props: { questionStore: new QuestionStore(), onExit: () => {} } }) } catch { readyTwiceThrew = true }
check('live: ready() is one-shot', readyTwiceThrew)
slot.dispose()
check('dispose: unmount clears the registry', instances.get(stdout as never) === undefined)
slot.dispose()
check('dispose: idempotent', slot.phase === 'disposed')

// ── 6. mismatch fallback + Ctrl+C exit ──────────────────────────────────────
exitCode = undefined
const second = await mountPreboot({ dshHome, renderOptions, exit: code => { exitCode = code } })
check('remount: fresh slot published', peekPrebootSlot() === second && instances.get(stdout as never) !== undefined)
await settled(() => screen().includes(BOOT_HINT), { timeoutMs: 3000 })
await type('carry me')
await settled(() => second.draft() === 'carry me', { timeoutMs: 2000 })
const carried = second.draft()
takePrebootSlot()
second.dispose()
const fresh = await mountChatHost({
  fullscreen: false,
  terminalImages: true,
  renderOptions,
  initial: {
    channel: makeLiveChannel().channel,
    props: { questionStore: new QuestionStore(), onExit: () => {}, initialDraft: { value: carried, cursor: carried.length } },
  },
})
check('fallback: fresh slot mounts already live', fresh.phase === 'ready')
check('fallback: carried draft restored into the composer', await settled(() => fresh.draft() === 'carry me' && screen().includes('carry me'), { timeoutMs: 3000 }), fresh.draft())
fresh.dispose()

exitCode = undefined
const third = await mountPreboot({ dshHome, renderOptions, exit: code => { exitCode = code } })
await settled(() => screen().includes(BOOT_HINT), { timeoutMs: 3000 })
await type('\x03')
check('ctrl+c: first press only arms', await settled(() => screen().includes('again'), { timeoutMs: 2000 }) && exitCode === undefined, screen())
await type('\x03')
// A deliberate exit, so 0 like the live funnel (the exit backstop must not
// turn it into a failure).
check('ctrl+c: second press exits 0 (user exit)', await settled(() => exitCode === 0, { timeoutMs: 2000 }), String(exitCode))
check('ctrl+c: renderer torn down', third.phase === 'disposed' && instances.get(stdout as never) === undefined)
takePrebootSlot()

// ── 7. fatal error while dsh is still loading ───────────────────────────────
// The preboot Ink instance installs the #185 process guard before dsh runs;
// without a boot-phase sink the guard rethrows from its listener (exit 7, no
// terminal restore). An error dsh throws while composing must restore the
// terminal, reach stderr, and exit 1 like the plain path.
exitCode = undefined
stderr.text = ''
const fourth = await mountPreboot({ dshHome, renderOptions, exit: code => { exitCode = code } })
await settled(() => screen().includes(BOOT_HINT), { timeoutMs: 3000 })
let rethrown: unknown
try {
  process.emit('uncaughtException', new Error('profile does-not-exist-xyz not found'), 'uncaughtException')
} catch (error) {
  rethrown = error
}
check('fatal: boot-phase error claimed, not rethrown', rethrown === undefined, String(rethrown))
check('fatal: exits 1 like the plain path', exitCode === 1, String(exitCode))
check('fatal: boot screen torn down first', fourth.phase === 'disposed' && instances.get(stdout as never) === undefined)
check('fatal: error reaches stderr', stderr.text.includes('profile does-not-exist-xyz not found'), JSON.stringify(stderr.text))
takePrebootSlot()

exitCode = undefined
stderr.text = ''
const fifth = await mountPreboot({ dshHome, renderOptions, exit: code => { exitCode = code } })
await settled(() => screen().includes(BOOT_HINT), { timeoutMs: 3000 })
rethrown = undefined
try {
  process.emit('unhandledRejection', undefined, Promise.resolve())
} catch (error) {
  rethrown = error
}
check('fatal: undefined rejection claimed and exits 1', rethrown === undefined && exitCode === 1 && fifth.phase === 'disposed', `${String(rethrown)} ${String(exitCode)}`)
check('fatal: undefined reason named on stderr', stderr.text.includes('unhandledRejection with undefined reason'), JSON.stringify(stderr.text))
takePrebootSlot()

// ── 8. boot-phase screens and commands ─────────────────────────────────────
// Slash commands during boot: only the purely local ones run; the rest are
// refused like a plain prompt (text kept, not-ready notice) on EVERY dispatch
// path, including the menu's selected row. A session screen opened during
// boot lists its foreign-source tabs once the live channel arrives, and a
// draft parked while it was open comes back after ready.
{
  exitCode = undefined
  const sixth = await mountPreboot({ dshHome, renderOptions, exit: code => { exitCode = code } })
  await settled(() => screen().includes(BOOT_HINT), { timeoutMs: 3000 })
  await type('/mo')
  await settled(() => screen().includes('commands ·'), { timeoutMs: 2000 })
  await type('\r')
  check('boot cmd: menu-selected /model refused with the notice', await settled(() => screen().includes('Not ready yet'), { timeoutMs: 2000 }), screen())
  check('boot cmd: menu-selected /model keeps the draft', sixth.draft() === '/mo', JSON.stringify(sixth.draft()))
  await type('\x7f\x7f\x7f')
  await settled(() => sixth.draft() === '', { timeoutMs: 2000 })
  await type('/settings')
  // Enter goes in as its own event once the text has landed: under CI load two
  // back-to-back writes can coalesce into one chunk (e.g. `e\r`).
  await settled(() => sixth.draft() === '/settings', { timeoutMs: 2000 })
  await type('\r')
  await sleep(100) // 固定窗:探针 断言 /settings 不开空设置屏
  check('boot cmd: /settings refused, draft kept', sixth.draft() === '/settings' && !screen().includes('Settings unavailable'), `${JSON.stringify(sixth.draft())}\n${screen()}`)
  for (let i = 0; i < '/settings'.length; i++) await type('\x7f')
  await settled(() => sixth.draft() === '', { timeoutMs: 2000 })
  await type('/vim')
  await settled(() => sixth.draft() === '/vim', { timeoutMs: 2000 })
  await type('\r')
  check('boot cmd: /vim runs during boot', await settled(() => sixth.draft() === '' && screen().includes('vim mode on') && screen().includes('INSERT'), { timeoutMs: 2000 }), `${JSON.stringify(sixth.draft())}\n${screen()}`)
  // The keyboard door to the session screen. The line itself is consumed, but
  // vim mode rides the parked draft snapshot even with no text.
  await type('/resume')
  await settled(() => sixth.draft() === '/resume', { timeoutMs: 2000 })
  // PromptInput drops an Enter within 80ms of the previous one (one keypress
  // split into two events); a fast runner gets here sooner after /vim's Enter.
  await sleep(100) // 固定窗:墙钟 跨过 handleEnter 的 80ms Enter 去重窗
  await type('\r')
  check('boot screen: /resume opens the session screen during boot', await settled(() => !screen().includes('INSERT'), { timeoutMs: 2000 }), screen())
  const liveSix = makeLiveChannel()
  takePrebootSlot()
  sixth.ready({ channel: liveSix.channel, props: { questionStore: new QuestionStore(), onExit: () => { exitCode = 0 } } })
  check('boot screen: foreign-source tab appears after ready', await settled(() => screen().includes('Claude Code'), { timeoutMs: 3000 }), screen())
  await type('\x1b')
  if (!(await settled(() => screen().includes('❯'), { timeoutMs: 800 }))) await type('\x1b')
  check('boot screen: vim mode parked during boot survives Esc after ready', await settled(() => screen().includes('❯') && screen().includes('INSERT'), { timeoutMs: 2000 }), screen())
  sixth.dispose()
}

// The prompt row's ⌸ is the door that keeps TEXT in the composer while the
// session screen is open (it needs mouse tracking, so a fullscreen home).
{
  const fullHome = join(home, '.dsh-full')
  mkdirSync(fullHome, { recursive: true })
  writeFileSync(join(fullHome, 'settings.yaml'), 'dsh-tui:\n  fullscreen: true\n  whale: false\n')
  exitCode = undefined
  const seventh = await mountPreboot({ dshHome: fullHome, renderOptions, exit: code => { exitCode = code } })
  check('boot screen (fullscreen): mounted', await settled(() => screen().includes(BOOT_HINT), { timeoutMs: 3000 }), screen())
  await type('keep me')
  // The ⌸ lookup below reads the painted screen, which can trail the draft.
  await settled(() => seventh.draft() === 'keep me' && screen().includes('keep me'), { timeoutMs: 2000 })
  const lines = screen().split('\n')
  const homeRow = lines.findIndex(line => line.includes('⌸') && line.includes('keep me'))
  const homeCol = homeRow < 0 ? -1 : lines[homeRow]!.indexOf('⌸')
  check('boot screen (fullscreen): ⌸ on the prompt row', homeRow >= 0, screen())
  stdin.write(`\x1b[<0;${homeCol + 1};${homeRow + 1}M`)
  stdin.write(`\x1b[<0;${homeCol + 1};${homeRow + 1}m`)
  check('boot screen (fullscreen): ⌸ opens the session screen during boot', await settled(() => !screen().includes('keep me'), { timeoutMs: 2000 }), screen())
  const liveSeven = makeLiveChannel()
  takePrebootSlot()
  seventh.ready({ channel: liveSeven.channel, props: { questionStore: new QuestionStore(), onExit: () => { exitCode = 0 } } })
  await settled(() => screen().includes('Claude Code'), { timeoutMs: 3000 })
  await type('\x1b')
  if (!(await settled(() => screen().includes('keep me'), { timeoutMs: 800 }))) await type('\x1b')
  check('boot screen (fullscreen): text draft parked during boot survives Esc after ready', await settled(() => seventh.draft() === 'keep me' && screen().includes('keep me'), { timeoutMs: 2000 }), `${JSON.stringify(seventh.draft())}\n${screen()}`)
  seventh.dispose()
  takePrebootSlot()
}

// /exit during boot is a deliberate exit like the double Ctrl+C: 0, boot
// screen torn down.
{
  exitCode = undefined
  const exiting = await mountPreboot({ dshHome, renderOptions, exit: code => { exitCode = code } })
  await settled(() => screen().includes(BOOT_HINT), { timeoutMs: 3000 })
  // /lang would lose its settings-layer mirror (the boot channel has no
  // settings host), so it waits for the session like any other command.
  await type('/lang en ')
  await settled(() => exiting.draft() === '/lang en ', { timeoutMs: 2000 })
  await type('\r')
  await sleep(100) // 固定窗:探针 断言 /lang 不执行、文字留在输入框
  check('boot cmd: /lang refused, draft kept', exiting.draft() === '/lang en ' && exitCode === undefined, JSON.stringify(exiting.draft()))
  for (let i = 0; i < '/lang en '.length; i++) await type('\x7f')
  await settled(() => exiting.draft() === '', { timeoutMs: 2000 })
  // A whole line in one input event (ConPTY / piped input: text + CR) takes
  // the direct-submit branch, which must refuse like Enter does.
  await type('piped line\r')
  await sleep(100) // 固定窗:探针 断言整行输入不被提交、草稿保留
  check('boot input: a whole piped line is kept as the draft', exiting.draft() === 'piped line' && exitCode === undefined, JSON.stringify(exiting.draft()))
  for (let i = 0; i < 'piped line'.length; i++) await type('\x7f')
  await settled(() => exiting.draft() === '', { timeoutMs: 2000 })
  await type('/exit')
  await settled(() => exiting.draft() === '/exit', { timeoutMs: 2000 })
  await type('\r')
  check('boot cmd: /exit during boot exits 0', await settled(() => exitCode === 0, { timeoutMs: 2000 }), `${String(exitCode)}\n${screen()}`)
  check('boot cmd: /exit tears the boot screen down', exiting.phase === 'disposed', exiting.phase)
  takePrebootSlot()
}

// ── 9. landing page decided before the first frame (M4) ─────────────────────
const HOME_TITLE = '▣ Sessions'
{
  setHomeSeenForTest(false)
  const landing = await mountPreboot({ dshHome, renderOptions, argv: [], exit: () => {} })
  const sawHome = await settled(() => screen().includes(HOME_TITLE), { timeoutMs: 3000 })
  const frames = [screen()]
  check('landing: first frame is the workspace home when it is unseen', sawHome && !screen().includes(BOOT_HINT), screen())
  const liveLanding = makeLiveChannel()
  takePrebootSlot()
  landing.ready({ channel: liveLanding.channel, props: { questionStore: new QuestionStore(), onExit: () => {}, openHomeOnBoot: true } })
  for (let i = 0; i < 6; i += 1) {
    await sleep(40) // 固定窗:探针 逐帧采样交接后的屏幕，断言首页不被翻走
    frames.push(screen())
  }
  check('landing: home stays put across the handoff (no flip)', frames.every(frame => frame.includes(HOME_TITLE)), frames.find(frame => !frame.includes(HOME_TITLE)) ?? '')
  landing.dispose()

  // The user closed the boot-time home (marking it seen, so the plugin says
  // `false`) and reopened it: the handoff must not take it away.
  setHomeSeenForTest(false)
  const reopened = await mountPreboot({ dshHome, renderOptions, argv: [], exit: () => {} })
  await settled(() => screen().includes(HOME_TITLE), { timeoutMs: 3000 })
  await type('\x1b')
  const closedHome = await settled(() => !screen().includes(HOME_TITLE) && screen().includes(BOOT_HINT), { timeoutMs: 2000 })
  await type('/home')
  await settled(() => reopened.draft() === '/home', { timeoutMs: 2000 })
  await type('\r')
  const reopenedHome = await settled(() => screen().includes(HOME_TITLE), { timeoutMs: 2000 })
  takePrebootSlot()
  reopened.ready({ channel: makeLiveChannel().channel, props: { questionStore: new QuestionStore(), onExit: () => {}, openHomeOnBoot: false } })
  const reopenedFrames: string[] = []
  for (let i = 0; i < 6; i += 1) {
    await sleep(40) // 固定窗:探针 逐帧采样交接后的屏幕，断言用户重开的主页不被关掉
    reopenedFrames.push(screen())
  }
  check('landing: a home the user reopened during boot survives a host `false`', closedHome && reopenedHome && reopenedFrames.every(frame => frame.includes(HOME_TITLE)), `${closedHome} ${reopenedHome}\n${reopenedFrames.find(frame => !frame.includes(HOME_TITLE)) ?? ''}`)
  reopened.dispose()

  // A seeded home nobody touched follows the host's `false` (a literal
  // cordis.yml target the preload could not see).
  setHomeSeenForTest(false)
  const overruled = await mountPreboot({ dshHome, renderOptions, argv: [], exit: () => {} })
  await settled(() => screen().includes(HOME_TITLE), { timeoutMs: 3000 })
  takePrebootSlot()
  overruled.ready({ channel: makeLiveChannel().channel, props: { questionStore: new QuestionStore(), onExit: () => {}, openHomeOnBoot: false } })
  check('landing: an untouched seeded home follows a host `false`', await settled(() => !screen().includes(HOME_TITLE), { timeoutMs: 2000 }), screen())
  overruled.dispose()

  const chatFirst = async (name: string, argv: readonly string[]): Promise<void> => {
    const slotUnderTest = await mountPreboot({ dshHome, renderOptions, argv, exit: () => {} })
    check(name, await settled(() => screen().includes(BOOT_HINT), { timeoutMs: 3000 }) && !screen().includes(HOME_TITLE), screen())
    takePrebootSlot()
    slotUnderTest.dispose()
  }
  await chatFirst('landing: --resume keeps the chat screen', ['--profile', 'dsh-tui', '--', '--resume', 'abc123'])
  await chatFirst('landing: a first prompt keeps the chat screen', ['--profile', 'dsh-tui', '--', 'fix', 'the', 'bug'])
  process.env.DSH_TUI_WORKSPACE_TARGET = '/tmp'
  await chatFirst('landing: a workspace target keeps the chat screen', [])
  delete process.env.DSH_TUI_WORKSPACE_TARGET
  process.env.DSH_TUI_RESUME_SESSION = 'abc123'
  await chatFirst('landing: a launcher resume target keeps the chat screen', [])
  delete process.env.DSH_TUI_RESUME_SESSION
  setHomeSeenForTest(true)
}

// ── 9b. launchpad / first-run guide decided before the first frame ──────────
// Chat seeds both once at mount (no prop reconcile), so the preload must reach
// the plugin's own answer (homePrefs.ts) or an ordinary `dst` launch would
// never show them.
{
  const LAUNCHPAD_PLACEHOLDER = 'Say something, or type / for commands'
  delete process.env.DSH_TUI_NO_LAUNCHPAD
  const plain = decidePrebootLanding([])
  check('launchpad: an ordinary launch starts on it', plain.launchpadOnBoot && !plain.onboardingOnBoot, JSON.stringify(plain))
  const resumed = decidePrebootLanding(['--profile', 'dsh-tui', '--', '--resume', 'abc123'])
  check('launchpad: --resume skips it', !resumed.launchpadOnBoot, JSON.stringify(resumed))
  const prompted = decidePrebootLanding(['--profile', 'dsh-tui', '--', 'fix', 'the', 'bug'])
  check('launchpad: a first prompt skips it', !prompted.launchpadOnBoot, JSON.stringify(prompted))
  const targeted = decidePrebootLanding([], { ...process.env, DSH_TUI_WORKSPACE_TARGET: '/tmp' })
  check('launchpad: a workspace target still starts on it (dst passes cwd)', targeted.launchpadOnBoot, JSON.stringify(targeted))
  const launcherResume = decidePrebootLanding([], { ...process.env, DSH_TUI_RESUME_SESSION: 'abc123' })
  check('launchpad: a launcher resume target skips it', !launcherResume.launchpadOnBoot && !launcherResume.onboardingOnBoot, JSON.stringify(launcherResume))
  const optedOut = decidePrebootLanding([], { ...process.env, DSH_TUI_NO_LAUNCHPAD: '1' })
  check('launchpad: DSH_TUI_NO_LAUNCHPAD=1 skips it', !optedOut.launchpadOnBoot, JSON.stringify(optedOut))
  setOnboardingDoneForTest(false)
  const fresh = decidePrebootLanding([])
  check('onboarding: an unconfigured install opens the guide', fresh.onboardingOnBoot, JSON.stringify(fresh))
  setOnboardingDoneForTest(true)

  const pad = await mountPreboot({ dshHome, renderOptions, argv: [], exit: () => {} })
  const sawPad = await settled(() => screen().includes(LAUNCHPAD_PLACEHOLDER), { timeoutMs: 3000 })
  check('launchpad: first frame is the launchpad', sawPad, screen())
  takePrebootSlot()
  pad.ready({ channel: makeLiveChannel().channel, props: { questionStore: new QuestionStore(), onExit: () => {}, launchpadOnBoot: true } })
  const padFrames: string[] = []
  for (let i = 0; i < 6; i += 1) {
    await sleep(40) // 固定窗:探针 逐帧采样交接后的屏幕，断言落地页不被翻走
    padFrames.push(screen())
  }
  check('launchpad: stays put across the handoff (no flip)', padFrames.every(frame => frame.includes(LAUNCHPAD_PLACEHOLDER)), padFrames.find(frame => !frame.includes(LAUNCHPAD_PLACEHOLDER)) ?? '')
  pad.dispose()
  process.env.DSH_TUI_NO_LAUNCHPAD = '1'
}

// ── 10. persisted renderer decision (M6) ────────────────────────────────────
{
  // A profile whose cordis.yml says fullscreen: false / terminalImages: false
  // and a settings.yaml that sets neither key. The plugin recorded its final
  // decision for this profile on the previous boot.
  const quietHome = join(home, '.dsh-quiet')
  mkdirSync(quietHome, { recursive: true })
  writeFileSync(join(quietHome, 'settings.yaml'), 'dsh-tui:\n  pageMargin: none\n  whale: false\n')
  writeFileSync(join(dataDir, 'renderer.json'), `${JSON.stringify({ profiles: { 'preboot-test': { fullscreen: false, terminalImages: false } } })}\n`)
  const bytesBefore = stdout.written.length
  const matched = await mountPreboot({ dshHome: quietHome, renderOptions, argv: ['--profile', 'preboot-test'], exit: () => {} })
  check('renderer: boot slot mounted with the persisted decision', matched.fullscreen === false && matched.terminalImages === false, `${matched.fullscreen}/${matched.terminalImages}`)
  await settled(() => screen().includes(BOOT_HINT), { timeoutMs: 3000 })
  check('renderer: inline boot screen (no alt-screen enter)', !stdout.written.slice(bytesBefore).includes('\x1b[?1049h'))
  takePrebootSlot()
  matched.dispose()
  const other = await mountPreboot({ dshHome: quietHome, renderOptions, argv: ['--profile', 'some-other-profile'], exit: () => {} })
  check('renderer: the decision is per profile', other.fullscreen === true && other.terminalImages === true, `${other.fullscreen}/${other.terminalImages}`)
  takePrebootSlot()
  other.dispose()
  rmSync(join(dataDir, 'renderer.json'), { force: true })
}

// ── 11. boot watchdog + exit backstop (M5) ─────────────────────────────────
{
  const exitListeners = process.listenerCount('exit')
  exitCode = undefined
  stderr.text = ''
  const orphan = await mountPreboot({ dshHome, renderOptions, bootTimeoutMs: 250, exit: code => { exitCode = code } })
  check('watchdog: exit backstop armed while booting', process.listenerCount('exit') > exitListeners)
  check('watchdog: fires when nobody takes the slot', await settled(() => exitCode !== undefined, { timeoutMs: 3000 }) && exitCode === 1, String(exitCode))
  check('watchdog: boot screen torn down first', orphan.phase === 'disposed' && instances.get(stdout as never) === undefined)
  check('watchdog: says why on stderr', stderr.text.includes('dsh-tui') && stderr.text.includes('DSH_TUI_PREBOOT=0'), JSON.stringify(stderr.text))
  check('watchdog: disarmed after teardown', process.listenerCount('exit') === exitListeners, String(process.listenerCount('exit')))
  takePrebootSlot()

  exitCode = undefined
  const adopted = await mountPreboot({ dshHome, renderOptions, bootTimeoutMs: 150, exit: code => { exitCode = code } })
  takePrebootSlot()
  await sleep(400) // 固定窗:探针 断言被接管的 slot 不会被看门狗杀掉
  check('watchdog: a taken slot is left to the plugin', exitCode === undefined && adopted.phase === 'booting', `${String(exitCode)} ${adopted.phase}`)
  adopted.ready({ channel: makeLiveChannel().channel, props: { questionStore: new QuestionStore(), onExit: () => {} } })
  check('watchdog: exit backstop released once live', process.listenerCount('exit') === exitListeners, String(process.listenerCount('exit')))
  adopted.dispose()

  // A real process exit with status 0 while the boot slot is still booting
  // (dsh returned without ever mounting the TUI): the terminal is restored
  // and the status is not success.
  const childFile = join(home, 'preboot-backstop-child.mts')
  writeFileSync(childFile, [
    "import { PassThrough, Writable } from 'node:stream'",
    "class Out extends Writable { columns = 80; rows = 24; isTTY = true; _write(_c: unknown, _e: unknown, cb: () => void) { cb() } }",
    'class In extends PassThrough { isTTY = true; setRawMode() { return this } }',
    `const { mountPreboot } = await import(${JSON.stringify(new URL('../src/preboot/mount.ts', import.meta.url).href)})`,
    `const slot = await mountPreboot({ dshHome: ${JSON.stringify(dshHome)}, argv: [], renderOptions: { stdout: new Out(), stdin: new In(), stderr: new Out(), patchConsole: false } })`,
    "process.on('exit', () => { process.stderr.write(`PHASE=${slot.phase}\\n`) })",
    'process.exit(0)',
    '',
  ].join('\n'))
  const child = spawnSync(process.execPath, ['--import', 'tsx/esm', childFile], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: process.env,
    encoding: 'utf8',
    timeout: 30000,
  })
  check('backstop: exit 0 while booting becomes non-zero', child.status !== 0 && child.status !== null, `status=${child.status} stderr=${child.stderr.slice(-400)}`)
  check('backstop: boot screen disposed on the way out', child.stderr.includes('PHASE=disposed'), child.stderr.slice(-400))

  // The real stack: Ink's own stderr/console patches installed (default
  // patchConsole, the process's real stderr). What dsh wrote while the boot
  // screen swallowed stderr must reach the restored terminal, and the
  // renderer's reset sequences must be written on the way out.
  const realFile = join(home, 'preboot-backstop-real.mts')
  writeFileSync(realFile, [
    "import { PassThrough, Writable } from 'node:stream'",
    "let out = ''",
    "class Out extends Writable { columns = 80; rows = 24; isTTY = true; _write(c: unknown, _e: unknown, cb: () => void) { out += String(c); cb() } }",
    'class In extends PassThrough { isTTY = true; setRawMode() { return this } }',
    `const { mountPreboot } = await import(${JSON.stringify(new URL('../src/preboot/mount.ts', import.meta.url).href)})`,
    `const slot = await mountPreboot({ dshHome: ${JSON.stringify(dshHome)}, argv: [], renderOptions: { stdout: new Out(), stdin: new In() } })`,
    "process.stderr.write('DSH-STDERR-MARKER\\n')",
    "console.error('DSH-CONSOLE-MARKER')",
    "process.on('exit', () => { process.stderr.write(`PHASE=${slot.phase} CURSOR=${out.includes('\\x1b[?25h')} ALT=${out.includes('\\x1b[?1049h') ? out.includes('\\x1b[?1049l') : 'n/a'}\\n`) })",
    'process.exit(0)',
    '',
  ].join('\n'))
  const real = spawnSync(process.execPath, ['--import', 'tsx/esm', realFile], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: process.env,
    encoding: 'utf8',
    timeout: 30000,
  })
  check('backstop (real stack): swallowed stderr is replayed', real.stderr.includes('DSH-STDERR-MARKER') && real.stderr.includes('DSH-CONSOLE-MARKER'), real.stderr.slice(-600))
  check('backstop (real stack): stderr restored after teardown', /PHASE=disposed/.test(real.stderr), real.stderr.slice(-600))
  check('backstop (real stack): cursor shown and alt-screen left', /CURSOR=true ALT=(true|n\/a)/.test(real.stderr), real.stderr.slice(-600))
  check('backstop (real stack): exit 0 while booting becomes non-zero', real.status !== 0 && real.status !== null, `status=${real.status}`)
}

// ── 12. host-composed settings (0.1.7+ hosts) ──────────────────────────────
{
  const root = join(home, 'fake-hosts')
  rmSync(root, { recursive: true, force: true })
  /**
   * A dsh install: package.json + lib/bin.js + its own app-boot copy. The
   * fake composes like the real one only as far as the preload relies on
   * it: it echoes the context it was handed into the dsh-tui row, applies
   * overlays last-wins by id, and chatters on stderr like 0.1.7-rc.1 does
   * for a skipped bundle.
   */
  const fakeHost = (name: string, appBoot: string, settings?: string): string => {
    const dir = join(root, name)
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', type: 'module' }))
    writeFileSync(join(dir, 'lib', 'bin.js'), '')
    const bootDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
    mkdirSync(bootDir, { recursive: true })
    writeFileSync(join(bootDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', type: 'module', exports: { '.': { default: './index.js' } } }))
    writeFileSync(join(bootDir, 'index.js'), appBoot)
    if (settings !== undefined) {
      const settingsDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh-settings')
      mkdirSync(settingsDir, { recursive: true })
      writeFileSync(join(settingsDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-settings', type: 'module', exports: { '.': { default: './index.js' } } }))
      writeFileSync(join(settingsDir, 'index.js'), settings)
    }
    return join(dir, 'lib', 'bin.js')
  }
  const modernBoot = [
    "import { readFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    'export function loadProfileDirectory() { return {} }',
    'export function loadOverlayPatches(_bin, file) { return JSON.parse(readFileSync(file, "utf8")) }',
    'export function resolveProfileDir(name, home) { return join(home, "profiles", name) }',
    'export function readProfilePatches(_bin, ctx) {',
    "  process.stderr.write('dsh: skipping profile bundle x\\n')",
    "  return [{ id: 'dsh-tui', config: { pageMargin: 'slim', whale: false, statusBar: { tps: true, cost: false }, preset: { __jsExpr: 'process.env.X' }, seenDir: ctx.dir, seenHome: ctx.home, seenAnchor: ctx.installAnchor, seenPatchPath: ctx.patchPath } }, ...ctx.overlays]",
    '}',
    'export function composeEntries(layers) {',
    '  const rows = new Map()',
    '  for (const row of layers.flat()) rows.set(row.id, { ...rows.get(row.id), ...row })',
    '  return [...rows.values()]',
    '}',
    '',
  ].join('\n')
  const modern = fakeHost('modern', modernBoot, 'export class SettingsForms { describe() { return [] } }\n')
  // A 0.1.7+ host whose settings service is patched back to register().
  const patched = fakeHost('patched', modernBoot, 'export class SettingsForms { register() {} }\n')
  // 0.1.5: loadProfileDirectory but no readProfilePatches; settings.yaml era.
  const older = fakeHost('older', 'export function loadProfileDirectory() { return {} }\nexport function composeEntries() { return [] }\n')
  const broken = fakeHost('broken', modernBoot.replace("process.stderr.write('dsh: skipping", "throw new Error('broken'); process.stderr.write('"))
  const composedHome = join(root, 'dsh-home')
  mkdirSync(composedHome, { recursive: true })
  const profileArgv = ['--profile', 'dsh-tui', '--', 'hello']

  // Record the real stderr to prove the host's chatter never reaches it.
  const realWrite = process.stderr.write
  let leaked = ''
  process.stderr.write = ((chunk: unknown) => {
    leaked += String(chunk)
    return true
  }) as typeof process.stderr.write
  let composed: Record<string, unknown>
  try {
    composed = await readPrebootSettingsLayer({ dshHome: composedHome, argv: profileArgv, hostEntry: modern })
  } finally {
    process.stderr.write = realWrite
  }
  check('host: composed dsh-tui row is the settings layer', composed.pageMargin === 'slim' && composed.whale === false, JSON.stringify(composed))
  check('host: profile dir resolved under $DSH_HOME/profiles', composed.seenDir === join(composedHome, 'profiles', 'dsh-tui') && composed.seenHome === composedHome, String(composed.seenDir))
  check('host: the profile patch path is the profile\'s cordis.patch.yml', composed.seenPatchPath === join(composedHome, 'profiles', 'dsh-tui', 'cordis.patch.yml'), String(composed.seenPatchPath))
  check('host: install anchor is the host package.json', composed.seenAnchor === join(root, 'modern', 'package.json'), String(composed.seenAnchor))
  check('host: stderr muted during composition and restored', leaked === '' && process.stderr.write === realWrite, JSON.stringify(leaked))
  const composedDecisions = decidePreboot(composed)
  check('host: !!js values are ignored, not misread', composedDecisions.fullscreen === true && composedDecisions.minimalUi === false)

  // --patch overlays (dsh's repeatable collector) reach the composition.
  const overlay = join(root, 'overlay.json')
  writeFileSync(overlay, JSON.stringify([{ id: 'dsh-tui', config: { pageMargin: 'roomy', effortDefault: 'high' } }]))
  const withOverlay = await readPrebootSettingsLayer({ dshHome: composedHome, argv: ['--profile', 'dsh-tui', `--patch=${overlay}`, '--', '--patch', 'not-a-host-flag'], hostEntry: modern })
  check('host: --patch overlays compose over the profile', withOverlay.pageMargin === 'roomy' && decidePreboot(withOverlay).effort === 'high', JSON.stringify(withOverlay))

  // A settings.yaml still on disk is imported on this boot, so it wins; the
  // status bar merges key by key like the host's layer merge.
  writeFileSync(join(composedHome, 'settings.yaml'), 'dsh-tui:\n  pageMargin: none\n  statusBar:\n    cost: true\n')
  const pending = await readPrebootSettingsLayer({ dshHome: composedHome, argv: profileArgv, hostEntry: modern })
  const pendingBar = pending.statusBar as Record<string, unknown> | undefined
  check('host: leftover settings.yaml layers over the composed row', pending.pageMargin === 'none' && pending.whale === false, JSON.stringify(pending))
  check('host: statusBar merges per key', pendingBar?.tps === true && pendingBar?.cost === true, JSON.stringify(pendingBar))

  // register() service: the plugin reads the service's legacy document
  // through its settings schema (defaults decide), Config fills the rest.
  const patchedHome = join(root, 'patched-home')
  mkdirSync(patchedHome, { recursive: true })
  writeFileSync(join(patchedHome, 'settings.yaml.imported'), 'dsh-tui:\n  effortDefault: high\n  whaleGirl: true\n')
  const patchedArgv = ['--profile', 'dsh-tui', '--']
  const legacyLayer = await readPrebootSettingsLayer({ dshHome: patchedHome, argv: patchedArgv, hostEntry: patched })
  check('legacy host: document values win', legacyLayer.effortDefault === 'high' && legacyLayer.whaleGirl === true, JSON.stringify(legacyLayer))
  // Config says whale: false; the document is silent, and the schema's
  // default decides — exactly what register() hands the live plugin.
  check('legacy host: a schema default shadows Config (as register() does)', legacyLayer.whale === true && legacyLayer.toolBackground === 'none', JSON.stringify(legacyLayer))
  // pageMargin's default sits inside a transform, so an absent field resolves
  // to undefined and the plugin's `?? config.pageMargin` takes the Config value.
  check('legacy host: a field the schema leaves unset falls through to Config', legacyLayer.pageMargin === 'slim' && legacyLayer.seenDir === join(patchedHome, 'profiles', 'dsh-tui'), JSON.stringify(legacyLayer))
  writeFileSync(join(patchedHome, 'settings-legacy.yaml'), 'dsh-tui:\n  pageMargin: roomy\n')
  const rewritten = await readPrebootSettingsLayer({ dshHome: patchedHome, argv: patchedArgv, hostEntry: patched })
  check('legacy host: the service\'s own settings-legacy.yaml beats .imported', rewritten.pageMargin === 'roomy' && rewritten.whaleGirl === false, JSON.stringify(rewritten))
  const configOnly = await readPrebootSettingsLayer({ dshHome: patchedHome, argv: patchedArgv, hostEntry: modern })
  check('host: a Config-only service ignores the legacy documents', configOnly.pageMargin === 'slim' && configOnly.whaleGirl === undefined, JSON.stringify(configOnly))

  // Fallbacks: every one reads settings.yaml only.
  const fallbackOf = (argv: readonly string[], hostEntry: string | undefined) =>
    readPrebootSettingsLayer({ dshHome: composedHome, argv, hostEntry })
  const olderLayer = await fallbackOf(profileArgv, older)
  check('host: an older host (no readProfilePatches) falls back to settings.yaml', olderLayer.pageMargin === 'none' && olderLayer.whale === undefined, JSON.stringify(olderLayer))
  const noProfile = await fallbackOf(['--', 'hello'], modern)
  check('host: a non-profile launch falls back to settings.yaml', noProfile.whale === undefined && noProfile.pageMargin === 'none', JSON.stringify(noProfile))
  const unresolvable = await fallbackOf(profileArgv, join(root, 'nowhere', 'bin.js'))
  check('host: an unresolvable entry falls back to settings.yaml', unresolvable.whale === undefined, JSON.stringify(unresolvable))
  const throwing = await fallbackOf(profileArgv, broken)
  check('host: a throwing host falls back to settings.yaml', throwing.whale === undefined && throwing.pageMargin === 'none', JSON.stringify(throwing))
  check('host: stderr restored after a throwing host', process.stderr.write === realWrite)
}

// ── 13. compile cache (preload entry) ──────────────────────────────────────
{
  const entry = new URL('../src/preboot/entry.ts', import.meta.url).href
  const cacheDirOf = (env: Record<string, string | undefined>): string => {
    const run = spawnSync(process.execPath, [
      '--import', 'tsx/esm', '--import', entry,
      '--input-type=module', '-e', "import { getCompileCacheDir } from 'node:module'; process.stdout.write(String(getCompileCacheDir()))",
    ], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      // Piped stdio: the preload must not mount a boot screen here.
      env: { ...process.env, NODE_COMPILE_CACHE: undefined, NODE_DISABLE_COMPILE_CACHE: undefined, ...env },
      encoding: 'utf8',
      timeout: 30000,
    })
    return run.status === 0 ? run.stdout : `exit ${run.status}: ${run.stderr.slice(-300)}`
  }
  const own = join(home, 'own-compile-cache')
  const defaultDir = cacheDirOf({ DSH_TUI_PREBOOT: '1' })
  check('compile cache: on under ~/.dsh-tui/compile-cache with the marker', defaultDir.startsWith(join(dataDir, 'compile-cache')), defaultDir)
  const explicit = cacheDirOf({ DSH_TUI_PREBOOT: '1', NODE_COMPILE_CACHE: own })
  check('compile cache: an explicit NODE_COMPILE_CACHE keeps its directory', explicit.startsWith(own), explicit)
  const disabled = cacheDirOf({ DSH_TUI_PREBOOT: '1', NODE_DISABLE_COMPILE_CACHE: '1' })
  check('compile cache: NODE_DISABLE_COMPILE_CACHE=1 turns it off', disabled === 'undefined', disabled)
  const unmarked = cacheDirOf({ DSH_TUI_PREBOOT: undefined })
  check('compile cache: untouched without the preboot marker', unmarked === 'undefined', unmarked)
}

// ── 14. kernel (remembered / pinned backend) ───────────────────────────────
{
  const { writeKernelPrefs, KERNEL_SWITCH_HANDOFF_ENV } = await import('../src/kernelPrefs.js')
  const { resolveBrand } = await import('../src/branding.js')
  const kernelFile = join(dataDir, 'kernel.json')
  const env = { ...process.env, DSH_TUI_BACKEND: undefined, [KERNEL_SWITCH_HANDOFF_ENV]: undefined }
  rmSync(kernelFile, { force: true })
  check('kernel: nothing remembered boots dsh', resolvePrebootBackend({}, env) === 'dsh')
  writeKernelPrefs({ backend: 'claude' }, kernelFile)
  check('kernel: the remembered kernel', resolvePrebootBackend({}, env) === 'claude')
  check('kernel: the row\'s backend beats the memory', resolvePrebootBackend({ backend: 'dsh' }, env) === 'dsh')
  check('kernel: DSH_TUI_BACKEND beats the memory', resolvePrebootBackend({}, { ...env, DSH_TUI_BACKEND: 'dsh' }) === 'dsh')
  check('kernel: an invalid DSH_TUI_BACKEND means dsh, not the memory', resolvePrebootBackend({}, { ...env, DSH_TUI_BACKEND: 'nope' }) === 'dsh')
  check('kernel: a switch handoff beats everything', resolvePrebootBackend({ backend: 'claude' }, { ...env, DSH_TUI_BACKEND: 'claude', [KERNEL_SWITCH_HANDOFF_ENV]: 'dsh' }) === 'dsh')

  delete process.env.DSH_TUI_NO_LAUNCHPAD
  setHomeSeenForTest(false)
  setOnboardingDoneForTest(false)
  const onDsh = decidePrebootLanding([], process.env, 'dsh')
  const onClaude = decidePrebootLanding([], process.env, 'claude')
  check('kernel: dsh boots offer the home and the guide', onDsh.openHomeOnBoot && onDsh.onboardingOnBoot, JSON.stringify(onDsh))
  check('kernel: a claude boot skips the DSH home and guide, keeps the launchpad', !onClaude.openHomeOnBoot && !onClaude.onboardingOnBoot && onClaude.launchpadOnBoot, JSON.stringify(onClaude))
  setOnboardingDoneForTest(true)
  setHomeSeenForTest(true)
  process.env.DSH_TUI_NO_LAUNCHPAD = '1'

  const bootOn = (backendId?: 'dsh' | 'claude') => createBootChannel({ model: '', effort: undefined, cwd: home, gitBranch: undefined, settings: {}, ...(backendId === undefined ? {} : { backendId }) })
  const claudeBoot = bootOn('claude')
  check('kernel: the boot channel reports the claude kernel', claudeBoot.backendCapabilities.backendId === 'claude' && claudeBoot.sessionRef.backendId === 'claude')
  check('kernel: the boot frame already wears the claude brand', resolveBrand(claudeBoot.brand, claudeBoot.backendCapabilities.backendId) === 'claude')
  check('kernel: the default boot channel is dsh', bootOn().backendCapabilities.backendId === 'dsh')
  rmSync(kernelFile, { force: true })
}

terminal.dispose()
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
process.exit(0)
