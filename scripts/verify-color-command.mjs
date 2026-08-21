/**
 * /color command regression — headless Chat-level smoke test.
 *
 * Renders the real Chat screen with a channel-shaped stub, drives /color
 * commands through stdin, and asserts on notifications and pushLocal output.
 * No persistence — color resets to default on restart.
 *
 * Run against the compiled lib:
 *   node scripts/verify-color-command.mjs
 *
 * Or against the TypeScript source:
 *   node --import tsx/esm scripts/verify-color-command.mjs
 */

import { Writable, PassThrough } from 'node:stream'
import React from 'react'

const { render } = await import('../lib/types/ui.js')
const { Chat } = await import('../lib/types/screens/Chat.js')
const { setLang } = await import('../lib/types/i18n.js')

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
process.exitCode = 0

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── streams ───────────────────────────────────────────────────────────────
function makeStreams() {
  const stdout = new Writable({
    write(chunk, _enc, cb) { stdout.frames.push(String(chunk)); cb() },
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

// ── channel stub ──────────────────────────────────────────────────────────
function makeChannel() {
  const notifications = []
  const pushedLocal = []
  const rows = []
  const listeners = new Set()
  const channel = {
    version: 0,
    rows,
    status: 'idle',
    sessionTitle: 'color-test',
    agentId: 'test',
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
    statusBar: { mode: true },
    agentPreset: 'standard',
    goal: undefined,
    todos: [],
    commandList: [
      { name: 'color', description: 'Set prompt border color' },
      { name: 'theme', description: 'Switch the color theme (auto, built-in or custom)' },
      { name: 'lang', description: 'Switch the UI language (en / zh)' },
    ],
    commandCompletions(input) {
      const prefix = input.replace(/^\//u, '').trim().toLowerCase()
      return this.commandList
        .filter((command) => command.name.startsWith(prefix))
        .map((command) => ({ ...command, commandLine: `/${command.name}`, replacement: `/${command.name} ` }))
    },
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    modeIndex: 0,
    async cycleMode() {},
    async listEfforts() { return { efforts: [], defaultEffort: 'high' } },
    async setEffort() { return true },
    notify(text, options) { notifications.push({ text, options }) },
    pushLocal(title, lines) {
      pushedLocal.push({ title, lines })
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
    notifications,
    pushedLocal,
  }
  return channel
}

// ── helper: write a /color command and press Enter ────────────────────────
async function runCommand(stdin, cmd, waitMs = 300) {
  stdin.write(cmd)
  await sleep(150)
  stdin.write('\r')
  await sleep(waitMs)
}

// ═══════════════════════════════════════════════════════════════════════════
// Part A: /color command through real Chat (no persistence)
// ═══════════════════════════════════════════════════════════════════════════
{
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
  await sleep(500)
  setLang('en')

  // A1: /color green → switch notification
  channel.notifications.length = 0
  await runCommand(stdin, '/color green')
  check('/color green: notification sent',
    channel.notifications.some(n => n.text.includes('green') && n.options?.color === 'success'),
    JSON.stringify(channel.notifications.map(n => n.text)))

  // A2: /color (bare) → shows current color
  channel.pushedLocal.length = 0
  await runCommand(stdin, '/color')
  check('/color bare: shows current color',
    channel.pushedLocal.some(p => p.lines.some(l => l.includes('green'))),
    JSON.stringify(channel.pushedLocal))

  // A3: /color red → switch notification
  channel.notifications.length = 0
  await runCommand(stdin, '/color red')
  check('/color red: notification sent',
    channel.notifications.some(n => n.text.includes('red') && n.options?.color === 'success'))

  // A4: /color (bare) → shows updated color
  channel.pushedLocal.length = 0
  await runCommand(stdin, '/color')
  check('/color bare: shows updated color',
    channel.pushedLocal.some(p => p.lines.some(l => l.includes('red'))))

  // A5: /color default → reset notification
  channel.notifications.length = 0
  await runCommand(stdin, '/color default')
  check('/color default: notification sent',
    channel.notifications.some(n => n.text.includes('default') && n.options?.color === 'success'))

  // A6: /color (bare) → shows default after reset
  channel.pushedLocal.length = 0
  await runCommand(stdin, '/color')
  check('/color bare: shows default after reset',
    channel.pushedLocal.some(p => p.lines.some(l => l.includes('default'))))

  // A7: /color foobar → unknown color warning
  channel.notifications.length = 0
  await runCommand(stdin, '/color foobar')
  check('/color foobar: unknown color warning',
    channel.notifications.some(n => n.options?.color === 'warning' && n.text.includes('foobar')))

  // A8: all 8 valid colors accepted
  const COLORS = ['blue', 'green', 'red', 'yellow', 'purple', 'orange', 'pink', 'cyan']
  let allAccepted = true
  for (const color of COLORS) {
    channel.notifications.length = 0
    await runCommand(stdin, `/color ${color}`)
    if (!channel.notifications.some(n => n.text.includes(color) && n.options?.color === 'success')) {
      allAccepted = false
      check(`/color ${color}: accepted`, false, JSON.stringify(channel.notifications.map(n => n.text)))
    }
  }
  check('all 8 colors accepted', allAccepted)

  instance.unmount()
}

process.exit(failed || process.exitCode)
