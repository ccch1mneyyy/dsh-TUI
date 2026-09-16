#!/usr/bin/env node
/**
 * Headless regression for the session screen `/resume`, `/agentview` and
 * `/home` share — driven through the REAL Chat screen (compiled lib) with fake
 * stdin, the same harness the picker it replaces used.
 *
 * This script used to drive the pre-#879 session BROWSER: one flat list with
 * its own session-level action menu (rename/delete per session), Ctrl+P pins,
 * Ctrl+S to reveal delegated runs and a workspace-directory menu. That surface
 * is gone. Its session-level actions were not carried over: the unified screen
 * manages WORKSPACES (edit / new session here / rename / remove from list) and
 * lists the sessions of the selected workspace read-only, because the runtime
 * behind it parks sessions instead of ending them.
 *
 * So this file keeps ONE job: pin down the behaviours of the CURRENT screen
 * that `verify-session-supervisor.tsx` does not already own — the pin STORE
 * contract, and the two ends of entering a session (the pane's own rows, and
 * the failure path that must not be misreported).
 *
 * What is NO LONGER asserted here, and why (delete, do not resurrect):
 *   - session-level right-click menu, rename and delete: no such affordance on
 *     the new screen (session rows are not editable there);
 *   - Ctrl+P / in-row star pinning: the new screen has no pin affordance. The
 *     STORE still backs `sessionPins`, so its contract is still verified below;
 *   - Ctrl+S to reveal delegated runs and the "N runs folded" counter: the new
 *     list shows the workspace's conversations and folds nothing;
 *   - Ctrl+A / the working-directory menu / per-directory scoping: replaced by
 *     the workspace rail.
 *
 * Assertion discipline: ink repaints only changed lines, so each step opens a
 * FRESH output window and asserts on what that window painted; checks that
 * depend on final placement read the composed xterm screen instead.
 *
 * Run: `node scripts/verify-session-browser.mjs`
 * Exits 1 on any failed assertion (CI gate).
 */
import fakeHome from './lib/fake-home.mjs'
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Writable, PassThrough } from 'node:stream'
import xtermPkg from '@xterm/headless'
import React from 'react'
import { render } from '../lib/types/ui.js'
import { Chat } from '../lib/types/screens/Chat.js'
import { setLang } from '../lib/types/i18n.js'
import { readSessionPins, setSessionPinned, writeSessionPins } from '../lib/types/sessionPins.js'
import instances from '../lib/types/ink/instances.js'
import { settle, settled, sleep } from './lib/term-test.mjs'

const { Terminal } = xtermPkg

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// ── pin store contract ────────────────────────────────────────────────────
// Independent of any screen: private atomic replacement, fresh
// read-modify-write, corruption preservation, and lock contention failure
// without lost data. Still the store the session screen reads.
const pinDir = join(fakeHome, '.dsh-tui')
const pinFile = join(pinDir, 'session-pins.json')
const pinLock = join(pinDir, 'session-pins.lock')
check('pin store initial write succeeds', writeSessionPins(['base']))
const mergedPin = setSessionPinned('second', true)
check('pin mutation re-reads and merges the persisted set',
  mergedPin.ok && [...mergedPin.pins].sort().join(',') === 'base,second',
  JSON.stringify([...mergedPin.pins]))
check('pin file is mode 0600 on POSIX',
  process.platform === 'win32' || (statSync(pinFile).mode & 0o777) === 0o600,
  process.platform === 'win32' ? 'Windows mode bits skipped' : (statSync(pinFile).mode & 0o777).toString(8))
writeFileSync(pinFile, '{truncated', 'utf8')
const corruptBefore = readFileSync(pinFile, 'utf8')
const corruptMutation = setSessionPinned('must-not-overwrite', true)
check('malformed pin file is preserved instead of overwritten as empty',
  !corruptMutation.ok && readFileSync(pinFile, 'utf8') === corruptBefore)
check('pin store can atomically recover through an explicit full write', writeSessionPins(['base']))
writeFileSync(pinLock, `${process.pid}\n`, { mode: 0o600 })
const lockedMutation = setSessionPinned('contended', true)
check('live pin lock fails cleanly without a lost update',
  !lockedMutation.ok && [...readSessionPins()].join(',') === 'base')
rmSync(pinLock, { force: true })
check('pin store resets for the screen scenario', writeSessionPins([]))

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

const WORKSPACE = '/tmp'
const summary = (over) => ({
  id: 'id',
  kind: { kind: 'root' },
  title: { text: 'title', source: 'auto' },
  cwd: WORKSPACE,
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
  // gamma (newest) → beta → alpha, all in the terminal's own workspace. The
  // live session is a model-switch fork; its current lineage must not be
  // offered as a separate resumable conversation. The delegated runs and the
  // boot artifact (no conversation) are filtered out of the list by the screen
  // itself. One foreign-directory conversation exists but belongs to another
  // workspace, so it must not appear while /tmp is selected.
  const sessions = [
    summary({
      id: 'live-session',
      kind: { kind: 'fork', parent: 'live-parent' },
      title: { text: 'after model switch', source: 'auto' },
      updatedAt: 8,
    }),
    summary({ id: 'live-parent', title: { text: 'before model switch', source: 'auto' }, updatedAt: 7 }),
    summary({ id: 's-new', title: { text: 'gamma', source: 'auto' }, updatedAt: 5 }),
    summary({ id: 's-mid', title: { text: 'beta', source: 'auto' }, updatedAt: 4, childCount: 2 }),
    summary({ id: 's-old', title: { text: 'alpha', source: 'auto' }, updatedAt: 3 }),
    summary({ id: 's-foreign', cwd: '/other/project', title: { text: 'delta other workspace', source: 'auto' }, updatedAt: 6 }),
    summary({ id: 's-run1', title: { text: 'delegated one', source: 'prompt' }, updatedAt: 2, label: 'audit run', kind: { kind: 'subagent', parent: 's-mid', depth: 1 } }),
    summary({ id: 's-run2', title: { text: 'delegated two', source: 'prompt' }, updatedAt: 1, kind: { kind: 'subagent', parent: 's-mid', depth: 1 } }),
    summary({ id: 's-boot', title: { text: 'tmp', source: 'fallback' }, updatedAt: 6, hasPrompt: false }),
  ]
  const registry = [
    { id: 'w-tmp', path: WORKSPACE, title: 'tmp', present: true, sessionCount: 5 },
    { id: 'w-other', path: '/other/project', title: 'other', present: true, sessionCount: 1 },
  ]
  const calls = { rename: [], delete: [], resume: [], workspace: [] }
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
    cwd: WORKSPACE,
    displayCwd: WORKSPACE,
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
    // Workspace lifecycle: the screen resolves a target, the HOST switches to
    // it. `switchWorkspace` is therefore what "start a session here" reports.
    async renameWorkspaceAt(path, title) {
      calls.workspace.push(`rename:${path}:${title}`)
      const entry = registry.find((e) => e.path === path)
      if (entry === undefined) return false
      entry.title = title
      return true
    },
    async removeWorkspace(path) {
      calls.workspace.push(`remove:${path}`)
      const i = registry.findIndex((e) => e.path === path)
      if (i < 0) return false
      registry.splice(i, 1)
      return true
    },
    async resolveWorkspace(reference) {
      calls.workspace.push(`resolve:${reference}`)
      return { cwd: reference, uri: reference, label: reference, kind: 'local', badge: 'LOCAL' }
    },
    async switchWorkspace(target) {
      calls.workspace.push(`switch:${target.cwd}`)
      return true
    },
    async stopBackgroundAgent(id) {
      calls.workspace.push(`stop:${id}`)
      return true
    },
    async listWorkspaceRegistry() {
      return registry.map((e) => ({ ...e }))
    },
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
      return [{ role: 'user', text: `preview of ${id}`, at: 1 }]
    },
    notify(text, options) { this.notifications.push({ text, options }) },
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
    activityFrames: 'moon8',
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
    // The mount path must NOT silently succeed: its failure text is what the
    // screen has to surface instead of a generic "the model is working".
    resumeTo: async (id) => {
      calls.resume.push(id)
      return {
        ok: false,
        reason: 'failed',
        error: 'corrupt session log: seq gap in committed region',
      }
    },
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
// does. Without this the screen would render with inline geometry and the
// test would be measuring an artefact of its own rig.
for (const value of instances.values()) instances.set(process.stdout, value)

const flat = (s) => s.replace(/\s+/g, ' ')

/** The composed screen, as the user sees it. Reads from baseY: before the
 *  screen enters the alternate screen the harness is in inline mode, where
 *  scrollback would shift the viewport (baseY is 0 in the alt screen). */
const screen = () => {
  const buf = stdout.term.buffer.active
  return Array.from({ length: stdout.term.rows }, (_, y) =>
    (buf.getLine(buf.baseY + y)?.translateToString(true) ?? '').replace(/\s+$/, ''))
    .join('\n')
}

setLang('en')

// Startup settles once the composer prompt is up and can take input.
await settle(() => screen().includes('❯'))

// ── open the session screen ────────────────────────────────────────────────
// The screen seeds its listing asynchronously, so "it is up" is read from the
// pane header, which only carries the workspace NAME after `listSessions()`
// resolved — the banner alone appears on the first paint with no rows.
stdin.write('/resume')
await settle(() => flat(screen()).includes('/resume'))
stdin.write('\r')
check('the session screen opens as a screen',
  await settled(() => /Sessions in tmp/.test(flat(screen()))), flat(screen()).slice(0, 140))

// ── the listing ────────────────────────────────────────────────────────────
let s = screen()
check('conversations are listed', /gamma/.test(s) && /beta/.test(s) && /alpha/.test(s))
// A `/resume` fork records `parentSession` exactly like a delegated run does.
// The row for the session the terminal is IN is kept (the screen marks it
// `current`), but its ANCESTOR is the same conversation at an earlier point —
// listing both makes one conversation look like two.
check('the current session\'s fork ancestor is not offered as another conversation',
  !/before model switch/.test(s), flat(s).slice(0, 220))
check('the current session itself is listed',
  /after model switch/.test(s), flat(s).slice(0, 220))
check('delegated runs are NOT listed', !/delegated one/.test(s) && !/delegated two/.test(s))
check('a session with no conversation is never a row', !/^\s*☆ ∙ tmp\b/m.test(s))
check('a conversation from another workspace is not listed',
  !/delta other workspace/.test(s), flat(s).slice(0, 160))
check('the workspace rail lists both ledger entries', /tmp/.test(s) && /other/.test(s))
check('the filter box is live', /Type to search sessions/.test(flat(s)))
check('the new-session card is the list\'s first row', /New session/.test(flat(s)))

// ── entering a session needs the session pane ──────────────────────────────
// The keyboard opens on the RAIL, and the list's row 0 is the new-session
// card. Entering a conversation is therefore: → into the pane, ↓ past the
// card, Enter. Each step must not reach the mount path on its own.
{
  const before = channel.calls.resume.length
  stdin.write('\r')
  await sleep(200) // 固定窗:pacing Enter 处理步间，无可观测锚点
  check('Enter on the rail does not mount anything', channel.calls.resume.length === before,
    `resume calls: ${channel.calls.resume.join(', ')}`)
  // Enter on the rail opens that workspace's action menu (edit / new session /
  // rename / remove), which is a modal layer: close it before the pane tests,
  // or every later key is swallowed by the menu.
  check('Enter on the rail opens the workspace action menu',
    await settled(() => /Rename workspace/.test(screen()) && /Remove from list/.test(screen())),
    flat(screen()).slice(0, 200))
  stdin.write('\u001b')
  check('Esc closes the workspace menu without mounting anything',
    await settled(() => !/Rename workspace/.test(screen())), flat(screen()).slice(0, 160))
}
// Cursor presence is read from the buffer with escapes stripped: a captured
// row can carry a bare ANSI cursor-move in front of the glyph.
const focusedRowHas = (needle) => {
  const buf = stdout.term.buffer.active
  for (let y = 0; y < stdout.term.rows; y++) {
    const raw = buf.getLine(buf.baseY + y)?.translateToString(true) ?? ''
    if (!raw.includes(needle)) continue
    return raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').includes('❯')
  }
  return false
}
const rowOfText = (needle) => {
  const buf = stdout.term.buffer.active
  for (let y = 0; y < stdout.term.rows; y++) {
    const raw = buf.getLine(buf.baseY + y)?.translateToString(true) ?? ''
    const col = raw.indexOf(needle)
    if (col >= 0) return { row: y, col }
  }
  return null
}
/** Click the row carrying `needle`, through the renderer's hit-testing path.
 *  The pointer report goes to STDIN (the app's input), like a real terminal. */
const clickText = async (needle) => {
  await settled(() => rowOfText(needle) !== null)
  const found = rowOfText(needle)
  if (found === null) throw new Error(`row not found: ${needle}`)
  const x = found.col + 1
  const y = found.row + 1
  stdin.write(`\u001b[<0;${x};${y}M\u001b[<0;${x};${y}m`)
  await sleep(150) // 固定窗:pacing 输入泵把字节交给解析器的步间
}

// ── the filter is a live query ─────────────────────────────────────────────
// Keyboard entry (`→` into the pane, then Enter) is covered by
// verify-session-supervisor.tsx; this file drives the pointer, which is the
// path a click on a row takes: row → hit-test → openSession.
stdin.write('gamma')
check('typing narrows the list',
  await settled(() => /gamma/.test(screen()) && !/beta/.test(screen()) && !/alpha/.test(screen())),
  flat(screen()).slice(0, 220))
check('the surviving row is still listed', /gamma/.test(screen()))
stdin.write('\u007f\u007f\u007f\u007f\u007f')
check('backspace widens it again',
  await settled(() => /beta/.test(screen()) && /alpha/.test(screen())), flat(screen()).slice(0, 220))
// Esc on a NON-empty query clears it and stays on the screen; Esc on an empty
// one leaves (checked at the end). The distinction is the whole layering rule:
// getting it wrong throws the user out of the screen for one stray keypress.
stdin.write('beta')
await settled(() => !/gamma/.test(screen()))
stdin.write('\u001b')
// After the clear, the whole workspace listing is back — the lineage rows stay
// hidden, so `gamma` is the newest CONVERSATION and the click target below.
check('Esc clears a live query rather than leaving the screen',
  await settled(() => /gamma/.test(screen()) && /beta/.test(screen()) && /Sessions in tmp/.test(flat(screen()))),
  flat(screen()).slice(0, 200))

// ── resume failure ─────────────────────────────────────────────────────────
// The stub's mount always fails with a REAL error string. The host (Chat) owns
// the reason and renders it through the shared `resumeFailureText`, so the
// screen must keep that sentence intact and stay up — never collapse into "the
// model is working", which is what misreported every failure before.
await clickText('gamma')
const failureShown = await settled(() =>
  /corrupt session log: seq gap in committed region/.test(flat(screen())))
s = screen()
check('clicking a conversation reaches the mount path with THAT session',
  channel.calls.resume.includes('s-new'), `resume calls: ${channel.calls.resume.join(', ')}`)
check('a failed resume stays on the session screen',
  /Sessions in tmp/.test(flat(s)), flat(s).slice(0, 200))
check('the screen names the session it could not enter',
  /Could not enter gamma/.test(flat(s)), flat(s).slice(-260))
// The reason travels through the shared `resumeFailureText` and out on the
// channel's notification seam — the host's wording, not a re-derived one.
check('the real resume failure reached the notification seam, not a generic one',
  channel.notifications.some((n) =>
    /corrupt session log: seq gap in committed region/.test(n.text)),
  JSON.stringify(channel.notifications.map((n) => n.text)))
check('it does not misreport the failure as a running model',
  !/model is working/.test(flat(s)) &&
    !channel.notifications.some((n) => /model is working/.test(n.text)),
  flat(s).slice(-260))

// ── leaving ────────────────────────────────────────────────────────────────
// The mount failure left a notice on screen, and Esc dismisses THAT layer
// first; the second Esc is the one that leaves.
stdin.write('\u001b')
await settled(() => /Sessions in tmp/.test(flat(screen())))
stdin.write('\u001b')
check('Esc leaves the session screen and restores the conversation',
  await settled(() => !/Sessions in tmp/.test(flat(screen()))), flat(screen()).slice(0, 160))

instance.unmount()
instances.delete(process.stdout)

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall session-screen checks passed')
