#!/usr/bin/env node
/**
 * Regression: multiple key events delivered in one stdin read must compose
 * against the state produced by the preceding event in that same batch.
 *
 * A busy terminal can coalesce `a`, Left, and `b` into one chunk. The parser
 * intentionally emits three events inside one React discrete update;
 * PromptInput must therefore preserve `a`, move before it, and insert `b`
 * rather than letting stale render closures drop characters.
 *
 * Run after build: `node scripts/verify-batched-prompt-input.mjs`.
 */
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import { render } from '../lib/types/ui.js'
import { PromptInput } from '../lib/types/components/PromptInput.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

function makeStreams() {
  const stdout = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  stdout.columns = 100
  stdout.rows = 30
  stdout.isTTY = true
  const stderr = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  return { stdout, stderr, stdin }
}

const submitted = []
const steered = []
const channel = {
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  cycleMode() {},
  commandList: [],
  commandCompletions: () => [],
  notifications: [],
  pending: [],
  working: false,
  notify() {},
  submit(text) { submitted.push(text) },
  steer(text) { steered.push(text) },
  interruptAndDeliver() { return 0 },
  removePending() { return false },
  stageImage() {},
  listFiles: async () => [],
}

const { stdout, stderr, stdin } = makeStreams()
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

await new Promise(resolve => setTimeout(resolve, 500))
stdin.write('a\x1b[Db')
await new Promise(resolve => setTimeout(resolve, 200))
stdin.write('\r')
await new Promise(resolve => setTimeout(resolve, 300))

check(
  'batched text, cursor movement, text, and Enter submit the composed value',
  submitted.length === 1 && submitted[0] === 'ba',
  JSON.stringify(submitted),
)

// Termy 1.4.1 batches win32-input-mode records before writing to its PTY.
// Two IME commits in one read must compose instead of both reading the empty
// render closure and leaving only the final character (issue #215).
stdin.write('\x1b[65;30;20320;1;0;1_\x1b[65;30;22909;1;0;1_')
await new Promise(resolve => setTimeout(resolve, 200))
stdin.write('\r')
await new Promise(resolve => setTimeout(resolve, 300))

check(
  'batched Termy win32 IME records preserve every committed character',
  submitted.length === 2 && submitted[1] === '你好',
  JSON.stringify(submitted),
)

// Native Windows terminals encode printable keys as individual win32-input-
// mode records. Under streaming output, one stdin read can contain several
// records; each edit must compose before Enter steers the text (issue #219).
channel.working = true
stdin.write('\x1b[78;49;110;1;0;1_\x1b[80;25;112;1;0;1_\x1b[77;50;109;1;0;1_')
await new Promise(resolve => setTimeout(resolve, 200))
stdin.write('\r')
await new Promise(resolve => setTimeout(resolve, 300))

check(
  'batched Windows input while streaming preserves npm before steer',
  steered.length === 1 && steered[0] === 'npm',
  JSON.stringify(steered),
)

instance.unmount()

if (failed > 0) {
  console.error(`verify-batched-prompt-input: ${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('verify-batched-prompt-input OK')
