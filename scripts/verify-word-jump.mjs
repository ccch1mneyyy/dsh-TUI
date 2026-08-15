#!/usr/bin/env node
/**
 * Regression: Ctrl+Left/Right word jump in PromptInput (#156, #158).
 *
 * Windows Terminal (and most xterm-family terminals) deliver Ctrl+Left as
 * ESC[1;5D — parsed to { name: 'left', ctrl: true } (parse-keypress.ts) and
 * mapped to leftArrow:true with ctrl preserved (input-event.ts). The prompt
 * dispatch must therefore test isMod(key) && key.leftArrow BEFORE the bare
 * key.leftArrow arm, or the word-jump arms stay dead code and Ctrl+Arrow
 * degrades to single-char movement.
 *
 * End-to-end through the REAL tokenizer/parser/render pipeline (compiled
 * lib, mock channel): type "hello world", move the caret with Ctrl/bare
 * arrows, insert a distinct marker after each move, then submit — the final
 * string encodes every caret position (asserted at submit time):
 *   type  "hello world"                caret 11
 *   Ctrl+Left  → caret 6               insert X → "hello Xworld"   caret 7
 *   Ctrl+Left  → caret 6               insert Y → "hello YXworld"  caret 7
 *   bare Left  → caret 6  (single char — NOT a word jump to 0)
 *                                      insert Z → "hello ZYXworld" caret 7
 *   Ctrl+Right → caret 14 (end)        insert Q → "hello ZYXworldQ"
 *   Enter → channel.submit("hello ZYXworldQ")
 *
 * With the #156 bug (bare-arrow arm first) every Ctrl+Arrow moves a single
 * char and the markers land in different places, so the submitted value
 * differs. A word-jump-on-bare-arrow regression likewise moves marker Z.
 *
 * Plus a static invariant (verify-cordis-approval style): in the source the
 * isMod arrow arms must textually precede the bare arrow arms.
 *
 * Run with plain node against the compiled lib:
 *   node scripts/verify-word-jump.mjs
 * Exits 1 on any failed assertion (CI gate).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Writable, PassThrough } from 'node:stream'
import React from 'react'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const { render } = await import('../lib/types/ui.js')
const { PromptInput } = await import('../lib/types/components/PromptInput.js')

function makeStreams() {
  const stdout = new Writable({ write(_c, _e, cb) { cb() } })
  stdout.columns = 100
  stdout.rows = 30
  stdout.isTTY = true
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

const submitted = []
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
  steer() {},
  interruptAndDeliver() {},
  removePending() {},
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
await sleep(600)

const feed = async seq => {
  stdin.write(seq)
  await sleep(250)
}

await feed('hello world')
await feed('\x1b[1;5D') // Ctrl+Left  → caret 6 (word start; bug: 10)
await feed('X')
await feed('\x1b[1;5D') // Ctrl+Left  → caret 6
await feed('Y')
await feed('\x1b[D')    // bare Left  → caret 6 (single char; jump bug: 0)
await feed('Z')
await feed('\x1b[1;5C') // Ctrl+Right → caret 14 (end of "…world")
await feed('Q')
await feed('\r')

check(
  'caret moves + inserts compose to the expected submitted text',
  submitted.length === 1 && submitted[0] === 'hello ZYXworldQ',
  JSON.stringify(submitted),
)

instance.unmount()

// ── static invariant: isMod arrow arms precede bare arrow arms ─────────────
const source = readFileSync(join(root, 'src/components/PromptInput.tsx'), 'utf8')
const modLeft = source.indexOf('if (isMod(key) && key.leftArrow)')
const bareLeft = source.indexOf('if (key.leftArrow)')
const modRight = source.indexOf('if (isMod(key) && key.rightArrow)')
const bareRight = source.indexOf('if (key.rightArrow)')
check('source: isMod+left arm exists and precedes bare left arm', modLeft !== -1 && bareLeft !== -1 && modLeft < bareLeft)
check('source: isMod+right arm exists and precedes bare right arm', modRight !== -1 && bareRight !== -1 && modRight < bareRight)

if (failed > 0) {
  console.error(`verify-word-jump: ${failed} assertion(s) failed`)
  process.exit(1)
}
console.log('verify-word-jump OK')
