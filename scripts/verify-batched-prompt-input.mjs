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

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return predicate()
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
const commands = []
const channel = {
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  cycleMode() {},
  commandList: [{ name: 'provider', description: 'provider wizard' }],
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
    onRunCommand: (name, rawInput) => {
      commands.push({ name, rawInput })
      return true
    },
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

// Terminals that cannot report modified Enter keys still expose Ctrl+J as a
// bare LF, while the physical Enter key arrives as CR. Ctrl+J must therefore
// remain a usable multiline fallback instead of submitting the first line.
channel.working = false
const multilineCases = [
  ['Ctrl+J', '\n', 'ctrl'],
  ['Option+Enter', '\x1b\r', 'option'],
  ['Shift+Enter', '\x1b[13;2u', 'shift'],
]
for (const [index, [label, newlineKey, prefix]] of multilineCases.entries()) {
  stdin.write(`${prefix} first`)
  await new Promise(resolve => setTimeout(resolve, 100))
  stdin.write(newlineKey)
  await new Promise(resolve => setTimeout(resolve, 100))
  stdin.write(`${prefix} second`)
  await new Promise(resolve => setTimeout(resolve, 100))
  stdin.write('\r')
  await new Promise(resolve => setTimeout(resolve, 300))

  check(
    `${label} inserts a newline before Enter submits the multiline draft`,
    submitted.length === index + 3
      && submitted[index + 2] === `${prefix} first\n${prefix} second`,
    JSON.stringify(submitted),
  )
}

// A slash token is a command only when it begins the entire draft. Pasted
// multiline prose ending in /provider must remain ordinary message text.
const proseEndingInProvider = '第一行\n第二行/provider'
stdin.write(`\x1b[200~${proseEndingInProvider}\x1b[201~`)
stdin.write('\r')
await waitFor(() => submitted.at(-1) === proseEndingInProvider || commands.length > 0)
check(
  'multiline prose ending in /provider submits as text instead of opening a command',
  submitted.at(-1) === proseEndingInProvider && commands.length === 0,
  JSON.stringify({ submitted: submitted.at(-1), commands }),
)

stdin.write('/provider')
// Printable slash-command characters arrive as separate input events; allow
// PromptInput's controlled draft to commit before the physical Enter event.
await new Promise(resolve => setTimeout(resolve, 200))
stdin.write('\r')
await waitFor(() => commands.length === 1)
check(
  'standalone /provider invokes the provider command',
  commands.length === 1 && commands[0]?.name === 'provider' && commands[0]?.rawInput === '',
  JSON.stringify(commands),
)

instance.unmount()

if (failed > 0) {
  console.error(`verify-batched-prompt-input: ${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('verify-batched-prompt-input OK')
