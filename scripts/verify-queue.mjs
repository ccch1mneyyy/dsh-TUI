/**
 * Headless verification of the two-stage Enter queue in PromptInput: while
 * the model is working, the first Enter stages the message (pending queue,
 * model untouched), and a second Enter on the empty input formally sends the
 * queue through channel.submit (DSH followup = next-turn inbox semantics).
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
  return {
    working,
    commandList: [],
    notifications: [],
    contextWindow: undefined,
    notify() {},
    submit(text) { submitted.push(text) },
    listFiles: async () => [],
    submitted,
  }
}

async function run() {
  // ---- Scenario 1: working — two-stage queue, flush in order.
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

    // Type "hello", press Enter while working.
    stdin.write('hello')
    await sleep(200)
    stdin.write('\r')
    await sleep(300)
    let last = toPlain(stdout.frames.at(-1) ?? '')
    check('first Enter stages (pending row appears)', last.includes('待发送'), JSON.stringify(last))
    check('first Enter does NOT submit', channel.submitted.length === 0)
    check('input cleared after staging', !/❯ hello/.test(last))

    // Type "world", press Enter again — second staged item.
    stdin.write('world')
    await sleep(200)
    stdin.write('\r')
    await sleep(300)
    const joined = toPlain(stdout.frames.join(''))
    // Differential frames: the count digit is rewritten in place, so "2 条"
    // never appears adjacent across frames — assert the stable full lines
    // (queue header from the first frame + the newly staged item row).
    check('second item staged', joined.includes('条待发送') && joined.includes('2. world'), JSON.stringify(joined.slice(-160)))
    check('still nothing submitted', channel.submitted.length === 0)

    // Empty input + Enter → formally send the queue, in order.
    stdin.write('\r')
    await sleep(300)
    last = toPlain(stdout.frames.at(-1) ?? '')
    check('second Enter sends the queue', channel.submitted.length === 2, JSON.stringify(channel.submitted))
    check('queue sent in order', channel.submitted[0] === 'hello' && channel.submitted[1] === 'world')
    check('queue cleared after flush', !last.includes('待发送'), JSON.stringify(last))
    instance.unmount()
  }

  // ---- Scenario 2: working — Esc abandons the input and sends the queue.
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
    stdin.write('hi')
    await sleep(200)
    stdin.write('\r')
    await sleep(300)
    let last = toPlain(stdout.frames.at(-1) ?? '')
    check('staged before Esc', last.includes('待发送'))

    // Type a second draft, then Esc: input is abandoned, queue is sent.
    stdin.write('draft2')
    await sleep(200)
    stdin.write('\x1b')
    await sleep(300)
    last = toPlain(stdout.frames.at(-1) ?? '')
    check('Esc sends the queue', channel.submitted.length === 1 && channel.submitted[0] === 'hi', JSON.stringify(channel.submitted))
    check('Esc abandoned the draft', !/❯ draft2/.test(last), JSON.stringify(last))
    check('queue cleared after Esc', !last.includes('待发送'), JSON.stringify(last))
    instance.unmount()
  }

  // ---- Scenario 3: working — ConPTY piped Enter (`\n`) uses queue too.
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
    // cmd batch -> node pipelines deliver Enter as a bare newline.
    stdin.write('piped')
    await sleep(200)
    stdin.write('\n')
    await sleep(300)
    let last = toPlain(stdout.frames.at(-1) ?? '')
    check('piped first Enter stages (not direct submit)', last.includes('待发送') && channel.submitted.length === 0, JSON.stringify(last))
    stdin.write('\n')
    await sleep(300)
    last = toPlain(stdout.frames.at(-1) ?? '')
    check('piped second Enter sends the queue', channel.submitted.length === 1 && channel.submitted[0] === 'piped')
    check('queue cleared after piped flush', !last.includes('待发送'), JSON.stringify(last))
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
    const last = toPlain(stdout.frames.at(-1) ?? '')
    check('idle Enter submits directly', channel.submitted.length === 1 && channel.submitted[0] === 'direct')
    check('no pending row while idle', !last.includes('待发送'), JSON.stringify(last))
    instance.unmount()
  }

  process.exit(failed)
}

run()
