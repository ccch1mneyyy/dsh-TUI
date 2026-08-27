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
 *   7. right-click: a session row opens a pointer-anchored action menu
 *      (open/pin/rename/delete); keyboard and mouse both drive it, modal
 *      screens keep it inert, outside clicks dismiss it, and it clamps
 *      inside the terminal.
 *   8. pinning: ctrl+p and the in-row star toggle a session into a top
 *      "Pinned" group (and back), the star click never resumes, the pin
 *      is persisted to ~/.dsh-tui/session-pins.json, delete clears it,
 *      pins for sessions that no longer exist are lazily ignored, and
 *      modals keep both paths inert.
 *
 * Assertion discipline: ink repaints only changed lines, so each step opens a
 * FRESH output window and asserts on what that window painted; checks that
 * depend on final placement read the composed xterm screen instead.
 *
 * Run: `node scripts/verify-session-browser.mjs`
 * Exits 1 on any failed assertion (CI gate).
 */
import './lib/fake-home.mjs'
import { Writable, PassThrough } from 'node:stream'
import xtermPkg from '@xterm/headless'
import React from 'react'
import { render } from '../lib/types/ui.js'
import { Chat } from '../lib/types/screens/Chat.js'
import { setLang } from '../lib/types/i18n.js'
import { readSessionPins, writeSessionPins } from '../lib/types/sessionPins.js'
import instances from '../lib/types/ink/instances.js'
import { settle, settled, sleep } from './lib/term-test.mjs'

const { Terminal } = xtermPkg

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}
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
  // The live session is a model-switch fork. Its current lineage must not be
  // offered as a separate resumable conversation; the remaining MRU order is
  // gamma (newest) → beta → alpha, plus one foreign-directory conversation,
  // two delegated runs under beta and one boot artifact holding no conversation.
  let sessions = [
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
  const calls = { rename: [], delete: [], preview: [], resume: [] }
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
// does. Without this the browser would render with inline geometry and the
// test would be measuring an artefact of its own rig.
for (const value of instances.values()) instances.set(process.stdout, value)

const flat = (s) => s.replace(/\s+/g, ' ')

/** The composed screen, as the user sees it. Reads from baseY: before the
 *  browser enters the alternate screen the harness is in inline mode, where
 *  scrollback would shift the viewport (baseY is 0 in the alt screen). */
const screen = () => {
  const buf = stdout.term.buffer.active
  return Array.from({ length: stdout.term.rows }, (_, y) =>
    (buf.getLine(buf.baseY + y)?.translateToString(true) ?? '').replace(/\s+$/, ''))
    .join('\n')
}

async function windowed(action, settleMs = 300) {
  stdout.frames.length = 0
  action()
  await sleep(settleMs)
  return toPlain(stdout.frames.join(''))
}

setLang('en')

// 启动落定：composer 提示符出现即可接收输入。
await settle(() => screen().includes('❯'))

// ── open the browser ────────────────────────────────────────────────────
stdin.write('/resume')
await settle(() => flat(screen()).includes('/resume'))
stdin.write('\r')
check('the browser opens as a screen', await settled(() => /Resume session/.test(flat(screen()))), flat(screen()).slice(0, 120))
check('conversations are listed', await settled(() => /gamma/.test(screen()) && /beta/.test(screen()) && /alpha/.test(screen())))
let s = screen()
check('the current model-switch lineage is not offered as another conversation', !/before model switch/.test(s) && !/after model switch/.test(s))
check('delegated runs are NOT listed by default', !/delegated one/.test(s) && !/delegated two/.test(s))
check('but they are counted', await settled(() => /2 runs folded/.test(flat(screen()))), flat(screen()).slice(0, 200))
check('a session with no conversation is never a row', !/^\s*❯?\s*tmp\b/m.test(s))
check('and it is counted too', await settled(() => /1 empty/.test(flat(screen()))), flat(screen()).slice(0, 200))
check('the count reflects only what is shown', await settled(() => /3 sessions/.test(flat(screen()))), flat(screen()).slice(0, 200))
check('metadata rides under each title', await settled(() => /2\.0 KB/.test(flat(screen())) && /deepseek-v4-pro/.test(flat(screen()))))
check('focus starts on the MRU top row (gamma)', await settled(() => /❯\s*[★☆]\s*gamma/.test(screen())), screen().split('\n').filter(l => l.includes('❯')).join('|'))
check('a foreign directory is hidden until its scope is selected', !/delta other workspace/.test(screen()))

// ── explicit working-directory menu ─────────────────────────────────────
stdin.write('\x1b[D') // ← opens the directory layer
check('left opens the visible working-directory menu',
  await settled(() => /Choose working directory/.test(flat(screen())) && /All working directories/.test(flat(screen()))),
  flat(screen()).slice(0, 260))
check('the directory menu exposes the foreign path', /\/other\/project/.test(screen()), flat(screen()).slice(0, 300))
stdin.write('\x1b[B') // current → foreign (all is above current)
check('directory focus moves independently from session focus',
  await settled(() => /❯\s*▣\s*project/.test(screen())),
  screen().split('\n').filter(line => line.includes('❯')).join('|'))
stdin.write('\r')
check('choosing a directory scopes the session list',
  await settled(() => /delta other workspace/.test(screen()) && !/gamma/.test(screen())),
  flat(screen()).slice(0, 280))
stdin.write('\x01') // ctrl+a = all directories quick toggle
check('ctrl+a still provides the all-directories fast path',
  await settled(() => /delta other workspace/.test(screen()) && /gamma/.test(screen()) && /all working directories/i.test(flat(screen()))))
stdin.write('\x01') // all → current
check('ctrl+a toggles back to the current directory',
  await settled(() => /gamma/.test(screen()) && !/delta other workspace/.test(screen()) && /Working directory\s+\/tmp/.test(flat(screen()))))
check('returning to current scope restores the MRU focus', await settled(() => /❯\s*[★☆]\s*gamma/.test(screen())))

// ── mouse wheel ─────────────────────────────────────────────────────────
// Wheel events arrive as SGR mouse sequences over the list region, exactly
// as a real fullscreen terminal delivers them. Rolling walks the cursor one
// session per notch (the window is cursor-follow, so rolling IS scrolling).
const wheelRow = screen().split('\n').findIndex(l => /❯\s*[★☆]\s*gamma/.test(l)) + 1 // SGR is 1-indexed
stdin.write(`\x1b[<65;10;${wheelRow}M`) // wheel-down
check('mouse wheel-down moves the focus one session', await settled(() => /❯\s*[★☆]\s*beta/.test(screen())), screen().split('\n').filter(l => l.includes('❯')).join('|'))
stdin.write(`\x1b[<64;10;${wheelRow}M`) // wheel-up
check('mouse wheel-up moves it back', await settled(() => /❯\s*[★☆]\s*gamma/.test(screen())), screen().split('\n').filter(l => l.includes('❯')).join('|'))

// ── held arrow keys ─────────────────────────────────────────────────────
// A held key (or a paste) arrives as several key events out of ONE stdin
// chunk, all handled before React re-renders. Every one of them must move
// the cursor; a handler reading its start position from the render closure
// would compute them all from the same row and keep only the last.
stdin.write('\x1b[B\x1b[B') // two ↓ in one chunk
check('two arrows in one chunk move two rows, not one', await settled(() => /❯\s*[★☆]\s*alpha/.test(screen())), screen().split('\n').filter(l => l.includes('❯')).join('|'))
stdin.write('\x1b[A\x1b[A') // two ↑ back to the top
check('and back again', await settled(() => /❯\s*[★☆]\s*gamma/.test(screen())))
// Control bytes this screen does not claim must never be typed into the
// search box. A chord arriving as raw C0 (here two ctrl+s in one chunk, which
// the parser hands over as literal control characters rather than as the
// shortcut) used to land in the query and leave a filter matching nothing,
// with nothing on screen to explain why the list went empty.
// Stability probe (the query and list must NOT change; the expected final
// screen equals the current one, so a settle would return immediately) —
// keep the fixed window for a wrong repaint to show up.
await windowed(() => stdin.write('\x13\x13'), 500)
// An empty query still shows the placeholder; a polluted one would not.
check('unclaimed control bytes never reach the search box', /Type to search/.test(flat(screen())), flat(screen()).slice(0, 200))
check('and the list is untouched by them', /gamma/.test(screen()) && /alpha/.test(screen()) && /3 sessions/.test(flat(screen())))

// ── search ──────────────────────────────────────────────────────────────
stdin.write('alph')
check('typing filters the list', await settled(() => /alpha/.test(screen()) && !/gamma/.test(screen())), flat(screen()).slice(0, 200))
check('the cursor lands on the surviving row', await settled(() => /❯\s*[★☆]\s*alpha/.test(screen())))
// Fixed window kept: the assertion condition (/alpha/) already holds before
// the backspace — the only change is one query character, which these
// regexes cannot distinguish ('alpha' contains 'alph'), so a settle would
// return on the stale screen.
await windowed(() => stdin.write('\x7f'), 300) // backspace
s = screen()
check('backspace widens the query again', /alpha/.test(s))
stdin.write('\x1b') // Esc clears the query first
check('Esc clears the query rather than leaving',
  await settled(() => /gamma/.test(screen()) && /Resume session/.test(flat(screen()))))

// ── right-click context menu ───────────────────────────────────────────
// SGR button 2 = right press. The menu must appear on press, anchored at
// the pointer, and must NOT trigger the row's left-click resume path.
const gammaLine = screen().split('\n').findIndex(l => /❯\s*[★☆]\s*gamma/.test(l))
const menuSgr = (col, row) => `\x1b[<2;${col};${row}M\x1b[<2;${col};${row}m`
stdin.write(menuSgr(30, gammaLine + 1))
check('right-click on a session row opens the action menu',
  await settled(() => /Open/.test(screen()) && /Rename/.test(screen()) && /Delete/.test(screen())),
  flat(screen()).slice(0, 260))
check('a right-click does not resume the session',
  channel.calls.resume.length === 0, JSON.stringify(channel.calls.resume))
{
  const lines = screen().split('\n')
  check('the menu is anchored just past the pointer, not at the screen top',
    /Open/.test(lines[gammaLine + 2] ?? ''),
    JSON.stringify(lines.slice(gammaLine, gammaLine + 4)))
}
// ↑/↓ move the keyboard cursor; Enter runs the highlighted action. Both
// keys go in ONE write so they land in the same stdin chunk — the exact
// path the menuRef exists for (↓ must move the item before Enter reads it).
// Two ↓: the menu is open/pin/rename/delete, so rename is the THIRD item.
stdin.write('\x1b[B\x1b[B\r')
check('menu Enter runs the highlighted action (rename)',
  await settled(() => /✎ gamma/.test(flat(screen()))), flat(screen()).slice(-200))
stdin.write('\x1b') // leave the rename editor
await settle(() => !/✎ gamma/.test(flat(screen())))
// Mouse activation: reopen, then left-click the Delete item. The popup is
// anchored at the pointer (menuCol → screen col 30), so the click must land
// INSIDE the popup's span — a click outside it would dismiss the menu by
// design.
stdin.write(menuSgr(30, gammaLine + 1))
await settle(() => /Open/.test(screen()))
const deleteItemLine = screen().split('\n').findIndex(l => /Delete/.test(l))
stdin.write(`\x1b[<0;34;${deleteItemLine + 1}M\x1b[<0;34;${deleteItemLine + 1}m`)
check('left-clicking a menu item runs it (delete → confirmation)',
  await settled(() => /Delete "gamma"/.test(flat(screen()))), flat(screen()).slice(-220))
// While a confirmation is up, right-click must not open a menu.
stdin.write(menuSgr(30, gammaLine + 1))
await sleep(250)
check('a right-click during the delete confirmation opens no menu',
  !/Open/.test(screen()) && /Delete "gamma"/.test(flat(screen())), flat(screen()).slice(-220))
stdin.write('\x1b') // cancel the confirmation
await settle(() => !/Delete "gamma"/.test(flat(screen())))
// Outside click dismisses the menu without acting on the row beneath.
stdin.write(menuSgr(30, gammaLine + 1))
await settle(() => /Open/.test(screen()))
stdin.write(`\x1b[<0;5;${ROWS}M\x1b[<0;5;${ROWS}m`) // hint row: no handler
await sleep(250)
check('a left-click outside the menu dismisses it and resumes nothing',
  !/Open/.test(screen()) && channel.calls.resume.length === 0 && /❯\s*[★☆]\s*gamma/.test(screen()),
  flat(screen()).slice(0, 240))
// Left-clicking ANOTHER session row while the menu is open must be inert
// (rows carry onClick but the menu gates them): the menu closes, nothing
// resumes, and the cursor stays where it was.
stdin.write(menuSgr(30, gammaLine + 1))
await settle(() => /Open/.test(screen()))
const betaLine = screen().split('\n').findIndex(l => /^\s*beta\b/.test(l))
stdin.write(`\x1b[<0;6;${betaLine + 1}M\x1b[<0;6;${betaLine + 1}m`)
await sleep(250)
check('left-clicking another row while the menu is open only dismisses it',
  !/Open/.test(screen()) && channel.calls.resume.length === 0 && /❯\s*[★☆]\s*gamma/.test(screen()),
  flat(screen()).slice(0, 240))
// Right-click near the right edge: the popup clamps inside the terminal.
stdin.write(menuSgr(COLS - 2, gammaLine + 1))
await settle(() => /Open/.test(screen()))
{
  const lines = screen().split('\n')
  const openLine = lines.findIndex(l => /Open/.test(l))
  check('a menu near the right edge clamps to the terminal width',
    openLine >= 0 && (lines[openLine]?.length ?? 0) === COLS,
    openLine >= 0 ? `line=${JSON.stringify(lines[openLine])}` : 'menu missing')
}
stdin.write('\x1b') // dismiss
await settle(() => !/Open/.test(screen()))
// Right-click on chrome with no handler opens nothing.
stdin.write(menuSgr(5, ROWS))
await sleep(250)
check('a right-click on empty chrome opens no menu',
  !/Open/.test(screen()) && !/Rename/.test(screen()), flat(screen()).slice(0, 200))

// ── reveal the delegated runs ───────────────────────────────────────────
stdin.write('\x13') // ctrl+s
check('ctrl+s reveals the delegated runs', await settled(() => /audit run/.test(screen())), flat(screen()).slice(0, 300))
s = screen()
check('nothing is folded any more', /0 runs folded/.test(flat(s)) || !/runs folded/.test(flat(s)))
const runLine = s.split('\n').find((l) => l.includes('audit run')) ?? ''
check('a run is indented under its parent', /^\s{3,}/.test(runLine), JSON.stringify(runLine))
stdin.write('\x13') // fold them back
check('ctrl+s folds them away again', await settled(() => !/audit run/.test(screen())))

// ── rename, and the cursor that follows it ──────────────────────────────
stdin.write('\x1b[B') // ↓ → beta
await settle(() => /❯\s*[★☆]\s*beta/.test(screen()))
// The prefill assertion reads the PAINTED window (per-cell diff semantics),
// so poll the accumulating frame bytes for the same condition.
stdout.frames.length = 0
stdin.write('\x12') // ctrl+r → rename
check('rename prefills the editor with the focused title',
  await settled(() => /✎ beta/.test(flat(toPlain(stdout.frames.join(''))))),
  flat(toPlain(stdout.frames.join(''))).slice(-160))
const renameForeignRow = screen().split('\n').findIndex(line => line.includes('gamma')) + 1
stdin.write(`\x1b[<0;6;${renameForeignRow}M\x1b[<0;6;${renameForeignRow}m`)
await sleep(250)
check(
  'rename mode makes other session rows inert to mouse clicks',
  channel.calls.resume.length === 0 && /✎\s*beta/.test(flat(screen())) && /❯\s*[★☆]\s*beta/.test(screen()),
  JSON.stringify({ resume: channel.calls.resume, focus: screen().split('\n').find(line => line.includes('❯')) }),
)
stdin.write('renamed')
await settle(() => /betarenamed/.test(screen()))
stdin.write('\r')
check(
  'the rename call hit the intended session',
  await settled(() => channel.calls.rename.length === 1 && channel.calls.rename[0][0] === 's-mid'),
  JSON.stringify(channel.calls.rename),
)
check(
  'the cursor followed the renamed session to its new position',
  await settled(() => {
    const row = screen().split('\n').find((l) => l.includes('betarenamed')) ?? ''
    return /❯\s*[★☆]\s*betarenamed/.test(row)
  }),
  JSON.stringify(screen().split('\n').find((l) => l.includes('betarenamed')) ?? ''),
)

// ── delete: the guard, the cancel, the commit ───────────────────────────
// Composed screen, not the painted window: the notice row this replaces sat
// on the same line, so the per-cell diff legitimately emits only the changed
// characters and a regex over those bytes can never match.
stdin.write('\x04') // ctrl+d
check('the confirmation names the focused session',
  await settled(() => /Delete "betarenamed"/.test(flat(screen()))), flat(screen()).slice(-220))
const deleteForeignRow = screen().split('\n').findIndex(line => line.includes('alpha')) + 1
stdin.write(`\x1b[<0;6;${deleteForeignRow}M\x1b[<0;6;${deleteForeignRow}m`)
await sleep(250)
check(
  'delete confirmation makes other session rows inert to mouse clicks',
  channel.calls.resume.length === 0 && /Delete "betarenamed"/.test(flat(screen())) && /❯\s*[★☆]\s*betarenamed/.test(screen()),
  JSON.stringify({ resume: channel.calls.resume, confirmation: flat(screen()).slice(-180) }),
)
// Negative probe (Ctrl+Enter must NOT confirm): nothing is supposed to
// change, so a settle would return immediately — keep the fixed window.
await windowed(() => stdin.write('\x1b[13;5u'), 400) // Ctrl+Enter must not confirm
check('Ctrl+Enter does not confirm an irreversible delete', channel.calls.delete.length === 0, JSON.stringify(channel.calls.delete))
stdin.write('\x1b') // Esc cancels
check('Esc cancels the confirmation',
  await settled(() => !/Delete "/.test(flat(screen())) && channel.calls.delete.length === 0))
stdin.write('\x04')
await settle(() => /Delete "betarenamed"/.test(flat(screen())))
stdin.write('\x1b[13u\x1b[13u')
// 先等屏幕呈现删除结果（两次 Enter 同批处理完毕），再断言「恰好一次」：
// 直接对 delete.length === 1 轮询可能在第二次 Enter 生效前提前通过。
const deleteEffectsPainted = await settled(() =>
  /Deleted session betarenamed/.test(flat(screen())) && /2 sessions/.test(flat(screen())))
check(
  'repeated Enter commits one delete, on the session the confirmation named',
  channel.calls.delete.length === 1 && channel.calls.delete[0] === 's-mid',
  JSON.stringify(channel.calls.delete),
)
// The notice line names what was deleted, so "gone" is asserted on the list
// itself: one fewer session, and no row carrying that title any more.
s = screen()
check('the browser says what it did, on the screen the user is looking at', deleteEffectsPainted && /Deleted session betarenamed/.test(flat(s)), flat(s).slice(-200))
check('the deleted row leaves the list', /2 sessions/.test(flat(s)) && !s.split('\n').some(l => /^[❯★☆\s]*betarenamed/.test(l)), flat(s).slice(0, 200))

// ── pin: the star, the group, the cleanup ───────────────────────────────
// The list is now gamma (MRU top) and alpha. Every row carries a ☆ slot; a
// pin turns it into ★ and lifts the row into a "Pinned" group at the top.
await settle(() => /❯\s*☆\s*gamma/.test(screen()))
stdin.write('\x10') // ctrl+p
check('ctrl+p pins the focused session',
  await settled(() => /❯\s*★\s*gamma/.test(screen()) && /★\s*Pinned/.test(flat(screen()))),
  flat(screen()).slice(0, 200))
{
  const lines = screen().split('\n')
  const headerIdx = lines.findIndex(l => /★\s*Pinned/.test(l))
  const gammaIdx = lines.findIndex(l => /★\s*gamma/.test(l))
  const alphaIdx = lines.findIndex(l => /☆\s*alpha/.test(l))
  check('the pinned group sits above the ordinary rows',
    headerIdx >= 0 && gammaIdx === headerIdx + 1 && alphaIdx > gammaIdx,
    JSON.stringify({ headerIdx, gammaIdx, alphaIdx }))
}
check('the pin is persisted', [...readSessionPins()].join(',') === 's-new', [...readSessionPins()].join(','))
// Clicking the star of ANOTHER row pins it and must never resume: the star
// is a control on the row, not the row. The ☆ sits two columns in (focus
// marker + star), so the SGR click lands on column 3.
{
  const alphaStarRow = screen().split('\n').findIndex(l => /☆\s*alpha/.test(l)) + 1
  stdin.write(`\x1b[<0;3;${alphaStarRow}M\x1b[<0;3;${alphaStarRow}m`)
  check('clicking the star pins without resuming',
    await settled(() => /★\s*alpha/.test(screen()) && channel.calls.resume.length === 0),
    JSON.stringify({ resume: channel.calls.resume }))
}
// The right-click menu's pin item is state-aware: pinned ⇒ "Unpin".
{
  const gammaMenuRow = screen().split('\n').findIndex(l => /★\s*gamma/.test(l)) + 1
  stdin.write(menuSgr(30, gammaMenuRow))
  await settled(() => /Unpin/.test(screen()))
  check('the menu offers Unpin for a pinned session',
    /Unpin/.test(screen()) && !/Pin to top/.test(screen()), flat(screen()).slice(0, 240))
  const unpinItemRow = screen().split('\n').findIndex(l => /Unpin/.test(l)) + 1
  // Col 34 sits inside the popup (anchored at the pointer col 30 + 1).
  stdin.write(`\x1b[<0;34;${unpinItemRow}M\x1b[<0;34;${unpinItemRow}m`)
  check('the menu item unpins the session',
    await settled(() => /☆\s*gamma/.test(screen()) && /★\s*alpha/.test(screen())),
    JSON.stringify(screen().split('\n').filter(l => /gamma|alpha|Pinned|Open|Unpin|Rename|Delete|✎/.test(l))))
}
// Modals keep both pin paths inert: ctrl+p must not toggle, and the star
// must not even be a click target while the rename editor is up.
stdin.write('\x12') // ctrl+r → rename
await settled(() => /✎ gamma/.test(flat(screen())))
const pinsBeforeModal = [...readSessionPins()].sort().join(',')
await windowed(() => stdin.write('\x10'), 300) // ctrl+p during rename
{
  const alphaStarRow = screen().split('\n').findIndex(l => /[★☆]\s*alpha/.test(l)) + 1
  await windowed(() => stdin.write(`\x1b[<0;3;${alphaStarRow}M\x1b[<0;3;${alphaStarRow}m`), 300)
}
check('ctrl+p and the star stay inert under a modal',
  [...readSessionPins()].sort().join(',') === pinsBeforeModal && channel.calls.resume.length === 0,
  JSON.stringify({ pins: [...readSessionPins()], resume: channel.calls.resume }))
stdin.write('\x1b') // leave the rename editor
await settled(() => !/✎ gamma/.test(flat(screen())))
// Delete clears the pin with the session: wrap ↓ from gamma (last row) to
// alpha (first selectable), then delete it.
stdin.write('\x1b[B')
await settled(() => /❯\s*★\s*alpha/.test(screen()))
stdin.write('\x04')
await settled(() => /Delete "alpha"/.test(flat(screen())))
stdin.write('\r')
check('deleting a pinned session clears its pin',
  await settled(() => !readSessionPins().has('s-old') && !/Pinned/.test(flat(screen()))),
  JSON.stringify([...readSessionPins()]))
// Reopening the browser re-reads the pin file; pins whose sessions are gone
// are lazily ignored — no row, no error, and the file is left untouched.
stdin.write('\x1b') // Esc leaves the browser
await settled(() => !/Resume session/.test(flat(screen())))
writeSessionPins(['ghost-session', 's-new'])
stdin.write('/resume')
await settled(() => flat(screen()).includes('/resume'))
stdin.write('\r')
check('a reopened browser ignores pins for missing sessions',
  await settled(() => /Resume session/.test(flat(screen())) && /❯\s*★\s*gamma/.test(screen())),
  flat(screen()).slice(0, 200))
s = screen()
check('a ghost pin never becomes a row',
  /Pinned/.test(flat(s)) && !s.split('\n').some(l => /ghost/.test(l)) && [...readSessionPins()].includes('ghost-session'),
  JSON.stringify([...readSessionPins()]))

// ── resume failure detail ──────────────────────────────────────────────────
stdin.write('\r')
const failureShown = await settled(() => /corrupt session log: seq gap in committed region/.test(flat(screen())))
s = screen()
check('a failed resume stays in the browser', /Resume session/.test(flat(s)), flat(s).slice(0, 180))
check(
  'the browser shows the real resume failure',
  failureShown,
  flat(s).slice(-220),
)
check(
  'the browser does not misreport every failure as a running model',
  !/model is working/.test(flat(s)),
  flat(s).slice(-220),
)

// ── leaving ─────────────────────────────────────────────────────────────
stdin.write('\x1b')
check('Esc leaves the browser and restores the conversation',
  await settled(() => !/Resume session/.test(flat(screen()))), flat(screen()).slice(0, 160))

instance.unmount()
instances.delete(process.stdout)

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall session-browser checks passed')
