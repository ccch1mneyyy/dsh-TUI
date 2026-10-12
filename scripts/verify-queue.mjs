/**
 * Headless verification of prompt send semantics: while the model streams,
 * Enter steers, Tab queues a followup, and Ctrl+Enter interrupts; a complete
 * piped line keeps the legacy direct-submit path. A `\r`+`\n` double event
 * must not send twice, and Esc with a queued message while working DOCKS the
 * queue (Claude Code parity: no auto-send; ⬆ selects a row to edit, ⏎ on an
 * empty draft sends the dock) or clears the draft according to the state.
 *
 * Run with plain node against the compiled lib: `node scripts/verify-queue.mjs`
 * (assertions check Chinese notices; DSH_TUI_LANG is pinned to zh here).
 */
import './lib/default-lang-zh.mjs'
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import { render } from '../lib/types/ui.js'
import { PromptInput } from '../lib/types/components/PromptInput.js'
import { settle } from './lib/term-test.mjs'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const toPlain = s =>
  s
    .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
    .replace(/\x1b\[[0-9;?>:]*[a-zA-Z]/g, '')
    .replace(/\x1b\]9;[^\x07]*\x07/g, '')

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

const sleep = ms => new Promise(r => setTimeout(r, ms))

// `initialPending` seeds the docked queue (the ⏎-sends-the-dock scenarios);
// `commands` / `completions` drive the `/` overlay and the command-hold cases.
function makeChannel(working, options = {}) {
  const { initialPending = [], commands = [], completions = [] } = options
  const submitted = []
  const steered = []
  const notified = []
  const cancelled = []
  const removed = []
  let pending = [...initialPending]
  let seq = 0
  return {
    working,
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    cycleMode() {},
    commandList: commands,
    commandCompletions() { return completions },
    notifications: [],
    contextWindow: undefined,
    get pending() { return pending },
    notify(text, options) { notified.push({ text, options }) },
    submit(text) { submitted.push(text); pending = [...pending, { id: `f${++seq}`, text, placement: 'followup' }] },
    steer(text) { steered.push(text); pending = [...pending, { id: `s${++seq}`, text, placement: 'steer' }] },
    removePending(id) { removed.push(id); pending = pending.filter(item => item.id !== id); return true },
    cancel() { cancelled.push('cancel') },
    interruptAndDock() {
      cancelled.push('interruptAndDock')
      let count = 0
      pending = pending.map(item => item.docked === true ? item : (count += 1, { ...item, docked: true }))
      return count
    },
    deliverDocked() {
      cancelled.push('deliverDocked')
      const docked = pending.filter(item => item.docked === true)
      pending = pending.filter(item => item.docked !== true)
      submitted.push(...docked.map(item => item.text))
      return docked.length
    },
    interruptAndDeliver(inputs) {
      cancelled.push('interruptAndDeliver')
      pending = []
      const trimmed = inputs
        .map(input => typeof input === 'string' ? input : input.text)
        .map(text => text.trim())
        .filter(text => text !== '')
      submitted.push(...trimmed)
      pending = trimmed.map(text => ({ id: `i${++seq}`, text, placement: 'followup' }))
      return trimmed.length
    },
    listFiles: async () => [],
    submitted,
    steered,
    notified,
    cancelled,
    removed,
  }
}

async function run() {
  // ---- Scenario 1: working — Enter STEERS into the running turn.
  {
    const { stdout, stderr, stdin } = makeStreams()
    const channel = makeChannel(true)
    const instance = await render(
      React.createElement(PromptInput, {
        channel,
        helpOpen: false,
        onToggleHelp() {},
        onRunCommand: () => false,
        selectionActive: false,
      }),
      { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
    )
    await sleep(600)
    stdin.write('hello')
    await sleep(200)
    stdin.write('\r')
    await sleep(300)
    let last = toPlain(stdout.frames.at(-1) ?? '')
    check('working Enter steers', channel.steered.length === 1 && channel.steered[0] === 'hello', JSON.stringify(channel.steered))
    check('working Enter does NOT followup-queue', channel.submitted.length === 0)
    check('input cleared after steer', !/❯ hello/.test(last))
    check('steer notice shown', channel.notified.some(n => n.text.includes('已插话')), JSON.stringify(channel.notified))
    instance.unmount()
  }

  // ---- Scenario 2: working — Tab queues for after the turn (followup).
  {
    const { stdout, stderr, stdin } = makeStreams()
    const channel = makeChannel(true)
    const instance = await render(
      React.createElement(PromptInput, {
        channel,
        helpOpen: false,
        onToggleHelp() {},
        onRunCommand: () => false,
        selectionActive: false,
      }),
      { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
    )
    await sleep(600)
    stdin.write('later')
    await sleep(200)
    stdin.write('\t')
    await sleep(300)
    let last = toPlain(stdout.frames.at(-1) ?? '')
    check('working Tab queues (followup)', channel.submitted.length === 1 && channel.submitted[0] === 'later')
    check('working Tab does NOT steer', channel.steered.length === 0)
    check('Tab queue notice shown', channel.notified.some(n => n.text.includes('已排队')), JSON.stringify(channel.notified))
    check('input cleared after Tab queue', !/❯ later/.test(last))
    instance.unmount()
  }

  // ---- Scenario 3: working — CRLF `\r`+`\n` Enter steers exactly once.
  {
    const { stdout, stderr, stdin } = makeStreams()
    const channel = makeChannel(true)
    const instance = await render(
      React.createElement(PromptInput, {
        channel,
        helpOpen: false,
        onToggleHelp() {},
        onRunCommand: () => false,
        selectionActive: false,
      }),
      { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
    )
    await sleep(600)
    stdin.write('dup')
    await sleep(150)
    stdin.write('\r')
    await sleep(50)
    stdin.write('\n')
    await sleep(300)
    check('CRLF Enter steers exactly once', channel.steered.length === 1 && channel.steered[0] === 'dup', JSON.stringify(channel.steered))
    instance.unmount()
  }

  // ---- Scenario 4: a piped line arrives as one `text + \n` batch and keeps
  // the legacy direct-submit path. A standalone LF after separately typed
  // text is Ctrl+J in the terminal protocol and inserts a newline.
  {
    const { stdout, stderr, stdin } = makeStreams()
    const channel = makeChannel(true)
    const instance = await render(
      React.createElement(PromptInput, {
        channel,
        helpOpen: false,
        onToggleHelp() {},
        onRunCommand: () => false,
        selectionActive: false,
      }),
      { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
    )
    await sleep(600)
    stdin.write('piped\n')
    await sleep(300)
    check(
      'piped line keeps the legacy direct-submit path while working',
      channel.submitted.length === 1 && channel.submitted[0] === 'piped' && channel.steered.length === 0,
      JSON.stringify({ steered: channel.steered, submitted: channel.submitted }),
    )
    instance.unmount()
  }

  // ---- Scenario 4b: text typed first, then a bare LF on its own while
  // working. The LF is Ctrl+J (newline insert), not Enter: nothing steers,
  // nothing submits, the draft keeps the text.
  {
    const { stdout, stderr, stdin } = makeStreams()
    const channel = makeChannel(true)
    const instance = await render(
      React.createElement(PromptInput, {
        channel,
        helpOpen: false,
        onToggleHelp() {},
        onRunCommand: () => false,
        selectionActive: false,
      }),
      { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
    )
    await sleep(600)
    stdin.write('piped')
    await sleep(200)
    stdin.write('\n')
    await sleep(300)
    check(
      'a bare LF after separately typed text inserts a newline while working (no steer, no submit)',
      channel.steered.length === 0 && channel.submitted.length === 0,
      JSON.stringify({ steered: channel.steered, submitted: channel.submitted }),
    )
    stdin.write('next')
    await sleep(100)
    stdin.write('\r')
    await sleep(300)
    check(
      'Enter after Ctrl+J delivers both draft lines with the inserted newline',
      channel.steered.length === 1 && channel.steered[0] === 'piped\nnext' && channel.submitted.length === 0,
      JSON.stringify({ steered: channel.steered, submitted: channel.submitted }),
    )
    instance.unmount()
  }

  // ---- Scenario 5: idle — Enter submits directly (unchanged behavior).
  {
    const { stdout, stderr, stdin } = makeStreams()
    const channel = makeChannel(false)
    const instance = await render(
      React.createElement(PromptInput, {
        channel,
        helpOpen: false,
        onToggleHelp() {},
        onRunCommand: () => false,
        selectionActive: false,
      }),
      { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
    )
    await sleep(600)
    stdin.write('direct')
    await sleep(200)
    stdin.write('\r')
    await sleep(300)
    const joined = toPlain(stdout.frames.join(''))
    check('idle Enter submits directly', channel.submitted.length === 1 && channel.submitted[0] === 'direct')
    check('no send notice while idle', !joined.includes('已发送'), JSON.stringify(joined.slice(-80)))
    instance.unmount()
  }

  // ---- Scenario 6: Esc with pending messages while working = DOCK the
  // queue (Claude Code parity): interrupt without auto-sending — the queued
  // message is NOT re-delivered, the dock hint replaces the delivery toast.
  {
    const { stdout, stderr, stdin } = makeStreams()
    const channel = makeChannel(true)
    const instance = await render(
      React.createElement(PromptInput, {
        channel,
        helpOpen: false,
        onToggleHelp() {},
        onRunCommand: () => false,
        selectionActive: false,
      }),
      { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
    )
    await sleep(600)
    stdin.write('fixit')
    await sleep(200)
    stdin.write('\r') // steer → pending = [fixit]
    await sleep(300)
    stdin.write('\x1b') // Esc: interrupt + DOCK pending
    await sleep(300)
    check('Esc docks the queued message (interrupt path)', channel.cancelled.length === 1 && channel.cancelled[0] === 'interruptAndDock', JSON.stringify(channel.cancelled))
    check('Esc dock does NOT auto-send the queue', channel.submitted.length === 0, JSON.stringify(channel.submitted))
    instance.unmount()
  }

  // ---- Scenario 6b: idle with a docked queue — the dock section and the
  // official-parity hint render; ⏎ on an EMPTY draft sends the dock once.
  {
    const { stdout, stderr, stdin } = makeStreams()
    const channel = makeChannel(false, { initialPending: [
      { id: 'd1', text: '停靠甲', placement: 'followup', docked: true },
      { id: 'd2', text: '停靠乙', placement: 'followup', docked: true },
    ] })
    const instance = await render(
      React.createElement(PromptInput, {
        channel,
        helpOpen: false,
        onToggleHelp() {},
        onRunCommand: () => false,
        selectionActive: false,
      }),
      { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
    )
    await sleep(600)
    // The pending-preview block lives in OverlayAbove (negative rows in this
    // headless fixture — it never paints), so the dock is asserted through
    // behavior: an empty ⏎ must send exactly the docked rows, in FIFO.
    stdin.write('\r') // empty draft + dock → send all
    await sleep(300)
    check('empty ⏎ sends the dock exactly once in FIFO', channel.cancelled.includes('deliverDocked') && JSON.stringify(channel.submitted) === '["停靠甲","停靠乙"]', JSON.stringify({ cancelled: channel.cancelled, submitted: channel.submitted }))
    check('dock-sent notice shown', channel.notified.some(n => n.text.includes('暂存消息')), JSON.stringify(channel.notified))
    instance.unmount()
  }

  // ---- Scenario 6c: a draft in progress keeps the ordinary submit — ⏎ does
  // NOT bundle the parked dock with the typed draft (that silent mass-send
  // is exactly what the dock exists to prevent).
  {
    const { stdout, stderr, stdin } = makeStreams()
    const channel = makeChannel(false, { initialPending: [
      { id: 'd1', text: '停靠丙', placement: 'followup', docked: true },
    ] })
    const instance = await render(
      React.createElement(PromptInput, {
        channel,
        helpOpen: false,
        onToggleHelp() {},
        onRunCommand: () => false,
        selectionActive: false,
      }),
      { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
    )
    await sleep(600)
    stdin.write('新话')
    await sleep(200)
    stdin.write('\r')
    await sleep(300)
    check('draft ⏎ submits the draft only; the dock stays parked', channel.submitted.length === 1 && channel.submitted[0] === '新话' && !channel.cancelled.includes('deliverDocked'), JSON.stringify({ submitted: channel.submitted, cancelled: channel.cancelled }))
    instance.unmount()
  }

  // ---- Scenario 6d: ↑ on an empty draft enters the dock selector (last row
  // first, Claude Code parity); ⏎ retracts the selected row into the draft.
  {
    const { stdout, stderr, stdin } = makeStreams()
    const channel = makeChannel(false, { initialPending: [
      { id: 'd1', text: '停靠丁', placement: 'followup', docked: true },
      { id: 'd2', text: '停靠戊', placement: 'followup', docked: true },
    ] })
    const instance = await render(
      React.createElement(PromptInput, {
        channel,
        helpOpen: false,
        onToggleHelp() {},
        onRunCommand: () => false,
        selectionActive: false,
      }),
      { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
    )
    await sleep(600)
    stdin.write('\x1b[A') // ↑ enters the selector on the newest row
    await sleep(300)
    stdin.write('\r') // ⏎ edits the selected row
    await sleep(300)
    check('↑+⏎ retracts the selected docked row into the draft', channel.removed.includes('d2') && !channel.removed.includes('d1'), JSON.stringify(channel.removed))
    const last = toPlain(stdout.frames.at(-1) ?? '')
    check('retracted text lands in the input', /停靠戊/.test(last), last.slice(-80))
    instance.unmount()
  }

  // ---- Scenario 6e: Esc leaves the selector without touching the dock —
  // the next empty ⏎ still sends it (the selector did not eat the key).
  {
    const { stdout, stderr, stdin } = makeStreams()
    const channel = makeChannel(false, { initialPending: [
      { id: 'd1', text: '停靠己', placement: 'followup', docked: true },
    ] })
    const instance = await render(
      React.createElement(PromptInput, {
        channel,
        helpOpen: false,
        onToggleHelp() {},
        onRunCommand: () => false,
        selectionActive: false,
      }),
      { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
    )
    await sleep(600)
    stdin.write('\x1b[A') // selector on
    await sleep(300)
    stdin.write('\x1b') // selector off (dock untouched)
    await sleep(300)
    stdin.write('\r') // empty draft + dock → send
    await sleep(300)
    check('Esc exits the selector; the dock remains sendable', channel.cancelled.includes('deliverDocked') && channel.removed.length === 0, JSON.stringify({ cancelled: channel.cancelled, removed: channel.removed }))
    instance.unmount()
  }

  // ---- Scenario 7: Esc with no pending and input empty → rewind path (no cancel).
  {
    const { stdout, stderr, stdin } = makeStreams()
    const channel = makeChannel(true)
    const instance = await render(
      React.createElement(PromptInput, {
        channel,
        helpOpen: false,
        onToggleHelp() {},
        onRunCommand: () => false,
        selectionActive: false,
      }),
      { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
    )
    await sleep(600)
    stdin.write('draft')
    await sleep(200)
    stdin.write('\x1b')
    await sleep(300)
    const last = toPlain(stdout.frames.at(-1) ?? '')
    check('Esc clears the draft', !/❯ draft/.test(last), JSON.stringify(last))
    check('Esc does not send without pending', channel.submitted.length === 0 && channel.steered.length === 0)
    instance.unmount()
  }

  // ---- Scenario 8: Ctrl+Enter aborts the turn and sends immediately.
  {
    const { stdout, stderr, stdin } = makeStreams()
    const channel = makeChannel(true)
    const instance = await render(
      React.createElement(PromptInput, {
        channel,
        helpOpen: false,
        onToggleHelp() {},
        onRunCommand: () => false,
        selectionActive: false,
      }),
      { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
    )
    await sleep(600)
    stdin.write('urgent')
    await sleep(200)
    // Windows Terminal Ctrl+Enter → CSI 13;5u (kitty protocol).
    stdin.write('\x1b[13;5u')
    await sleep(300)
    const last = toPlain(stdout.frames.at(-1) ?? '')
    check('Ctrl+Enter cancels the running turn', channel.cancelled.length === 1)
    check('Ctrl+Enter sends immediately', channel.submitted.length === 1 && channel.submitted[0] === 'urgent')
    check('Ctrl+Enter input cleared', !/❯ urgent/.test(last))
    check('interrupt notice shown', channel.notified.some(n => n.text.includes('已打断当前回合')), JSON.stringify(channel.notified))
    instance.unmount()
  }

  // ---- Scenarios 9+: issue #1072 — while a turn is running a KNOWN command
  // is still a COMMAND (with or without arguments, overlay open or closed,
  // inline or fullscreen); only input that is not a command steers into the
  // running turn. The command's own gate decides whether it may run mid-turn.
  const COMMANDS = [
    { name: 'model', description: 'Show the active model' },
    { name: 'btw', description: 'Side question' },
    { name: 'skills', description: 'List skills' },
    { name: 'new', description: 'Start a new conversation' },
    { name: 'audit', description: 'Registered skill', external: true, skill: true },
    { name: 'notes', description: 'Completion-only filesystem skill', skill: true },
  ]
  // 等待每一步自己产生的那一帧，而不是固定窗（#791）：挂载一帧、回显键入
  // 的那一帧、Enter 提交的那一帧。回显帧同时证明输入钩子已经接上，所以
  // Enter 绝不会写进一个还没安装监听器的组件里。
  const typeAndEnter = async (channel, text, onRunCommand) => {
    const { stdout, stderr, stdin } = makeStreams()
    const instance = await render(
      React.createElement(PromptInput, {
        channel,
        helpOpen: false,
        onToggleHelp() {},
        onRunCommand,
        selectionActive: false,
      }),
      { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
    )
    await settle(() => stdout.frames.length > 0)
    const typedFrom = stdout.frames.length
    stdin.write(text)
    await settle(() => stdout.frames.length > typedFrom)
    const enteredFrom = stdout.frames.length
    stdin.write('\r')
    await settle(() => stdout.frames.length > enteredFrom)
    instance.unmount()
  }
  const dispatchRun = runs => (name, rawInput) => { runs.push([name, rawInput]); return true }

  // `/model <arg>`: the overlay is closed for an argument the completer does
  // not know, which is exactly where Enter used to steer the whole line.
  {
    const runs = []
    const channel = makeChannel(true, { commands: COMMANDS })
    await typeAndEnter(channel, '/model deepseek-chat', dispatchRun(runs))
    check(
      'working: /model <arg> dispatches the command instead of steering',
      runs.length === 1 && runs[0][0] === 'model' && runs[0][1] === ' deepseek-chat' && channel.steered.length === 0,
      JSON.stringify({ runs, steered: channel.steered }),
    )
  }
  // Trailing-space form with the completion overlay OPEN: Enter still accepts
  // the selected row (unchanged precedence), never steers `/model`.
  {
    const runs = []
    const channel = makeChannel(true, {
      commands: COMMANDS,
      completions: [{ name: 'deepseek-chat', commandLine: '/model deepseek-chat', replacement: '/model deepseek-chat ', description: 'Chat model' }],
    })
    await typeAndEnter(channel, '/model ', dispatchRun(runs))
    check(
      'working: /model with a trailing space dispatches the selected completion',
      runs.length === 1 && runs[0][0] === 'model' && runs[0][1] === ' deepseek-chat' && channel.steered.length === 0,
      JSON.stringify({ runs, steered: channel.steered }),
    )
  }
  // A gated command still reaches the command channel: the channel's own gate
  // answers (issue #1072 keeps the gate, it only stops the steer).
  {
    const runs = []
    const channel = makeChannel(true, { commands: COMMANDS })
    await typeAndEnter(channel, '/new ', dispatchRun(runs))
    check(
      'working: a gated command (/new) is dispatched, not steered',
      runs.length === 1 && runs[0][0] === 'new' && channel.steered.length === 0,
      JSON.stringify({ runs, steered: channel.steered }),
    )
  }
  // A registry-registered skill (`external && skill`) takes the registry
  // gesture path; its placement (steer vs followup) is the channel's call.
  {
    const runs = []
    const channel = makeChannel(true, { commands: COMMANDS })
    await typeAndEnter(channel, '/audit ', (name, rawInput) => { runs.push([name, rawInput]); return Promise.resolve(true) })
    check(
      'working: a registry skill (/audit) goes to the registry gesture, not a steer',
      runs.length === 1 && runs[0][0] === 'audit' && channel.steered.length === 0,
      JSON.stringify({ runs, steered: channel.steered }),
    )
  }
  // Immediate commands stay immediate (the old whitelist behavior, now general).
  for (const name of ['btw', 'skills']) {
    const runs = []
    const channel = makeChannel(true, { commands: COMMANDS })
    await typeAndEnter(channel, `/${name}`, dispatchRun(runs))
    check(
      `working: /${name} still executes immediately`,
      runs.length === 1 && runs[0][0] === name && channel.steered.length === 0,
      JSON.stringify({ runs, steered: channel.steered }),
    )
  }
  // Completion-only skills fall through to the model (Chat's runCommand
  // returns false for a non-external skill entry): the line still steers.
  {
    const runs = []
    const channel = makeChannel(true, { commands: COMMANDS })
    await typeAndEnter(channel, '/notes do it', (name, rawInput) => { runs.push([name, rawInput]); return false })
    check(
      'working: a completion-only skill (/notes) still steers into the turn',
      runs.length === 1 && channel.steered.length === 1 && channel.steered[0] === '/notes do it',
      JSON.stringify({ runs, steered: channel.steered }),
    )
  }
  // Not-a-command input keeps steering.
  for (const text of ['hello there', '/usr/bin/env node x', '/modelx keep going']) {
    const channel = makeChannel(true, { commands: COMMANDS })
    await typeAndEnter(channel, text, () => { throw new Error('non-command input must not dispatch') })
    check(
      `working: ${JSON.stringify(text)} steers (not a command)`,
      channel.steered.length === 1 && channel.steered[0] === text,
      JSON.stringify({ steered: channel.steered }),
    )
  }

  process.exit(failed)
}

run()
