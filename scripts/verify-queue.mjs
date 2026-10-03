/**
 * Headless verification of prompt send semantics: while the model streams,
 * Enter steers, Tab queues a followup, and Ctrl+Enter interrupts; a complete
 * piped line keeps the legacy direct-submit path. A `\r`+`\n` double event
 * must not send twice, and Esc either delivers pending input or clears the
 * draft according to the current state.
 *
 * Run with plain node against the compiled lib: `node scripts/verify-queue.mjs`
 * (assertions check Chinese notices; DSH_TUI_LANG is pinned to zh here).
 */
import './lib/default-lang-zh.mjs'
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import { render } from '../lib/types/ui.js'
import { PromptInput } from '../lib/types/components/PromptInput.js'

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

function makeChannel(working, options = {}) {
  const submitted = []
  const steered = []
  const notified = []
  const cancelled = []
  let pending = []
  let seq = 0
  return {
    working,
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    cycleMode() {},
    commandList: options.commands ?? [],
    commandCompletions() { return options.completions ?? [] },
    notifications: [],
    contextWindow: undefined,
    get pending() { return pending },
    notify(text, options) { notified.push({ text, options }) },
    submit(text) { submitted.push(text); pending = [...pending, { id: `f${++seq}`, text, placement: 'followup' }] },
    steer(text) { steered.push(text); pending = [...pending, { id: `s${++seq}`, text, placement: 'steer' }] },
    removePending(id) { pending = pending.filter(item => item.id !== id); return true },
    cancel() { cancelled.push('cancel') },
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

  // ---- Scenario 6: Esc with pending messages while working = interrupt+deliver.
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
    stdin.write('\x1b') // Esc: interrupt + deliver pending
    await sleep(300)
    check('Esc interrupts with pending messages', channel.cancelled.length === 1, JSON.stringify(channel.cancelled))
    check('Esc interrupt notice shown', channel.notified.some(n => n.text.includes('已打断当前回合')), JSON.stringify(channel.notified))
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
    await sleep(600)
    stdin.write(text)
    await sleep(250)
    stdin.write('\r')
    await sleep(300)
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
