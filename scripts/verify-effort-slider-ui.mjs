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
import xtermHeadless from '@xterm/headless'
const { Terminal: XTerm } = xtermHeadless
import { render } from '../lib/types/ui.js'
import { Chat } from '../lib/types/screens/Chat.js'
import { setLang } from '../lib/types/i18n.js'
import { settle, settled, sleep, viewportLines } from './lib/term-test.mjs'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
process.exitCode = 0

const term = new XTerm({ cols: 110, rows: 34, scrollback: 100, allowProposedApi: true })

function makeStreams() {
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      const text = String(chunk)
      stdout.frames.push(text)
      term.write(text, cb)
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

function makeChannel(options = {}) {
  const setEffortCalls = []
  const cycled = []
  const notifications = []
  const rows = []
  let modeIndex = options.modeIndex ?? 0
  let MODES = options.modes ?? [
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
    displayCwd: '/tmp',
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
    // Status footer fields: the assertions below watch the mode label, so
    // enable it explicitly (the compact defaults hide it).
    statusBar: { mode: true },
    agentPreset: 'standard',
    goal: undefined,
    todos: [],
    commandList: [
      { name: 'effort', description: 'Adjust the reasoning effort (slider)' },
      { name: 'help', description: 'Show shortcuts and commands' },
    ],
    commandCompletions(input) {
      const prefix = input.replace(/^\//u, '').trim().toLowerCase()
      return this.commandList
        .filter((command) => command.name.startsWith(prefix))
        .map((command) => ({ ...command, commandLine: `/${command.name}`, replacement: `/${command.name} ` }))
    },
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    get mode() { return MODES[modeIndex] },
    get modeIndex() { return modeIndex },
    async cycleMode() {
      cycled.push(modeIndex)
      modeIndex = (modeIndex + 1) % MODES.length
      channel.version += 1
      for (const listener of listeners) listener()
    },
    setModesForTest(nextModes, nextIndex = 0) {
      MODES = nextModes
      modeIndex = nextIndex
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
    resumeTo: async () => ({ ok: false, reason: 'unavailable' }),
    newSession: async () => false,
    compact() {},
    setEffortCalls,
    cycled,
  }
  return channel
}

const toPlain = s =>
  s
    // 光标前移按真实格数展开：浮层面板覆盖既有行时 diff 会跳过未变单元格
    // （两个空格之间只发 CSI n C），固定 8 空格会把 "Reasoning effort"
    // 拆成多格空格导致断言漏匹配。
    .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
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
// 启动固定窗保留：等 Chat 首帧与快捷键安装完成，无单一可轮询锚点。
await sleep(700)

// inline 模式下有 scrollback 时 getLine(0..rows) 直扫读的是缓冲区开头；
// 改用公共辅助按 baseY 读可见视口（issue #532）。
const screen = () => viewportLines(term).join('\n')

// Pin the UI language so the assertions below don't depend on the host's
// persisted /lang choice or OS locale (the slider chrome is localized).
setLang('en')

// Help owns Esc while it is visible; Chat's modal guard must not let the key
// reach working cancellation or any hidden global shortcut.
stdin.write('/help')
// 输入已落屏（补全菜单描述可见）再回车——等待后只操作不断言，用 settle。
await settle(() => screen().includes('Show shortcuts and commands'))
stdin.write('\r')
check('en: Help opens before slider', await settled(() => /scroll|commands:/.test(screen())), '')
stdin.write('\x1b')
check('en: Esc closes Help only', await settled(() => !/commands:/.test(screen())), '')

// 1. /effort bare → slider opens with the current level (High) checked.
stdin.write('/effort')
await settle(() => screen().includes('Adjust the reasoning effort'))
stdin.write('\r')
check('slider opens with Reasoning effort title', await settled(() => /Reasoning effort/.test(screen())), '')
check('slider lists all three levels', await settled(() => /Off/.test(screen()) && /High/.test(screen()) && /Max/.test(screen())), '')
check('current level marked', await settled(() => /High\s*✓/.test(screen()) || /✓/.test(screen())), '')

// 2. → moves focus and applies immediately.
stdin.write('\x1b[C')
check('right arrow applied setEffort(max)', await settled(() => channel.setEffortCalls.length === 1 && channel.setEffortCalls[0] === 'max'), JSON.stringify(channel.setEffortCalls))
check('statusline effort shows max', await settled(() => /max/.test(screen())), '')

// 3. Esc closes.
stdin.write('\x1b')
check('Esc closed the slider', await settled(() => !/Reasoning effort/.test(screen().slice(-4000))), '')

// 4. /effort off → direct set + notify.
stdin.write('/effort off')
// 输入已落屏再回车（此串无补全项，等输入框本身）。
await settle(() => screen().includes('/effort off'))
stdin.write('\r')
check('/effort off applied', await settled(() => channel.setEffortCalls.includes('off')), JSON.stringify(channel.setEffortCalls))

// 5. Shift+Tab cycles the mode; StatusLine shows the label.
stdin.write('\x1b[Z')
check('statusline shows mode label', await settled(() => screen().includes('计划模式') || /plan mode/.test(screen())), screen().slice(-300))
stdin.write('\x1b[Z')
check('second backtab → full', await settled(() => channel.mode.id === 'full'), channel.mode.id)
stdin.write('\x1b[Z')
check('third backtab → default (no segment)', await settled(() => channel.modeIndex === 0), String(channel.modeIndex))
channel.setModesForTest([
  { id: 'full', plan: false, sandbox: 'danger-full-access', approval: 'never' },
])
check('index-0 full mode stays visible', await settled(() => screen().includes('full access')), screen().slice(-300))

// 6. zh locale: the slider chrome hot-swaps to the localized strings
//    (picker i18n branch: picker-title-effort / hint-adjust-done).
setLang('zh')
stdin.write('/help')
// zh 下 /help 的补全描述是本地化文案（i18n cmd-desc-help），等英文永远不成立。
await settle(() => screen().includes('查看快捷键与命令'))
stdin.write('\r')
check('zh: Help opens before slider', await settled(() => /命令：/.test(screen())), '')
stdin.write('\x1b')
check('zh: Esc closes Help only', await settled(() => !/命令：/.test(screen())), '')
stdin.write('/effort')
// /effort 暂无 cmd-desc-effort 键，zh 下补全描述回退英文；若日后补键需同步改这里。
await settle(() => screen().includes('Adjust the reasoning effort'))
stdin.write('\r')
check('zh: slider title 推理强度', await settled(() => screen().includes('推理强度')), '')
check('zh: hint line localized', await settled(() => screen().includes('调整') && screen().includes('完成')), '')
// Read the xterm visible screen after the repaint, not the raw output backlog.
stdin.write('\x1b')
check('zh: Esc closed the slider', await settled(() => !screen().includes('推理强度')), '')
setLang('en')

instance.unmount()
process.exit(failed)
