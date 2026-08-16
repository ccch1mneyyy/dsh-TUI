#!/usr/bin/env node
/**
 * Headless regression for the /resume session browser, driven through the
 * REAL Chat screen (compiled lib) with fake stdin — the same harness the
 * picker it replaces used.
 *
 * Covers the behaviours a person would notice breaking:
 *   1. the browser opens as a screen, lists conversations, and FOLDS the
 *      delegated sub-agent runs away while still counting them;
 *   2. sessions holding no conversation are never listed, only counted;
 *   3. typing filters the list, Esc clears the query, a second Esc leaves;
 *   4. ctrl+s reveals the runs, indented under their parent;
 *   5. rename: the inline editor prefills, the call hits the intended
 *      session, and the cursor FOLLOWS that session when the rename bumps it
 *      to the top of the list — the cursor tracks identity, not position;
 *   6. delete: the confirmation names the focused session, Ctrl+Enter must
 *      NOT confirm an irreversible action, Esc cancels, and repeated Enter
 *      commits the action only once.
 *
 * Assertion discipline: ink repaints only changed lines, so each step opens a
 * FRESH output window and asserts on what that window painted; checks that
 * depend on final placement read the composed xterm screen instead.
 *
 * Run: `node scripts/verify-session-browser.mjs`
 * Exits 1 on any failed assertion (CI gate).
 */
import { Writable, PassThrough } from 'node:stream'
import xtermPkg from '@xterm/headless'
import React from 'react'
import { render } from '../lib/types/ui.js'
import { Chat } from '../lib/types/screens/Chat.js'
import { setLang } from '../lib/types/i18n.js'
import instances from '../lib/types/ink/instances.js'

const { Terminal } = xtermPkg

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const COLS = 110
const ROWS = 34

function makeStreams() {
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 200, allowProposedApi: true })
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      const text = String(chunk)
      stdout.frames.push(text)
      term.write(text)
      cb()
    },
  })
  stdout.term = term
  stdout.columns = COLS
  stdout.rows = ROWS
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

const summary = (over) => ({
  id: 'id',
  kind: { kind: 'root' },
  title: { text: 'title', source: 'auto' },
  cwd: '/tmp',
  createdAt: 1,
  updatedAt: 1,
  bytes: 2048,
  hasPrompt: true,
  agentPreset: 'standard',
  model: 'deepseek-v4-pro',
  label: undefined,
  branch: 'main',
  childCount: 0,
  ...over,
})

function makeChannel() {
  // MRU order: gamma (newest) → beta → alpha, plus two delegated runs under
  // beta and one boot artifact holding no conversation.
  let sessions = [
    summary({ id: 's-new', title: { text: 'gamma', source: 'auto' }, updatedAt: 5 }),
    summary({ id: 's-mid', title: { text: 'beta', source: 'auto' }, updatedAt: 4, childCount: 2 }),
    summary({ id: 's-old', title: { text: 'alpha', source: 'auto' }, updatedAt: 3 }),
    summary({ id: 's-run1', title: { text: 'delegated one', source: 'prompt' }, updatedAt: 2, label: 'audit run', kind: { kind: 'subagent', parent: 's-mid', depth: 1 } }),
    summary({ id: 's-run2', title: { text: 'delegated two', source: 'prompt' }, updatedAt: 1, kind: { kind: 'subagent', parent: 's-mid', depth: 1 } }),
    summary({ id: 's-boot', title: { text: 'tmp', source: 'fallback' }, updatedAt: 6, hasPrompt: false }),
  ]
  const calls = { rename: [], delete: [], preview: [] }
  const listeners = new Set()
  const rows = []
  const channel = {
    version: 0,
    rows,
    status: 'idle',
    sessionTitle: 'live',
    agentId: 'live-session',
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
    notifications: [],
    contextWindow: undefined,
    reasoningEffort: 'high',
    workingActivity: undefined,
    activityEnabled: false,
    contextBarEnabled: true,
    agentPreset: 'standard',
    goal: undefined,
    todos: [],
    commandList: [{ name: 'resume', description: 'Resume a session' }],
    commandCompletions(input) {
      const prefix = input.replace(/^\//u, '').trim().toLowerCase()
      return this.commandList
        .filter((command) => command.name.startsWith(prefix))
        .map((command) => ({ ...command, commandLine: `/${command.name}`, replacement: `/${command.name} ` }))
    },
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    modeIndex: 0,
    // The real rename touches MRU (verify-resume-rename-mru), so the renamed
    // session jumps to the top — mirror that, because the cursor following it
    // is exactly what check 5 is about.
    async renameSessionTo(id, title) {
      calls.rename.push([id, title])
      const i = sessions.findIndex((s) => s.id === id)
      if (i < 0) return false
      const [s] = sessions.splice(i, 1)
      sessions.unshift({ ...s, title: { text: title, source: 'renamed' }, updatedAt: 99 })
      return true
    },
    async deleteSession(id) {
      calls.delete.push(id)
      const i = sessions.findIndex((s) => s.id === id)
      if (i < 0) return false
      sessions.splice(i, 1)
      return true
    },
    async listSessions() {
      return sessions.map((s) => ({ ...s }))
    },
    async previewSession(id) {
      calls.preview.push(id)
      return [{ role: 'user', text: `preview of ${id}`, at: 1 }]
    },
    notify(text, options) { this.notifications.push({ text, options }) },
    pushLocal(title, lines) {
      for (const line of [title, ...lines]) rows.push({ id: rows.length, kind: 'notice', text: line })
      channel.version += 1
      for (const listener of listeners) listener()
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    emit() { channel.version += 1; for (const listener of listeners) listener() },
    submit() {},
    steer() {},
    removePending: () => true,
    cancel() {},
    interruptAndDeliver: () => 0,
    clear() {},
    loadOlder: () => 0,
    listModels: async () => [],
    listFiles: async () => [],
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
    resumeTo: async () => false,
    newSession: async () => false,
    compact() {},
    calls,
  }
  return channel
}

const toPlain = (s) =>
  s
    .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
    .replace(/\x1b\[[0-9;?>:]*[a-zA-Z]/g, '')
    .replace(/\x1b\]9;[^\x07]*\x07/g, '')
    .replace(/\]8;;[^\x1b\x07]*(\x1b\\|\x07)?/g, '')
    .replace(/[^\S\n]+/g, ' ')

const { stdout, stderr, stdin } = makeStreams()
const channel = makeChannel()
const instance = await render(
  React.createElement(Chat, {
    channel,
    questionStore: { subscribe: () => () => {}, getSnapshot: () => null, answerCurrent: () => {} },
    onExit() {},
  }),
  { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
)
// <AlternateScreen> finds its Ink instance through `process.stdout`; alias the
// fake one so the harness enters the alternate screen the way a real terminal
// does. Without this the browser would render with inline geometry and the
// test would be measuring an artefact of its own rig.
for (const value of instances.values()) instances.set(process.stdout, value)
await sleep(700)

const flat = (s) => s.replace(/\s+/g, ' ')

/** The composed screen, as the user sees it. */
const screen = () => {
  const buf = stdout.term.buffer.active
  return Array.from({ length: stdout.term.rows }, (_, y) =>
    (buf.getLine(y)?.translateToString(true) ?? '').replace(/\s+$/, ''))
    .join('\n')
}

async function windowed(action, settle = 300) {
  stdout.frames.length = 0
  action()
  await sleep(settle)
  return toPlain(stdout.frames.join(''))
}

setLang('en')

// ── open the browser ────────────────────────────────────────────────────
await windowed(() => stdin.write('/resume'), 250)
await windowed(() => stdin.write('\r'), 600)
let s = screen()
check('the browser opens as a screen', /Resume session/.test(flat(s)), flat(s).slice(0, 120))
check('conversations are listed', /gamma/.test(s) && /beta/.test(s) && /alpha/.test(s))
check('delegated runs are NOT listed by default', !/delegated one/.test(s) && !/delegated two/.test(s))
check('but they are counted', /2 runs folded/.test(flat(s)), flat(s).slice(0, 200))
check('a session with no conversation is never a row', !/^\s*❯?\s*tmp\b/m.test(s))
check('and it is counted too', /1 empty/.test(flat(s)), flat(s).slice(0, 200))
check('the count reflects only what is shown', /3 sessions/.test(flat(s)), flat(s).slice(0, 200))
check('metadata rides under each title', /2\.0 KB/.test(flat(s)) && /deepseek-v4-pro/.test(flat(s)))
check('focus starts on the MRU top row (gamma)', /❯\s*gamma/.test(s), s.split('\n').filter(l => l.includes('❯')).join('|'))

// ── held arrow keys ─────────────────────────────────────────────────────
// A held key (or a paste) arrives as several key events out of ONE stdin
// chunk, all handled before React re-renders. Every one of them must move
// the cursor; a handler reading its start position from the render closure
// would compute them all from the same row and keep only the last.
await windowed(() => stdin.write('\x1b[B\x1b[B'), 450) // two ↓ in one chunk
s = screen()
check('two arrows in one chunk move two rows, not one', /❯\s*alpha/.test(s), s.split('\n').filter(l => l.includes('❯')).join('|'))
await windowed(() => stdin.write('\x1b[A\x1b[A'), 450) // two ↑ back to the top
check('and back again', /❯\s*gamma/.test(screen()))
// Control bytes this screen does not claim must never be typed into the
// search box. A chord arriving as raw C0 (here two ctrl+s in one chunk, which
// the parser hands over as literal control characters rather than as the
// shortcut) used to land in the query and leave a filter matching nothing,
// with nothing on screen to explain why the list went empty.
await windowed(() => stdin.write('\x13\x13'), 500)
// An empty query still shows the placeholder; a polluted one would not.
check('unclaimed control bytes never reach the search box', /Type to search/.test(flat(screen())), flat(screen()).slice(0, 200))
check('and the list is untouched by them', /gamma/.test(screen()) && /alpha/.test(screen()) && /3 sessions/.test(flat(screen())))

// ── search ──────────────────────────────────────────────────────────────
await windowed(() => stdin.write('alph'), 400)
s = screen()
check('typing filters the list', /alpha/.test(s) && !/gamma/.test(s), flat(s).slice(0, 200))
check('the cursor lands on the surviving row', /❯\s*alpha/.test(s))
await windowed(() => stdin.write('\x7f'), 300) // backspace
s = screen()
check('backspace widens the query again', /alpha/.test(s))
await windowed(() => stdin.write('\x1b'), 350) // Esc clears the query first
s = screen()
check('Esc clears the query rather than leaving', /gamma/.test(s) && /Resume session/.test(flat(s)))

// ── reveal the delegated runs ───────────────────────────────────────────
await windowed(() => stdin.write('\x13'), 400) // ctrl+s
s = screen()
check('ctrl+s reveals the delegated runs', /audit run/.test(s), flat(s).slice(0, 300))
check('nothing is folded any more', /0 runs folded/.test(flat(s)) || !/runs folded/.test(flat(s)))
const runLine = s.split('\n').find((l) => l.includes('audit run')) ?? ''
check('a run is indented under its parent', /^\s{3,}/.test(runLine), JSON.stringify(runLine))
await windowed(() => stdin.write('\x13'), 400) // fold them back
check('ctrl+s folds them away again', !/audit run/.test(screen()))

// ── rename, and the cursor that follows it ──────────────────────────────
await windowed(() => stdin.write('\x1b[B'), 300) // ↓ → beta
s = await windowed(() => stdin.write('\x12'), 350) // ctrl+r → rename
check('rename prefills the editor with the focused title', /✎ beta/.test(flat(s)), flat(s).slice(-160))
await windowed(() => stdin.write('renamed'), 250)
await windowed(() => stdin.write('\r'), 700)
check(
  'the rename call hit the intended session',
  channel.calls.rename.length === 1 && channel.calls.rename[0][0] === 's-mid',
  JSON.stringify(channel.calls.rename),
)
await sleep(60)
s = screen()
const renamedRow = s.split('\n').find((l) => l.includes('betarenamed')) ?? ''
check(
  'the cursor followed the renamed session to its new position',
  /❯\s*betarenamed/.test(renamedRow),
  JSON.stringify(renamedRow),
)

// ── delete: the guard, the cancel, the commit ───────────────────────────
// Composed screen, not the painted window: the notice row this replaces sat
// on the same line, so the per-cell diff legitimately emits only the changed
// characters and a regex over those bytes can never match.
await windowed(() => stdin.write('\x04'), 400) // ctrl+d
check('the confirmation names the focused session', /Delete "betarenamed"/.test(flat(screen())), flat(screen()).slice(-220))
await windowed(() => stdin.write('\x1b[13;5u'), 400) // Ctrl+Enter must not confirm
check('Ctrl+Enter does not confirm an irreversible delete', channel.calls.delete.length === 0, JSON.stringify(channel.calls.delete))
await windowed(() => stdin.write('\x1b'), 350) // Esc cancels
check('Esc cancels the confirmation', !/Delete "/.test(flat(screen())) && channel.calls.delete.length === 0)
await windowed(() => stdin.write('\x04'), 400)
await windowed(() => stdin.write('\x1b[13u\x1b[13u'), 700)
check(
  'repeated Enter commits one delete, on the session the confirmation named',
  channel.calls.delete.length === 1 && channel.calls.delete[0] === 's-mid',
  JSON.stringify(channel.calls.delete),
)
// The notice line names what was deleted, so "gone" is asserted on the list
// itself: one fewer session, and no row carrying that title any more.
s = screen()
check('the browser says what it did, on the screen the user is looking at', /Deleted session betarenamed/.test(flat(s)), flat(s).slice(-200))
check('the deleted row leaves the list', /2 sessions/.test(flat(s)) && !s.split('\n').some(l => /^[❯\s]*betarenamed/.test(l)), flat(s).slice(0, 200))

// ── leaving ─────────────────────────────────────────────────────────────
await windowed(() => stdin.write('\x1b'), 500)
s = screen()
check('Esc leaves the browser and restores the conversation', !/Resume session/.test(flat(s)), flat(s).slice(0, 160))

instance.unmount()
instances.delete(process.stdout)

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall session-browser checks passed')
