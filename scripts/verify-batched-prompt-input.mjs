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
import { settled, sleep } from './lib/term-test.mjs'

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

instance.unmount()

if (failed > 0) {
  console.error(`verify-batched-prompt-input: ${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('verify-batched-prompt-input OK')
