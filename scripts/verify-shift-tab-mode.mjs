/**
 * Headless verification of the Shift+Tab session-mode wiring: renders the
 * compiled PromptInput with a stub channel and injects `\x1b[Z` (backtab —
 * the escape sequence a real terminal sends for Shift+Tab), asserting that
 * exactly one `channel.cycleMode()` fires and no send path does.
 *
 * It also pins the failure contract of that keyboard entry: a `cycleMode`
 * whose promise REJECTS must be handled by the entry itself (notification,
 * no unhandled rejection, handler still alive). Dropping that rejection is
 * what killed the process behind issue #1072's crash class, so this half is
 * the regression that must stay red without the `.catch`.
 *
 * The process-level #185 guard is disabled for this script: with no fatal
 * sink registered (plugin.ts is not mounted here) its rethrow would abort the
 * process from the rejection listener, replacing the FAIL line this script
 * exists to print with a raw crash.
 *
 * Run with plain node against the compiled lib:
 *   node scripts/verify-shift-tab-mode.mjs
 */
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import { render } from '../lib/types/ui.js'
import { PromptInput } from '../lib/types/components/PromptInput.js'

// Must be set before the first render(): that is when the guard installs.
process.env.DSH_TUI_NO_185_PROCESS_GUARD = '1'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function makeStreams() {
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdout.frames.push(String(chunk))
      cb()
    },
  })
  stdout.columns = 100
  stdout.rows = 30
  stdout.isTTY = true
  stdout.frames = []
  const stderr = new Writable({ write(_c, _e, cb) { cb() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  return { stdout, stderr, stdin }
}

/** Stub channel for the composer. `rejectCycle` models an UNEXPECTED throw
 *  inside `cycleMode` (kernel refusal, lifetime race): the real ChannelUi
 *  always returns a promise (adapter/channel/ui.ts `settle`), so the stub
 *  does too — a bare `undefined` would hide the drop this script tests. */
function makeChannel({ rejectCycle = false } = {}) {
  const cycled = []
  const submitted = []
  const steered = []
  const notifications = []
  return {
    working: false,
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    cycleMode() {
      cycled.push(Date.now())
      return rejectCycle ? Promise.reject(new Error('boom')) : Promise.resolve()
    },
    commandList: [],
    notifications,
    contextWindow: undefined,
    pending: [],
    notify(text, options) { notifications.push({ text, options }) },
    submit(text) { submitted.push(text) },
    steer(text) { steered.push(text) },
    removePending: () => true,
    cancel() {},
    interruptAndDeliver: () => 0,
    listFiles: async () => [],
    cycled,
    submitted,
    steered,
  }
}

const renderInput = async (channel, streams) => render(
  React.createElement(PromptInput, {
    channel,
    helpOpen: false,
    onToggleHelp() {},
    onRunCommand: () => false,
    selectionActive: false,
  }),
  { stdout: streams.stdout, stderr: streams.stderr, stdin: streams.stdin, exitOnCtrlC: false, patchConsole: false },
)

const { stdout, stderr, stdin } = makeStreams()
const channel = makeChannel()
const instance = await renderInput(channel, { stdout, stderr, stdin })
await sleep(600) // 固定窗:pacing 等 PromptInput 首帧就绪再注入按键
// Backtab with text in the editor: mode cycling must win over the plain-Tab
// completion arm (the parser reports backtab as key.tab + key.shift).
stdin.write('hello')
await sleep(150) // 固定窗:pacing 让输入落进编辑器再发 Backtab
stdin.write('\x1b[Z')
await sleep(300) // 固定窗:探针 一次 Backtab 只准循环一次（多触发即失败）
check('backtab cycles the session mode once', channel.cycled.length === 1, JSON.stringify(channel.cycled.length))
check('backtab does not submit or steer', channel.submitted.length === 0 && channel.steered.length === 0, JSON.stringify([channel.submitted, channel.steered]))

// A second backtab cycles again; Tab alone still completes (no steer).
stdin.write('\x1b[Z')
await sleep(300) // 固定窗:探针 第二次 Backtab 仍只加一次
check('second backtab cycles again', channel.cycled.length === 2, JSON.stringify(channel.cycled.length))
stdin.write('\t')
await sleep(300) // 固定窗:探针 普通 Tab 不得改动循环计数
check('plain Tab does not cycle the mode', channel.cycled.length === 2, JSON.stringify(channel.cycled.length))
instance.unmount()

// ---- rejected cycleMode: the keyboard entry owns the failure ---------------
const rejections = []
const onRejection = reason => rejections.push(reason)
process.on('unhandledRejection', onRejection)
{
  const failingStreams = makeStreams()
  const failing = makeChannel({ rejectCycle: true })
  const failingInstance = await renderInput(failing, failingStreams)
  await sleep(600) // 固定窗:pacing 等首帧就绪再注入按键
  failingStreams.stdin.write('\x1b[Z')
  // Observation window: Node reports an unhandled rejection at the end of the
  // current macrotask, so one 300ms stretch is far past the decision point.
  await sleep(300) // 固定窗:探针 观察窗内不得出现任何 unhandledRejection
  check('rejected cycleMode leaves no unhandled rejection', rejections.length === 0, rejections.map(String).join(' | '))
  check(
    'rejected cycleMode surfaces as an error notification carrying the cause',
    failing.notifications.length === 1
      && failing.notifications[0].options?.color === 'error'
      && failing.notifications[0].text.includes('boom'),
    JSON.stringify(failing.notifications),
  )
  // The key is still consumed and the handler is still live: a second backtab
  // reports the second failure instead of the composer having silently died.
  failingStreams.stdin.write('\x1b[Z')
  await sleep(300) // 固定窗:探针 第二次拒绝仍只通知一次且输入框存活
  check('second rejected backtab reports again', failing.cycled.length === 2 && failing.notifications.length === 2, JSON.stringify([failing.cycled.length, failing.notifications.length]))
  // The composer itself is still alive: a mounted, responsive input writes a
  // new frame for the typed character (a dead or stuck tree writes none).
  const framesBefore = failingStreams.stdout.frames.length
  failingStreams.stdin.write('x')
  await sleep(300) // 固定窗:探针 输入框仍须响应（卡死/卸载即失败）
  check('composer still renders after the rejected cycle', failingStreams.stdout.frames.length > framesBefore, JSON.stringify([framesBefore, failingStreams.stdout.frames.length]))
  failingInstance.unmount()
}
process.off('unhandledRejection', onRejection)
check('no rejection escaped the whole run', rejections.length === 0, rejections.map(String).join(' | '))

process.exit(failed)
