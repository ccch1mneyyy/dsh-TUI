/**
 * Headless verification of the prompt-input send semantics: Enter submits
 * IMMEDIATELY — even while the model is streaming (channel.submit is DSH
 * followup / next-turn inbox: processed after the current turn, never
 * interrupting). No staging queue; a `\r`+`\n` double event must not send
 * twice; Esc only clears the input.
 *
 * Run with plain node against the compiled lib: `node scripts/verify-queue.mjs`
 */
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

function makeChannel(working) {
  const submitted = []
  const steered = []
  const notified = []
  const cancelled = []
  let pending = []
  let seq = 0
  return {
    working,
    commandList: [],
    notifications: [],
    contextWindow: undefined,
    get pending() { return pending },
    notify(text, options) { notified.push({ text, options }) },
    submit(text) { submitted.push(text); pending = [...pending, { id: `f${++seq}`, text, placement: 'followup' }] },
    steer(text) { steered.push(text); pending = [...pending, { id: `s${++seq}`, text, placement: 'steer' }] },
    removePending(id) { pending = pending.filter(item => item.id !== id); return true },
    cancel() { cancelled.push('cancel') },
    interruptAndDeliver(texts) {
      cancelled.push('interruptAndDeliver')
      pending = []
      const trimmed = texts.map(text => text.trim()).filter(text => text !== '')
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

  // ---- Scenario 4: piped Enter (`\n` alone) steers while working.
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
    check('piped Enter steers while working', channel.steered.length === 1 && channel.steered[0] === 'piped')
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

  process.exit(failed)
}

run()
