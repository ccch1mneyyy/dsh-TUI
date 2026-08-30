#!/usr/bin/env node
/**
 * Regression: plain-Enter guard on modal decisions (4-PR review leftover).
 *
 * Since #110 the input pipeline delivers Enter WITH modifiers: Option+Enter
 * arrives as meta+return (ESC CR), and extended-keys terminals deliver
 * Shift/Ctrl+Enter as return+modifier (CSI 13;2u / 13;5u). A bare
 * `key.return` in a decision dialog lets those commit by accident — e.g.
 * approving a permission escalation while the user only wanted a newline.
 *
 * Asserts:
 *   1. isPlainReturn's modifier matrix (unit);
 *   2. ApprovalPanel end-to-end through the REAL tokenizer/parser/render
 *      pipeline: ESC CR, CSI 13;5u and CSI 13;2u must NOT decide; a plain
 *      CR decides the focused outcome;
 *   3. static invariant (verify-cordis-approval style): no bare
 *      `if (key.return)` confirm site survives in the modal components —
 *      PromptInput.tsx is exempt on purpose (its modifier handling is the
 *      feature: shift/meta inserts a newline, isMod interrupts).
 *
 * Run with plain node against the compiled lib:
 *   node scripts/verify-plain-enter-guard.mjs
 * Exits 1 on any failed assertion (CI gate).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import { settled, sleep } from './lib/term-test.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const { isPlainReturn } = await import('../lib/types/utils/modifiers.js')

// ── 1. helper matrix ────────────────────────────────────────────────────────
const base = { return: true, ctrl: false, meta: false, shift: false, super: false }
check('plain return accepted', isPlainReturn({ ...base }) === true)
check('meta+return rejected (Option+Enter / ESC CR)', isPlainReturn({ ...base, meta: true }) === false)
check('ctrl+return rejected (CSI 13;5u)', isPlainReturn({ ...base, ctrl: true }) === false)
check('shift+return rejected (CSI 13;2u)', isPlainReturn({ ...base, shift: true }) === false)
check('super+return rejected (Cmd+Enter)', isPlainReturn({ ...base, super: true }) === false)
check('non-return rejected', isPlainReturn({ ...base, return: false }) === false)

// ── 2. ApprovalPanel through the real input pipeline ───────────────────────
const { render } = await import('../lib/types/ui.js')
const { ApprovalPanel } = await import('../lib/types/components/approvals/ApprovalPanel.js')

function makeStreams() {
  const stdout = new Writable({ write(chunk, _enc, cb) { cb() } })
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

const decisions = []
const { stdout, stderr, stdin } = makeStreams()
const instance = await render(
  React.createElement(ApprovalPanel, {
    approval: { toolName: 'bash', command: 'rm -rf /tmp/x', reason: 'needs escalation' },
    onDecide: (outcome) => decisions.push(outcome),
  }),
  { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
)
// 首帧挂载 pacing：等 React 树完成首次渲染与输入监听挂接，无单一可观测条件。
await sleep(500)

// Modifier Enters must be inert in the panel (they were inert text tokens
// before #110; the guard restores that for decision paths).
// Stability probes (nothing may be decided): a settle would return
// immediately on the already-true condition — keep fixed windows so a
// wrong decision has time to surface.
stdin.write('\x1b\r') // Option+Enter (ESC CR) → meta+return
await sleep(250)
check('Option+Enter (ESC CR) does not decide', decisions.length === 0, JSON.stringify(decisions))

stdin.write('\x1b[13;5u') // Ctrl+Enter (kitty CSI-u)
await sleep(250)
check('Ctrl+Enter (CSI 13;5u) does not decide', decisions.length === 0, JSON.stringify(decisions))

stdin.write('\x1b[13;2u') // Shift+Enter
await sleep(250)
check('Shift+Enter (CSI 13;2u) does not decide', decisions.length === 0, JSON.stringify(decisions))

// Plain Enter still confirms the focused row (default 0 = allowed-once).
stdin.write('\r')
check('plain Enter decides the focused outcome', await settled(() => decisions.length === 1 && decisions[0] === 'allowed-once'), JSON.stringify(decisions))

instance.unmount()

// ── 3. static invariant: no bare key.return confirm in modal components ─────
const MODAL_SOURCES = [
  'src/screens/Chat.tsx',
  'src/components/approvals/ApprovalPanel.tsx',
  'src/components/questions/AskUserQuestionPanel.tsx',
  'src/components/questions/PlanReviewPanel.tsx',
]
for (const rel of MODAL_SOURCES) {
  const text = readFileSync(join(root, rel), 'utf8')
  const bare = text.match(/if \(key\.return[)&| ]/g) ?? []
  check(`${rel} has no unguarded key.return confirm`, bare.length === 0, bare.join(' | '))
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall plain-Enter guard checks passed')
