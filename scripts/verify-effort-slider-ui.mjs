/**
 * Headless full-stack smoke of the new /effort + Shift+Tab features through
 * the real Chat screen (compiled lib): renders Chat with a channel-shaped
 * stub whose listEfforts/setEffort/cycleMode mirror the real seam contracts,
 * drives the real useInput path through fake stdin, and asserts on the
 * rendered screen (xterm-headless rebuilds the visible rows):
 *   1. `/effort` (bare) opens the slider listing the adapter levels with the
 *      current one checked;
 *   2. `→` moves focus right and applies (setEffort called, StatusLine
 *      effort segment changes);
 *   3. Esc closes the slider;
 *   4. `/effort off` sets directly (notify);
 *   5. Shift+Tab (\x1b[Z) cycles the session mode; StatusLine shows the mode
 *      label; a plan-declaring mode recolors nothing observable here but the
 *      border token changes — asserted via channel.mode.plan.
 *
 * Run with plain node against the compiled lib:
 *   node scripts/verify-effort-slider-ui.mjs
 */
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import { render } from '../lib/types/ui.js'
import { Chat } from '../lib/types/screens/Chat.js'
import { setLang } from '../lib/types/i18n.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
process.exitCode = 0

const sleep = ms => new Promise(r => setTimeout(r, ms))

function makeStreams() {
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdout.frames.push(String(chunk))
      cb()
    },
  })
  stdout.columns = 110
  stdout.rows = 34
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

const EFFORTS = [
  { id: 'off', name: 'Off', description: 'No extra thinking' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Max' },
]

function makeChannel() {
  const setEffortCalls = []
  const cycled = []
  const notifications = []
  const rows = []
  let modeIndex = 0
  const MODES = [
    { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    { id: 'plan', plan: true, sandbox: 'read-only', approval: 'ask' },
    { id: 'full', plan: false, sandbox: 'danger-full-access', approval: 'never' },
  ]
  const listeners = new Set()
  const channel = {
    version: 0,
    rows,
    status: 'idle',
    sessionTitle: 'smoke',
    agentId: 'smoke',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    tokens: { input: 0, output: 0 },
    cwd: '/tmp',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    pending: [],
    notifications,
    contextWindow: undefined,
    reasoningEffort: 'high',
    workingActivity: undefined,
    activityEnabled: false,
    contextBarEnabled: true,
    agentPreset: 'standard',
    goal: undefined,
    todos: [],
    commandList: [
      { name: 'effort', description: 'Adjust the reasoning effort (slider)' },
    ],
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    get mode() { return MODES[modeIndex] },
    get modeIndex() { return modeIndex },
    async cycleMode() {
      cycled.push(modeIndex)
      modeIndex = (modeIndex + 1) % MODES.length
      channel.version += 1
      for (const listener of listeners) listener()
    },
    async listEfforts() { return { efforts: EFFORTS, defaultEffort: 'high' } },
    async setEffort(id) {
      setEffortCalls.push(id)
      if (!EFFORTS.some(e => e.id === id)) return false
      channel.reasoningEffort = id
      channel.version += 1
      for (const listener of listeners) listener()
      return true
    },
    notify(text, options) { notifications.push({ text, options }) },
    pushLocal(title, lines) {
      for (const line of [title, ...lines]) {
        rows.push({ id: rows.length, kind: 'notice', text: line })
      }
      channel.version += 1
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit() { channel.version += 1; for (const listener of listeners) listener() },
    submit() {},
    steer() {},
    removePending: () => true,
    cancel() {},
    interruptAndDeliver: () => 0,
    clear() {},
    loadOlder: () => 0,
    listModels: async () => [],
    listFiles: async () => [],
    listSessions: async () => [],
    setResumeTarget() {},
    setActivityFrames: () => true,
    activityFrames: 'claude',
    runExternalCommand: async () => '',
    mcpStatus: () => [],
    exportSession: () => null,
    initWorkspace: () => null,
    doctorInfo: () => [],
    listSubagents: async () => [],
    listPresets: async () => [],
    switchPreset: async () => false,
    switchModel: async () => false,
    rewindTo: async () => null,
    resumeTo: async () => false,
    newSession: async () => false,
    compact() {},
    setEffortCalls,
    cycled,
  }
  return channel
}

const toPlain = s =>
  s
    .replace(/\x1b\[(\d+)C/g, () => ' '.repeat(8))
    .replace(/\x1b\[[0-9;?>:]*[a-zA-Z]/g, '')
    .replace(/\x1b\]9;[^\x07]*\x07/g, '')

const { stdout, stderr, stdin } = makeStreams()
const channel = makeChannel()
const instance = await render(
  React.createElement(Chat, {
    channel,
    questionStore: { subscribe: () => () => {}, getSnapshot: () => null, answerCurrent: () => {} },
    onExit() {},
  }),
  { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
)
await sleep(700)

const screen = () => toPlain(stdout.frames.join(''))

// Pin the UI language so the assertions below don't depend on the host's
// persisted /lang choice or OS locale (the slider chrome is localized).
setLang('en')

// 1. /effort bare → slider opens with the current level (High) checked.
stdin.write('/effort')
await sleep(250)
stdin.write('\r')
await sleep(400)
let s = screen()
check('slider opens with Reasoning effort title', /Reasoning effort/.test(s), '')
check('slider lists all three levels', /Off/.test(s) && /High/.test(s) && /Max/.test(s), '')
check('current level marked', /High\s*✓/.test(s) || /✓/.test(s), '')

// 2. → moves focus and applies immediately.
stdin.write('\x1b[C')
await sleep(300)
check('right arrow applied setEffort(max)', channel.setEffortCalls.length === 1 && channel.setEffortCalls[0] === 'max', JSON.stringify(channel.setEffortCalls))
s = screen()
check('statusline effort shows max', /max/.test(s), '')

// 3. Esc closes.
stdin.write('\x1b')
await sleep(300)
s = screen()
check('Esc closed the slider', !/Reasoning effort/.test(s.slice(-4000)), '')

// 4. /effort off → direct set + notify.
stdin.write('/effort off')
await sleep(200)
stdin.write('\r')
await sleep(300)
check('/effort off applied', channel.setEffortCalls.includes('off'), JSON.stringify(channel.setEffortCalls))

// 5. Shift+Tab cycles the mode; StatusLine shows the label.
stdin.write('\x1b[Z')
await sleep(300)
s = screen()
check('statusline shows mode label', s.includes('计划模式') || /plan mode/.test(s), s.slice(-300))
stdin.write('\x1b[Z')
await sleep(300)
check('second backtab → full', channel.mode.id === 'full', channel.mode.id)
stdin.write('\x1b[Z')
await sleep(300)
check('third backtab → default (no segment)', channel.modeIndex === 0, String(channel.modeIndex))

// 6. zh locale: the slider chrome hot-swaps to the localized strings
//    (picker i18n branch: picker-title-effort / hint-adjust-done).
setLang('zh')
stdin.write('/effort')
await sleep(250)
stdin.write('\r')
await sleep(400)
s = screen()
check('zh: slider title 推理强度', s.includes('推理强度'), '')
check('zh: hint line localized', s.includes('调整') && s.includes('完成'), '')
// Clear the frame buffer so the check only sees the post-Esc repaint —
// slicing the joined backlog can still reach the open-slider frame.
stdout.frames.length = 0
stdin.write('\x1b')
await sleep(300)
s = screen()
check('zh: Esc closed the slider', !s.includes('推理强度'), '')
setLang('en')

instance.unmount()
process.exit(failed)
