#!/usr/bin/env node
/**
 * Headless regression for the /resume picker keyboard flows (4-PR review
 * leftovers) through the REAL Chat screen (compiled lib), in the
 * verify-effort-slider-ui style: fake stdin drives the real useInput path.
 *
 * Covers:
 *   1. rename re-anchor: renaming a non-top row bumps its MRU (the stub
 *      reorders), the list re-sorts, and focus must FOLLOW the renamed row
 *      — a kept stale index would silently point at a different session and
 *      a following Enter/ctrl+d would act on the wrong one;
 *   2. confirm-delete Enter guard: with the confirmation open, Ctrl+Enter
 *      (CSI 13;5u) must NOT delete; only a plain Enter may confirm an
 *      irreversible delete;
 *   3. Esc cancels a confirmation without touching the channel.
 *
 * Assertion discipline: ink repaints only changed lines, so each step opens
 * a FRESH output window (frames cleared before the action) and asserts only
 * on what that window painted.
 *
 * Run with plain node against the compiled lib:
 *   node scripts/verify-resume-picker-ui.mjs
 * Exits 1 on any failed assertion (CI gate).
 */
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import { render } from '../lib/types/ui.js'
import { Chat } from '../lib/types/screens/Chat.js'
import { setLang } from '../lib/types/i18n.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeStreams() {
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdout.frames.push(String(chunk))
      cb()
    },
  })
  stdout.columns = 110
  stdout.rows = 34
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

function makeChannel() {
  // MRU order: gamma (newest) → beta → alpha (oldest).
  const sessions = [
    { id: 's-new', title: 'gamma', cwd: '/tmp', createdAt: 3, updatedAt: 3 },
    { id: 's-mid', title: 'beta', cwd: '/tmp', createdAt: 2, updatedAt: 2 },
    { id: 's-old', title: 'alpha', cwd: '/tmp', createdAt: 1, updatedAt: 1 },
  ]
  const calls = { rename: [], delete: [] }
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
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    modeIndex: 0,
    // The real channel's rename touches MRU (verify-resume-rename-mru), so
    // the renamed session jumps to the top — mirror that here.
    async renameSessionTo(id, title) {
      calls.rename.push([id, title])
      const i = sessions.findIndex((s) => s.id === id)
      if (i < 0) return false
      const [s] = sessions.splice(i, 1)
      sessions.unshift({ ...s, title })
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
    .replace(/\x1b\[(\d+)C/g, () => ' '.repeat(8))
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
await sleep(700)

/** The window flattened to one space-normalized line (chunk splits can
 *  separate a label from its value by cursor moves). */
const flat = (s) => s.replace(/\s+/g, ' ')

/** Open a fresh output window, run the action, return what got painted. */
async function windowed(action, settle = 300) {
  stdout.frames.length = 0
  action()
  await sleep(settle)
  return toPlain(stdout.frames.join(''))
}

// Pin UI language: the picker chrome is localized (picker i18n branch),
// so the en assertions below must not depend on the host's persisted /lang.
setLang('en')

// ── open the picker ─────────────────────────────────────────────────────────
let s = await windowed(() => stdin.write('/resume'), 250)
s += await windowed(() => stdin.write('\r'), 500)
check('picker opens listing all three sessions', /Resume/.test(s) && /gamma/.test(s) && /beta/.test(s) && /alpha/.test(s))
check('focus starts on the MRU top row (gamma)', /❯\s*gamma/.test(s), s.split('\n').filter(l => l.includes('❯')).join('|'))

// ── 1. rename re-anchor ─────────────────────────────────────────────────────
await windowed(() => stdin.write('\x1b[B')) // ↓ → beta (proven by the rename target below)
s = await windowed(() => stdin.write('\x12')) // ctrl+r → rename mode
check('rename mode shows the inline editor prefilled with beta', /✎ beta/.test(flat(s)), flat(s).slice(-160))
await windowed(() => stdin.write('renamed'), 250)
s = await windowed(() => stdin.write('\r'), 600) // save → 'betarenamed'
check('rename call hit the intended session (beta/s-mid)',
  channel.calls.rename.length === 1 && channel.calls.rename[0][0] === 's-mid',
  JSON.stringify(channel.calls.rename))
check('focus followed the renamed row to its new top position',
  /❯\s*betarenamed/.test(s),
  s.split('\n').filter(l => l.includes('❯')).join('|'))

// ── 2. confirm-delete Enter guard ───────────────────────────────────────────
s = await windowed(() => stdin.write('\x04'), 400) // ctrl+d on the focused row
check('delete confirmation names the focused session', /Delete "betarenamed"/.test(flat(s)), flat(s).slice(-160))
await windowed(() => stdin.write('\x1b[13;5u'), 400) // Ctrl+Enter must NOT confirm
check('Ctrl+Enter does not confirm the delete', channel.calls.delete.length === 0, JSON.stringify(channel.calls.delete))
// Survival is behavioral: an ignored key paints nothing, so prove the
// confirmation is STILL OPEN by completing it with a plain Enter — the
// delete must land on the row the confirmation named.
await windowed(() => stdin.write('\r'), 600)
check('plain Enter afterwards still confirms (confirmation survived Ctrl+Enter)',
  channel.calls.delete.length === 1 && channel.calls.delete[0] === 's-mid',
  JSON.stringify(channel.calls.delete))

// ── 3. Esc cancels; plain Enter confirms ────────────────────────────────────
// After the delete the focus clamps to the new top row (gamma).
s = await windowed(() => stdin.write('\x04'), 400) // ctrl+d on gamma
check('confirmation retargets gamma', /Delete "gamma"/.test(flat(s)), flat(s).slice(-160))
s = await windowed(() => stdin.write('\x1b'), 400) // Esc cancels
check('Esc cancels the confirmation', !/Delete "/.test(flat(s)) && channel.calls.delete.length === 1)
await windowed(() => stdin.write('\x04'), 400) // ctrl+d on gamma again
s = await windowed(() => stdin.write('\r'), 600) // plain Enter confirms
check('plain Enter confirms the delete', channel.calls.delete.length === 2 && channel.calls.delete[1] === 's-new', JSON.stringify(channel.calls.delete))
// The row is gone from the picker (the 'Deleted session gamma' notify still
// names it — match the ROW shape: title followed by its timestamp).
check('deleted row disappears from the picker', !/gamma Jan/.test(flat(s)), flat(s).slice(-200))

instance.unmount()

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall resume-picker checks passed')
