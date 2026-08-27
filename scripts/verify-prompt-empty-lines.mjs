#!/usr/bin/env node
/**
 * Regression for issue #599: consecutive modified-Enter presses must keep
 * every logical blank line visible in the prompt. Empty non-caret Text nodes
 * have no Yoga height, so a draft like `alpha\n\n\nomega` used to paint alpha
 * and omega on adjacent rows even though the stored value was correct.
 *
 * Run after build: `node scripts/verify-prompt-empty-lines.mjs`.
 */
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import xtermHeadless from '@xterm/headless'
const { Terminal: XTerm } = xtermHeadless
import { render } from '../lib/types/ui.js'
import { PromptInput } from '../lib/types/components/PromptInput.js'
import { settled, sleep, viewportLines } from './lib/term-test.mjs'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const term = new XTerm({ cols: 80, rows: 16, scrollback: 50, allowProposedApi: true })
const stdout = new Writable({ write(chunk, _encoding, callback) { term.write(String(chunk), callback) } })
stdout.columns = 80
stdout.rows = 16
stdout.isTTY = true
const stderr = new Writable({ write(_chunk, _encoding, callback) { callback() } })
stderr.isTTY = true
const stdin = new PassThrough()
stdin.isTTY = true
stdin.setRawMode = () => stdin
stdin.setEncoding = () => stdin
stdin.ref = () => stdin
stdin.unref = () => stdin

const channel = {
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  sessionColor: '',
  promptSessionLabel: false,
  reasoningEffort: 'high',
  effortLevels: [],
  commandList: [],
  notifications: [],
  pending: [],
  working: false,
  cycleMode() {},
  commandCompletions: () => [],
  notify() {},
  submit() {},
  steer() {},
  interruptAndDeliver: () => 0,
  removePending: () => false,
  stageImage() {},
  listFiles: async () => [],
}

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

// First-frame listener setup has no stable external signal.
await sleep(400)
stdin.write('alpha')
await settled(() => viewportLines(term).some(line => line.includes('alpha')))
stdin.write('\x1b\r')
await sleep(100)
stdin.write('\x1b\r')
await sleep(100)
stdin.write('\x1b\r')
await sleep(100)
stdin.write('omega')

const visible = () => viewportLines(term)
const rendered = await settled(() => visible().some(line => line.includes('omega')))
const lines = visible()
const alphaRow = lines.findIndex(line => line.includes('alpha'))
const omegaRow = lines.findIndex(line => line.includes('omega'))

check('the full multiline draft renders', rendered && alphaRow >= 0 && omegaRow >= 0, JSON.stringify(lines))
check(
  'three consecutive modified-Enters preserve both intervening empty rows',
  omegaRow - alphaRow === 3,
  `alphaRow=${alphaRow} omegaRow=${omegaRow} screen=${JSON.stringify(lines)}`,
)

instance.unmount()

if (failed > 0) {
  console.error(`verify-prompt-empty-lines: ${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('verify-prompt-empty-lines OK')
