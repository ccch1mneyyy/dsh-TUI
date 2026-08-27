#!/usr/bin/env node
/**
 * vim editing mode regression (compiled lib): `/vim` toggles the prompt's
 * vim editing (session-scoped, lands in INSERT), Esc switches INSERT↔NORMAL,
 * and the NORMAL key set edits/moves the draft — via the REAL Chat render +
 * useInput pipeline (xterm headless).
 *
 * Checks:
 * - `/vim` on → 'vim mode on' notify + INSERT badge; typing still works
 * - Esc in INSERT → NORMAL badge, text preserved (Esc no longer clears)
 * - NORMAL keys: 0 (line start) x (delete char) u (undo) w (word forward)
 *   $ (line end) dd (clear line) — each edit is undoable
 * - unrecognized NORMAL key (t) is ignored, never types
 * - A (line-end insert), o (new line below), k/j (line moves), I (line-start
 *   insert) work; edits keep their undo snapshots
 * - `/vim` off → 'vim mode off' notify, badge gone, typing normal again
 * - NORMAL Esc on a non-empty draft does NOT clear it (vim owns Esc)
 * - working turn: Esc stays with vim in BOTH submodes (chat:cancel yields;
 *   interrupt via Ctrl+C) — cancel counter stays 0
 * - pending `d` + Esc cancels the operator (next `x` deletes normally)
 * - undo stack is cleared when vim is toggled off (re-enabled vim cannot
 *   `u` past pre-toggle edits, but new edits still undo)
 * - multi-line: `$x` on a mid-draft line deletes the last CHAR (not the
 *   newline); `dd` deletes the whole line including its newline
 * - `I` lands on the line's first non-blank; `/` works in NORMAL (inserts
 *   the slash and returns to INSERT so the command menu can open)
 *
 * Run after build: `node scripts/verify-vim-mode.mjs`
 */
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import xtermHeadless from '@xterm/headless'
const { Terminal: XTerm } = xtermHeadless
import { render } from '../lib/types/ui.js'
import { Chat } from '../lib/types/screens/Chat.js'
import { setLang } from '../lib/types/i18n.js'
import { settle, settled, sleep, viewportLines } from './lib/term-test.mjs'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const term = new XTerm({ cols: 110, rows: 34, scrollback: 100, allowProposedApi: true })

function makeStreams() {
  const stdout = new Writable({ write(chunk, _enc, cb) { term.write(String(chunk), cb) } })
  stdout.columns = 110
  stdout.rows = 34
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

const listeners = new Set()
const notifications = []
const rows = []
const channel = {
  version: 0,
  rows,
  status: 'idle',
  sessionTitle: 'vimtest',
  agentId: 'vimtest',
  model: 'deepseek-v4-flash',
  provider: 'deepseek',
  tokens: { input: 0, output: 0 },
  cwd: '/tmp',
  displayCwd: '/tmp',
  gitBranch: 'main',
  working: false,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 0,
  turnStart: 0,
  lastUserText: '',
  pending: [],
  notifications,
  contextWindow: undefined,
  reasoningEffort: 'high',
  effortLevels: [],
  workingActivity: undefined,
  activityEnabled: false,
  contextBarEnabled: true,
  statusBar: {},
  agentPreset: 'standard',
  goal: undefined,
  todos: [],
  mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
  modeIndex: 0,
  sessionColor: '',
  promptSessionLabel: false,
  cycleMode() {},
  commandList: [{ name: 'vim', description: 'Toggle vim mode' }],
  commandCompletions: () => [],
  contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
  notify(text, options) { notifications.push({ text: String(text), options }) },
  pushLocal() {},
  subscribe(l) { listeners.add(l); return () => listeners.delete(l) },
  emit() { channel.version += 1; for (const l of listeners) l() },
  submit() {},
  steer() {},
  removePending: () => true,
  cancelCalls: 0,
  cancel() { channel.cancelCalls += 1 },
  interruptAndDeliver: () => 0,
  clear() {},
  loadOlder: () => 0,
  listModels: async () => [],
  listFiles: async () => [],
  listSessions: async () => [],
  setResumeTarget() {},
  setActivityFrames: () => true,
  activityFrames: 'claude',
  runExternalCommand: async () => '',
  mcpStatus: () => [],
  exportSession: () => null,
  initWorkspace: () => null,
  doctorInfo: () => [],
  listSubagents: async () => [],
  listPresets: async () => [],
  switchPreset: async () => false,
  switchModel: async () => false,
  rewindTo: async () => null,
  resumeTo: async () => ({ ok: false, reason: 'unavailable' }),
  newSession: async () => false,
  compact() {},
}

const { stdout, stderr, stdin } = makeStreams()
const instance = await render(
  React.createElement(Chat, {
    channel,
    questionStore: { subscribe: () => () => {}, getSnapshot: () => null, answerCurrent: () => {} },
    onExit() {},
  }),
  { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
)
// Startup wait: first-frame content (random tip) has no stable poll anchor.
await sleep(700)
setLang('en')

const screen = () => viewportLines(term).join('\n')

const promptText = () => {
  // The prompt row begins with the '❯' glyph; the vim badge (INSERT/NORMAL)
  // sits right after it, then the draft. Strip border decoration and the
  // ⛶ expand-editor affordance now ending the row.
  const match = screen().match(/^[❯]\s*(.*)$/m)
  const raw = match === null ? '' : (match[1] ?? '')
  return raw.replace(/[╭╮╰╯─│═║⛶]+/g, '').trim()
}
// NOTE: the prompt can span multiple visual rows (multi-line drafts); the
// '❯' row only carries the FIRST line, so multi-line assertions check the
// whole screen instead of promptText().
const draft = () => promptText().replace(/^(INSERT|NORMAL)\s*/, '')
const badge = () => (screen().includes('INSERT') ? 'INSERT' : screen().includes('NORMAL') ? 'NORMAL' : 'none')
const notice = (re) => notifications.some(n => re.test(String(n.text)))

// ── baseline: no vim mode yet ──────────────────────────────
stdin.write('v')
check('baseline: plain v types', await settled(() => promptText().includes('v')), JSON.stringify(promptText()))
check('baseline: no vim badge', badge() === 'none', badge())
stdin.write('\x03')
await settle(() => promptText() === '')

// ── /vim on: INSERT badge, typing works ────────────────────
stdin.write('/vim\r')
check('vim on notify', await settled(() => notice(/vim mode on/i)), JSON.stringify(notifications.map(n => n.text)))
check('vim on: INSERT badge', await settled(() => badge() === 'INSERT'), badge())
stdin.write('hello world')
check('insert types hello world', await settled(() => draft() === 'hello world'), JSON.stringify(draft()))

// ── Esc → NORMAL: badge flips, draft preserved ─────────────
stdin.write('\x1b')
check('esc → NORMAL badge', await settled(() => badge() === 'NORMAL'), badge())
check('esc does not clear the draft', draft() === 'hello world', JSON.stringify(draft()))

// ── NORMAL keys ────────────────────────────────────────────
stdin.write('0x')
check('0x: delete first char', await settled(() => draft() === 'ello world'), JSON.stringify(draft()))
stdin.write('u')
check('u: undo x', await settled(() => draft() === 'hello world'), JSON.stringify(draft()))
stdin.write('wx')
check('wx: delete first char of second word', await settled(() => draft() === 'hello orld'), JSON.stringify(draft()))
stdin.write('u')
await settle(() => draft() === 'hello world')
stdin.write('$x')
check('$x: delete last char', await settled(() => draft() === 'hello worl'), JSON.stringify(draft()))
stdin.write('u')
await settle(() => draft() === 'hello world')
stdin.write('dd')
check('dd: clear the line', await settled(() => draft() === ''), JSON.stringify(draft()))
stdin.write('u')
check('u: undo dd', await settled(() => draft() === 'hello world'), JSON.stringify(draft()))
stdin.write('t')
check('unrecognized normal key ignored', await settled(() => draft() === 'hello world'), JSON.stringify(draft()))

// ── A: insert at line end ──────────────────────────────────
stdin.write('A!')
check('A! appends at line end', await settled(() => draft() === 'hello world!'), JSON.stringify(draft()))
stdin.write('\x1b')
await settle(() => badge() === 'NORMAL')

// ── o / k / j: new line below + vertical moves ─────────────
stdin.write('osecond')
check('o: new line below, typing lands there', await settled(() => screen().includes('hello world!') && screen().includes('second')), JSON.stringify(screen()))
stdin.write('\x1b')
await settle(() => badge() === 'NORMAL')
stdin.write('k0x')
check('k: up one line, 0: line start, x deletes first char', await settled(() => screen().includes('ello world!') && screen().includes('second')), JSON.stringify(screen()))
stdin.write('u')
await settle(() => screen().includes('hello world!') && screen().includes('second'))
stdin.write('jx')
check('j: down one line, x deletes its first char', await settled(() => screen().includes('hello world!') && screen().includes('econd')), JSON.stringify(screen()))

// ── I: insert at line start ────────────────────────────────
stdin.write('I> ')
check('I: insert at line start', await settled(() => screen().includes('> econd')), JSON.stringify(screen()))

// ── working turn: Esc stays with vim in BOTH submodes ─────
// Chat's chat:cancel must yield while vim is on (interrupt via Ctrl+C).
channel.working = true
const cancelsBefore = channel.cancelCalls
stdin.write('\x1b') // INSERT → NORMAL
await settle(() => badge() === 'NORMAL')
check('working: esc in vim insert does not interrupt', channel.cancelCalls === cancelsBefore, `cancel=${channel.cancelCalls}`)
stdin.write('\x1b') // NORMAL: no-op, still no interrupt
await sleep(120)
check('working: esc in vim normal does not interrupt', channel.cancelCalls === cancelsBefore, `cancel=${channel.cancelCalls}`)
channel.working = false

// ── pending `d` + Esc cancels the operator ────────────────
// Cursor sits after '> ' on line 2; `d` arms, Esc cancels, then `x` must
// delete the character at the caret instead of acting as d's second key.
stdin.write('d\x1b')
await sleep(120)
stdin.write('x')
check('esc cancels pending d; x deletes normally', await settled(() => screen().includes('> cond')), JSON.stringify(screen()))
stdin.write('u')
await settle(() => screen().includes('> econd'))

// ── undo stack is cleared when vim is toggled off ─────────
// (a slash command only dispatches on an EMPTY draft — a non-empty one
// turns "/vim" into plain text — so clear before every toggle)
stdin.write('\x03')
await settle(() => draft() === '')
stdin.write('i')
await settle(() => badge() === 'INSERT')
stdin.write('ab')
await settle(() => draft() === 'ab')
stdin.write('\x1b')
await settle(() => badge() === 'NORMAL')
stdin.write('x') // delete 'b' → 'a' (pushes an undo snapshot)
await settled(() => draft() === 'a')
stdin.write('\x03')
await settle(() => draft() === '')
stdin.write('/vim\r') // OFF — undo stack must be cleared
await settled(() => notice(/vim mode off/i))
stdin.write('\x1b') // vim off: Esc regains its clear-the-draft meaning
await settled(() => draft() === '')
check('vim off: Esc clears the draft again', draft() === '', JSON.stringify(draft()))
stdin.write('ab') // type while vim is off
await settle(() => draft() === 'ab')
stdin.write('\x03')
await settle(() => draft() === '')
stdin.write('/vim\r') // ON again
// Wait for the toggle's RENDER (badge), not a notify: an earlier
// 'vim mode on' notice would match instantly and the next write could
// merge into the same stdin batch as '/vim\r'.
await settle(() => badge() === 'INSERT')
stdin.write('cd') // INSERT typing (toggle lands in INSERT)
await settle(() => draft() === 'cd')
stdin.write('\x1b')
await settle(() => badge() === 'NORMAL')
stdin.write('u') // stack was cleared by the toggles: must be a no-op
await sleep(150)
check('re-enabled vim: undo cannot reach pre-toggle edits', draft() === 'cd', JSON.stringify(draft()))
stdin.write('x') // delete 'd' → 'c' (pushes a fresh snapshot)
await settled(() => draft() === 'c')
stdin.write('u')
check('re-enabled vim: undo still works for new edits', await settled(() => draft() === 'cd'), JSON.stringify(draft()))

// ── multi-line vim semantics ──────────────────────────────
// Current: 'cd' NORMAL (single line). Build a 2-line draft, then verify
// `$x` on a mid-draft line deletes the LAST CHAR (not the newline), and
// `dd` deletes the WHOLE line (newline included) — vim semantics.
stdin.write('oxy') // o: new line below + INSERT; 'xy' types
await settled(() => screen().includes('cd') && screen().includes('xy'))
stdin.write('\x1b')
await settle(() => badge() === 'NORMAL')
stdin.write('k$x') // up to the 'cd' line end; x deletes 'd'
check('$x on a mid-draft line deletes the last char, not the newline', await settled(() => screen().includes('c') && screen().includes('xy') && !screen().includes('cd')), JSON.stringify(screen()))
stdin.write('u')
await settle(() => screen().includes('cd') && screen().includes('xy'))
stdin.write('dd') // delete the whole 'cd' line including its newline
check('dd deletes the whole line incl. newline', await settled(() => !screen().includes('cd') && screen().includes('xy')), JSON.stringify(screen()))
stdin.write('u')
await settle(() => screen().includes('cd') && screen().includes('xy'))

// ── I lands on the first non-blank of the line ────────────
stdin.write('o  ab') // new line below; two spaces + 'ab' → 'cd\n  ab\nxy'
await settled(() => screen().includes('  ab'))
stdin.write('\x1b') // NORMAL (caret at the end of '  ab')
await settle(() => badge() === 'NORMAL')
stdin.write('I>') // I → first non-blank; '>' types there
check('I inserts at the first non-blank', await settled(() => screen().includes('  >ab')), JSON.stringify(screen()))
stdin.write('\x1b') // back to NORMAL
await settle(() => badge() === 'NORMAL')

// ── '/' opens the command menu even in NORMAL ─────────────
stdin.write('/') // inserts '/' and returns to INSERT
check('/ in NORMAL inserts and returns to INSERT', await settled(() => screen().includes('>/ab') && badge() === 'INSERT'), JSON.stringify(screen()))
stdin.write('\x1b') // INSERT → NORMAL
await settle(() => badge() === 'NORMAL')
await settle(() => badge() === 'NORMAL')
stdin.write('\x03') // clear the multi-line draft so /vim dispatches
await settle(() => draft() === '')
stdin.write('/vim\r')
check('vim off notify', await settled(() => notice(/vim mode off/i)), JSON.stringify(notifications.map(n => n.text)))
check('vim off: badge gone', await settled(() => badge() === 'none'), badge())
stdin.write('z')
check('after off: typing inserts again', await settled(() => draft() === 'z'), JSON.stringify(draft()))

instance.unmount()
console.log(failed === 0 ? '\nall vim-mode checks passed' : `\n${failed} vim-mode check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
