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
  const notified = []
  return {
    working,
    commandList: [],
    notifications: [],
    contextWindow: undefined,
    notify(text, options) { notified.push({ text, options }) },
    submit(text) { submitted.push(text) },
    listFiles: async () => [],
    submitted,
    notified,
  }
}

async function run() {
  // ---- Scenario 1: working — Enter submits immediately, no queue.
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
    const joined = toPlain(stdout.frames.join(''))
    check('working Enter submits immediately', channel.submitted.length === 1 && channel.submitted[0] === 'hello')
    check('no pending queue row', !joined.includes('待发送'), JSON.stringify(joined.slice(-80)))
    check('input cleared after send', !/❯ hello/.test(last))
    check('send notice while working', channel.notified.some(n => n.text.includes('已发送')), JSON.stringify(channel.notified))
    instance.unmount()
  }

  // ---- Scenario 2: working — CRLF `\r`+`\n` Enter sends exactly once.
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
    check('CRLF Enter sends exactly once', channel.submitted.length === 1 && channel.submitted[0] === 'dup', JSON.stringify(channel.submitted))
    instance.unmount()
  }

  // ---- Scenario 3: piped Enter (`\n` alone) submits while working.
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
    check('piped Enter submits while working', channel.submitted.length === 1 && channel.submitted[0] === 'piped')
    instance.unmount()
  }

  // ---- Scenario 4: idle — Enter submits directly (unchanged behavior).
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

  // ---- Scenario 5: Esc clears the input, never sends.
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
    check('Esc does not send', channel.submitted.length === 0)
    instance.unmount()
  }

  process.exit(failed)
}

run()
