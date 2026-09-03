/**
 * Headless verification of the Shift+Tab session-mode wiring: renders the
 * compiled PromptInput with a stub channel and injects `\x1b[Z` (backtab —
 * the escape sequence a real terminal sends for Shift+Tab), asserting that
 * exactly one `channel.cycleMode()` fires and no send path does.
 *
 * Run with plain node against the compiled lib:
 *   node scripts/verify-shift-tab-mode.mjs
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

function makeChannel() {
  const cycled = []
  const submitted = []
  const steered = []
  return {
    working: false,
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    cycleMode() { cycled.push(Date.now()) },
    commandList: [],
    notifications: [],
    contextWindow: undefined,
    pending: [],
    notify() {},
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

const { stdout, stderr, stdin } = makeStreams()
const channel = makeChannel()
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
// Backtab with text in the editor: mode cycling must win over the plain-Tab
// completion arm (the parser reports backtab as key.tab + key.shift).
stdin.write('hello')
await sleep(150)
stdin.write('\x1b[Z')
await sleep(300)
check('backtab cycles the session mode once', channel.cycled.length === 1, JSON.stringify(channel.cycled.length))
check('backtab does not submit or steer', channel.submitted.length === 0 && channel.steered.length === 0, JSON.stringify([channel.submitted, channel.steered]))

// A second backtab cycles again; Tab alone still completes (no steer).
stdin.write('\x1b[Z')
await sleep(300)
check('second backtab cycles again', channel.cycled.length === 2, JSON.stringify(channel.cycled.length))
stdin.write('\t')
await sleep(300)
check('plain Tab does not cycle the mode', channel.cycled.length === 2, JSON.stringify(channel.cycled.length))

// Fullscreen draft editor: Ctrl+Shift+E opens the cover, but Shift+Tab must
// still reach the mode cycle instead of being swallowed as indentation.
stdin.write('\x1b[69;6u')
await sleep(250)
stdin.write('\x1b[Z')
await sleep(300)
check('fullscreen backtab cycles the session mode', channel.cycled.length === 3, JSON.stringify(channel.cycled.length))
instance.unmount()

process.exit(failed)
