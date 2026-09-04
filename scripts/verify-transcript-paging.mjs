#!/usr/bin/env node
/**
 * Transcript paging regression (compiled lib): PgUp/PgDn page the FULLSCREEN
 * transcript a viewport at a time, and stay out of the way everywhere the
 * keyboard already belongs to someone else.
 *
 * Why this exists: the fullscreen transcript had exactly one scroll input —
 * the mouse wheel. The alt screen holds no native scrollback (MessageList's
 * historyPaint gate is main-screen only), so a keyboard-only user could never
 * reach an earlier turn, while every other fullscreen surface (session
 * browser, session tree, trajectory) already paged with these very keys.
 *
 * Scenario: 60 single-line assistant rows in a 34-row viewport, pinned to the
 * bottom (sticky).
 *  - PgUp once      → the tail row leaves the viewport and a deeper row shows:
 *                     the view actually paged, it did not just clamp.
 *  - PgUp until top → the FIRST row becomes reachable (paging repeats, so the
 *                     page size is not one giant jump to 0 / a no-op).
 *  - PgDn to bottom → the tail row returns.
 *  - inline mode    → PgUp must NOT move the TUI viewport: committed history
 *                     lives in the terminal's own scrollback there, and its
 *                     paging must not be stolen (mirrors the wheel no-op).
 *  - help open      → Chat yields these keys to PromptInput's help viewport,
 *                     so the transcript behind must not move.
 *
 * Run after build: `node scripts/verify-transcript-paging.mjs`
 */
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import xtermHeadless from '@xterm/headless'
const { Terminal: XTerm } = xtermHeadless
import { render, ThemeProvider, AlternateScreen } from '../lib/types/ui.js'
import { PageMargin } from '../lib/types/components/PageMargin.js'
import { Chat } from '../lib/types/screens/Chat.js'
import { setLang } from '../lib/types/i18n.js'
import { screenHas, settled, settle, sleep } from './lib/term-test.mjs'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const TERM_ROWS = 34
const TERM_COLS = 110
/** Zero-padded so the marker never aliases another row's digits. */
const marker = i => `row${String(i).padStart(3, '0')}`
const FIRST = 0
const LAST = 59

function makeChannel() {
  const rows = []
  for (let i = FIRST; i <= LAST; i += 1) {
    rows.push({ id: i, kind: 'assistant', text: marker(i), seq: i, fresh: false })
  }
  const listeners = new Set()
  const channel = {
    version: 0,
    rows,
    status: 'idle',
    sessionTitle: 'paging',
    agentId: 'paging',
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
    statusBar: {},
    agentPreset: 'standard',
    goal: undefined,
    todos: [],
    mode: { id: 'default', plan: false, sandbox: 'workspace-write', approval: 'ask' },
    modeIndex: 0,
    cycleMode() {},
    commandList: [],
    commandCompletions: () => [],
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    notify() {},
    pushLocal() {},
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    emit() {
      channel.version += 1
      for (const l of listeners) l()
    },
    submit() {},
    steer() {},
    removePending: () => true,
    cancel() {},
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
  return channel
}

async function mount(fullscreen) {
  const term = new XTerm({ cols: TERM_COLS, rows: TERM_ROWS, allowProposedApi: true })
  const stdout = new Writable({ write(chunk, _enc, cb) { term.write(String(chunk), cb) } })
  stdout.columns = TERM_COLS
  stdout.rows = TERM_ROWS
  stdout.isTTY = true
  const stderr = new Writable({ write(_c, _e, cb) { cb() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin

  const channel = makeChannel()
  // Mirror the real fullscreen mount (dsh-adapter/plugin.ts): ThemeProvider >
  // AlternateScreen > PageMargin > Chat. The AlternateScreen wrap is not
  // cosmetic — it constrains the transcript ScrollBox to the terminal rows;
  // an unwrapped Chat grows to its content height and getViewportHeight()
  // reports the whole buffer instead of the window. Inline mounts PageMargin
  // only, matching the host's inline path.
  const chat = React.createElement(Chat, {
    channel,
    questionStore: { subscribe: () => () => {}, getSnapshot: () => null, answerCurrent: () => {} },
    fullscreen,
    onExit() {},
  })
  const tree = React.createElement(ThemeProvider, {
    children: fullscreen
      ? React.createElement(AlternateScreen, null, React.createElement(PageMargin, null, chat))
      : React.createElement(PageMargin, null, chat),
  })
  const instance = await render(tree, { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false })
  // Fixed wait: the first frame carries a random tip, so there is no stable
  // content anchor to poll for (same compromise as verify-keymap.mjs).
  await sleep(700)
  return { term, stdin, instance, channel }
}

const PGUP = '\x1b[5~'
const PGDN = '\x1b[6~'

/** Press `key` up to `max` times, stopping when `pred` holds. */
async function pageUntil(term, stdin, key, pred, max = 12) {
  let presses = 0
  while (!pred() && presses < max) {
    stdin.write(key)
    presses += 1
    await settle(pred, { timeoutMs: 1500 })
  }
  return presses
}


setLang('en')

// ---- fullscreen: the transcript pages ----
const full = await mount(true)
const tailBefore = screenHas(full.term, marker(LAST))
check('fullscreen: pinned to the bottom before any key', tailBefore)
check('fullscreen: the first row is off-screen before paging', !screenHas(full.term, marker(FIRST)))

full.stdin.write(PGUP)
await sleep(400)
const pagedUp = !screenHas(full.term, marker(LAST))
check('fullscreen: PgUp moves the tail row out of the viewport', pagedUp)
// Paging must land somewhere in the middle, not teleport to the top: the row
// just above the first page boundary is expected while the topmost is not.
check('fullscreen: one PgUp is one page, not the whole buffer', !screenHas(full.term, marker(FIRST)))

const upPresses = await pageUntil(full.term, full.stdin, PGUP, () => screenHas(full.term, marker(FIRST)))
check('fullscreen: repeated PgUp reaches the first row', upPresses > 0 && screenHas(full.term, marker(FIRST)), `${upPresses} presses`)

const downPresses = await pageUntil(full.term, full.stdin, PGDN, () => screenHas(full.term, marker(LAST)))
check('fullscreen: PgDn pages back down to the tail', downPresses > 0 && screenHas(full.term, marker(LAST)), `${downPresses} presses`)

// Back home re-pins the follow (the scrollBy overshoot clamps exactly onto
// maxScroll, whose positional at-bottom restore re-pins sticky): arriving
// content must land IN the viewport, never behind a "↓ 1 new message" pill.
full.channel.rows.push({ id: 60, kind: 'assistant', text: marker(60), seq: 60, fresh: false })
full.channel.emit()
const followed = await settled(() => screenHas(full.term, marker(60)))
check('fullscreen: new content after paging home follows, no pill', followed && !screenHas(full.term, '↓ 1 new message'))

// Help is modal over the transcript and pages its own viewport, so the tail
// has to stay exactly where it is. `?` opens help on empty input; its footer
// hint ("↑/↓ scroll · PgUp/PgDn page · Home/End jump · Esc close") is the
// stable anchor that help is actually up.
full.stdin.write('?')
const helpShown = await settled(() => screenHas(full.term, 'PgUp/PgDn page'), { timeoutMs: 3000 })
check('fullscreen: ? opens the help overlay', helpShown)
if (helpShown) {
  const tail = screenHas(full.term, marker(LAST))
  full.stdin.write(PGUP)
  await sleep(400)
  check('fullscreen: help open yields PgUp to the help viewport', screenHas(full.term, marker(LAST)) === tail)
}
await full.instance.unmount()

// ---- inline: the terminal owns these keys ----
const inline = await mount(false)
check('inline: pinned to the bottom', screenHas(inline.term, marker(LAST)))
inline.stdin.write(PGUP)
inline.stdin.write(PGUP)
await sleep(500)
check('inline: PgUp leaves the TUI viewport alone (terminal scrollback owns it)', screenHas(inline.term, marker(LAST)))
await inline.instance.unmount()

console.log(failed === 0 ? '\nAll transcript paging checks passed.' : `\n${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
