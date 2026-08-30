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
import xtermHeadless from '@xterm/headless'
import { render } from '../lib/types/ui.js'
import { PromptInput } from '../lib/types/components/PromptInput.js'
import { settled, sleep, viewportLines } from './lib/term-test.mjs'

const { Terminal: XTerm } = xtermHeadless

let failed = 0
/** Print one pass/fail line and keep a running failure count. */
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

/** Build the writable TTY streams used by the headless prompt harness. */
function makeStreams(term) {
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      if (term === undefined) {
        callback()
      } else {
        term.write(String(chunk), callback)
      }
    },
  })
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
let commandHandled = true
const channel = {
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  cycleMode() {},
  commandList: [
    { name: 'skills', description: 'List available skills' },
    { name: 'model', description: 'Show the active model' },
  ],
  commandCompletions(input) {
    if (input !== '/skills' && input !== '/model') return []
    const name = input.slice(1)
    return [{ name, description: name, commandLine: input, replacement: `${input} ` }]
  },
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

const term = new XTerm({ cols: 100, rows: 30, scrollback: 100, allowProposedApi: true })
const { stdout, stderr, stdin } = makeStreams(term)
const instance = await render(
  React.createElement(PromptInput, {
    channel,
    helpOpen: false,
    onToggleHelp() {},
    onRunCommand(name) { commands.push(name); return commandHandled },
    selectionActive: false,
  }),
  { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
)

// 首帧挂载 pacing：等 React 树完成首次渲染与输入监听挂接，无单一可观测条件。
await sleep(500)
stdin.write('a\x1b[Db')
// 批与 Enter 之间的 pacing：编辑态对外不可观测（stdout 被丢弃），只有
// submit 可断言——保留固定窗口（本文件后续同类 sleep 同理）。
await sleep(200)
stdin.write('\r')

check(
  'batched text, cursor movement, text, and Enter submit the composed value',
  await settled(() => submitted.length === 1 && submitted[0] === 'ba'),
  JSON.stringify(submitted),
)

// Termy 1.4.1 batches win32-input-mode records before writing to its PTY.
// Two IME commits in one read must compose instead of both reading the empty
// render closure and leaving only the final character (issue #215).
stdin.write('\x1b[65;30;20320;1;0;1_\x1b[65;30;22909;1;0;1_')
await sleep(200)
stdin.write('\r')

check(
  'batched Termy win32 IME records preserve every committed character',
  await settled(() => submitted.length === 2 && submitted[1] === '你好'),
  JSON.stringify(submitted),
)

// Native Windows terminals encode printable keys as individual win32-input-
// mode records. Under streaming output, one stdin read can contain several
// records; each edit must compose before Enter steers the text (issue #219).
channel.working = true
stdin.write('\x1b[78;49;110;1;0;1_\x1b[80;25;112;1;0;1_\x1b[77;50;109;1;0;1_')
await sleep(200)
stdin.write('\r')

check(
  'batched Windows input while streaming preserves npm before steer',
  await settled(() => steered.length === 1 && steered[0] === 'npm'),
  JSON.stringify(steered),
)

// A command and Enter can arrive as win32-input-mode records in one stdin
// read. React has not repainted the completion overlay yet, so PromptInput
// must use the synchronous value mirror to keep safe live commands local.
const win32Record = (virtualKey, scanCode, codePoint) =>
  `\x1b[${virtualKey};${scanCode};${codePoint};1;0;1_`
const batchedCommand = (letters) => [
  win32Record(191, 53, 47),
  ...letters.map(([virtualKey, scanCode, codePoint]) =>
    win32Record(virtualKey, scanCode, codePoint)),
  win32Record(13, 28, 13),
].join('')

// Keep separate physical Enter presses outside PromptInput's 80ms CR/LF
// dedupe window; each command itself still arrives as one atomic batch.
await sleep(100)
stdin.write(batchedCommand([
  [83, 31, 115],
  [75, 37, 107],
  [73, 23, 105],
  [76, 38, 108],
  [76, 38, 108],
  [83, 31, 115],
]))

check(
  'batched /skills while streaming executes locally before the overlay repaints',
  await settled(() => commands.length === 1 && commands[0] === 'skills' && steered.length === 1),
  `commands=${JSON.stringify(commands)} steered=${JSON.stringify(steered)}`,
)

await sleep(100)
stdin.write(batchedCommand([
  [77, 50, 109],
  [79, 24, 111],
  [68, 32, 100],
  [69, 18, 101],
  [76, 38, 108],
]))

check(
  'batched idle-only commands keep the existing steer behavior while streaming',
  await settled(() => commands.length === 1 && steered.length === 2 && steered[1] === '/model'),
  `commands=${JSON.stringify(commands)} steered=${JSON.stringify(steered)}`,
)

// A registered local command may decline handling and explicitly ask the
// input component to send the original text to the model instead.
await sleep(100)
commandHandled = false
stdin.write(batchedCommand([
  [83, 31, 115],
  [75, 37, 107],
  [73, 23, 105],
  [76, 38, 108],
  [76, 38, 108],
  [83, 31, 115],
]))

check(
  'declined /skills falls back to steer while streaming',
  await settled(() => commands.length === 2 && commands[1] === 'skills'
    && steered.length === 3 && steered[2] === '/skills'),
  `commands=${JSON.stringify(commands)} steered=${JSON.stringify(steered)}`,
)

// Terminals that cannot report modified Enter keys still expose Ctrl+J as a
// bare LF, while the physical Enter key arrives as CR. Ctrl+J must therefore
// remain a usable multiline fallback instead of submitting the first line.
channel.working = false
const multilineCases = [
  ['Ctrl+J (legacy LF)', '\n', 'ctrl'],
  ['Ctrl+J (CSI-u)', '\x1b[106;5u', 'csi-u'],
  ['Ctrl+J (modifyOtherKeys)', '\x1b[27;5;106~', 'modify-other-keys'],
  ['Option+Enter', '\x1b\r', 'option'],
  ['Shift+Enter', '\x1b[13;2u', 'shift'],
]
for (const [index, [label, newlineKey, prefix]] of multilineCases.entries()) {
  // 按键间 pacing（同上）：各段必须作为独立 chunk 依次落入编辑态。
  stdin.write(`${prefix} first`)
  await sleep(100)
  stdin.write(newlineKey)
  await sleep(100)
  stdin.write(`${prefix} second`)
  await sleep(100)
  stdin.write('\r')

  check(
    `${label} inserts a newline before Enter submits the multiline draft`,
    await settled(() => submitted.length === index + 3
      && submitted[index + 2] === `${prefix} first\n${prefix} second`),
    JSON.stringify(submitted),
  )
}

// Enhanced protocols distinguish extra modifiers that legacy LF cannot carry.
// Only exact Ctrl+J is the fallback; modified variants stay available to other
// bindings instead of silently changing the draft.
const modifiedCtrlJCases = [
  ['Ctrl+Shift+J', '\x1b[106;6u', 'ctrl-shift'],
  ['Ctrl+Alt+J', '\x1b[106;7u', 'ctrl-alt'],
  ['Ctrl+Super+J', '\x1b[106;13u', 'ctrl-super'],
]
for (const [index, [label, newlineKey, prefix]] of modifiedCtrlJCases.entries()) {
  stdin.write(`${prefix} first`)
  await sleep(100)
  stdin.write(newlineKey)
  await sleep(100)
  stdin.write(`${prefix} second`)
  await sleep(100)
  stdin.write('\r')

  const submission = multilineCases.length + index + 2
  check(
    `${label} does not insert a Ctrl+J fallback newline`,
    await settled(() => submitted.length === submission + 1
      && submitted[submission] === `${prefix} first${prefix} second`),
    JSON.stringify(submitted),
  )
}

stdin.write('a')
await sleep(100)
stdin.write('\x1b\r')
await sleep(100)
stdin.write('\x1b\r')
await sleep(100)
stdin.write('b')
check(
  'consecutive Option+Enter keeps both blank prompt lines visible',
  await settled(() => {
    const lines = viewportLines(term)
    const top = lines.findIndex(line => line.includes('╭'))
    const bottom = lines.findIndex((line, index) => index > top && line.includes('╰'))
    return top >= 0 && bottom - top === 4 && lines.some(line => line.includes('b'))
  }),
  viewportLines(term).join('\n'),
)
stdin.write('\r')
check(
  'consecutive Option+Enter submits both newlines',
  await settled(() => submitted.at(-1) === 'a\n\nb'),
  JSON.stringify(submitted),
)

instance.unmount()

if (failed > 0) {
  console.error(`verify-batched-prompt-input: ${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('verify-batched-prompt-input OK')
