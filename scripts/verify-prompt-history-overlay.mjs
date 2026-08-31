#!/usr/bin/env node
/**
 * Regression: a history walk must own ↑/↓ until it returns to the draft.
 *
 * A recalled entry can itself satisfy an overlay grammar — recalling
 * `/model` opens the slash-command menu the moment it lands in the input
 * (`suggestions.length > 0`). Before the fix, ↑/↓ on such an entry
 * navigated the MENU instead of the history: the stashed draft became
 * unreachable via ↓, and Esc (menu open → clear input) destroyed the
 * recalled entry without restoring the draft either — recovery required
 * Ctrl+R. The fix gates both overlay branches on `historyIndex < 0` so the
 * walk keeps walking until the draft comes back.
 *
 * Run after build: `node scripts/verify-prompt-history-overlay.mjs`.
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
const commands = []
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
  steer() {},
  interruptAndDeliver() { return 0 },
  removePending() { return false },
  stageImage() {},
  listFiles: async () => [],
}

const term = new XTerm({ cols: 100, rows: 30, scrollback: 100, allowProposedApi: true })
const { stdout, stderr, stdin } = makeStreams(term)
await render(
  React.createElement(PromptInput, {
    channel,
    helpOpen: false,
    onToggleHelp() {},
    onRunCommand(name) { commands.push(name); return true },
    selectionActive: false,
  }),
  { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
)

const UP = '\x1b[A'
const DOWN = '\x1b[B'
/** True when some viewport row contains the text (input echo assertion). */
const shows = (text) => viewportLines(term).some(line => line.includes(text))

// 首帧挂载 pacing：等 React 树完成首次渲染与输入监听挂接，无单一可观测条件。
await sleep(500)

// Seed the history: one plain message, then a slash command — the command
// entry is the one that reopens the menu when recalled.
stdin.write('plain one')
await sleep(150)
stdin.write('\r')
await settled(() => submitted.length === 1, JSON.stringify({ submitted }))
await sleep(150)
stdin.write('/model')
await sleep(150)
stdin.write('\r')
await settled(() => commands.length === 1 && commands[0] === 'model', JSON.stringify({ commands }))
await sleep(150)

// Type a draft but do NOT submit it.
stdin.write('draft 草稿')
await sleep(200)
check('draft typed into the input', await settled(() => shows('draft 草稿')))

// ↑ recalls `/model` — the slash menu opens over it (this is the trap).
stdin.write(UP)
check('up recalls the /model history entry', await settled(() => shows('/model')))

// ↓ must return to the draft even though the menu is open over `/model`.
stdin.write(DOWN)
check(
  'down past the newest entry restores the draft despite the open menu',
  await settled(() => shows('draft 草稿')),
)

// The walk also continues UP through menu-opening entries: ↑↑ from the
// draft reaches `plain one` past `/model`.
stdin.write(UP)
await settled(() => shows('/model'))
stdin.write(UP)
check(
  'up continues through the menu-opening entry to the older one',
  await settled(() => shows('plain one')),
)

// ↓↓ returns all the way to the draft, and Enter submits it — the draft
// was never lost.
stdin.write(DOWN)
await settled(() => shows('/model'))
stdin.write(DOWN)
await settled(() => shows('draft 草稿'))
await sleep(150)
stdin.write('\r')
check(
  'draft submits intact after the round trip',
  await settled(() => submitted.length === 2 && submitted[1] === 'draft 草稿'),
  JSON.stringify({ submitted, commands }),
)

console.log(failed === 0 ? '\nAll prompt-history-overlay checks passed' : `\n${failed} check(s) FAILED`)
process.exit(failed === 0 ? 0 : 1)
